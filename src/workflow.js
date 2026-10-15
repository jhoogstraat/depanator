import { bindingFor, configHashFor, hash } from './store.js';
import { assertReconciled } from './config.js';

// Self-healing (backoff, browser restart, retry) runs first; the user hears only about streaks it cannot fix.
const ALERT_AFTER = 3;
const MAX_BACKOFF_MS = 3_600_000;
// The browser fetches details one at a time; this many LLM calls overlap with it.
const ANALYSIS_CONCURRENCY = 3;
const ADVICE = {
  IS24: 'Self-healing restarted the browser and is backing off. Check the browser viewer for a captcha, block, or expired login.',
  LLM: 'Analysis is paused and retries every poll. Check the API key and quota, or rerun llm-login for Codex.',
};

export class Workflow {
  constructor({ store, adapter, evaluate, notify, config, onEvent = () => {}, beforeWork = async () => {}, alert = async () => {} }) {
    Object.assign(this, { store, adapter, evaluate, notify, config, onEvent, beforeWork, alert });
    this.health = {};
    this.backoff = { skip: 0, blocked: false };
    this.revisions = new Set();
    this.queue = Promise.resolve();
    this.runningTick = null;
    this.closed = false;
    this.controller = new AbortController();
    this.status = { polling: false, lastPollAt: null, lastError: null, searchComplete: null };
  }
  bindings() { return { accountBinding: bindingFor(this.config), configHash: configHashFor(this.config) }; }
  emit(event) { try { this.onEvent(event); } catch { /* Reporting cannot change a send outcome. */ } }
  assertRunning() {
    if (this.closed) throw new Error('Workflow is closed');
    assertReconciled(this.config);
  }
  stop() {
    this.closed = true;
    this.controller.abort();
    this.adapter.cancelLogin?.();
  }
  run(fn) {
    if (this.closed) return Promise.reject(new Error('Workflow is closed'));
    const result = this.queue.then(async () => {
      this.assertRunning();
      try { await this.beforeWork(); }
      catch (error) { if (!this.closed) await this.is24Failure(error); throw error; }
      this.assertRunning();
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  poll() { return this.run(() => this.pollInternal()); }
  sendApproved() { return this.run(() => this.sendInternal()); }
  tick() {
    if (this.runningTick) return this.runningTick;
    this.runningTick = this.run(async () => {
      let result;
      let pollError;
      if (this.backoff.skip > 0) { this.backoff.skip--; result = { skipped: true }; }
      else try { result = await this.pollInternal(); } catch (error) { pollError = error; }
      await this.sendInternal();
      if (pollError) throw pollError;
      return result;
    }).finally(() => { this.runningTick = null; });
    return this.runningTick;
  }
  async raise(text) {
    try { await this.alert(text); } catch (error) { this.emit({ type: 'alert_error', detail: error.message }); }
  }
  async failure(component, error) {
    const health = (this.health[component] ??= { failures: 0, alerted: false });
    health.failures++;
    this.emit({ type: 'health_error', detail: `${component} failure ${health.failures}: ${error.message}` });
    if (health.failures !== ALERT_AFTER) return;
    health.alerted = true;
    await this.raise(`⚠️ ${component} failed ${health.failures} times in a row.\nLast error: ${error.message}\n${ADVICE[component]}`);
  }
  async recovered(component) {
    const health = this.health[component];
    delete this.health[component];
    if (health?.alerted) await this.raise(`✅ ${component} recovered; normal operation resumed.`);
  }
  async is24Failure(error, { restartBrowser = false } = {}) {
    await this.failure('IS24', error);
    // Skip 0, 1, 3, 7... polls, capped near one hour. Sends also pause while IS24 actively blocks us.
    const interval = this.config.pollIntervalMs ?? 600_000;
    this.backoff = { skip: Math.min(2 ** (this.health.IS24.failures - 1), Math.max(1, Math.floor(MAX_BACKOFF_MS / interval))) - 1, blocked: error.code === 'BLOCKED' };
    if (restartBrowser) try { await this.adapter.close?.(); } catch { /* The next task relaunches it. */ }
  }
  async pollInternal() {
    this.status.polling = true;
    this.status.lastError = null;
    try {
      let search;
      try {
        search = await this.adapter.search({ signal: this.controller.signal });
        if (!search || !Array.isArray(search.listings)) throw new Error('Invalid search response');
      } catch (error) { if (!this.closed) await this.is24Failure(error); throw error; }
      this.assertRunning();
      this.status.searchComplete = search.complete;
      this.status.warning = search.warning || (!search.complete ? 'Search is partial; increase maxPages to cover more results' : null);
      // One commit for the whole page set instead of one per listing.
      this.store.transaction(() => { for (const listing of search.listings) this.store.discover(listing); });
      const batch = { stop: false, is24Failed: false, llmFailed: false };
      const queue = this.store.pendingAnalysis();
      const worker = async () => { while (!batch.stop && queue.length) await this.analyze(queue.shift(), batch); };
      // allSettled: no worker may still touch the store after this poll ends or the workflow closes.
      const failed = (await Promise.allSettled(Array.from({ length: ANALYSIS_CONCURRENCY }, worker))).find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (!batch.is24Failed) { this.backoff.blocked = false; await this.recovered('IS24'); }
      for (const review of this.store.pendingNotifications()) {
        this.assertRunning();
        try { await this.notify(review); this.store.markNotified(review.id); }
        catch (error) { this.store.notificationFailed(review.id, error.message); this.emit({ type: 'notification_error', id: review.id, detail: error.message }); }
      }
      this.status.lastPollAt = this.store.now();
      return { ...search, tracked: this.store.count() };
    } catch (error) { this.status.lastError = error.message; throw error; }
    finally { this.status.polling = false; }
  }
  async analyze(candidate, batch) {
    this.assertRunning();
    const review = this.store.beginAnalysis(candidate.id);
    if (!review) return;
    let stage = 'IS24';
    try {
      const snapshot = await this.adapter.details(review.snapshot);
      this.assertRunning();
      if (String(snapshot.expose_id) !== review.exposeId) throw new Error('Listing identity changed during enrichment');
      stage = 'LLM';
      const bindings = this.bindings();
      const result = await this.evaluate(snapshot, { signal: this.controller.signal });
      this.assertRunning();
      await this.recovered('LLM');
      if (hash(bindings) !== hash(this.bindings())) throw new Error('Configuration changed during analysis');
      const saved = this.store.saveAnalysis(review.id, snapshot, result, { ...bindings, expiresAt: this.store.now() + (this.config.approvalTtlMs ?? 86400000) });
      this.emit({ type: 'analysis', review: saved });
    } catch (error) {
      // Shutdown and global outages are not the listing's fault and do not use up its attempts.
      const systemic = this.closed || error.code === 'BLOCKED' || error.code === 'LLM_UNAVAILABLE';
      const failed = this.store.failAnalysis(review.id, error.message, { refund: systemic });
      if (this.closed) throw error;
      this.emit({ type: 'analysis_error', id: review.id, detail: error.message });
      if (failed?.status === 'analysis_failed') await this.raise(`🛑 Gave up on "${review.snapshot.title}" (${review.exposeId}).\n${failed.detail}`);
      if (stage === 'IS24' && error.code !== 'LISTING_GONE') {
        batch.stop = true;
        if (!batch.is24Failed) { batch.is24Failed = true; await this.is24Failure(error, { restartBrowser: true }); }
      } else if (error.code === 'LLM_UNAVAILABLE') {
        batch.stop = true;
        if (!batch.llmFailed) { batch.llmFailed = true; await this.failure('LLM', error); }
      }
    }
  }
  revise(id, version, instructions) {
    if (this.closed) return Promise.reject(new Error('Workflow is closed'));
    const task = this.reviseInternal(id, version, instructions).finally(() => this.revisions.delete(task));
    this.revisions.add(task);
    return task;
  }
  async reviseInternal(id, version, instructions) {
    const review = this.store.get(id);
    if (!review || review.status !== 'awaiting_approval' || review.version !== version) throw new Error('This draft was already handled, changed, or expired');
    const result = await this.evaluate(review.snapshot, { signal: this.controller.signal, revision: { draft: review.draft, instructions } });
    this.assertRunning();
    if (result.decision !== 'message') throw new Error('The agent did not produce a revised draft');
    const saved = this.store.reviseDraft(id, { version, draft: result.draft, reasons: result.reasons, expiresAt: this.store.now() + (this.config.approvalTtlMs ?? 86400000) });
    try { await this.notify(saved); this.store.markNotified(id); }
    catch (error) { this.store.notificationFailed(id, error.message); throw new Error('Draft revised, but delivering it failed; it will be resent on the next poll'); }
    return this.store.get(id);
  }
  async sendInternal() {
    const results = [];
    // Approvals stay durable and are sent once IS24 stops blocking.
    if (this.backoff.blocked) return results;
    for (const candidate of this.store.approved()) {
      this.assertRunning();
      const review = this.store.claimSend(candidate.id, this.bindings());
      if (!review) continue;
      let outcome;
      let sending = false;
      // Claim is durable before any remote operation; ambiguous failures never requeue.
      try {
        const snapshot = await this.adapter.details(review.snapshot);
        if (hash(snapshot) !== review.snapshotHash) {
          outcome = { outcome: 'failed', detail: 'Listing details changed; approval invalidated' };
        } else {
          const beforeSubmit = async () => {
            this.assertRunning();
            if (!this.store.validateSubmission(review.id, { version: review.version, draftHash: review.draftHash, snapshotHash: review.snapshotHash, ...this.bindings() })) throw new Error('Approval expired or binding changed before submission');
            return true;
          };
          await beforeSubmit();
          sending = true;
          outcome = await this.adapter.send(review, { beforeSubmit, assertCanSubmit: () => this.assertRunning() });
          if (!outcome || !['sent', 'failed', 'unknown_outcome'].includes(outcome.outcome)) outcome = { outcome: 'unknown_outcome', detail: 'Adapter returned no reliable submission outcome' };
        }
      } catch (error) { outcome = { outcome: sending ? 'unknown_outcome' : 'failed', detail: error.message }; }
      const saved = this.store.finishSend(review.id, outcome);
      results.push(saved);
      this.emit({ type: 'submission', review: saved });
    }
    return results;
  }
  async close() {
    this.stop();
    await Promise.allSettled([this.queue, ...this.revisions]);
    try { await this.adapter.close?.(); }
    finally { this.store.close(); }
  }
}
