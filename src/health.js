// Failure streaks, shared by the per-person workflow and the shared crawlers. Self-healing (backoff, retry)
// runs first; the user hears only about streaks it cannot fix.
export const ALERT_AFTER = 3;
const MAX_BACKOFF_MS = 3_600_000;
export const IS24_ADVICE = 'Ich versuche es mit immer längeren Pausen weiter. Hält es an, blockiert IS24 vielleicht diese Verbindung.';

// Checks to skip after the nth failure in a row: the pause doubles (0, 1, 3, 7...), capped near one hour.
export const backoffSkip = (failures, intervalMs) => Math.min(2 ** (failures - 1), Math.max(1, Math.floor(MAX_BACKOFF_MS / intervalMs))) - 1;

export const failedAlert = (what, failures, error, advice) => `⚠️ ${what}: ${failures} Fehler in Folge.\nLetzter Fehler: ${error.message}\n${advice}`;
export const recoveredAlert = what => `✅ ${what} läuft wieder normal.`;

// One dependency's health (IS24, ChatGPT, one search's crawler). MACHINE below is complete: the state changes
// only through these events, and any other (status, event) pair leaves it as it is.
//
//   healthy ─failed→ failing ─succeeded→ healthy
//                     ↺ failed   another failure in a row: a longer backoff
//                     ↺ waited   a check skipped while backing off (wait counts down to 0)
//
//   failing: { failures in a row, wait: checks still to skip, blocked: the last failure was IS24 blocking us }
//   The user is alerted once, on the ALERT_AFTER-th failure in a row, and then told when it recovered.
export const HEALTHY = Object.freeze({ status: 'healthy', failures: 0, wait: 0, blocked: false });

// intervalMs: how often the dependency is checked; without it there is no backoff, only the streak.
const failing = (failures, { error, intervalMs }) =>
  ({ status: 'failing', failures, wait: intervalMs ? backoffSkip(failures, intervalMs) : 0, blocked: error.code === 'BLOCKED' });

const MACHINE = {
  healthy: {
    failed: (state, event) => failing(1, event),
  },
  failing: {
    failed: (state, event) => failing(state.failures + 1, event),
    waited: state => ({ ...state, wait: Math.max(0, state.wait - 1) }),
    succeeded: () => HEALTHY,
  },
};
// Pure: the next state; an event that does not apply leaves it unchanged.
export function transition(state, event) {
  return MACHINE[state.status][event.type]?.(state, event) ?? state;
}

// A dependency's health as it changes. what: its name in alerts, e.g. "IS24 search Berlin".
export class Health {
  constructor({ advice }) {
    this.advice = advice;
    this.state = HEALTHY;
  }
  get failures() { return this.state.failures; }
  get blocked() { return this.state.blocked; }
  // Still backing off: the next `wait` checks are skipped.
  get backingOff() { return this.state.wait > 0; }
  // Applies the event. -> the alert this change calls for, or ''.
  record(event, what) {
    const before = this.state;
    this.state = transition(before, event);
    if (before.failures < ALERT_AFTER && this.state.failures === ALERT_AFTER) return failedAlert(what, this.state.failures, event.error, this.advice);
    if (before.failures >= ALERT_AFTER && this.state.status === 'healthy') return recoveredAlert(what);
    return '';
  }
}
