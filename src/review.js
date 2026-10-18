import { createHash } from 'node:crypto';

// The review lifecycle. MACHINE below is the complete state machine: a review's status changes only
// through these handlers, and any (status, event) pair not listed is a CONFLICT.
//
//   discovered ─analyzed→ awaiting_approval ─approve→ approved ─claim→ submitting ─finish→ sent             ↺ reported
//       │  ↺ start, fail        │  ↺ revise, delivered,     │                 │                   failed           ↺ reported
//       │                       │     deliveryFailed        │                 │                   unknown_outcome  ↺ reported
//       ├─analyzed(dismiss)→ dismissed ←─dismiss───────────┤                 │
//       └─start/fail (5th)→ analysis_failed                └─claim(binding changed)→ failed
//                                                          approved ←release─ submitting  (only before the request)
//
//   existing: online before the agent watched this search (first check, or after a search change);
//   never analyzed or messaged.
//
// Terminal: existing, sent, failed, unknown_outcome, dismissed, analysis_failed. Nothing leaves them; a send
// outcome only records that the user was told about it (reported).
// Not a status: whether the draft reached Telegram (notifiedAt) and the outcome report (reportedAt).
// Both are durable outboxes, retried every tick until delivered.
// `submitting` is the only in-flight state: it is durable before the remote submit, and a restart
// finishes it as unknown_outcome, so an application is never sent twice.

// ponytail: fixed cap; a long non-systemic failure streak can exhaust it. Raise if listings get lost.
export const MAX_ANALYSIS_ATTEMPTS = 5;
export const OUTCOMES = ['sent', 'failed', 'unknown_outcome'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
export function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}
export function bindingFor(config) {
  return hash({ accountEmail: config.accountEmail.toLowerCase().trim() });
}
export function configHashFor(config) {
  const { searchUrl, accountEmail, persona, preferences, llm } = config;
  // Secrets and notification destinations do not authorize or change a message.
  return hash({ searchUrl, accountEmail, persona, preferences, llm: llm && { model: llm.model, codexHome: llm.codexHome } });
}

export function conflict(message) {
  const error = new Error(message);
  error.code = 'CONFLICT';
  throw error;
}

export function newReview({ id, snapshot, now }) {
  const exposeId = String(snapshot.expose_id ?? '');
  if (!/^\d+$/.test(exposeId)) throw new Error('Invalid expose ID');
  return { id, exposeId, status: 'discovered', snapshot: structuredClone(snapshot), version: 1, draft: '', draftHash: null, reasons: [], analysisAttempts: 0, accountBinding: null, configHash: null, createdAt: now, notifiedAt: null };
}

// Draft, listing and account/config are exactly what the user saw when approving.
function intact(review, bindings) {
  return review.draftHash === hash(review.draft) && review.snapshotHash === hash(review.snapshot) && String(review.snapshot.expose_id) === review.exposeId
    && review.accountBinding === bindings.accountBinding && review.configHash === bindings.configHash;
}
// The last check before the contact request goes out: the claimed review is still active and unchanged.
export function authorizes(current, claimed, bindings) {
  return Boolean(current && current.status === 'submitting' && current.version === claimed.version && current.draftHash === claimed.draftHash
    && current.snapshotHash === claimed.snapshotHash && intact(current, bindings));
}

function sameVersion(review, version) {
  if (review.version !== version) conflict('A newer draft replaced this one');
}
function giveUpOr(review, detail) {
  return review.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS
    ? { ...review, status: 'analysis_failed', detail: `Gave up after ${review.analysisAttempts} attempts: ${detail}` }
    : { ...review, detail };
}

const dismiss = (review, { version }) => {
  sameVersion(review, version);
  return { ...review, status: 'dismissed', detail: 'Dismissed by user' };
};

const MACHINE = {
  discovered: {
    // Counted before the work, so a crash mid-analysis still uses up the attempt.
    start: review => review.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS
      ? giveUpOr(review, review.detail || 'Analysis interrupted')
      : { ...review, analysisAttempts: review.analysisAttempts + 1, detail: undefined },
    // systemic: shutdown or an outage, not the listing's fault, so the attempt is refunded.
    fail: (review, { detail, systemic }) => giveUpOr({ ...review, analysisAttempts: review.analysisAttempts - (systemic ? 1 : 0) }, detail),
    analyzed: (review, { snapshot, result, bindings }) => {
      if (String(snapshot.expose_id) !== review.exposeId) conflict('Listing identity changed');
      if (!['message', 'dismiss'].includes(result.decision) || !Array.isArray(result.reasons) || result.reasons.some(reason => typeof reason !== 'string') || typeof result.draft !== 'string' || (result.decision === 'message' && !result.draft.trim())) throw new Error('Invalid analysis result');
      return { ...review, status: result.decision === 'message' ? 'awaiting_approval' : 'dismissed', snapshot: structuredClone(snapshot), snapshotHash: hash(snapshot),
        reasons: result.reasons, draft: result.draft, draftHash: hash(result.draft), accountBinding: bindings.accountBinding, configHash: bindings.configHash };
    },
  },
  awaiting_approval: {
    delivered: (review, { version }, now) => { sameVersion(review, version); return { ...review, notifiedAt: now, notificationError: undefined }; },
    deliveryFailed: (review, { version, detail }) => {
      sameVersion(review, version);
      return { ...review, notificationError: detail, deliveryFailures: (review.deliveryFailures ?? 0) + 1 };
    },
    // A new version invalidates every Telegram button signed for the previous draft, and is delivered again.
    // It is bound to the current account/config, so editing also renews a draft stranded by a settings change.
    revise: (review, { version, draft, reasons, bindings }) => {
      sameVersion(review, version);
      if (typeof draft !== 'string' || !draft.trim()) throw new Error('Invalid revised draft');
      return { ...review, version: version + 1, draft, draftHash: hash(draft), reasons, accountBinding: bindings.accountBinding, configHash: bindings.configHash,
        notifiedAt: null, notificationError: undefined, deliveryFailures: 0 };
    },
    // by: 'user' (a Telegram tap) or 'auto' (auto-send on, and the LLM was confident).
    approve: (review, { version, draftHash, bindings, by = 'user' }, now) => {
      if (review.version !== version || review.draftHash !== draftHash) conflict('A newer draft replaced this one');
      if (!intact(review, bindings)) conflict('Settings changed since this draft was written. Tap ✏️ Edit to renew it, or Dismiss.');
      return { ...review, status: 'approved', approvedAt: now, approvedBy: by };
    },
    dismiss,
  },
  approved: {
    claim: (review, { bindings }, now) => intact(review, bindings)
      ? { ...review, status: 'submitting', claimedAt: now }
      : { ...review, status: 'failed', detail: 'Settings changed after approval; nothing was sent', finishedAt: now, reportedAt: null },
    dismiss,
  },
  submitting: {
    // A temporary failure (outage, block) before anything was sent: the approval stays valid.
    release: review => ({ ...review, status: 'approved', claimedAt: undefined }),
    finish: (review, { outcome, detail = '' }, now) => {
      if (!OUTCOMES.includes(outcome)) throw new Error('Invalid submission outcome');
      return { ...review, status: outcome, detail, finishedAt: now, reportedAt: null };
    },
  },
  ...Object.fromEntries(OUTCOMES.map(outcome => [outcome, { reported: (review, _, now) => ({ ...review, reportedAt: now }) }])),
};
// Pure: returns the next review or throws. Persisting it is the store's job.
export function transition(review, event, now) {
  const handler = MACHINE[review.status]?.[event.type];
  if (!handler) conflict(`This review was already handled (${review.status.replaceAll('_', ' ')})`);
  return handler(review, event, now);
}
