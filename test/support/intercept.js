// Preloaded into the agent process: every outgoing request goes to the fake world, so nothing can reach a
// real service. The real hostname travels in a header; the world answers an unknown host with an error.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = new URL(input);
  return realFetch(`${process.env.E2E_WORLD_URL}${url.pathname}${url.search}`, { ...init, headers: { ...init.headers, 'x-e2e-host': url.hostname } });
};
