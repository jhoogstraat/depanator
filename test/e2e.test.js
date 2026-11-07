import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, FRIEND, OWNER, SEARCH_URL, STRANGER, until, wait } from './support/world.js';

const IMMOMIO_ID = '12345678-1234-1234-1234-123456789abc';
const IMMOMIO_AUTO = '87654321-4321-4321-4321-cba987654321';

test('first run: from pairing through setup to one approved application', async t => {
  const world = await createWorld(t);
  world.listing(100, 'Already online', 'Schöne Wohnung.');
  world.seedFirstRun();
  await world.start();
  const code = await until('the pairing code', () => /\/start (\d{6})/.exec(world.agentLog)?.[1]);
  assert.deepEqual(world.telegram.find(call => call.method === 'setMyCommands').body.commands.map(command => command.command), ['status', 'settings']);

  world.say(`/start ${code}`);
  await world.sees(/Hi! I am your apartment agent/);
  await world.connect('🔗 Connect ImmoScout24', 'connect', 'Alex@Example.com', 'correct');
  await world.sees(/Connected to ImmoScout24 as alex@example\.com/);
  for (const [question, answer] of [
    [/Which searches/, () => world.tap('➕ Add')],
    [/send a name and the address/, async () => {
      world.say('no link');
      await world.sees(/Please send a name/);
      world.say('Berlin https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen');
      await world.sees(/Only apartment rental searches/);
      world.say(`Berlin ${SEARCH_URL}`);
      await until('the new search', () => world.labels().includes('⬜ Berlin'));
      assert.match(await world.tap('Done'), /at least one/);
      await world.tap('⬜ Berlin');
      await world.tap('Done');
    }],
    [/What are you looking for/, async () => {
      assert.match((await world.fill('search', { rent: 'cheap', preferences: 'No swap' })).error, /^Highest warm rent in €: Please write a rent/);
      assert.match((await world.fill('search', { rent: '1500' })).error, /^Requirements: please fill this in/, 'nothing was saved');
      // Requests the page cannot make, as a forged one would: refused, and nothing is saved.
      for (const [values, error] of [[{ admin: true }, /outdated/], [{ rooms: 3 }, /^Rooms: this value is not allowed/],
        [{ preferences: 'No swap\u202E' }, /invisible or control characters/], [{ rent: '50000' }, /between 0 and 20000/]]) {
        assert.match((await world.fill('search', { rent: '1500', preferences: 'No swap', ...values })).error, error);
      }
      assert.equal((await world.fill('search', { rent: '1500', preferences: 'No swap' })).status, 204);
    }],
    [/Now about you/, async () => {
      const contact = { 'persona.anrede': 'FEMALE', 'persona.telefon': '+49 170 1234567', address: 'Musterstraße', 'persona.plz': '10115', 'persona.ort': 'Berlin', 'persona.about': 'Nichtraucher.' };
      const { form, error } = await world.fill('profile', contact);
      assert.deepEqual(form.fields.filter(field => field.prefilled).map(field => [field.key, field.value]), [['persona.vorname', 'Alex'], ['persona.nachname', 'Doe']], 'the name comes from the IS24 account');
      assert.match(error, /^Street and house number: Please write the street and then the house number/);
      assert.equal((await world.fill('profile', { ...contact, address: 'Straße des 17. Juni 12a' })).status, 204);
    }],
  ]) { await world.sees(question); await answer(); }
  await world.sees(/All set/);
  await world.sees(/1 listings are already online/);

  world.listing(200, 'Sonnige Wohnung', 'Balkon, ruhig.');
  await world.sees(/Sonnige Wohnung\n📍 Teststraße 1, 10115 Berlin/);
  await world.tap('✨ Write message');
  await world.sees(/Guten Tag, ich bin Alex\.$/);
  assert.deepEqual(world.button('📋 Copy').copy_text, { text: 'Guten Tag, ich bin Alex.' }, 'a short draft copies with one tap');
  const firstSend = world.button('✅ Send');
  await world.tap('✏️ Rewrite');
  await world.sees(/How should I rewrite it/);
  world.say('Einzug ab März.');
  await world.sees(/Guten Tag, ich bin Alex\. Einzug ab März\./);
  assert.match(await world.press(firstSend), /newer draft/, 'the replaced draft cannot be approved');
  assert.equal(world.contacts.length, 0);

  await world.tap('✅ Send');
  await world.sees(/✅ Message sent/);
  await wait(300); // Several more polls: an accepted request is never repeated.
  assert.deepEqual(world.contacts.map(({ id, authorization }) => [id, authorization]), [['200', 'Bearer connected-token']]);
  const { form } = world.contacts[0];
  assert.deepEqual([form.message, form.firstname, form.emailAddress, form.phoneNumber], ['Guten Tag, ich bin Alex. Einzug ab März.', 'Alex', 'alex@example.com', '+49 170 1234567']);
  assert.deepEqual(form.address, { street: 'Straße des 17. Juni', houseNumber: '12a', postcode: '10115', city: 'Berlin' });
  assert.equal(world.codexCalls().filter(call => call.input.listing.title === 'Already online').length, 0, 'listings online before the start are not reviewed');
});

test('a draft too long for a copy button is copied from a code block', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  world.listing(250, 'Lange Wohnung', 'Balkon, ruhig, unclear.');
  await world.sees(/^Lange Wohnung\n/);
  await world.tap('✨ Write message');
  await world.sees(/Guten Tag, ich bin Alex\.$/);
  await world.tap('📝 Write myself');
  await world.sees(/exactly as it should go out/);
  const long = `Guten Tag, ${'ich möchte die Wohnung gerne besichtigen. '.repeat(10)}`.trim();
  world.say(long);
  await world.sees(new RegExp(`${long.slice(-40).replace(/[.]/g, '\\.')}$`));
  assert.match(await world.tap('📋 Copy'), /Tap the code block/);
  const copy = await until('the code block', () => world.messages().find(call => call.body.text === long));
  assert.deepEqual(copy.body.entities, [{ type: 'pre', offset: 0, length: long.length }]);
  assert.ok(copy.body.reply_parameters, 'the code block sits under its draft');
});

test('chat settings change what happens: a mismatch stays silent, a clear match auto-sends, the rest asks', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);

  world.say('/status');
  await world.sees(/🟢 Searching/);
  await world.tap('⚙️ Settings');
  await world.sees(/Tap what you want to change/);
  await world.tap('🔍 Search');
  await world.sees(/<b>🎯 Requirements<\/b>\n<blockquote expandable>No swap<\/blockquote>/);
  assert.deepEqual(world.labels(), ['🔎 Searches', '✏️ Edit', '← Settings']);
  const { form } = await world.fill('search', { preferences: 'No swap\nNo ground floor' });
  assert.deepEqual(form.fields.map(field => [field.key, field.value]), [['rent', '-1500'], ['rooms', ''], ['area', ''], ['preferences', 'No swap']], 'the form opens with what is set');
  await world.sees(/<blockquote expandable>No swap\nNo ground floor<\/blockquote>/);
  world.say('/settings');
  await world.tap('✍️ Agent\'s style');
  await world.sees(/The agent's writing style<\/b>[^]*None yet/);
  const style = await world.fill('style', { style: 'Kurz & formell.', 'style.closing': 'Mit vollem Namen unterschreiben.', 'style.closing.example': 'Viele Grüße\nAlex' });
  assert.deepEqual(style.form.fields.filter(field => field.section).map(field => field.section), ['Overall', 'Greeting', 'Introduction', 'Main part', 'Closing'], 'each part of the message has its own fields');
  assert.equal(style.form.fields.length, 10);
  await world.sees(/<b>Overall<\/b>\n<blockquote expandable>Kurz &amp; formell\.<\/blockquote>[^]*<b>Closing<\/b>\n<blockquote expandable>Mit vollem Namen unterschreiben\.<\/blockquote>\nExample:\n<blockquote expandable>Viele Grüße\nAlex<\/blockquote>/);

  world.say('hello?'); // Anything the bot cannot act on opens the settings.
  await until('new settings buttons', () => world.messages().filter(call => /Tap what you want to change/.test(call.body.text)).length === 2);
  assert.match(await world.tap('📤 Auto-send: off'), /Auto-send on/); // Switches at once, in place.
  await world.sees(/📤 Auto-send is <b>on<\/b>/);
  // The admin picks the one model that screens and writes for everyone.
  const menu = world.button('🛠 Admin').messageId;
  await world.tap('🛠 Admin');
  await world.tap('🧠 Model');
  await world.sees(/🧠 Model<\/b>\nReads every new listing/);
  assert.ok(!world.labels().includes('GPT E1E'), 'only the newest model of each family is offered');
  await world.tap('GPT E2E');
  await world.sees(/Thinking for GPT E2E/);
  assert.match(await world.tap('high'), /GPT E2E · thinking high\. Screens and writes from now on, for everyone/);
  await until('the picked model', () => world.labels().includes('✓ GPT E2E'));
  // Every menu leads back up, in the same message: Model → Admin → Settings → Status.
  await world.tap('← Admin');
  await world.tap('← Settings');
  await world.tap('← Status');
  await until('the status in place of the menu', () => world.telegram.some(call => call.method === 'editMessageText' && call.body.message_id === menu
    && /🧠 Model: gpt-e2e · thinking high\n/.test(call.body.text)));

  world.listing(301, 'Parterre', 'Wohnung im Ground Floor.');
  world.listing(302, 'Klar passend', 'Balkon, ruhig.');
  world.listing(303, 'Vielleicht', 'Etage unclear.');
  await world.sees(/✅ Message sent \(auto-send\)/);
  await world.sees(/^Vielleicht\n/);
  await until('the reviews of all three', () => world.codexCalls().length >= 4);
  assert.deepEqual(world.contacts.map(contact => contact.id), ['302'], 'only the clear match goes out by itself');
  world.never(/^Parterre/);
  const calls = world.codexCalls();
  assert.ok(calls.some(({ input }) => input.task === 'write'), 'the clear match was written');
  assert.ok(calls.every(({ args, input }) => args.includes('gpt-e2e') && args.includes('model_reasoning_effort="high"')), 'screening and writing with the one model');
  assert.ok(calls.every(({ input }) => input.preferences === 'No swap\nNo ground floor' && JSON.stringify(input.writingStyle) === JSON.stringify({ overall: { instructions: 'Kurz & formell.' }, closing: { instructions: 'Mit vollem Namen unterschreiben.', example: 'Viele Grüße\nAlex' } })));

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
  world.listing(304, 'Während der Pause', 'Etage unclear.');
  await world.tap('▶️ Resume');
  await until('searching to resume', () => world.searches > searches + 2);
  world.listing(305, 'Nach der Pause', 'Etage unclear.');
  await world.sees(/^Nach der Pause\n/);
  world.never(/^Während der Pause/); // Paused on purpose: what came meanwhile counts as already online.
  assert.ok(!world.codexCalls().some(call => call.input.listing.title === 'Während der Pause'));
});

test('Immomio: connected from /settings, a linked listing is applied there with the message and never on IS24', async t => {
  const world = await createWorld(t);
  world.seed({ autoSend: true });
  // A public link ID: Immomio answers with the property's own ID, which the application uses.
  world.immomio.properties.p8FkQ2 = IMMOMIO_AUTO;
  await world.start();
  await until('the first search', () => world.searches > 0);
  world.say('/settings');
  await world.sees(/Tap what you want to change/);
  await world.tap('🔗 Immomio');
  await world.connect('🔗 Connect Immomio', 'immomio', 'alex@immomio.test', 'correct');
  await world.sees(/Connected to Immomio as alex@immomio\.test/);

  world.listing(400, 'Immomio Wohnung', `Bewerbung nur über https://tenant.immomio.com/apply/${IMMOMIO_ID.toUpperCase()}, unclear.`);
  await world.sees(/^Immomio Wohnung\n[\s\S]*🏢 Applies on Immomio/);
  await world.tap('✨ Write message');
  await until('the draft', () => world.labels().includes('✅ Apply + send'));
  await world.tap('✅ Apply + send');
  const { body: applied } = await world.sees(/✅ Applied on Immomio/);
  assert.match(applied.text, /Your message went to the landlord/);
  // A clear match is applied by itself, with a written message.
  world.listing(401, 'Immomio klar', 'Bewerbung über tenant.immomio.com/de/apply/p8FkQ2 bitte.');
  await world.sees(/✅ Applied on Immomio \(auto-send\)/);
  assert.deepEqual(world.immomioApplications, [{ userId: 'immomio-user', propertyId: IMMOMIO_ID }, { userId: 'immomio-user', propertyId: IMMOMIO_AUTO }]);
  assert.deepEqual(world.immomio.sent, [{ applicationId: 'application-1', message: 'Guten Tag, ich bin Alex.' }, { applicationId: 'application-2', message: 'Guten Tag, ich bin Alex.' }]);
  assert.deepEqual(world.contacts, []);
});

test('Immomio messages: new landlord messages reach the chat once, and a reply goes back to that conversation', async t => {
  const world = await createWorld(t);
  world.seed();
  // The history is ten days old, so the account counts as quiet.
  const at = minutes => new Date(Date.now() - 10 * 86_400_000 + minutes * 60_000).toISOString();
  const landlord = { firstname: 'Kim', name: 'Vermieter', type: 'LANDLORD' };
  const me = { firstname: 'Alex', name: 'Doe', type: 'PROPERTY_SEARCHER' };
  world.immomio.conversations.push(
    { id: 'conv-old', subject: 'Altbau Mitte', unread: 0, messages: [{ id: 'm1', messageSent: at(0), message: 'Already read', sender: landlord }] },
    { id: 'conv-1', subject: 'Wohnung Kreuzberg', unread: 1, messages: [{ id: 'm2', messageSent: at(1), message: 'Hallo', sender: me },
      { id: 'm3', messageSent: at(2), message: 'Besichtigung am Montag um 18 Uhr?', sender: landlord, attachments: [{ title: 'Grundriss.pdf', url: 'https://example.test/x' }] }] });
  await world.start();
  await until('the first search', () => world.searches > 0);
  world.say('/immomio');
  await world.connect('🔗 Connect Immomio', 'immomio', 'alex@immomio.test', 'correct');

  // The first check shows what is still unread, not the history.
  const forwarded = await world.sees(/^📨 Immomio · Wohnung Kreuzberg\nKim Vermieter:\nBesichtigung am Montag um 18 Uhr\?/);
  assert.match(forwarded.body.text, /📎 Grundriss\.pdf/);
  world.never(/Already read|^📨 .*\n.*\nHallo/);
  // A quiet account is read 30 times less often than an active one.
  const quiet = world.immomio.reads;
  await wait(1500);
  assert.ok(world.immomio.reads - quiet <= 1, `a quiet account was read ${world.immomio.reads - quiet} times in 1.5 s`);

  world.immomio.conversations[0].messages.push({ id: 'm4', messageSent: new Date().toISOString(), message: 'Ist die Wohnung noch frei?', sender: landlord });
  world.immomio.conversations[0].unread = 1;
  await world.sees(/^📨 Immomio · Altbau Mitte\nKim Vermieter:\nIst die Wohnung noch frei\?/);

  // ↩️ Reply opens a prompt; the reply to it is sent as written.
  assert.match(await world.press(world.button('↩️ Reply')), /Reply to the prompt/);
  const { result: prompt } = await world.sees(/^↩️ Your reply to Altbau Mitte on Immomio/);
  world.reply('Ja, ich komme gern.', prompt.message_id);
  await world.sees(/✅ Sent on Immomio to Altbau Mitte/);
  // Replying to the forwarded message itself works too.
  world.reply('Montag passt.', forwarded.result.message_id);
  await world.sees(/✅ Sent on Immomio to Wohnung Kreuzberg/);
  assert.deepEqual(world.immomio.sent, [{ conversationId: 'conv-old', message: 'Ja, ich komme gern.' }, { conversationId: 'conv-1', message: 'Montag passt.' }]);

  // Active again: read often. Nothing is shown twice, and the own replies are not shown back.
  const reads = world.immomio.reads;
  await until('frequent Immomio checks', () => world.immomio.reads > reads + 3, 1500);
  assert.equal(world.messages().filter(call => /^📨 /.test(call.body.text)).length, 2);
});

test('a listing IS24 published without a rent still reaches the owner, waits for a tap, and leaves its responses behind', async t => {
  const world = await createWorld(t);
  world.seed({ autoSend: true });
  await world.start();
  await until('the first search', () => world.searches > 0);

  world.listing(601, 'Klar passend', 'Balkon, ruhig.');
  const incomplete = world.listing(600, 'Ohne Miete', 'Balkon, ruhig.', { rent: null, exposeArea: null });
  const { body: card } = await world.sees(/^Ohne Miete\n/);
  assert.match(card.text, /💶 \? €/);
  assert.match(card.text, /📐 50 m²/, 'the search result fills the gap it can');
  await world.sees(/✅ Message sent \(auto-send\)/);
  assert.deepEqual(world.contacts.map(contact => contact.id), ['601'], 'the model calls both clear matches, but only the complete one goes out by itself');
  const { listing } = world.codexCalls().find(call => call.input.listing.expose_id === '600').input;
  assert.deepEqual([listing.price, listing.missing], [null, ['price']], 'the model is told what is missing');

  const labels = ['expose-600', 'search-item-600'];
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

  await world.press({ ...card.reply_markup.inline_keyboard.flat().find(button => button.text === '✨ Write message'), messageId: (world.messages().find(call => call.body === card)).result.message_id });
  await until('the draft', () => world.labels().includes('✅ Send'));
  await world.tap('✅ Send');
  await until('the contact request', () => world.contacts.length === 2);
  assert.equal(world.contacts[1].id, '600', 'the check before sending accepts the gap the owner approved');
  await until('the sent report', () => world.messages().filter(call => /✅ Message sent/.test(call.body.text)).length === 2);
  assert.deepEqual(stored(), labels, 'fetching the same response again stores nothing new');
});

test('a rent that appears after approval stops the send', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  const listing = world.listing(610, 'Miete folgt', 'Balkon, ruhig.', { rent: null });
  await world.sees(/^Miete folgt\n/);
  await world.tap('✨ Write message');
  await world.sees(/Guten Tag, ich bin Alex\./);
  listing.rent = '1.900 €';
  await world.tap('✅ Send');
  await world.sees(/approval invalidated/);
  assert.deepEqual(world.contacts, []);
});

test('a listing\'s photos: one card, ◀️ ▶️ swap the photo in place, and they stay browsable after a decision', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  world.listing(620, 'Mit Fotos', 'Balkon, ruhig.', { photos: ['a', 'b', 'c'] });
  const { body: card, result: { message_id: messageId } } = await world.sees(/^Mit Fotos\n/);
  const edits = () => world.telegram.filter(call => call.method === 'editMessageText' && call.body.message_id === messageId);
  const shown = () => edits().at(-1)?.body;
  const photo = body => /listings\/(\w+)\.jpg/.exec(body.link_preview_options.url)[1];
  assert.equal(photo(card), 'a', 'the title picture first');
  assert.match(card.link_preview_options.url, /\/format\/jpg\//);
  assert.deepEqual(card.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [['◀️', '1/3', '▶️'], ['✨ Write message', '✖️ Dismiss']]);
  assert.ok(!('images' in world.codexCalls().at(-1).input.listing), 'ChatGPT is not sent the photo links');

  // The tap is answered before the card is edited, so wait for the edit itself.
  const browse = async label => { const before = edits().length; await world.tap(label); return until(`photo after ${label}`, () => edits().length > before && shown()); };
  let edit = await browse('▶️');
  assert.deepEqual([photo(edit), edit.text, edit.entities], ['b', card.text, card.entities], 'the same card with the next photo');
  assert.ok(!world.telegram.some(call => call.method === 'sendMessage' && call.result.message_id > messageId), 'and no new message');
  assert.deepEqual(edit.reply_markup.inline_keyboard[0].map(button => button.text), ['◀️', '2/3', '▶️']);
  edit = await browse('◀️');
  edit = await browse('◀️');
  assert.deepEqual([photo(edit), edit.reply_markup.inline_keyboard[0][1].text], ['c', '3/3'], 'it wraps around');

  await world.tap('✨ Write message');
  const kept = await until('the card without its decision buttons', () => world.telegram.findLast(call => call.method === 'editMessageReplyMarkup' && call.body.message_id === messageId));
  assert.deepEqual(kept.body.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [['◀️', '3/3', '▶️']], 'the photos stay browsable');
  assert.equal(photo(await browse('▶️')), 'a');
  await world.sees(/Guten Tag, ich bin Alex\./);

  world.listing(621, 'Ein Foto', 'Balkon, ruhig.', { photos: ['e'] });
  const { body: lone } = await world.sees(/^Ein Foto\n/);
  assert.equal(photo(lone), 'e');
  assert.deepEqual(lone.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [['✨ Write message', '✖️ Dismiss']], 'one photo, no carousel');
  assert.deepEqual(world.kept(), [], 'a listing with its photos leaves nothing behind');
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
  delete world.respond.expose[700];
  await world.sees(/^Wartung\n/); // The listing survives the outage.

  world.respond.search = { status: 429, type: 'text/plain', body: 'Zu viele Anfragen' };
  await until('the blocked search to be saved', () => saved('search-list').length === 1);
  assert.equal(saved('search-list')[0].problem, 'IS24 blocked access (HTTP 429)');
  world.respond.search = null;
  assert.match(world.agentLog, /health_error: IS24 failure/);

  world.respond.expose[701] = { status: 404, body: '{}' };
  world.listing(701, 'Offline', 'Balkon, ruhig.');
  await until('the offline listing to be noticed', () => world.agentLog.includes('Listing is no longer available'));
  assert.deepEqual(saved('expose-701'), [], 'a listing going offline is routine');

  world.respond.contact = { status: 400, body: JSON.stringify({ message: 'abgelehnt' }) };
  world.listing(702, 'Abgelehnt', 'Balkon, ruhig, unclear.');
  await world.sees(/^Abgelehnt\n/);
  await world.tap('✨ Write message');
  await until('the draft', () => world.labels().includes('✅ Send'));
  await world.tap('✅ Send');
  await world.sees(/❌ Message not sent\n\nAbgelehnt\n[^]*IS24 rejected the request \(HTTP 400: \{"message":"abgelehnt"\}\)/);
  assert.deepEqual([saved('contact-702')[0].problem, JSON.parse(saved('contact-702')[0].body)], ['Contact request answered HTTP 400', { message: 'abgelehnt' }]);
});

test('the admin\'s list: a search runs only once someone picked it, and a listing in two searches counts once', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  assert.ok(world.searchUrls.every(url => !/[?&]price=/.test(url) && !/pricetype=rentpermonth/.test(url)), 'an old personal search joined the list without its rent');
  const hamburg = url => url.includes('hamburg');

  world.say('/search');
  await world.sees(/💶 Warm rent: up to 1500 €/); // ...and the rent became a limit.
  await world.tap('🔎 Searches');
  await world.sees(/Which searches/);
  assert.ok(!world.labels().includes('➕ Add'), 'the list everyone picks from does not change it');
  // The admin changes the list in ⚙️ Settings → 🛠 Admin → 🔎 Manage searches.
  world.say('/settings');
  await world.sees(/Tap what you want to change/);
  await world.tap('🛠 Admin');
  await world.sees(/<b>🛠 Admin<\/b>\nOnly you see this/);
  await world.tap('🔎 Manage searches');
  await world.sees(/<b>🔎 Searches for everyone<\/b>[^]*Search 1<\/a> · every 0\.1 s · 🌙 no night pause\n└ 1 person uses it/);
  await world.tap('➕ Add');
  await world.sees(/send a name and the address/);
  // Adding runs the search once, so the admin knows IS24 answers it.
  world.say('Hamburg https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten');
  await world.sees(/✅ <b>Hamburg<\/b> works: IS24 answered it\.\n\nIt has no listings right now/);
  await until('the new search', () => world.labels().includes('⚙️ Hamburg'));
  const tried = world.searchUrls.filter(hamburg).length;
  const before = world.searches;
  await until('more checks', () => world.searches > before + 3);
  assert.equal(world.searchUrls.filter(hamburg).length, tried, 'nobody picked it, so IS24 hears about it only for the check');

  world.say('/search');
  await world.sees(/💶 Warm rent/);
  await world.tap('🔎 Searches');
  await until('the list to pick from', () => world.labels().includes('⬜ Hamburg'));
  await world.tap('⬜ Hamburg');
  await until('both searches', () => world.searchUrls.some(hamburg));
  const counted = world.searches;
  await until('both searches again', () => world.searches > counted + 2);

  world.listing(800, 'In beiden', 'Hell.'); // The fake answers every search with every listing.
  world.listing(801, 'Viel zu teuer', 'Hell.', { rent: '1.600 €' });
  await world.sees(/^In beiden\n/);
  await wait(300);
  assert.equal(world.reads[800], 1);
  assert.equal(world.messages().filter(call => /^In beiden\n/.test(call.body.text)).length, 1);
  assert.equal(world.reads[801], undefined, 'a list price above the limit saves reading the listing');

  // Renaming keeps it picked.
  await world.tap('⚙️ Search 1');
  await world.sees(/<b>🔎 Search 1<\/b>\n[^]*1 person uses it/);
  await world.tap('✏️ Rename');
  await world.sees(/Send the new name for Search 1/);
  world.say('Berlin');
  await until('the new name', () => world.labels().includes('⚙️ Berlin'));
  const renamed = world.searches;
  await until('more checks', () => world.searches > renamed + 3);
  world.listing(802, 'Nach dem Umbenennen', 'Hell.');
  await world.sees(/^Nach dem Umbenennen\n/); // Still searched, and the rename did not start a new baseline.

  // A new link is tried once, like a new search; its name and the people who picked it stay.
  const pankow = url => url.includes('pankow');
  await world.tap('⚙️ Berlin');
  await world.tap('🔗 Change link');
  await world.sees(/Send the new address of the IS24 results page for Berlin/);
  world.say('https://www.immobilienscout24.de/Suche/de/berlin/berlin/pankow/wohnung-mieten');
  await world.sees(/✅ <b>Berlin<\/b> works: IS24 answered it/);
  await until('the new link', () => world.labels().includes('⚙️ Berlin'));
  const relinked = world.searchUrls.length;
  await until('checks of the new link', () => world.searchUrls.slice(relinked).filter(url => !hamburg(url)).length > 2);
  assert.ok(world.searchUrls.slice(relinked).filter(url => !hamburg(url)).every(pankow), 'only the new link is searched');

  // Each search runs on its own schedule.
  await world.tap('⚙️ Berlin');
  await world.sees(/<b>🔎 Berlin<\/b>[^]*⏱ Every 0\.1 s\n🌙 Night pause: off/);
  await world.tap('⏱ 0.1 s');
  await world.sees(/How often should I search Berlin/);
  assert.match(await world.tap('1 min'), /applies to everyone/);
  await until('the saved interval', () => world.labels().includes('⏱ 1 min'));
  const berlin = () => world.searchUrls.filter(url => !hamburg(url)).length;
  const [berlinBefore, hamburgBefore] = [berlin(), world.searchUrls.filter(hamburg).length];
  await until('more Hamburg checks', () => world.searchUrls.filter(hamburg).length > hamburgBefore + 5);
  assert.ok(berlin() <= berlinBefore + 1, 'Berlin waits for its minute while Hamburg keeps its pace');
  await world.tap('🌙 Off');
  await world.tap('20:00–08:00');
  await until('the saved night pause', () => world.labels().includes('🌙 20:00–08:00'));
  await world.tap('← Searches');
  await world.sees(/Berlin<\/a> · every 1 min · 🌙 20:00–08:00\n└ 1 person uses it\n.*Hamburg<\/a> · every 0\.1 s · 🌙 no night pause/);

  // Removing one tells whoever picked it, and the other keeps running.
  await world.tap('⚙️ Berlin');
  await world.tap('🗑 Remove');
  await world.sees(/Remove Berlin\?/);
  await world.tap('🗑 Yes, remove');
  await world.sees(/The search Berlin is no longer available/);
  assert.ok(!world.labels().includes('⚙️ Berlin') && world.labels().includes('⚙️ Hamburg'), 'the shorter list');
  const left = world.searchUrls.length;
  await until('more checks', () => world.searchUrls.length > left + 2);
  assert.ok(world.searchUrls.slice(left).every(hamburg), 'only what is left is searched');
});

test('two people on one bot: private by invite, one shared search, separate chats, accounts and listings', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  assert.ok(existsSync(join(world.dataDir, 'users', String(OWNER), 'agent.db')) && !existsSync(join(world.dataDir, 'agent.db')), 'a single-owner directory moved to its owner');

  // The bot stays private.
  world.say('/start', STRANGER);
  world.say('hello', STRANGER);
  world.say('/settings');
  await world.sees(/Tap what you want to change/);
  await world.tap('🛠 Admin');
  await world.tap('👥 People');
  await world.sees(/People on this agent/);
  assert.deepEqual(world.chat(STRANGER), [], 'strangers get no answer');
  await world.tap('➕ Invite');
  const code = (await world.seesIn(OWNER, /opens their own private chat/)).match(/t\.me\/e2e_bot\?start=(\S+)/)[1];

  // Someone invited joins and sets up their own search in their own chat.
  world.say(`/start ${code}`, FRIEND);
  await world.seesIn(FRIEND, /Hi! I am your apartment agent/);
  await world.seesIn(FRIEND, /Connect your ImmoScout24 account/);
  const state = from => fetch(`http://127.0.0.1:${world.port}/connect/state`, { headers: { 'x-init-data': world.signed(from) } });
  assert.equal((await (await state(FRIEND)).json()).step, 'form', 'their login is waiting');
  assert.equal((await (await state(OWNER)).json()).step, 'idle', 'it is not someone else\'s');
  assert.equal((await state(STRANGER)).status, 403, 'a valid signature from a stranger gets nothing');
  await world.connect('🔗 Connect ImmoScout24', 'connect', 'friend@example.com', 'correct', FRIEND);
  await world.seesIn(FRIEND, /Which searches/);
  assert.ok(!world.labels().includes('➕ Add') && !world.labels().includes('⚙️'), 'only the admin adds, renames and removes searches');
  assert.match(await world.press({ callback_data: 'x:sa' }, FRIEND), /outdated/);
  await world.tap('⬜ Search 1', FRIEND);
  await world.tap('Done', FRIEND);
  await world.seesIn(FRIEND, /What are you looking for/);
  const save = from => fetch(`http://127.0.0.1:${world.port}/form/save`, { method: 'POST', headers: { 'x-init-data': world.signed(from) }, body: JSON.stringify({ part: 'search', values: { preferences: 'Stranger' } }) });
  assert.equal((await save(STRANGER)).status, 403, 'a stranger cannot change anybody\'s settings');
  assert.equal((await world.fill('search', { rent: '800', rooms: '2', preferences: 'No cellar' }, FRIEND)).status, 204);
  await world.seesIn(FRIEND, /Now about you/);
  const { form } = await world.fill('profile', { 'persona.anrede': 'MALE', 'persona.nachname': 'Roe', 'persona.about': 'Nichtraucher.' }, FRIEND);
  assert.equal(form.fields.find(field => field.key === 'persona.vorname').value, 'Robin', 'their own account, not the admin\'s');
  await world.seesIn(FRIEND, /All set/);
  world.say('/settings', FRIEND);
  await until('their settings', () => world.chat(FRIEND).filter(text => /Tap what you want to change/.test(text)).length);
  const labels = world.labels();
  assert.ok(labels.includes('✍️ Agent\'s style'), 'these are the settings');
  assert.ok(!labels.includes('🛠 Admin') && !labels.some(label => /model/.test(label)), 'the shared searches, model, login and people stay with the admin');
  world.say('/status', FRIEND);
  await world.seesIn(FRIEND, /<b>Search 1<\/b> · every 0\.1 s · 🌙 no night pause/); // The search's, carried over from the admin's old settings.
  assert.ok(!world.chat(FRIEND).some(text => /Model:/.test(text)), 'the model is internal');
  await until('their first check', () => world.agentLog.includes(`[${FRIEND}] Poll complete`));

  // The model the admin picks is everyone's: it screens and writes for Robin too.
  world.say('/model');
  await world.sees(/🧠 Model<\/b>/);
  await world.tap('GPT E2E');
  await world.sees(/Thinking for GPT E2E/);
  await world.tap('high');

  // One listing for each kind of match. Between them they prove the search itself never narrowed.
  world.listing(300, 'Passt beiden', 'Hell.', { rent: '700 €' });
  world.listing(301, 'Zu teuer für Robin', 'Ruhig.');
  world.listing(302, 'Zu klein für Robin', 'Klein.', { rent: '700 €', rooms: '1' });
  world.listing(303, 'Ohne Warmmiete', 'Unklar beschrieben.', { rent: null });
  world.listing(304, 'Danach', 'Hell.', { rent: '700 €' });
  for (const title of ['Passt beiden', 'Zu teuer für Robin', 'Zu klein für Robin', 'Danach']) await world.seesIn(OWNER, new RegExp(title));
  await world.seesIn(FRIEND, /Passt beiden/);
  await world.seesIn(FRIEND, /Ohne Warmmiete/); // A fact the listing does not state is not a miss.
  await world.seesIn(FRIEND, /Danach/);
  await wait(300);
  const robin = world.chat(FRIEND).join('\n');
  assert.ok(!/Zu teuer für Robin|Zu klein für Robin/.test(robin), 'only their own matches reach them');
  assert.ok(!/alex@example|Alex/.test(robin), 'nothing of the other person reaches them');
  assert.equal(world.codexCalls().filter(({ input }) => input.preferences === 'No cellar' && /Zu (teuer|klein)/.test(input.listing.title)).length, 0, 'outside the hard filters, no ChatGPT call');
  assert.ok(world.searchUrls.every(url => url === world.searchUrls[0] && !/[?&](price|numberofrooms)=/.test(url)), 'one broad query for both');
  assert.deepEqual([world.reads[300], world.reads[304]], [1, 1], 'each listing is read once for both');
  world.never(/IS24 failed/); // A listing without a warm rent is that listing's problem, not an outage.
  assert.ok(world.kept().some(({ label }) => label === 'search-item-303'), 'the shared search saves what went wrong, too');

  const polls = () => world.agentLog.match(/Poll complete/g)?.length ?? 0;
  const before = [polls(), world.searches];
  await until('some more rounds', () => polls() >= before[0] + 20);
  assert.ok(world.searches - before[1] <= (polls() - before[0]) * 0.75, 'two people do not mean two searches a round');

  // Each applies from their own account, with their own details.
  await world.tap('✨ Write message', FRIEND);
  await world.seesIn(FRIEND, /Guten Tag, ich bin Robin\.$/);
  await world.tap('✅ Send', FRIEND);
  await world.seesIn(FRIEND, /✅ Message sent/);
  assert.deepEqual(world.contacts.map(({ authorization, form }) => [authorization, form.firstname, form.emailAddress]), [['Bearer connected-token', 'Robin', 'friend@example.com']]);
  assert.ok(!world.chat(OWNER).some(text => /Guten Tag, ich bin Robin|Message sent/.test(text)), 'their draft and outcome stay in their chat');
  const robins = world.codexCalls().filter(({ input }) => input.preferences === 'No cellar');
  assert.ok(robins.some(({ input }) => input.task === 'screen') && robins.some(({ input }) => input.task === 'write'));
  assert.ok(robins.every(({ args }) => args.includes('gpt-e2e') && args.includes('model_reasoning_effort="high"')), 'the admin\'s model screens and writes for them');

  // Removing someone ends it for them, for good, and keeps their folder.
  world.say('/users');
  await world.sees(/🗑|People on this agent/);
  await until('the remove button', () => world.labels().some(label => label.startsWith('🗑')));
  await world.tap(world.labels().find(label => label.startsWith('🗑')));
  await world.sees(/<b>Remove <code>/);
  await world.tap('🗑 Yes, remove');
  await world.seesIn(FRIEND, /access to this apartment agent has ended/);
  const sent = world.chat(FRIEND).length;
  world.say('/status', FRIEND);
  await wait(200);
  assert.equal(world.chat(FRIEND).length, sent, 'ignored like any stranger');
  await until('the kept folder', () => readdirSync(join(world.dataDir, 'users')).some(name => name.startsWith(`removed-${FRIEND}-`)));
});
