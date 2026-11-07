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
  await world.sees(/Hallo! Ich bin dein Wohnungsagent/);
  await world.connect('🔗 ImmoScout24 verbinden', 'connect', 'Alex@Example.com', 'correct');
  await world.sees(/Mit ImmoScout24 verbunden als alex@example\.com/);
  for (const [question, answer] of [
    [/Aus welchen Suchen/, () => world.tap('➕ Hinzufügen')],
    [/sende dann einen Namen und die Adresse/, async () => {
      world.say('no link');
      await world.sees(/Bitte sende einen Namen/);
      world.say('Berlin https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen');
      await world.sees(/Nur Suchen nach Mietwohnungen/);
      world.say(`Berlin ${SEARCH_URL}`);
      await until('the new search', () => world.labels().includes('⬜ Berlin'));
      assert.match(await world.tap('Fertig'), /mindestens eine/);
      await world.tap('⬜ Berlin');
      await world.tap('Fertig');
    }],
    [/Was suchst du/, async () => {
      assert.match((await world.fill('search', { rent: 'cheap', preferences: 'No swap' })).error, /^Warmmiete in €: Bitte gib die Miete als Zahlen an/);
      assert.match((await world.fill('search', { rent: '1500' })).error, /^AI-Filter: bitte ausfüllen/, 'nothing was saved');
      // Requests the page cannot make, as a forged one would: refused, and nothing is saved.
      for (const [values, error] of [[{ admin: true }, /veraltet/], [{ rooms: 3 }, /^Zimmer: dieser Wert ist nicht erlaubt/],
        [{ preferences: 'No swap\u202E' }, /unsichtbare Zeichen oder Steuerzeichen/], [{ rent: '50000' }, /zwischen 0 und 20000/]]) {
        assert.match((await world.fill('search', { rent: '1500', preferences: 'No swap', ...values })).error, error);
      }
      assert.equal((await world.fill('search', { rent: '1500', preferences: 'No swap' })).status, 204);
    }],
    [/Jetzt zu dir/, async () => {
      const contact = { 'persona.anrede': 'FEMALE', 'persona.telefon': '+49 170 1234567', address: 'Musterstraße', 'persona.plz': '10115', 'persona.ort': 'Berlin', 'persona.about': 'Nichtraucher.' };
      const { form, error } = await world.fill('profile', contact);
      assert.deepEqual(form.fields.filter(field => field.prefilled).map(field => [field.key, field.value]), [['persona.vorname', 'Alex'], ['persona.nachname', 'Doe']], 'the name comes from the IS24 account');
      assert.match(error, /^Straße und Hausnummer: Bitte schreib erst die Straße, dann die Hausnummer/);
      assert.equal((await world.fill('profile', { ...contact, address: 'Straße des 17. Juni 12a' })).status, 204);
    }],
  ]) { await world.sees(question); await answer(); }
  await world.sees(/Alles eingerichtet/);
  await world.sees(/1 Inserat ist schon online/);

  world.listing(200, 'Sonnige Wohnung', 'Balkon, ruhig.');
  await world.sees(/Sonnige Wohnung\n📍 Teststraße 1, 10115 Berlin/);
  await world.tap('✨ Schreiben');
  await world.sees(/Guten Tag, ich bin Alex\.$/);
  assert.deepEqual(world.button('📋 Kopieren').copy_text, { text: 'Guten Tag, ich bin Alex.' }, 'a short draft copies with one tap');
  const firstSend = world.button('✅ Senden');
  await world.tap('✏️ Umschreiben');
  await world.sees(/Wie soll ich ihn umschreiben/);
  world.say('Einzug ab März.');
  await world.sees(/Guten Tag, ich bin Alex\. Einzug ab März\./);
  assert.match(await world.press(firstSend), /neuerer Entwurf/, 'the replaced draft cannot be approved');
  assert.equal(world.contacts.length, 0);

  await world.tap('✅ Senden');
  await world.sees(/✅ Nachricht gesendet/);
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
  await world.tap('✨ Schreiben');
  await world.sees(/Guten Tag, ich bin Alex\.$/);
  await world.tap('📝 Eigener Text');
  await world.sees(/genau so, wie sie rausgehen soll/);
  const long = `Guten Tag, ${'ich möchte die Wohnung gerne besichtigen. '.repeat(10)}`.trim();
  world.say(long);
  await world.sees(new RegExp(`${long.slice(-40).replace(/[.]/g, '\\.')}$`));
  assert.match(await world.tap('📋 Kopieren'), /Tippe auf den Code-Block/);
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
  await world.sees(/🟢 Suche läuft/);
  await world.tap('⚙️ Einstellungen');
  await world.sees(/Tippe auf das, was du ändern möchtest/);
  await world.tap('🔍 Suche');
  await world.sees(/<b>🎯 AI-Filter<\/b>\n<blockquote expandable>No swap<\/blockquote>/);
  assert.deepEqual(world.labels(), ['🔎 Suchen', '✏️ Bearbeiten', '← Einstellungen']);
  const { form } = await world.fill('search', { preferences: 'No swap\nNo ground floor' });
  assert.deepEqual(form.fields.map(field => [field.key, field.value]), [['rent', '-1500'], ['rooms', ''], ['area', ''], ['preferences', 'No swap']], 'the form opens with what is set');
  await world.sees(/<blockquote expandable>No swap\nNo ground floor<\/blockquote>/);
  world.say('/settings');
  await world.tap('✍️ Schreibstil');
  await world.sees(/✍️ Schreibstil<\/b>[^]*Noch keiner/);
  const style = await world.fill('style', { style: 'Kurz & formell.', 'style.example': 'Viele Grüße\nAlex' });
  assert.deepEqual(style.form.fields.map(field => field.key), ['style', 'style.example'], 'one style text and one example');
  await world.sees(/<blockquote expandable>Kurz &amp; formell\.<\/blockquote>\nBeispielnachricht:\n<blockquote expandable>Viele Grüße\nAlex<\/blockquote>/);

  world.say('hello?'); // Anything the bot cannot act on opens the settings.
  await until('new settings buttons', () => world.messages().filter(call => /Tippe auf das, was du ändern möchtest/.test(call.body.text)).length === 2);
  assert.match(await world.tap('📤 Auto-Senden: aus'), /Auto-Senden an/); // Switches at once, in place.
  await world.sees(/📤 Auto-Senden ist <b>an<\/b>/);
  // The admin picks the one model that screens and writes for everyone.
  const menu = world.button('🛠 Admin').messageId;
  await world.tap('🛠 Admin');
  await world.tap('🧠 Modell');
  await world.sees(/🧠 Modell<\/b>\nLiest für alle bei diesem Agenten jedes neue Inserat/);
  assert.ok(!world.labels().includes('GPT E1E'), 'only the newest model of each family is offered');
  await world.tap('GPT E2E');
  await world.sees(/Denken für GPT E2E/);
  assert.match(await world.tap('high'), /GPT E2E · Denken high\. Prüft und schreibt ab jetzt für alle/);
  await until('the picked model', () => world.labels().includes('✓ GPT E2E'));
  // Every menu leads back up, in the same message: Model → Admin → Settings, the root.
  await world.tap('← Admin');
  await world.tap('← Einstellungen');
  await until('the settings in place of the menu', () => world.telegram.some(call => call.method === 'editMessageText' && call.body.message_id === menu
    && /Tippe auf das, was du ändern möchtest/.test(call.body.text)));
  assert.ok(!world.labels().includes('← Status'), '/settings is a root: nothing above it');
  await world.tap('✖️ Schließen'); // A root closes instead.
  await until('the menu to be deleted', () => world.telegram.some(call => call.method === 'deleteMessage' && call.body.message_id === menu));
  world.say('/status');
  await world.sees(/🧠 Modell: gpt-e2e · Denken high\n/);

  world.listing(301, 'Parterre', 'Wohnung im Ground Floor.');
  world.listing(302, 'Klar passend', 'Balkon, ruhig.');
  world.listing(303, 'Vielleicht', 'Etage unclear.');
  await world.sees(/✅ Nachricht gesendet \(Auto-Senden\)/);
  await world.sees(/^Vielleicht\n/);
  await until('the reviews of all three', () => world.codexCalls().length >= 4);
  assert.deepEqual(world.contacts.map(contact => contact.id), ['302'], 'only the clear match goes out by itself');
  world.never(/^Parterre/);
  const calls = world.codexCalls();
  assert.ok(calls.some(({ input }) => input.task === 'write'), 'the clear match was written');
  assert.ok(calls.every(({ args, input }) => args.includes('gpt-e2e') && args.includes('model_reasoning_effort="high"')), 'screening and writing with the one model');
  assert.ok(calls.every(({ input }) => input.preferences === 'No swap\nNo ground floor' && JSON.stringify(input.writingStyle) === JSON.stringify({ instructions: 'Kurz & formell.', example: 'Viele Grüße\nAlex' })));

  const card = world.button('✖️ Verwerfen');
  assert.match(await world.press(card), /Verworfen/);
  await until('the card to disappear', () => world.telegram.some(call => call.method === 'deleteMessage' && call.body.message_id === card.messageId));
  world.say('/status');
  await world.sees(/Passt nicht: 2/);
  await world.tap('⏸ Pausieren');
  await world.sees(/⏸ Pausiert/);
  await wait(300);
  const searches = world.searches;
  await wait(400);
  assert.equal(world.searches, searches, 'paused: no searching');
  world.listing(304, 'Während der Pause', 'Etage unclear.');
  await world.tap('▶️ Fortsetzen');
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
  await world.sees(/Tippe auf das, was du ändern möchtest/);
  await world.tap('🔗 Immomio');
  await world.connect('🔗 Immomio verbinden', 'immomio', 'alex@immomio.test', 'correct');
  await world.sees(/Mit Immomio verbunden als alex@immomio\.test/);

  world.listing(400, 'Immomio Wohnung', `Bewerbung nur über https://tenant.immomio.com/apply/${IMMOMIO_ID.toUpperCase()}, unclear.`);
  await world.sees(/^Immomio Wohnung\n[\s\S]*🏢 Bewerbung über Immomio/);
  await world.tap('✨ Schreiben');
  await until('the draft', () => world.labels().includes('✅ Bewerben'));
  await world.tap('✅ Bewerben');
  const { body: applied } = await world.sees(/✅ Bei Immomio beworben/);
  assert.match(applied.text, /Deine Nachricht ging im Immomio-Messenger an den Vermieter/);
  // A clear match is applied by itself, with a written message.
  world.listing(401, 'Immomio klar', 'Bewerbung über tenant.immomio.com/de/apply/p8FkQ2 bitte.');
  await world.sees(/✅ Bei Immomio beworben \(Auto-Senden\)/);
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
  await world.connect('🔗 Immomio verbinden', 'immomio', 'alex@immomio.test', 'correct');

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
  assert.match(await world.press(world.button('↩️ Antworten')), /Antworte auf die Frage/);
  const { result: prompt } = await world.sees(/^↩️ Deine Antwort an Altbau Mitte bei Immomio/);
  world.reply('Ja, ich komme gern.', prompt.message_id);
  await world.sees(/✅ Bei Immomio an Altbau Mitte gesendet/);
  // Replying to the forwarded message itself works too.
  world.reply('Montag passt.', forwarded.result.message_id);
  await world.sees(/✅ Bei Immomio an Wohnung Kreuzberg gesendet/);
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
  await world.sees(/✅ Nachricht gesendet \(Auto-Senden\)/);
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
  world.never(/Fehler in Folge/);

  incomplete.published = 'vor 4 Minuten'; // A new body each poll; known listings are not saved again.
  const searches = world.searches;
  await until('more searches', () => world.searches > searches + 3);
  assert.deepEqual(stored(), labels);

  await world.press({ ...card.reply_markup.inline_keyboard.flat().find(button => button.text === '✨ Schreiben'), messageId: (world.messages().find(call => call.body === card)).result.message_id });
  await until('the draft', () => world.labels().includes('✅ Senden'));
  await world.tap('✅ Senden');
  await until('the contact request', () => world.contacts.length === 2);
  assert.equal(world.contacts[1].id, '600', 'the check before sending accepts the gap the owner approved');
  await until('the sent report', () => world.messages().filter(call => /✅ Nachricht gesendet/.test(call.body.text)).length === 2);
  assert.deepEqual(stored(), labels, 'fetching the same response again stores nothing new');
});

test('a rent that appears after approval stops the send', async t => {
  const world = await createWorld(t);
  world.seed();
  await world.start();
  await until('the first search', () => world.searches > 0);
  const listing = world.listing(610, 'Miete folgt', 'Balkon, ruhig.', { rent: null });
  await world.sees(/^Miete folgt\n/);
  await world.tap('✨ Schreiben');
  await world.sees(/Guten Tag, ich bin Alex\./);
  listing.rent = '1.900 €';
  await world.tap('✅ Senden');
  await world.sees(/deine Freigabe ist ungültig/);
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
  assert.deepEqual(card.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [['◀️', '1/3', '▶️'], ['✨ Schreiben', '✖️ Verwerfen']]);
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

  await world.tap('✨ Schreiben');
  const kept = await until('the card without its decision buttons', () => world.telegram.findLast(call => call.method === 'editMessageReplyMarkup' && call.body.message_id === messageId));
  assert.deepEqual(kept.body.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [['◀️', '3/3', '▶️']], 'the photos stay browsable');
  assert.equal(photo(await browse('▶️')), 'a');
  await world.sees(/Guten Tag, ich bin Alex\./);

  world.listing(621, 'Ein Foto', 'Balkon, ruhig.', { photos: ['e'] });
  const { body: lone } = await world.sees(/^Ein Foto\n/);
  assert.equal(photo(lone), 'e');
  assert.deepEqual(lone.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [['✨ Schreiben', '✖️ Verwerfen']], 'one photo, no carousel');
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
  assert.deepEqual([saved('expose-700')[0].problem, saved('expose-700')[0].body], ['IS24 nicht erreichbar (HTTP 503)', maintenance]);
  delete world.respond.expose[700];
  await world.sees(/^Wartung\n/); // The listing survives the outage.

  world.respond.search = { status: 429, type: 'text/plain', body: 'Zu viele Anfragen' };
  await until('the blocked search to be saved', () => saved('search-list').length === 1);
  assert.equal(saved('search-list')[0].problem, 'IS24 blockiert den Zugriff (HTTP 429)');
  world.respond.search = null;
  assert.match(world.agentLog, /health_error: IS24 failure/);

  world.respond.expose[701] = { status: 404, body: '{}' };
  world.listing(701, 'Offline', 'Balkon, ruhig.');
  await until('the offline listing to be noticed', () => world.agentLog.includes('Inserat ist nicht mehr verfügbar'));
  assert.deepEqual(saved('expose-701'), [], 'a listing going offline is routine');

  world.respond.contact = { status: 400, body: JSON.stringify({ message: 'abgelehnt' }) };
  world.listing(702, 'Abgelehnt', 'Balkon, ruhig, unclear.');
  await world.sees(/^Abgelehnt\n/);
  await world.tap('✨ Schreiben');
  await until('the draft', () => world.labels().includes('✅ Senden'));
  await world.tap('✅ Senden');
  await world.sees(/❌ Nachricht nicht gesendet\n\nAbgelehnt\n[^]*IS24 hat die Anfrage abgelehnt \(HTTP 400: \{"message":"abgelehnt"\}\)/);
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
  await world.sees(/💶 Warmmiete: bis 1500 €/); // ...and the rent became a limit.
  await world.tap('🔎 Suchen');
  await world.sees(/Aus welchen Suchen/);
  assert.ok(!world.labels().includes('➕ Hinzufügen'), 'the list everyone picks from does not change it');
  // The admin changes the list in ⚙️ Settings → 🛠 Admin → 🔎 Manage searches.
  world.say('/settings');
  await world.sees(/Tippe auf das, was du ändern möchtest/);
  await world.tap('🛠 Admin');
  await world.sees(/<b>🛠 Admin<\/b>\nNur du siehst das/);
  await world.tap('🔎 Suchen verwalten');
  await world.sees(/<b>🔎 Suchen für alle<\/b>[^]*Search 1<\/a> · alle 0\.1 Sek\. · 🌙 keine Nachtpause\n└ 1 Person nutzt sie/);
  await world.tap('➕ Hinzufügen');
  await world.sees(/sende dann einen Namen und die Adresse/);
  // Adding runs the search once, so the admin knows IS24 answers it.
  world.say('Hamburg https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten');
  await world.sees(/✅ <b>Hamburg<\/b> funktioniert: IS24 hat geantwortet\.\n\nGerade gibt es keine Inserate/);
  await until('the new search', () => world.labels().includes('⚙️ Hamburg'));
  const tried = world.searchUrls.filter(hamburg).length;
  const before = world.searches;
  await until('more checks', () => world.searches > before + 3);
  assert.equal(world.searchUrls.filter(hamburg).length, tried, 'nobody picked it, so IS24 hears about it only for the check');

  world.say('/search');
  await world.sees(/💶 Warmmiete/);
  await world.tap('🔎 Suchen');
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
  await world.sees(/<b>🔎 Search 1<\/b>\n[^]*1 Person nutzt sie/);
  await world.tap('✏️ Umbenennen');
  await world.sees(/Sende den neuen Namen für Search 1/);
  world.say('Berlin');
  await until('the new name', () => world.labels().includes('⚙️ Berlin'));
  const renamed = world.searches;
  await until('more checks', () => world.searches > renamed + 3);
  world.listing(802, 'Nach dem Umbenennen', 'Hell.');
  await world.sees(/^Nach dem Umbenennen\n/); // Still searched, and the rename did not start a new baseline.

  // A new link is tried once, like a new search; its name and the people who picked it stay.
  const pankow = url => url.includes('pankow');
  await world.tap('⚙️ Berlin');
  await world.tap('🔗 Link ändern');
  await world.sees(/Sende die neue Adresse der IS24-Ergebnisseite für Berlin/);
  world.say('https://www.immobilienscout24.de/Suche/de/berlin/berlin/pankow/wohnung-mieten');
  await world.sees(/✅ <b>Berlin<\/b> funktioniert: IS24 hat geantwortet/);
  await until('the new link', () => world.labels().includes('⚙️ Berlin'));
  const relinked = world.searchUrls.length;
  await until('checks of the new link', () => world.searchUrls.slice(relinked).filter(url => !hamburg(url)).length > 2);
  assert.ok(world.searchUrls.slice(relinked).filter(url => !hamburg(url)).every(pankow), 'only the new link is searched');

  // Each search runs on its own schedule.
  await world.tap('⚙️ Berlin');
  await world.sees(/<b>🔎 Berlin<\/b>[^]*⏱ Alle 0\.1 Sek\.\n🌙 Nachtpause: aus/);
  await world.tap('⏱ 0.1 Sek.');
  await world.sees(/Wie oft soll ich Berlin durchsuchen/);
  assert.match(await world.tap('alle 1 Min.'), /Gilt für alle/);
  await until('the saved interval', () => world.labels().includes('⏱ 1 Min.'));
  const berlin = () => world.searchUrls.filter(url => !hamburg(url)).length;
  const [berlinBefore, hamburgBefore] = [berlin(), world.searchUrls.filter(hamburg).length];
  await until('more Hamburg checks', () => world.searchUrls.filter(hamburg).length > hamburgBefore + 5);
  assert.ok(berlin() <= berlinBefore + 1, 'Berlin waits for its minute while Hamburg keeps its pace');
  await world.tap('🌙 Aus');
  await world.tap('20:00–08:00');
  await until('the saved night pause', () => world.labels().includes('🌙 20:00–08:00'));
  await world.tap('← Suchen');
  await world.sees(/Berlin<\/a> · alle 1 Min\. · 🌙 20:00–08:00\n└ 1 Person nutzt sie\n.*Hamburg<\/a> · alle 0\.1 Sek\. · 🌙 keine Nachtpause/);

  // Removing one tells whoever picked it, and the other keeps running.
  await world.tap('⚙️ Berlin');
  await world.tap('🗑 Entfernen');
  await world.sees(/Berlin entfernen\?/);
  await world.tap('🗑 Ja, entfernen');
  await world.sees(/Die Suche Berlin gibt es nicht mehr/);
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
  await world.sees(/Tippe auf das, was du ändern möchtest/);
  await world.tap('🛠 Admin');
  await world.tap('👥 Personen');
  await world.sees(/Personen bei diesem Agenten/);
  assert.deepEqual(world.chat(STRANGER), [], 'strangers get no answer');
  await world.tap('➕ Einladen');
  const code = (await world.seesIn(OWNER, /öffnet ihren eigenen privaten Chat/)).match(/t\.me\/e2e_bot\?start=(\S+)/)[1];

  // Someone invited joins and sets up their own search in their own chat.
  world.say(`/start ${code}`, FRIEND);
  await world.seesIn(FRIEND, /Hallo! Ich bin dein Wohnungsagent/);
  await world.seesIn(FRIEND, /Verbinde dein ImmoScout24-Konto/);
  const state = from => fetch(`http://127.0.0.1:${world.port}/connect/state`, { headers: { 'x-init-data': world.signed(from) } });
  assert.equal((await (await state(FRIEND)).json()).step, 'form', 'their login is waiting');
  assert.equal((await (await state(OWNER)).json()).step, 'idle', 'it is not someone else\'s');
  assert.equal((await state(STRANGER)).status, 403, 'a valid signature from a stranger gets nothing');
  await world.connect('🔗 ImmoScout24 verbinden', 'connect', 'friend@example.com', 'correct', FRIEND);
  await world.seesIn(FRIEND, /Aus welchen Suchen/);
  assert.ok(!world.labels().includes('➕ Hinzufügen') && !world.labels().includes('⚙️'), 'only the admin adds, renames and removes searches');
  assert.match(await world.press({ callback_data: 'x:sa' }, FRIEND), /veraltet/);
  await world.tap('⬜ Search 1', FRIEND);
  await world.tap('Fertig', FRIEND);
  await world.seesIn(FRIEND, /Was suchst du/);
  const save = from => fetch(`http://127.0.0.1:${world.port}/form/save`, { method: 'POST', headers: { 'x-init-data': world.signed(from) }, body: JSON.stringify({ part: 'search', values: { preferences: 'Stranger' } }) });
  assert.equal((await save(STRANGER)).status, 403, 'a stranger cannot change anybody\'s settings');
  assert.equal((await world.fill('search', { rent: '800', rooms: '2', preferences: 'No cellar' }, FRIEND)).status, 204);
  await world.seesIn(FRIEND, /Jetzt zu dir/);
  const { form } = await world.fill('profile', { 'persona.anrede': 'MALE', 'persona.nachname': 'Roe', 'persona.about': 'Nichtraucher.' }, FRIEND);
  assert.equal(form.fields.find(field => field.key === 'persona.vorname').value, 'Robin', 'their own account, not the admin\'s');
  await world.seesIn(FRIEND, /Alles eingerichtet/);
  world.say('/settings', FRIEND);
  await until('their settings', () => world.chat(FRIEND).filter(text => /Tippe auf das, was du ändern möchtest/.test(text)).length);
  const labels = world.labels();
  assert.ok(labels.includes('✍️ Schreibstil'), 'these are the settings');
  assert.ok(!labels.includes('🛠 Admin') && !labels.some(label => /modell/i.test(label)), 'the shared searches, model, login and people stay with the admin');
  world.say('/status', FRIEND);
  await world.seesIn(FRIEND, /<b>Search 1<\/b> · alle 0\.1 Sek\. · 🌙 keine Nachtpause/); // The search's, carried over from the admin's old settings.
  assert.ok(!world.chat(FRIEND).some(text => /Modell:/.test(text)), 'the model is internal');
  await until('their first check', () => world.agentLog.includes(`[${FRIEND}] Poll complete`));

  // The model the admin picks is everyone's: it screens and writes for Robin too.
  world.say('/model');
  await world.sees(/🧠 Modell<\/b>/);
  await world.tap('GPT E2E');
  await world.sees(/Denken für GPT E2E/);
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
  world.never(/Fehler in Folge/); // A listing without a warm rent is that listing's problem, not an outage.
  assert.ok(world.kept().some(({ label }) => label === 'search-item-303'), 'the shared search saves what went wrong, too');

  const polls = () => world.agentLog.match(/Poll complete/g)?.length ?? 0;
  const before = [polls(), world.searches];
  await until('some more rounds', () => polls() >= before[0] + 20);
  assert.ok(world.searches - before[1] <= (polls() - before[0]) * 0.75, 'two people do not mean two searches a round');

  // Each applies from their own account, with their own details.
  await world.tap('✨ Schreiben', FRIEND);
  await world.seesIn(FRIEND, /Guten Tag, ich bin Robin\.$/);
  await world.tap('✅ Senden', FRIEND);
  await world.seesIn(FRIEND, /✅ Nachricht gesendet/);
  assert.deepEqual(world.contacts.map(({ authorization, form }) => [authorization, form.firstname, form.emailAddress]), [['Bearer connected-token', 'Robin', 'friend@example.com']]);
  assert.ok(!world.chat(OWNER).some(text => /Guten Tag, ich bin Robin|Nachricht gesendet/.test(text)), 'their draft and outcome stay in their chat');
  const robins = world.codexCalls().filter(({ input }) => input.preferences === 'No cellar');
  assert.ok(robins.some(({ input }) => input.task === 'screen') && robins.some(({ input }) => input.task === 'write'));
  assert.ok(robins.every(({ args }) => args.includes('gpt-e2e') && args.includes('model_reasoning_effort="high"')), 'the admin\'s model screens and writes for them');

  // Removing someone ends it for them, for good, and keeps their folder.
  world.say('/users');
  await world.sees(/🗑|Personen bei diesem Agenten/);
  await until('the remove button', () => world.labels().some(label => label.startsWith('🗑')));
  await world.tap(world.labels().find(label => label.startsWith('🗑')));
  await world.sees(/<b><code>[^<]*<\/code> entfernen\?/);
  await world.tap('🗑 Ja, entfernen');
  await world.seesIn(FRIEND, /Zugang zu diesem Wohnungsagenten wurde beendet/);
  const sent = world.chat(FRIEND).length;
  world.say('/status', FRIEND);
  await wait(200);
  assert.equal(world.chat(FRIEND).length, sent, 'ignored like any stranger');
  await until('the kept folder', () => readdirSync(join(world.dataDir, 'users')).some(name => name.startsWith(`removed-${FRIEND}-`)));
});
