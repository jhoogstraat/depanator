// Failure streaks, shared by the per-person workflow and the shared crawlers. Self-healing (backoff, retry)
// runs first; the user hears only about streaks it cannot fix.
export const ALERT_AFTER = 3;
const MAX_BACKOFF_MS = 3_600_000;
export const IS24_ADVICE = 'I keep retrying with longer pauses. If it continues, IS24 may be blocking this connection.';

// Checks to skip after the nth failure in a row: the pause doubles (0, 1, 3, 7...), capped near one hour.
export const backoffSkip = (failures, intervalMs) => Math.min(2 ** (failures - 1), Math.max(1, Math.floor(MAX_BACKOFF_MS / intervalMs))) - 1;

export const failedAlert = (what, failures, error, advice) => `⚠️ ${what} failed ${failures} times in a row.\nLast error: ${error.message}\n${advice}`;
export const recoveredAlert = what => `✅ ${what} recovered; normal operation resumed.`;
