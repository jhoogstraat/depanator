import { createHash } from 'node:crypto';
import { compactId } from './review.js';
import { INTERVALS, NIGHT_PAUSES, STYLE_SECTIONS, TIME_ZONE, every, nightPause } from './settings.js';

// The Telegram menu (☰ next to the message field): two entry points, everything else is a button in the chat.
// Hidden but still working: /start, /setup, /search, /pause, /prompt, /autosend, /connect, /immomio, /login. Admin only: /users, /model.
export const COMMANDS = [
  ['status', 'Overview: search now, waiting and sent'],
  ['settings', 'Search, about you, writing style, connections'],
];
export const MENU_HINT = 'Send /status to see what I am doing, /settings to change anything.';

// Buttons name an option by index plus a short fingerprint, so a stale button never picks a different option.
export const fingerprint = label => createHash('sha256').update(String(label)).digest('base64url').slice(0, 4);
const rows = (buttons, perRow) => Array.from({ length: Math.ceil(buttons.length / perRow) }, (_, index) => buttons.slice(index * perRow, index * perRow + perRow));
// Telegram cuts a label that is wider than its share of the row. An emoji counts double.
// ponytail: 32 characters across a small phone, measured by eye; adjust if labels still get cut.
export const ROW_WIDTH = 32;
export const width = text => [...new Intl.Segmenter().segment(text)].reduce((sum, { segment }) => sum + (/\p{Extended_Pictographic}/u.test(segment) ? 2 : 1), 0);
// As many buttons per row (up to `most`) as fit without cutting any label.
export function fit(buttons, most = 3) {
  let perRow = most;
  while (perRow > 1 && buttons.some(button => width(button.text) > ROW_WIDTH / perRow)) perRow--;
  return rows(buttons, perRow);
}
// Every view is HTML; anything not written here (listing titles, your texts) goes through esc().
const esc = value => String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const html = (text, buttons) => ({ text, extra: { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: buttons } } });
// The menus are one tree, each shown in place of the last: ⚙️ Settings and 📬 📨 hang below /status, every view below them.
// A view's last row leads one level up.
const back = (to, text = '← Back') => [{ text, callback_data: `x:${to}` }];
const BACK = { status: back('status', '← Status'), settings: back('settings', '← Settings'), admin: back('admin', '← Admin'), catalog: back('catalog', '← Searches') };
const WHEN = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });
const when = time => time ? WHEN.format(time) : 'not yet';
const link = review => `<a href="https://www.immobilienscout24.de/expose/${encodeURIComponent(review.exposeId)}">${esc(review.snapshot.title)}</a>`;
export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// How many people picked a search.
const usedBy = using => using === 1 ? '1 person uses it' : using ? `${using} people use it` : 'Nobody uses it';

// A search's schedule as people read it: "every 2 min · 🌙 22:00–07:00".
const schedule = ({ intervalMs, quietHours }) => `every ${every(intervalMs)} · 🌙 ${quietHours ? nightPause(quietHours) : 'no night pause'}`;
// How long ago, as people say it: "just now", "5 min ago", "3 h ago", then the date.
function ago(time, now = Date.now()) {
  if (!time) return 'not yet';
  const minutes = Math.floor((now - time) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h ago` : when(time);
}
// status: { counts, failures: { IS24, LLM }, blocked, paused, autoSend, email, immomioEmail,
// llm: { model, thinking } (only for the admin; internal to everyone else), chatgpt: { email, plan },
// searches: [{ name, intervalMs, quietHours, quiet, crawledAt, failures, blocked }] (the ones picked), quiet: all of them are in their night pause }
// Blocks, most important first: what I do, your listings, the searches, the connections, how ChatGPT works.
export function statusView(s) {
  const n = key => s.counts[key] ?? 0;
  const trouble = (failures, blocked) => blocked ? '⛔ blocking me, backing off' : failures ? `⚠️ ${plural(failures, 'failure')} in a row` : '';
  // ✅ connected, ⚠️ connected but failing (why on the next line), ▫️ not connected and how to connect.
  const account = (name, email, failures = 0, blocked = false, connect = '') => {
    if (!email && connect) return `▫️ ${name} · not connected · ${connect}`;
    const problem = trouble(failures, blocked);
    return `${problem ? '⚠️' : '✅'} ${name}${email ? ` · ${esc(email)}` : ''}${problem ? `\n└ ${problem}` : ''}`;
  };
  const state = s.paused ? '<b>⏸ Paused</b>\nI do not search. Waiting drafts and sending still work.'
    : s.quiet ? '<b>🌙 Night pause</b>\nAll your searches rest until morning.' : `<b>🟢 Searching</b> · ${s.searches.length === 1 ? '1 search' : `${s.searches.length} searches`}`;
  const waiting = n('awaiting_approval'), working = n('discovered') + n('approved') + n('submitting');
  const listings = [
    waiting ? `📬 <b>${waiting} waiting for you</b>` : '📬 Nothing waiting for you',
    `📨 Sent: ${n('sent')}${working ? ` · ⏳ in progress: ${working}` : ''}`,
    ...(n('unknown_outcome') ? [`⚠️ Check on IS24: ${n('unknown_outcome')}`] : []),
    ...(n('failed') + n('analysis_failed') ? [`❌ Not sent: ${n('failed') + n('analysis_failed')}`] : []),
    `🙈 Not a match: ${n('dismissed')} · 👀 online before I started: ${n('existing')}`,
  ];
  const searches = s.searches.map(search => {
    const problem = search.blocked ? '⛔ IS24 is blocking it, backing off' : search.failures ? `⚠️ ${plural(search.failures, 'failure')} in a row` : '';
    return `<b>${esc(search.name)}</b> · ${schedule(search)}\n└ ${problem ? `${problem} · ` : ''}${search.quiet && !s.quiet ? 'resting now · ' : ''}checked ${ago(search.crawledAt)}`;
  });
  const plan = s.chatgpt.plan ? ` ${esc(s.chatgpt.plan[0].toUpperCase() + s.chatgpt.plan.slice(1))}` : '';
  const blocks = [
    [state],
    ['<b>📊 Listings</b>', ...listings],
    ['<b>🔎 Searches</b>', ...(searches.length ? searches : ['None picked. 🔍 Search in /settings.'])],
    ['<b>🔗 Connections</b>', account('ImmoScout24', s.email, s.failures.IS24, s.blocked, '/connect'), account('Immomio', s.immomioEmail, 0, false, '/immomio'),
      account(`ChatGPT${plan}`, s.chatgpt.email, s.failures.LLM)],
    ['<b>🤖 Agent</b>', ...(s.llm ? [`🧠 Model: ${esc(s.llm.model)} · thinking ${esc(s.llm.thinking || 'default')}`] : []),
      `📤 Auto-send ${s.autoSend ? '<b>on</b>: clear matches go out by themselves' : 'off: you approve every application'}`],
  ];
  return html(blocks.map(block => block.join('\n')).join('\n\n'), [
    [s.paused ? { text: '▶️ Resume', callback_data: 'x:pause' } : { text: '⏸ Pause', callback_data: 'x:pause' }],
    [{ text: `📬 Waiting (${waiting})`, callback_data: 'x:waiting' }, { text: `📨 Sent (${n('sent') + n('unknown_outcome') + n('failed')})`, callback_data: 'x:sent' }],
    [{ text: '⚙️ Settings', callback_data: 'x:settings' }],
  ]);
}

// One way to everything you can change; each button opens that setting's view in place, 📤 switches at once.
// admin: the shared ChatGPT login, and who is on this agent. Each search's schedule is set on the search (🔍 Search → 🔎 Searches).
export function settingsView({ autoSend, admin }) {
  return html([
    '<b>⚙️ Settings</b>', 'Tap what you want to change.', '',
    autoSend ? '📤 Auto-send is <b>on</b>: I send clear matches myself and show you what went out. Unclear ones still ask you first.'
      : '📤 Auto-send is <b>off</b>: you approve every application. Turned on, I send clear matches myself; unclear ones still ask you first.',
  ].join('\n'), [
    [{ text: '🔍 Search', callback_data: 'x:requirements' }, { text: '👤 About you', callback_data: 'x:about' }],
    [{ text: '✍️ Agent\'s style', callback_data: 'x:style' }],
    [{ text: `📤 Auto-send: ${autoSend ? 'on' : 'off'}`, callback_data: 'x:autosend' }],
    [{ text: '🔗 ImmoScout24', callback_data: 'x:reconnect:/connect' }, { text: '🔗 Immomio', callback_data: 'x:reconnect:/immomio' }],
    ...(admin ? [[{ text: '🛠 Admin', callback_data: 'x:admin' }]] : []),
    BACK.status,
  ]);
}

// What only the admin changes, for everyone on this agent.
export function adminView() {
  return html([
    '<b>🛠 Admin</b>', 'Only you see this. What you change here applies to everyone on this agent.', '',
    '🔎 <b>Manage searches</b>: add, rename, relink and remove the searches people pick from, and set how often each runs.',
    '👥 <b>People</b>: invite and remove people.',
    '🧠 <b>Model</b>: the ChatGPT model for everyone. It reads every new listing and writes and rewrites the messages.',
    '🔗 <b>ChatGPT</b>: the one ChatGPT login everyone\'s listings are read with.',
  ].join('\n'), [
    [{ text: '🔎 Manage searches', callback_data: 'x:catalog' }],
    [{ text: '🧠 Model', callback_data: 'x:model' }],
    [{ text: '👥 People', callback_data: 'x:users' }, { text: '🔗 ChatGPT', callback_data: 'x:reconnect:/login' }],
    BACK.settings,
  ]);
}

// users: [{ id, email, ready, admin }]. Each button removes that person after a confirmation.
export function usersView(users) {
  const lines = users.map(user => `${user.admin ? '👑' : user.ready ? '✅' : '⏳'} ${esc(user.email || 'IS24 not connected')} · <code>${esc(user.id)}</code>`);
  return html(`<b>👥 People on this agent</b>\n\n${lines.join('\n')}\n\n✅ set up · ⏳ still in setup · 👑 admin`,
    [[{ text: '➕ Invite', callback_data: 'x:invite' }], ...users.filter(user => !user.admin).map(user => [{ text: `🗑 ${user.email || user.id}`, callback_data: `x:rm:${user.id}` }]), BACK.admin]);
}
export function removeUserView(id) {
  return html(`<b>Remove <code>${esc(id)}</code>?</b>\nThey stop getting listings and the bot ignores them. Their data stays on the server, in a folder named removed-${esc(id)}-….`,
    [[{ text: '🗑 Yes, remove', callback_data: `x:rm:${id}:yes` }], back('users', 'Cancel')]);
}

// Newest first; each number re-sends that listing with its buttons.
export function waitingView(reviews) {
  if (!reviews.length) return html('<b>📬 Waiting for you</b>\n\nNothing is waiting. New matches arrive here in the chat.', [BACK.status]);
  const shown = reviews.slice(-20).reverse();
  const lines = shown.map((review, index) => `${index + 1}. ${link(review)}\n      ${esc(review.snapshot.price ?? '?')} € · ${esc(review.snapshot.rooms ?? '?')} Zi. · ${esc(review.snapshot.area ?? '?')} m²`);
  const more = reviews.length > shown.length ? `\n\n…and ${reviews.length - shown.length} older.` : '';
  return html(`<b>📬 Waiting for you</b>\n\n${lines.join('\n')}${more}\n\nTap a number to show that listing again with its buttons.`, [
    ...rows(shown.map((review, index) => ({ text: String(index + 1), callback_data: `x:show:${compactId(review.id)}` })), 5),
    [{ text: `🧹 Clear all ${reviews.length}`, callback_data: 'x:clear' }],
    BACK.status,
  ]);
}
// Clearing dismisses every waiting listing, so it asks once more.
export function clearView(count) {
  return html(`<b>🧹 Clear all ${count} waiting listings?</b>\nThey are dismissed and no message is sent. New listings still come in.`,
    [[{ text: `🧹 Yes, clear all ${count}`, callback_data: `x:clear:${count}` }], back('waiting', 'Cancel')]);
}

const OUTCOME = { sent: '✅', unknown_outcome: '⚠️', failed: '❌' };
// Telegram refuses a message over 4096 characters: as many lines as fit, counted with their markup to be safe.
const fitting = (lines, room) => { let used = 0; return lines.filter(line => (used += line.length + 1) <= room); };
export function sentView(reviews) {
  const shown = reviews.filter(review => OUTCOME[review.status]).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 20);
  if (!shown.length) return html('<b>📨 Applications</b>\n\nNone sent yet.', [BACK.status]);
  const lines = fitting(shown.map(review => `${OUTCOME[review.status]} ${link(review)}\n      ${when(review.finishedAt)}${review.approvedBy === 'auto' ? ' · auto-sent' : ''}${review.status === 'sent' ? '' : ` · ${esc(review.detail || '')}`}`), 3800);
  return html(`<b>📨 Applications</b>\n\n${lines.join('\n')}\n\n✅ accepted by IS24 · ⚠️ uncertain, check on IS24 · ❌ not sent`, [BACK.status]);
}

// The one ChatGPT model the admin sets for everyone, for screening and writing alike.
// models: [{ id, name, thinking: [levels], defaultThinking }]. Step 1 of 2: the model.
export function modelView(models, current, thinking) {
  return html(`<b>🧠 Model</b>\nReads every new listing for everyone on this agent and decides whether it reaches them, and writes and rewrites the messages: ✨ Write message, ✏️ Rewrite and auto-send. Screening runs far more often than writing, so a fast model saves the plan's usage.\n\nNow: <b>${esc(current)}</b> · thinking ${esc(thinking || 'default')}\n\n1️⃣ Pick a model, then 2️⃣ how hard it should think.`,
    [...fit(models.map((model, index) => ({ text: `${model.id === current ? '✓ ' : ''}${model.name}`, callback_data: `x:m:${index}:${fingerprint(model.id)}` })), 2),
      BACK.admin]);
}
// Step 2 of 2: a thinking level the chosen model supports.
export function thinkingView(model, modelIndex, current, thinking) {
  const active = model.id === current ? thinking || model.defaultThinking : null;
  const label = level => `${level === active ? '✓ ' : ''}${level}`;
  const fallback = model.defaultThinking ? `\nIts default: ${esc(model.defaultThinking)}.` : '';
  return html(`<b>🧠 Thinking for ${esc(model.name)}</b>\nMore thinking: better judgement and drafts, but slower and more of the plan's usage.${fallback}`,
    [...fit(model.thinking.map(level => ({ text: label(level), callback_data: `x:t:${modelIndex}:${level}:${fingerprint(model.id)}` })), 3), back('model', '← Models')]);
}

const span = ({ min, max }, unit) => min === null && max === null ? 'any' : min === null ? `up to ${max}${unit}` : max === null ? `from ${min}${unit}` : `${min}–${max}${unit}`;
const quote = body => `<blockquote expandable>${esc(body)}</blockquote>`;
// A button that opens a settings form (forms.js) in Telegram.
const editButton = (url, text = '✏️ Edit') => ({ text, web_app: { url } });

// searches: the names you picked. limits: { price, rooms, livingSpace }, see Settings. edit: the search form's address.
export function requirementsView(preferences, { searches, limits }, edit) {
  const hard = [`🔎 Searches: ${esc(searches.join(', '))}`, `💶 Warm rent: ${span(limits.price, ' €')}`, `🚪 Rooms: ${span(limits.rooms, '')}`, `📐 Living space: ${span(limits.livingSpace, ' m²')}`];
  return html([
    '<b>🔍 Search</b>', ...hard,
    '', '<b>🎯 Requirements</b>', quote(preferences || 'None yet.'),
    'Listings outside the searches, rent, rooms or living space never reach you. ChatGPT reads your requirements for the rest and skips the ones that clearly do not fit; every other listing comes to you.',
  ].join('\n'), [[{ text: '🔎 Searches', callback_data: 'x:searches' }, editButton(edit)], BACK.settings]);
}

// catalog: the admin's [{ name, url, intervalMs, quietHours }]. selected: the names this person picked.
// Everyone picks here. Only the admin adds, changes and removes searches, in 🛠 Admin (catalogView); during setup,
// before there is one to pick, the admin also adds them here (manage).
// ready: setup is done, so the list leads back to 🔍 Search; during setup, Done goes on with it.
export function searchesView({ catalog, selected, admin, ready }) {
  const manage = admin && !ready;
  const lines = catalog.map(search => `<b>${esc(search.name)}</b> · ${schedule(search)}`).join('\n');
  const empty = manage ? 'None yet. Tap ➕ Add for the first one.' : 'None yet. The admin adds them.';
  return html(`<b>🔎 Which searches do you want listings from?</b>\nTap to pick. Your rent, rooms, living space and requirements are applied to each.\n\n${lines || empty}`, [
    ...catalog.map(({ name }, index) => [{ text: `${selected.includes(name) ? '✅' : '⬜'} ${name}`, callback_data: `x:st:${index}:${fingerprint(name)}` },
      ...(manage ? [{ text: '⚙️', callback_data: `x:se:${index}:${fingerprint(name)}` }] : [])]),
    ...(manage ? [[{ text: '➕ Add', callback_data: 'x:sa' }]] : []),
    [{ text: ready ? '← Search' : 'Done', callback_data: 'x:sd' }],
  ]);
}
// 🛠 Admin → 🔎 Manage searches: the list everyone picks from. using(name): how many people picked it.
export function catalogView(catalog, using) {
  const lines = catalog.map(search => `<a href="${esc(new URL(search.url).href)}">${esc(search.name)}</a> · ${schedule(search)}\n└ ${usedBy(using(search.name))}`).join('\n');
  return html(`<b>🔎 Searches for everyone</b>\nEveryone picks from these in 🔍 Search. Each runs as often and pauses at night as shown; ⚙️ changes that, renames, relinks or removes it.\n\n${lines || 'None yet. Tap ➕ Add for the first one.'}`, [
    ...fit(catalog.map(({ name }, index) => ({ text: `⚙️ ${name}`, callback_data: `x:se:${index}:${fingerprint(name)}` })), 2),
    [{ text: '➕ Add', callback_data: 'x:sa' }],
    BACK.admin,
  ]);
}
// One search of the admin's list. using: how many people picked it.
export function searchView(search, index, using) {
  const mark = fingerprint(search.name);
  return html(`<b>🔎 ${esc(search.name)}</b>\n<a href="${esc(new URL(search.url).href)}">Open on ImmoScout24</a>\n⏱ Every ${every(search.intervalMs)}\n🌙 Night pause: ${nightPause(search.quietHours)}\n${usedBy(using)}.`, [
    [{ text: `⏱ ${every(search.intervalMs)}`, callback_data: `x:si:${index}:${mark}` }, { text: `🌙 ${search.quietHours ? nightPause(search.quietHours) : 'Off'}`, callback_data: `x:sq:${index}:${mark}` }],
    [{ text: '✏️ Rename', callback_data: `x:sn:${index}:${mark}` }, { text: '🔗 Change link', callback_data: `x:su:${index}:${mark}` }],
    [{ text: '🗑 Remove', callback_data: `x:sr:${index}:${mark}` }],
    BACK.catalog,
  ]);
}
// How often a search runs (what: 'si') or when it pauses ('sq'): each button saves one choice.
export function scheduleView(search, index, what) {
  const mark = fingerprint(search.name);
  const [title, note, options, current, label] = what === 'si'
    ? [`⏱ How often should I search ${esc(search.name)}?`, 'Being early matters most; every 2 minutes is a good balance. Each check costs IS24 one request.', INTERVALS, search.intervalMs, every]
    : [`🌙 When should ${esc(search.name)} pause?`, 'Hardly anyone publishes listings at night. German time.', NIGHT_PAUSES, search.quietHours, value => value ? nightPause(value) : 'Around the clock'];
  return html(`<b>${title}</b>\n${note}\nIt applies to everyone who picked this search.`, [
    ...fit(options.map((option, choice) => ({ text: `${option === current ? '✓ ' : ''}${label(option)}`, callback_data: `x:${what}:${index}:${mark}:${choice}` })), 3),
    [{ text: '← Back', callback_data: `x:se:${index}:${mark}` }],
  ]);
}
// listings: the newest results of the test run, so the admin can see the area and filters took effect.
export function searchAddedView(name, listings) {
  const newest = listings.slice(0, 3).map(({ title, address, url }) => `• <a href="${esc(url)}">${esc(title)}</a>${address ? `, ${esc(address)}` : ''}`).join('\n');
  return html(`✅ <b>${esc(name)}</b> works: IS24 answered it.\n\n${newest ? `Newest listings:\n${newest}\n\nIf these are outside the area you picked, IS24 did not take the area from the link: remove the search.` : 'It has no listings right now, which can be right for a small area.'}`, []);
}
export function removeSearchView({ name }, index, using) {
  return html(`<b>Remove ${esc(name)}?</b>\n${usedBy(using)}${using ? ' and will be told' : ''}.`,
    [[{ text: '🗑 Yes, remove', callback_data: `x:sr:${index}:${fingerprint(name)}:yes` }], back('catalog', 'Cancel')]);
}

// Up to 10 texts of up to 2000 characters, shortened when together they would not fit one Telegram message.
const STYLE_ROOM = 3200;
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
// How ChatGPT writes, per section of the message, and everything else it gets with each listing (the fixed safety rules are not shown).
// style: Settings#style(), or null.
export function styleView(style, edit) {
  const texts = STYLE_SECTIONS.flatMap(({ name }) => [style?.[name]?.instructions, style?.[name]?.example]).filter(Boolean);
  const max = texts.join('').length > STYLE_ROOM ? Math.floor(STYLE_ROOM / texts.length) : STYLE_ROOM;
  const sections = STYLE_SECTIONS.filter(({ name }) => style?.[name]).map(({ name, title }) => [
    `<b>${esc(title)}</b>`, ...(style[name].instructions ? [quote(clip(style[name].instructions, max))] : []), ...(style[name].example ? [`Example:\n${quote(clip(style[name].example, max))}`] : []),
  ].join('\n'));
  return html([
    '<b>✍️ The agent\'s writing style</b>',
    `How ChatGPT writes your applications, for each part: ${STYLE_SECTIONS.map(({ title }) => title.toLowerCase()).join(', ')}.`,
    '', ...(sections.length ? sections : [quote('None yet: polite and concise. For example "Formal, short, always mention that I am a non-smoker."')]),
    '', '<b>What ChatGPT gets for each new listing</b>',
    '• this writing style', '• your 🎯 requirements, from 🔍 Search', '• your 👤 About you and contact details', '• the listing itself, as data, never as instructions',
  ].join('\n'), [[editButton(edit), ...(style ? [{ text: '🗑 Remove', callback_data: 'x:clearStyle' }] : [])], BACK.settings]);
}
// persona: the stored persona.* values without the prefix; email: the IS24 login, which IS24 sends along.
const SALUTATION = { FEMALE: 'Frau', MALE: 'Herr' };
// Blocks as in the 👤 About you form; ▫️ marks what is missing and why it matters.
export function aboutView(persona, email, edit) {
  const name = [SALUTATION[persona.anrede], persona.vorname, persona.nachname].filter(Boolean).join(' ');
  const address = [[persona.strasse, persona.hausnummer].filter(Boolean).join(' '), [persona.plz, persona.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const blocks = [
    ['<b>👤 About you</b>', 'Everything your applications say about you comes from here.'],
    ['<b>📇 Contact details</b> · sent in IS24\'s contact form',
      name ? `<b>${esc(name)}</b>` : '▫️ No name yet',
      email ? `✉️ ${esc(email)} · your IS24 login` : '▫️ No email: IS24 is not connected · /connect',
      persona.telefon ? `📞 ${esc(persona.telefon)}` : '▫️ No phone · landlords often call the first applicants',
      address ? `🏠 ${esc(address)}` : '▫️ No address'],
    ['<b>📝 For ChatGPT</b> · what your applications may say about you',
      persona.about ? quote(persona.about) : '▫️ Nothing yet: applications mention only your name.'],
    ['<b>📎 IS24 Selbstauskunft</b>', persona.sendProfile === true ? '✅ Attached to every application' : '▫️ Not attached'],
  ];
  return html(blocks.map(block => block.join('\n')).join('\n\n'), [[editButton(edit)], BACK.settings]);
}
