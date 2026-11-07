import { authorizes, bindingFor, configHashFor, hash, OUTCOMES } from './review.js';
import { assertReconciled } from './config.js';
import { TIME_ZONE } from './settings.js';
import { ALERT_AFTER, IS24_ADVICE, Health } from './health.js';

// At most this many listings are enriched and analyzed at once.
const ANALYSIS_CONCURRENCY = 3;
// A component as alerts name it.
const NAME = { IS24: 'IS24', LLM: 'ChatGPT' };
const ADVICE = {
  IS24: IS24_ADVICE,
  LLM: 'Die Analyse pausiert und wird bei jeder Prüfung neu versucht. Prüfe dein ChatGPT-Abo oder verbinde es mit /login neu.',
};

// Moves reviews through the review.js state machine: search → analyze → deliver → (user decides) → send.
// Everything about a review is durable in the store. Process-local state is only scheduling and health.
export class Workflow {
  // notify delivers a draft for approval, report tells the user a send outcome, alert raises an operator problem.
  // withdraw removes the Telegram messages of a listing that went offline.
  // interval() -> how often checks run.
  constructor({ store, adapter, evaluate, notify, report = async () => {}, withdraw = async () => {}, config, onEvent = () => {}, beforeWork = async () => {}, alert = async () => {}, interval = () => 600_000 }) {
    Object.assign(this, { store, adapter, evaluate, notify, report, withdraw, config, onEvent, beforeWork, alert, interval });
    this.controller = new AbortController(); // Aborted once closed.
    this.queue = Promise.resolve(); // Polls and sends run one at a time.
    this.runningTick = null;
    this.revisions = new Set(); // Run beside the queue so an edit never waits for a poll; close() awaits them.
    this.reporting = Promise.resolve(); // Outcome reports, serialized but independent of IS24 work.
    // Outage streaks (health.js). Only IS24 is backed off; ChatGPT is retried every check.
    this.health = { IS24: new Health({ advice: ADVICE.IS24 }), LLM: new Health({ advice: ADVICE.LLM }) };
    this.cleanedOn = null; // The German date of the last morning cleanup.
  }
  get closed() { return this.controller.signal.aborted; }
  bindings() { return { accountBinding: bindingFor(this.config), configHash: configHashFor(this.config) }; }
  // The account or configuration changed since `bindings` were taken, e.g. while ChatGPT was working.
  changedSince(bindings) { return hash(bindings) !== hash(this.bindings()); }
  closedError() { return new Error('Workflow is closed'); }
  emit(event) { try { this.onEvent(event); } catch { /* Reporting cannot change a send outcome. */ } }
  assertRunning() {
    if (this.closed) throw this.closedError();
    assertReconciled(this.config);
  }
  // The user, or a revision, may have acted first; then the event no longer applies.
  tryDispatch(id, event) {
    try { return this.store.dispatch(id, event); }
    catch (error) { if (error.code === 'CONFLICT') return null; throw error; }
  }
  stop() { this.controller.abort(); }
  run(fn) {
    if (this.closed) return Promise.reject(this.closedError());
    const result = this.queue.then(async () => {
      this.assertRunning();
      try { await this.beforeWork(); }
      catch (error) { if (!this.closed) await this.failure('IS24', error); throw error; }
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
      // Approved applications go out even when there was no search or the search failed.
      try { return await this.check(); }
      finally { await this.sendInternal(); }
    }).finally(() => { this.runningTick = null; });
    return this.runningTick;
  }

  // One check: why it does not search, or what it found.
  async check() {
    // The backoff counts down every tick, paused or not, so approvals held back by a block go out once it ends.
    if (this.health.IS24.backingOff) { this.health.IS24.record({ type: 'waited' }); return { skipped: true }; }
    if (this.config.paused === true) return { paused: true };
    if (this.adapter.quiet?.()) return { quiet: true };
    await this.morningCleanup();
    return this.pollInternal();
  }
  // Once per German calendar day, on the first check after the night pause.
  async morningCleanup() {
    const today = new Date().toLocaleDateString('sv', { timeZone: TIME_ZONE });
    if (this.cleanedOn === today) return;
    this.cleanedOn = today;
    await this.pruneGone();
  }

  // User decisions from Telegram.
  approve(id, version, draftHash) {
    const review = this.store.dispatch(id, { type: 'approve', version, draftHash, bindings: this.bindings() });
    this.sendApproved().catch(error => this.emit({ type: 'send_error', detail: error.message }));
    return review;
  }
  dismiss(id, version) { return this.store.dispatch(id, { type: 'dismiss', version }); }
  // Writes the first draft (instructions ''), revises it, or, with manual, takes instructions as the new draft verbatim.
  revise(id, version, instructions, { manual = false } = {}) {
    if (this.closed) return Promise.reject(this.closedError());
    const task = this.reviseInternal(id, version, instructions, manual).finally(() => this.revisions.delete(task));
    this.revisions.add(task);
    return task;
  }

  async raise(text) {
    try { await this.alert(text); } catch (error) { this.emit({ type: 'alert_error', detail: error.message }); }
  }
  async failure(component, error) {
    const health = this.health[component];
    const alert = health.record({ type: 'failed', error, intervalMs: component === 'IS24' ? this.interval() : 0 }, NAME[component]);
    this.emit({ type: 'health_error', detail: `${component} failure ${health.failures}: ${error.message}` });
    if (alert) await this.raise(alert);
  }
  async recovered(component) {
    const alert = this.health[component].record({ type: 'succeeded' }, NAME[component]);
    if (alert) await this.raise(alert);
  }

  async pollInternal() {
    let search;
    try {
      search = await this.adapter.search();
      if (!search || !Array.isArray(search.listings)) throw new Error('Invalid search response');
    } catch (error) { if (!this.closed) await this.failure('IS24', error); throw error; }
    this.assertRunning();
    // The adapter marks each search's first successful result after startup/resume/change/night pause as a baseline.
    // Those listings were already online; only later arrivals become candidates.
    const noted = this.store.discover(search.baseline ?? [], { existing: true });
    this.store.discover(search.listings, { fresh: true });
    search.commit?.();
    if (noted.length) await this.raise(`👀 Ich beobachte deine Suche. ${noted.length === 1 ? '1 Inserat ist' : `${noted.length} Inserate sind`} schon online; die überspringe ich und melde mich nur bei neuen.`);
    const batch = { stop: false, is24Failed: false, llmFailed: false, tried: new Set() }; // tried: delivered once this poll
    const queue = this.store.list('discovered');
    const worker = async () => { while (!batch.stop && queue.length) await this.analyze(queue.shift(), batch); };
    // allSettled: no worker may still touch the store after this poll ends or the workflow closes.
    const failed = (await Promise.allSettled(Array.from({ length: ANALYSIS_CONCURRENCY }, worker))).find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (!batch.is24Failed) await this.recovered('IS24');
    for (const review of this.store.list('awaiting_approval')) {
      if (review.notifiedAt != null || batch.tried.has(review.id)) continue;
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
      const snapshot = await this.adapter.details(review.snapshot, { shared: true });
      this.assertRunning();
      if (String(snapshot.expose_id) !== review.exposeId) throw new Error('Listing identity changed during enrichment');
      stage = 'LLM';
      const bindings = this.bindings();
      // The exact rent is known only now. Outside the person's search means no ChatGPT call.
      const outside = this.adapter.outside?.(snapshot);
      const result = outside ? { decision: 'dismiss', reasons: [outside], draft: '', confident: false } : await this.evaluate(snapshot, { signal: this.controller.signal });
      this.assertRunning();
      if (!outside) await this.recovered('LLM');
      if (this.changedSince(bindings)) throw new Error('Einstellungen haben sich während der Analyse geändert');
      const saved = this.store.dispatch(review.id, { type: 'analyzed', snapshot, result, bindings });
      if (saved.status !== 'awaiting_approval') return;
      if (this.autoSendable(review, result, snapshot) && await this.autoSend(saved, bindings)) return;
      batch.tried.add(saved.id);
      await this.deliver(saved); // Each listing as soon as it is screened.
    } catch (error) {
      // Shutdown and global outages are not the listing's fault and do not use up its attempts.
      const systemic = this.closed || error.code === 'BLOCKED' || error.code === 'LLM_UNAVAILABLE';
      const failed = this.store.dispatch(review.id, { type: 'fail', detail: error.message, systemic });
      if (this.closed) throw error;
      this.emit({ type: 'analysis_error', id: review.id, detail: error.message });
      if (failed.status === 'analysis_failed') await this.raise(`🛑 Aufgegeben: „${review.snapshot.title}“ (${review.exposeId}).\n${failed.detail}`);
      if (stage === 'IS24' && error.code !== 'LISTING_GONE') {
        batch.stop = true;
        if (!batch.is24Failed) { batch.is24Failed = true; await this.failure('IS24', error); }
      } else if (error.code === 'LLM_UNAVAILABLE') {
        batch.stop = true;
        if (!batch.llmFailed) { batch.llmFailed = true; await this.failure('LLM', error); }
      }
    }
  }
  // After the night pause: yesterday's undecided listings that IS24 took offline are dismissed and removed from the chat.
  async pruneGone() {
    const since = Date.now() - 86_400_000;
    for (const review of this.store.list('awaiting_approval').filter(review => review.createdAt >= since)) {
      this.assertRunning();
      try { await this.adapter.feeds.expose(review.exposeId); continue; }
      catch (error) { if (error.code !== 'LISTING_GONE') { this.emit({ type: 'prune_error', detail: error.message }); return; } } // Retry tomorrow.
      const dismissed = this.tryDispatch(review.id, { type: 'dismiss', version: review.version, detail: 'Inserat nicht mehr verfügbar' });
      if (dismissed) await this.withdraw(dismissed).catch(error => this.emit({ type: 'notification_error', id: review.id, detail: error.message }));
    }
  }
  // Auto-send: the owner's standing approval for clear matches, written and sent in the same tick. Only for newly
  // published listings: the first check, or one after a search change, would otherwise mass-apply.
  // A listing with missing facts always waits for the owner, whatever the model thinks.
  autoSendable(review, result, snapshot) {
    return this.config.autoSend === true && result.confident === true && review.fresh === true && !snapshot.missing;
  }
  // False if writing failed; then the listing waits for the user like any other. On Immomio the message goes with
  // the application, like the IS24 contact request.
  async autoSend(review, bindings) {
    try {
      const written = await this.evaluate(review.snapshot, { signal: this.controller.signal, revision: { draft: '', instructions: '' } });
      if (this.closed || written.decision !== 'message' || this.changedSince(bindings)) return false;
      const revised = this.store.dispatch(review.id, { type: 'revise', version: review.version, draft: written.draft, reasons: review.reasons, bindings });
      this.store.dispatch(review.id, { type: 'approve', version: revised.version, draftHash: revised.draftHash, bindings, by: 'auto' });
      return true;
    } catch (error) { this.emit({ type: 'analysis_error', id: review.id, detail: error.message }); return false; }
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
      if (failed?.deliveryFailures === ALERT_AFTER) await this.raise(`⚠️ Ein Entwurf für „${review.snapshot.title}“ (${review.exposeId}) kam ${ALERT_AFTER}-mal nicht bei Telegram an: ${error.message}. Ich versuche es bei jeder Prüfung erneut.`);
      return false;
    }
  }
  async reviseInternal(id, version, instructions, manual) {
    const review = this.store.get(id);
    if (review?.status !== 'awaiting_approval' || review.version !== version) throw new Error('Dieser Entwurf wurde schon bearbeitet oder geändert');
    const bindings = this.bindings();
    const result = manual ? { decision: 'message', draft: instructions, reasons: review.reasons }
      : await this.evaluate(review.snapshot, { signal: this.controller.signal, revision: { draft: review.draft, instructions } });
    this.assertRunning();
    if (result.decision !== 'message') throw new Error('Es kam kein überarbeiteter Entwurf zurück');
    if (this.changedSince(bindings)) throw new Error('Deine Einstellungen haben sich währenddessen geändert; tippe noch einmal auf ✏️ Umschreiben');
    const revised = this.store.dispatch(id, { type: 'revise', version, draft: result.draft, reasons: result.reasons.length ? result.reasons : review.reasons, bindings });
    if (!await this.deliver(revised)) throw new Error('Entwurf überarbeitet, aber das Zustellen schlug fehl; er kommt bei der nächsten Prüfung erneut');
    return this.store.get(id);
  }
  async sendInternal() {
    const results = [];
    // Approvals stay durable. While IS24 blocks us they wait out the backoff; then the next send tries again.
    const held = this.health.IS24.blocked && this.health.IS24.backingOff;
    for (const candidate of held ? [] : this.store.list('approved')) {
      this.assertRunning();
      // The claim is durable before any remote operation; a claimed review is never sent again.
      let review = this.tryDispatch(candidate.id, { type: 'claim', bindings: this.bindings() });
      if (!review) continue;
      if (review.status === 'submitting') {
        const result = await this.submit(review);
        if (result.retry) {
          this.store.dispatch(review.id, { type: 'release' });
          if (!this.closed) await this.failure('IS24', result.retry);
          break;
        }
        await this.recovered('IS24'); // IS24 answered the listing's last check.
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
  // Returns an outcome, or { retry } when a temporary failure hit before anything was sent.
  // Never throws: any failure after the request may have reached IS24 is an unknown outcome.
  async submit(review) {
    let sending = false;
    try {
      let snapshot;
      try { snapshot = await this.adapter.details(review.snapshot); }
      catch (error) { if (error.code !== 'LISTING_GONE') return { retry: error }; throw error; }
      // New or reordered photos are not a change to what was approved.
      if (hash({ ...snapshot, images: review.snapshot.images }) !== review.snapshotHash) return { outcome: 'failed', detail: 'Das Inserat hat sich geändert; deine Freigabe ist ungültig' };
      const beforeSubmit = async () => {
        this.assertRunning();
        if (!authorizes(this.store.get(review.id), review, this.bindings())) throw new Error('Freigabe hat sich vor dem Senden geändert');
        return true;
      };
      await beforeSubmit();
      sending = true;
      const result = await this.adapter.send(review, { beforeSubmit, assertCanSubmit: () => this.assertRunning() });
      return OUTCOMES.includes(result?.outcome) ? { outcome: result.outcome, detail: result.detail } : { outcome: 'unknown_outcome', detail: 'Kein verlässliches Ergebnis des Sendens' };
    } catch (error) { return { outcome: sending ? 'unknown_outcome' : 'failed', detail: error.message }; }
  }
  async close() {
    this.stop();
    await Promise.allSettled([this.queue, this.reporting, ...this.revisions]);
    this.store.close();
  }
}
