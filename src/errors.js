// An Error with the code callers branch on: BLOCKED and LISTING_GONE (is24.js), LOGIN_REQUIRED (oauth.js),
// LLM_UNAVAILABLE (llm.js), CONFLICT (review.js).
export function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
