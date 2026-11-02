import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, SEARCH_URL, STRANGER, until, wait } from './support/world.js';

const IMMOMIO_ID = '12345678-1234-1234-1234-123456789abc';

test('first run: from pairing through setup to one approved application', async t => {
  const world = await createWorld(t);
  world.listing(100, 'Already online', 'Schöne Wohnung.');
  world.seedFirstRun();
  await world.start();
  const code = await until('the pairing code', () => /\/start (\d{6})/.exec(world.agentLog)?.[1]);
  assert.deepEqual(world.telegram.find(call => call.method === 'setMyCommands').body.commands.map(command => command.command), ['status', 'settings']);

  world.say('/start 000000', STRANGER);
  world.say(`/start ${code}`);
  await world.sees(/Hi! I am your apartment agent/);
  await world.connect('🔗 Connect ImmoScout24', 'connect', 'Alex@Example.com', 'correct');
  await world.sees(/Connected to ImmoScout24 as alex@example\.com/);
  for (const [question, answer] of [
    [/Open immobilienscout24\.de/, () => world.say(SEARCH_URL)],
    [/Describe what you are looking for/, () => world.say('No swap')],
    [/How should landlords address you/, () => world.tap('Frau')],
    [/Your first name/, () => world.say('Alex')],
    [/Your last name/, () => world.say('Doe')],
    [/Your phone number/, () => world.say('+49 170 1234567')],
    [/Your current street/, () => world.tap('Skip')],
    [/Your house number/, () => world.tap('Skip')],
    [/Your postcode/, () => world.tap('Skip')],
    [/Your current city/, () => world.tap('Skip')],
    [/What should landlords know/, () => world.say('Nichtraucher.')],
    [/also include your IS24 Selbstauskunft/, () => world.tap('Message only')],
  ]) { await world.sees(question); await answer(); }
  await world.sees(/All set/);
  await world.sees(/1 listings are already online/);

  world.listing(200, 'Sonnige Wohnung', 'Balkon, ruhig.');
  await world.sees(/Sonnige Wohnung\n📍 Teststraße 1, 10115 Berlin/);
  await world.tap('✍️ Write message');
  await world.sees(/Guten Tag, ich bin Alex\.$/);
  const firstSend = world.button('✅ Send');
  await world.tap('✏️ Improve');
  await world.sees(/What should change/);
  world.say('Einzug ab März.');
  await world.sees(/Guten Tag, ich bin Alex\. Einzug ab März\./);
  assert.match(await world.press(firstSend), /newer draft/, 'the replaced draft cannot be approved');
  assert.match(await world.tap('✅ Send', STRANGER), /invalid/);
  assert.equal(world.contacts.length, 0);

  await world.tap('✅ Send');
  await world.sees(/✅ Message sent/);
  world.say('/status', STRANGER);
  await wait(300); // Several more polls: an accepted request is never repeated.
  world.never(/🟢 Searching/); // After pairing, only the owner gets an answer, here to a /status nobody else sent.
  assert.deepEqual(world.contacts.map(({ id, authorization }) => [id, authorization]), [['200', 'Bearer connected-token']]);
  const { form } = world.contacts[0];
  assert.deepEqual([form.message, form.firstname, form.emailAddress, form.phoneNumber], ['Guten Tag, ich bin Alex. Einzug ab März.', 'Alex', 'alex@example.com', '+49 170 1234567']);
  assert.equal(world.codexCalls().filter(call => call.input.listing.title === 'Already online').length, 0, 'listings online before the start are not reviewed');
});

test('chat settings change what happens: a mismatch stays silent, a clear match auto-sends, the rest asks', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);

  world.say('/status');
  await world.sees(/🟢 Searching/);
  assert.ok(!world.labels().includes('🔄 Refresh'));
  await world.tap('⚙️ Settings');
  await world.sees(/Tap what you want to change/);
  await world.tap('🔍 Search');
  await world.sees(/Search requirements/);
  await world.tap('➕ Add');
  await world.sees(/Send one more requirement/);
  world.say('No ground floor');
  await world.sees(/1\. No swap\n2\. No ground floor/);

  world.say('hello?'); // Anything the bot cannot act on opens the settings.
  await until('new settings buttons', () => world.messages().filter(call => /Tap what you want to change/.test(call.body.text)).length === 2);
  await world.tap('📤 Auto-send: off');
  await world.sees(/send applications myself/);
  await world.tap('Auto-send clear matches');
  await world.sees(/Saved: Auto-send = Auto-send clear matches/);
  await world.tap('🧠 Model');
  await world.sees(/ChatGPT model/);
  await world.tap('GPT E2E');
  await world.sees(/Thinking for GPT E2E/);
  await world.tap('high');
  await world.sees(/Using GPT E2E · thinking high/);

  world.listing(301, 'Parterre', 'Wohnung im Ground Floor.');
  world.listing(302, 'Klar passend', 'Balkon, ruhig.');
  world.listing(303, 'Vielleicht', 'Etage unclear.');
  await world.sees(/✅ Message sent \(auto-send\)/);
  await world.sees(/^Vielleicht\n/);
  await until('the reviews of all three', () => world.codexCalls().length >= 4);
  assert.deepEqual(world.contacts.map(contact => contact.id), ['302'], 'only the clear match goes out by itself');
  world.never(/^Parterre/);
  assert.ok(world.codexCalls().every(({ args, input }) => args.includes('gpt-e2e') && args.includes('model_reasoning_effort="high"') && input.preferences === 'No swap\nNo ground floor'));

  const card = world.button('✖️ Dismiss');
  assert.match(await world.press(card), /Dismissed/);
  await until('the card to disappear', () => world.telegram.some(call => call.method === 'deleteMessage' && call.body.message_id === card.messageId));
  world.say('/status');
  await world.sees(/Not a match: 2/);
  await world.tap('⏸ Pause');
  await world.sees(/⏸ Paused/);
  await wait(300);
  const searches = world.searches;
  await wait(400);
  assert.equal(world.searches, searches, 'paused: no searching');
  await world.tap('▶️ Resume');
  await until('searching to resume', () => world.searches > searches);
});

test('Immomio: connected from /settings, a linked listing is applied there and never on IS24', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  world.say('/settings');
  await world.sees(/Tap what you want to change/);
  await world.tap('🔗 Immomio');
  await world.connect('🔗 Connect Immomio', 'immomio', 'alex@immomio.test', 'correct');
  await world.sees(/Connected to Immomio as alex@immomio\.test/);

  world.listing(400, 'Immomio Wohnung', `Bewerbung nur über https://tenant.immomio.com/apply/${IMMOMIO_ID}`);
  await world.sees(/Apply on Immomio with your profile \(alex@immomio\.test\)/);
  await world.tap('✅ Apply on Immomio');
  await world.sees(/✅ Applied on Immomio/);
  assert.deepEqual(world.immomioApplications, [{ userId: 'immomio-user', propertyId: IMMOMIO_ID }]);
  assert.deepEqual(world.contacts, []);
  assert.equal(world.codexCalls().filter(call => call.input.task === 'write').length, 0, 'there is nothing to write');
});

test('a crash during sending is reported as uncertain and never sent again', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  world.listing(500, 'Absturz Wohnung', 'Balkon, ruhig, unclear.');
  await world.sees(/^Absturz Wohnung\n/);
  await world.tap('✍️ Write message');
  await world.sees(/Guten Tag, ich bin Alex\./);
  const send = world.button('✅ Send');

  world.holdContact = true;
  await world.press(send);
  await until('the send to reach IS24', () => world.contacts.length === 1);
  await world.kill('SIGKILL');
  rmSync(join(world.dataDir, 'agent.lock'), { force: true }); // The owner's documented step after a hard stop.
  world.holdContact = false;

  await world.start();
  await world.sees(/⚠️ Check your IS24 account/);
  await world.press(send);
  await wait(400);
  world.say('/status');
  await world.sees(/⚠️ Check on IS24: 1/);
  assert.equal(world.contacts.length, 1, 'neither the restart nor the old button sends again');
});

test('a listing IS24 published without a rent still reaches the owner, waits for a tap, and leaves its responses behind', async t => {
  const world = await createWorld(t);
  world.seed({ autoSend: true });
  await world.start();
  await until('the first search', () => world.searches > 0);

  world.unusableResults = [{ item: { title: 'Anzeige ohne ID' } }, null];
  world.listing(601, 'Klar passend', 'Balkon, ruhig.');
  const incomplete = world.listing(600, 'Ohne Miete', 'Balkon, ruhig.', { rent: null, exposeArea: null });
  const { body: card } = await world.sees(/^Ohne Miete\n/);
  assert.match(card.text, /💶 \? €/);
  assert.match(card.text, /📐 50 m²/, 'the search result fills the gap it can');
  await world.sees(/✅ Message sent \(auto-send\)/);
  assert.deepEqual(world.contacts.map(contact => contact.id), ['601'], 'the model calls both clear matches, but only the complete one goes out by itself');
  const { listing } = world.codexCalls().find(call => call.input.listing.expose_id === '600').input;
  assert.deepEqual([listing.price, listing.missing], [null, ['price']], 'the model is told what is missing');

  const labels = ['expose-600', 'search-item', 'search-item', 'search-item-600'];
  const stored = () => world.kept().map(entry => entry.label).sort();
  await until('the responses to be saved', () => stored().length === labels.length);
  assert.deepEqual(stored(), labels);
  const saved = world.kept().find(entry => entry.label === 'expose-600');
  assert.deepEqual([saved.problem, saved.mode], ['Listing without price, area', 0o600]);
  assert.equal(saved.body.sections.find(section => section.type === 'TITLE').title, 'Ohne Miete', 'the response as IS24 sent it');
  assert.equal(world.kept().find(entry => entry.label === 'search-item-600').problem, 'Search result without price');
  assert.match(world.agentLog, /Kept IS24 response .*expose-600-.*: Listing without price, area/);

  world.listing(602, 'Später', 'Balkon, ruhig, unclear.');
  await world.sees(/^Später\n/); // The gap did not pause the search.
  assert.ok(!/health_error|analysis_error/.test(world.agentLog), 'a gap is not a failure');
  world.never(/IS24 failed/);

  incomplete.published = 'vor 4 Minuten'; // A new body each poll; known listings are not saved again.
  const searches = world.searches;
  await until('more searches', () => world.searches > searches + 3);
  assert.deepEqual(stored(), labels);

  await world.press({ ...card.reply_markup.inline_keyboard.flat().find(button => button.text === '✍️ Write message'), messageId: (world.messages().find(call => call.body === card)).result.message_id });
  await until('the draft', () => world.labels().includes('✅ Send'));
  await world.tap('✅ Send');
  await until('the contact request', () => world.contacts.length === 2);
  assert.equal(world.contacts[1].id, '600', 'the check before sending accepts the gap the owner approved');
  await until('the sent report', () => world.messages().filter(call => /✅ Message sent/.test(call.body.text)).length === 2);
  assert.deepEqual(stored(), labels, 'fetching the same response again stores nothing new');
  assert.equal(world.kept().find(entry => entry.label === 'expose-600').at, saved.at, 'and keeps when it was first seen');
});

test('a rent that appears after approval stops the send', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  const listing = world.listing(610, 'Miete folgt', 'Balkon, ruhig.', { rent: null });
  await world.sees(/^Miete folgt\n/);
  await world.tap('✍️ Write message');
  await world.sees(/Guten Tag, ich bin Alex\./);
  listing.rent = '1.900 €';
  await world.tap('✅ Send');
  await world.sees(/approval invalidated/);
  assert.deepEqual(world.contacts, []);
});

test('real IS24 failures still count as failures, recover, and are saved', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  const saved = label => world.kept().filter(entry => entry.label === label);

  const maintenance = '<html>Wartung</html>';
  world.respond.expose[700] = { status: 503, type: 'text/html', body: maintenance };
  world.listing(700, 'Wartung', 'Balkon, ruhig, unclear.');
  await until('the failed expose to be saved', () => saved('expose-700').length === 1);
  assert.deepEqual([saved('expose-700')[0].problem, saved('expose-700')[0].body], ['IS24 unavailable (HTTP 503)', maintenance]);
  world.respond.expose[700] = { body: '{broken' };
  await until('the broken expose to be saved', () => saved('expose-700').length === 2);
  assert.ok(saved('expose-700').some(entry => entry.problem === 'IS24 sent invalid JSON' && entry.body === '{broken'));
  delete world.respond.expose[700];
  await world.sees(/^Wartung\n/); // The listing survives the outage.

  world.respond.search = { status: 429, type: 'text/plain', body: 'Zu viele Anfragen' };
  await until('the blocked search to be saved', () => saved('search-list').length === 1);
  world.respond.search = { body: JSON.stringify({ nope: true }) };
  await until('the malformed search to be saved', () => saved('search-list').length === 2);
  assert.deepEqual(saved('search-list').map(entry => entry.problem).sort(), ['IS24 blocked access (HTTP 429)', 'Unexpected search response']);
  world.respond.search = null;
  assert.match(world.agentLog, /health_error: IS24 failure/);

  world.respond.expose[701] = { status: 404, body: '{}' };
  world.listing(701, 'Offline', 'Balkon, ruhig.');
  await until('the offline listing to be noticed', () => world.agentLog.includes('Listing is no longer available'));
  assert.deepEqual(saved('expose-701'), [], 'a listing going offline is routine');

  world.respond.contact = { status: 400, body: JSON.stringify({ message: 'abgelehnt' }) };
  const rejectedSend = async (id, title) => {
    world.listing(id, title, 'Balkon, ruhig, unclear.');
    await world.sees(new RegExp(`^${title}\\n`));
    await world.tap('✍️ Write message');
    await until('the draft', () => world.labels().includes('✅ Send'));
    await world.tap('✅ Send');
    await until(`the rejection of ${title}`, () => world.messages().some(call => call.body.text.includes(title) && /IS24 rejected the request/.test(call.body.text)));
  };
  await rejectedSend(702, 'Abgelehnt');
  assert.deepEqual([saved('contact-702')[0].problem, JSON.parse(saved('contact-702')[0].body)], ['Contact request answered HTTP 400', { message: 'abgelehnt' }]);

  // Saving is impossible: the agent carries on, and the owner hears what IS24 really answered.
  rmSync(join(world.dataDir, 'raw'), { recursive: true });
  writeFileSync(join(world.dataDir, 'raw'), '');
  await rejectedSend(703, 'Ohne Ablage');
  world.never(/Check your IS24 account/);
});
