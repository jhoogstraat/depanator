import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, FRIEND, OWNER, SEARCH_URL, STRANGER, until, wait } from './support/world.js';

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
  assert.deepEqual(form.address, { street: 'Straße des 17. Juni', houseNumber: '12a', postcode: '10115', city: 'Berlin' });
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
  await world.sees(/<b>🎯 Requirements<\/b>\n<blockquote expandable>No swap<\/blockquote>/);
  assert.deepEqual(world.labels(), ['🔎 Searches', '✏️ Edit']);
  const { form } = await world.fill('search', { preferences: 'No swap\nNo ground floor' });
  assert.deepEqual(form.fields.map(field => [field.key, field.value]), [['rent', '-1500'], ['rooms', ''], ['area', ''], ['preferences', 'No swap']], 'the form opens with what is set');
  await world.sees(/<blockquote expandable>No swap\nNo ground floor<\/blockquote>/);
  world.say('/settings');
  await world.tap('✍️ Agent\'s style');
  await world.sees(/The agent's writing style<\/b>[^]*None yet/);
  await world.fill('style', { style: 'Kurz & formell.' });
  await world.sees(/<blockquote expandable>Kurz &amp; formell\.<\/blockquote>/);

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
  assert.ok(world.codexCalls().every(({ args, input }) => args.includes('gpt-e2e') && args.includes('model_reasoning_effort="high"') && input.preferences === 'No swap\nNo ground floor' && input.writingStyle === 'Kurz & formell.'));

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
  world.listing(501, 'Während des Neustarts', 'Balkon, ruhig, unclear.');

  await world.start();
  await world.sees(/^Während des Neustarts\n/); // Like after a night pause: what came while it was down is new.
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
  await world.tap('➕ Add');
  await world.sees(/send a name and the address/);
  world.say('Hamburg https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten');
  await until('the new search', () => world.labels().includes('⬜ Hamburg'));
  const before = world.searches;
  await until('more checks', () => world.searches > before + 3);
  assert.ok(!world.searchUrls.some(hamburg), 'nobody picked it, so IS24 never hears about it');

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
  await world.tap('⚙️');
  await world.sees(/<b>🔎 Search 1<\/b>\n[^]*1 person uses it/);
  await world.tap('✏️ Rename');
  await world.sees(/Send the new name for Search 1/);
  world.say('Hamburg');
  await world.sees(/already is a search named Hamburg/);
  world.say('Berlin');
  await until('the new name', () => world.labels().includes('✅ Berlin'));
  const renamed = world.searches;
  await until('more checks', () => world.searches > renamed + 3);
  world.listing(802, 'Nach dem Umbenennen', 'Hell.');
  await world.sees(/^Nach dem Umbenennen\n/); // Still searched, and the rename did not start a new baseline.

  // Each search runs on its own schedule.
  await world.tap('⚙️');
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
  await world.tap('← Back');
  await world.sees(/Berlin<\/a>: every 1 min · 🌙 20:00–08:00\n.*Hamburg<\/a>: every 0\.1 s · 🌙 no night pause/);

  // Removing one tells whoever picked it, and the other keeps running. The last one stays.
  await world.tap('⚙️');
  await world.tap('🗑 Remove');
  await world.sees(/Remove Berlin\?/);
  await world.tap('🗑 Yes, remove');
  await world.sees(/The search Berlin is no longer available/);
  await until('the shorter list', () => !world.labels().includes('✅ Berlin') && world.labels().includes('✅ Hamburg'));
  await world.tap('⚙️');
  await world.tap('🗑 Remove');
  await world.sees(/Remove Hamburg\?/);
  assert.match(await world.tap('🗑 Yes, remove'), /last search/);
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
  await world.tap('👥 People');
  await world.sees(/People on this agent/);
  assert.deepEqual(world.chat(STRANGER), [], 'strangers get no answer');
  await world.tap('➕ Invite');
  const code = (await world.seesIn(OWNER, /opens their own private chat/)).match(/t\.me\/e2e_bot\?start=(\S+)/)[1];
  world.updates.push({ update_id: world.nextUpdate++, message: { message_id: world.nextMessage++, text: `/start ${code}`, chat: { id: -9, type: 'group' }, from: { id: STRANGER } } });
  await wait(100);
  assert.deepEqual(world.chat(-9), [], 'an invite does not work in a group');

  // Someone invited joins and sets up their own search in their own chat.
  world.say(`/start ${code}`, FRIEND);
  await world.seesIn(FRIEND, /Hi! I am your apartment agent/);
  world.say(`/start ${code}`, STRANGER);
  await world.seesIn(STRANGER, /not valid any more/);
  await world.seesIn(FRIEND, /Connect your ImmoScout24 account/);
  const state = from => fetch(`http://127.0.0.1:${world.port}/connect/state`, { headers: { 'x-init-data': world.signed(from) } });
  assert.equal((await (await state(FRIEND)).json()).step, 'form', 'their login is waiting');
  assert.equal((await (await state(OWNER)).json()).step, 'idle', 'it is not someone else\'s');
  assert.equal((await state(STRANGER)).status, 403, 'a valid signature from a stranger gets nothing');
  await world.connect('🔗 Connect ImmoScout24', 'connect', 'friend@example.com', 'correct', FRIEND);
  await world.seesIn(FRIEND, /Which searches/);
  assert.ok(!world.labels().includes('➕ Add') && !world.labels().includes('⚙️'), 'only the admin adds, renames and removes searches');
  assert.match(await world.press({ callback_data: 'x:sa' }, FRIEND), /outdated/);
  assert.match(await world.press({ callback_data: 'x:sn:0:x' }, FRIEND), /outdated/);
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
  assert.ok(!labels.includes('👥 People') && !labels.includes('🔗 ChatGPT'), 'the shared login and people stay with the admin');
  assert.match(await world.press({ callback_data: 'x:si:0:x:0' }, FRIEND), /outdated/, 'only the admin sets how often a search runs');
  world.say('/status', FRIEND);
  await world.seesIn(FRIEND, /🔎 Search 1: every 0\.1 s · 🌙 no night pause/); // The search's, carried over from the admin's old settings.
  await until('their first check', () => world.agentLog.includes(`[${FRIEND}] Poll complete`));

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
  await world.tap('✍️ Write message', FRIEND);
  await world.seesIn(FRIEND, /Guten Tag, ich bin Robin\.$/);
  await world.tap('✅ Send', FRIEND);
  await world.seesIn(FRIEND, /✅ Message sent/);
  assert.deepEqual(world.contacts.map(({ authorization, form }) => [authorization, form.firstname, form.emailAddress]), [['Bearer connected-token', 'Robin', 'friend@example.com']]);
  assert.ok(!world.chat(OWNER).some(text => /Guten Tag, ich bin Robin|Message sent/.test(text)), 'their draft and outcome stay in their chat');

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

  await world.kill();
  await world.start();
  world.say('/status', FRIEND);
  world.say('/status');
  await until('a new status', () => world.chat(OWNER).filter(text => /🟢 Searching/.test(text)).length > 0);
  assert.equal(world.chat(FRIEND).length, sent, 'still removed after a restart');
});
