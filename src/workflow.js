import { bindingFor, configHashFor, hash } from './store.js';

export class Workflow {
  constructor({ store, adapter, evaluate, notify, config, onEvent = () => {} }) {
    Object.assign(this, { store, adapter, evaluate, notify, config, onEvent });
    this.queue = Promise.resolve();
    this.runningTick = null;
    this.closed = false;
    this.status = { polling: false, lastPollAt: null, lastError: null, searchComplete: null };
  }
  bindings() { return { accountBinding: bindingFor(this.config), configHash: configHashFor(this.config) }; }
  emit(event) { try { this.onEvent(event); } catch { /* Reporting cannot change a send outcome. */ } }
  run(fn) {
    if (this.closed) return Promise.reject(new Error('Workflow is closed'));
    const result = this.queue.then(fn);
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
      try { result = await this.pollInternal(); } catch (error) { pollError = error; }
      await this.sendInternal();
      if (pollError) throw pollError;
      return result;
    }).finally(() => { this.runningTick = null; });
    return this.runningTick;
  }
  async pollInternal() {
    this.status.polling = true;
    this.status.lastError = null;
    try {
      const search = await this.adapter.search();
      if (!search || !Array.isArray(search.listings)) throw new Error('Invalid search response');
      this.status.searchComplete = search.complete;
      this.status.warning = search.warning || (!search.complete ? 'Search is partial; increase maxPages to cover more results' : null);
      for (const listing of search.listings) this.store.discover(listing);
      for (const candidate of this.store.pendingAnalysis()) {
        const review = this.store.beginAnalysis(candidate.id);
        if (!review) continue;
        try {
          const snapshot = await this.adapter.details(review.snapshot);
          if (String(snapshot.expose_id) !== review.exposeId) throw new Error('Listing identity changed during enrichment');
          const bindings = this.bindings();
          const result = await this.evaluate(snapshot);
          if (hash(bindings) !== hash(this.bindings())) throw new Error('Configuration changed during analysis');
          const saved = this.store.saveAnalysis(review.id, snapshot, result, { ...bindings, expiresAt: this.store.now() + (this.config.approvalTtlMs ?? 86400000) });
          this.emit({ type: 'analysis', review: saved });
        } catch (error) {
          this.store.failAnalysis(review.id, error.message);
          this.emit({ type: 'analysis_error', id: review.id, detail: error.message });
        }
      }
      for (const review of this.store.pendingNotifications()) {
        try { await this.notify(review); this.store.markNotified(review.id); }
        catch (error) { this.store.notificationFailed(review.id, error.message); this.emit({ type: 'notification_error', id: review.id, detail: error.message }); }
      }
      this.status.lastPollAt = this.store.now();
      return { ...search, reviews: this.store.list() };
    } catch (error) { this.status.lastError = error.message; throw error; }
    finally { this.status.polling = false; }
  }
  async sendInternal() {
    const results = [];
    for (const candidate of this.store.approved()) {
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
            if (!this.store.validateSubmission(review.id, { version: review.version, draftHash: review.draftHash, snapshotHash: review.snapshotHash, ...this.bindings() })) throw new Error('Approval expired or binding changed before submission');
            return true;
          };
          await beforeSubmit();
          sending = true;
          outcome = await this.adapter.send(review, { beforeSubmit });
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
    this.closed = true;
    await this.queue;
    await this.adapter.close?.();
    this.store.close();
  }
}
