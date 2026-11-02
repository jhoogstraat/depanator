import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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
