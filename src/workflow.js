import { authorizes, bindingFor, configHashFor, hash, OUTCOMES } from './review.js';
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

// Moves reviews through the review.js state machine: search → analyze → deliver → (user decides) → send.
// Everything about a review is durable in the store. Process-local state is only scheduling and health.
export class Workflow {
  // notify delivers a draft for approval, report tells the user a send outcome, alert raises an operator problem.
  constructor({ store, adapter, evaluate, notify, report = async () => {}, config, onEvent = () => {}, beforeWork = async () => {}, alert = async () => {} }) {
    Object.assign(this, { store, adapter, evaluate, notify, report, config, onEvent, beforeWork, alert });
    this.controller = new AbortController(); // Aborted once closed.
    this.queue = Promise.resolve(); // Polls and sends run one at a time.
    this.runningTick = null;
    this.revisions = new Set(); // Run beside the queue so an edit never waits for a poll; close() awaits them.
    this.reporting = Promise.resolve(); // Outcome reports, serialized but independent of IS24 work.
    this.failures = { IS24: 0, LLM: 0 }; // Consecutive outage streaks.
    this.backoff = { skip: 0, blocked: false }; // Polls to skip; sends pause while IS24 blocks us.
  }
  get closed() { return this.controller.signal.aborted; }
  bindings() { return { accountBinding: bindingFor(this.config), configHash: configHashFor(this.config) }; }
  emit(event) { try { this.onEvent(event); } catch { /* Reporting cannot change a send outcome. */ } }
  assertRunning() {
    if (this.closed) throw new Error('Workflow is closed');
    assertReconciled(this.config);
  }
  // The user, or a revision, may have acted first; then the event no longer applies.
  tryDispatch(id, event) {
    try { return this.store.dispatch(id, event); }
    catch (error) { if (error.code === 'CONFLICT') return null; throw error; }
  }
  stop() {
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
    // Every interval, even while a previous tick is stuck (e.g. waiting for an IS24 login).
    this.reportOutcomes();
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

  // User decisions from Telegram.
  approve(id, version, draftHash) {
    const review = this.store.dispatch(id, { type: 'approve', version, draftHash, bindings: this.bindings() });
    this.sendApproved().catch(error => this.emit({ type: 'send_error', detail: error.message }));
    return review;
  }
  dismiss(id, version) { return this.store.dispatch(id, { type: 'dismiss', version }); }
  revise(id, version, instructions) {
    if (this.closed) return Promise.reject(new Error('Workflow is closed'));
    const task = this.reviseInternal(id, version, instructions).finally(() => this.revisions.delete(task));
    this.revisions.add(task);
    return task;
  }

  async raise(text) {
    try { await this.alert(text); } catch (error) { this.emit({ type: 'alert_error', detail: error.message }); }
  }
  async failure(component, error) {
    const failures = ++this.failures[component];
    this.emit({ type: 'health_error', detail: `${component} failure ${failures}: ${error.message}` });
    if (failures === ALERT_AFTER) await this.raise(`⚠️ ${component} failed ${failures} times in a row.\nLast error: ${error.message}\n${ADVICE[component]}`);
  }
  async recovered(component) {
    const failures = this.failures[component];
    this.failures[component] = 0;
    if (failures >= ALERT_AFTER) await this.raise(`✅ ${component} recovered; normal operation resumed.`);
  }
  async is24Failure(error, { restartBrowser = false } = {}) {
    await this.failure('IS24', error);
    // Skip 0, 1, 3, 7... polls, capped near one hour.
    const interval = this.config.pollIntervalMs ?? 600_000;
    this.backoff = { skip: Math.min(2 ** (this.failures.IS24 - 1), Math.max(1, Math.floor(MAX_BACKOFF_MS / interval))) - 1, blocked: error.code === 'BLOCKED' };
    if (restartBrowser) try { await this.adapter.close?.(); } catch { /* The next task relaunches it. */ }
  }

  async pollInternal() {
    let search;
    try {
      search = await this.adapter.search({ signal: this.controller.signal, known: exposeId => this.store.has(exposeId) });
      if (!search || !Array.isArray(search.listings)) throw new Error('Invalid search response');
    } catch (error) { if (!this.closed) await this.is24Failure(error); throw error; }
    this.assertRunning();
    this.store.discover(search.listings);
    const batch = { stop: false, is24Failed: false, llmFailed: false };
    const queue = this.store.list('discovered');
    const worker = async () => { while (!batch.stop && queue.length) await this.analyze(queue.shift(), batch); };
    // allSettled: no worker may still touch the store after this poll ends or the workflow closes.
    const failed = (await Promise.allSettled(Array.from({ length: ANALYSIS_CONCURRENCY }, worker))).find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (!batch.is24Failed) { this.backoff.blocked = false; await this.recovered('IS24'); }
    for (const review of this.store.list('awaiting_approval')) {
      if (review.notifiedAt != null) continue;
      this.assertRunning();
      await this.deliver(review);
    }
    return { ...search, tracked: this.store.count() };
  }
  async analyze(candidate, batch) {
    this.assertRunning();
    const review = this.store.dispatch(candidate.id, { type: 'start' });
    if (review.status !== 'discovered') return; // A crash used up its final attempt.
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
      const saved = this.store.dispatch(review.id, { type: 'analyzed', snapshot, result, bindings });
      this.emit({ type: 'analysis', review: saved });
      // Auto-send: the owner's standing approval for clear matches. It is sent in this same tick.
      if (saved.status === 'awaiting_approval' && this.config.autoSend === true && result.confident === true) {
        this.store.dispatch(review.id, { type: 'approve', version: saved.version, draftHash: saved.draftHash, bindings, by: 'auto' });
      }
    } catch (error) {
      // Shutdown and global outages are not the listing's fault and do not use up its attempts.
      const systemic = this.closed || error.code === 'BLOCKED' || error.code === 'LLM_UNAVAILABLE';
      const failed = this.store.dispatch(review.id, { type: 'fail', detail: error.message, systemic });
      if (this.closed) throw error;
      this.emit({ type: 'analysis_error', id: review.id, detail: error.message });
      if (failed.status === 'analysis_failed') await this.raise(`🛑 Gave up on "${review.snapshot.title}" (${review.exposeId}).\n${failed.detail}`);
      if (stage === 'IS24' && error.code !== 'LISTING_GONE') {
        batch.stop = true;
        if (!batch.is24Failed) { batch.is24Failed = true; await this.is24Failure(error, { restartBrowser: true }); }
      } else if (error.code === 'LLM_UNAVAILABLE') {
        batch.stop = true;
        if (!batch.llmFailed) { batch.llmFailed = true; await this.failure('LLM', error); }
      }
    }
  }
  // Undelivered drafts stay pending and are retried every poll without another LLM call.
  async deliver(review) {
    try {
      await this.notify(review);
      this.tryDispatch(review.id, { type: 'delivered', version: review.version });
      return true;
    } catch (error) {
      const failed = this.tryDispatch(review.id, { type: 'deliveryFailed', version: review.version, detail: error.message });
      this.emit({ type: 'notification_error', id: review.id, detail: error.message });
      if (failed?.deliveryFailures === ALERT_AFTER) await this.raise(`⚠️ A draft for "${review.snapshot.title}" (${review.exposeId}) failed to reach Telegram ${ALERT_AFTER} times: ${error.message}. It is retried every poll.`);
      return false;
    }
  }
  async reviseInternal(id, version, instructions) {
    const review = this.store.get(id);
    if (review?.status !== 'awaiting_approval' || review.version !== version) throw new Error('This draft was already handled or changed');
    const bindings = this.bindings();
    const result = await this.evaluate(review.snapshot, { signal: this.controller.signal, revision: { draft: review.draft, instructions } });
    this.assertRunning();
    if (result.decision !== 'message') throw new Error('The agent did not produce a revised draft');
    if (hash(bindings) !== hash(this.bindings())) throw new Error('Configuration changed during revision; tap Edit again');
    const revised = this.store.dispatch(id, { type: 'revise', version, draft: result.draft, reasons: result.reasons, bindings });
    if (!await this.deliver(revised)) throw new Error('Draft revised, but delivering it failed; it will be resent on the next poll');
    return this.store.get(id);
  }
  async sendInternal() {
    const results = [];
    // Approvals stay durable and are sent once IS24 stops blocking.
    for (const candidate of this.backoff.blocked ? [] : this.store.list('approved')) {
      this.assertRunning();
      // The claim is durable before any remote operation; a claimed review is never sent again.
      let review = this.tryDispatch(candidate.id, { type: 'claim', bindings: this.bindings() });
      if (!review) continue;
      if (review.status === 'submitting') {
        const result = await this.submit(review);
        if (result.retry) {
          this.store.dispatch(review.id, { type: 'release' });
          if (!this.closed) await this.is24Failure(result.retry, { restartBrowser: true });
          break;
        }
        review = this.store.dispatch(review.id, { type: 'finish', ...result });
      }
      results.push(review);
      this.emit({ type: 'submission', review });
    }
    await this.reportOutcomes();
    return results;
  }
  // Outcomes reach the user even if reporting failed before, the process stopped right after a send,
  // or IS24 work is stuck (e.g. waiting for a login): Telegram does not need IS24.
  reportOutcomes() {
    this.reporting = this.reporting.then(() => this.reportPending()).catch(error => this.emit({ type: 'report_error', detail: error.message }));
    return this.reporting;
  }
  async reportPending() {
    if (this.closed) return; // Still unreported, so it goes out after the restart.
    for (const review of OUTCOMES.flatMap(status => this.store.list(status)).filter(review => review.reportedAt === null)) {
      if (this.closed) return;
      try { await this.report(review); this.tryDispatch(review.id, { type: 'reported' }); }
      catch (error) { this.emit({ type: 'report_error', id: review.id, detail: error.message }); }
    }
  }
  // Returns an outcome, or { retry } when a temporary failure hit before anything was clicked.
  // Never throws: any failure after the browser may have submitted is an unknown outcome.
  async submit(review) {
    let sending = false;
    try {
      let snapshot;
      try { snapshot = await this.adapter.details(review.snapshot); }
      catch (error) { if (error.code !== 'LISTING_GONE') return { retry: error }; throw error; }
      if (hash(snapshot) !== review.snapshotHash) return { outcome: 'failed', detail: 'Listing details changed; approval invalidated' };
      const beforeSubmit = async () => {
        this.assertRunning();
        if (!authorizes(this.store.get(review.id), review, this.bindings())) throw new Error('Approval binding changed before submission');
        return true;
      };
      await beforeSubmit();
      sending = true;
      const result = await this.adapter.send(review, { beforeSubmit, assertCanSubmit: () => this.assertRunning() });
      return OUTCOMES.includes(result?.outcome) ? { outcome: result.outcome, detail: result.detail } : { outcome: 'unknown_outcome', detail: 'Adapter returned no reliable submission outcome' };
    } catch (error) { return { outcome: sending ? 'unknown_outcome' : 'failed', detail: error.message }; }
  }
  async close() {
    this.stop();
    await Promise.allSettled([this.queue, this.reporting, ...this.revisions]);
    try { await this.adapter.close?.(); }
    finally { this.store.close(); }
  }
}
