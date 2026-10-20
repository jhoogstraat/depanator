// Opt-in model behavior check; no messages or applications are sent.
// DEPANATOR_LIVE_CODEX_HOME=/path/to/codex bun test/live-criteria.js
import assert from 'node:assert/strict';
import { createEvaluator } from '../src/llm.js';

const codexHome = process.env.DEPANATOR_LIVE_CODEX_HOME;
if (!codexHome) throw new Error('Set DEPANATOR_LIVE_CODEX_HOME to an existing ChatGPT login directory');
const evaluate = createEvaluator({ preferences: 'Mit Balkon. Kein Wohnungstausch und keine Tauschwohnungen.', persona: { vorname: 'Alex' },
  llm: { model: 'gpt-6-luna', codexHome } });
const listing = { expose_id: '123', title: 'Zwei Zimmer zur Miete mit Balkon', price: 1100, area: 58, rooms: 2,
  description: 'Diese frisch renovierte Wohnung hat einen Westbalkon. Ab sofort zu vermieten.', amenities: ['Balkon'] };
const ordinary = await evaluate(listing);
assert.equal(ordinary.decision, 'message', 'an ordinary rental does not require an explicit no-swap statement');
assert.doesNotMatch(ordinary.draft, /tausch|swap/i, 'do not invent a swap question');
const swap = await evaluate({ ...listing, title: 'Tauschwohnung mit Balkon', description: 'Nur Wohnungstausch. Wir tauschen unsere Wohnung gegen eine kleinere Wohnung.' });
assert.equal(swap.decision, 'dismiss', 'an explicit swap requirement violates no-swap criteria');
assert.equal(swap.draft, '');
console.log('Live criteria check passed: ordinary rental accepted without swap questions; swap-only listing dismissed.');
