import { createHash } from 'node:crypto';
import { compactId } from './review.js';
import { INTERVALS, NIGHT_PAUSES, every, nightPause } from './settings.js';

// The Telegram menu (☰ next to the message field): two entry points, everything else is a button in the chat.
// Hidden but still working: /start, /setup, /search, /pause, /prompt, /model, /autosend, /connect, /immomio, /login. Admin only: /users.
export const COMMANDS = [
  ['status', 'Overview: search now, waiting and sent'],
  ['settings', 'Search, about you, writing style, model, connections'],
];
export const MENU_HINT = 'Send /status to see what I am doing, /settings to change anything.';

// Buttons name an option by index plus a short fingerprint, so a stale button never picks a different option.
export const fingerprint = label => createHash('sha256').update(String(label)).digest('base64url').slice(0, 4);
export const rows = (buttons, perRow) => Array.from({ length: Math.ceil(buttons.length / perRow) }, (_, index) => buttons.slice(index * perRow, index * perRow + perRow));
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
// ponytail: German time zone fixed; IS24 is a German site. Make it a setting if that ever changes.
const when = time => time ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(time) : 'not yet';
const link = review => `<a href="https://www.immobilienscout24.de/expose/${encodeURIComponent(review.exposeId)}">${esc(review.snapshot.title)}</a>`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// A search's schedule as people read it: "every 2 min · 🌙 22:00–07:00".
const schedule = ({ intervalMs, quietHours }) => `every ${every(intervalMs)} · 🌙 ${quietHours ? nightPause(quietHours) : 'no night pause'}`;
// status: { counts, failures: { IS24, LLM }, blocked, paused, autoSend, email, immomioEmail, model, thinking, chatgpt: { email, plan },
// searches: [{ name, intervalMs, quietHours, quiet, crawledAt, failures, blocked }] (the ones picked), quiet: all of them are in their night pause }
export function statusView(s) {
  const n = key => s.counts[key] ?? 0;
  const health = (failures, ok, blocked = false) => blocked ? '⛔ blocking me, backing off' : failures ? `⚠️ ${plural(failures, 'failure')} in a row` : `✅ ${ok}`;
  const lines = [
    s.paused ? '<b>⏸ Paused</b>: I do not search. Waiting drafts and sending still work.'
      : s.quiet ? '<b>🌙 Night pause</b> for all your searches.' : '<b>🟢 Searching</b>',
    ...s.searches.map(search => `🔎 ${esc(search.name)}: ${schedule(search)}${search.quiet && !s.quiet ? ' (now paused)' : ''}\n      🕑 checked ${when(search.crawledAt)}${search.blocked ? ' · ⛔ IS24 is blocking it, backing off' : search.failures ? ` · ⚠️ ${plural(search.failures, 'failure')} in a row` : ''}`),
    `🏠 ImmoScout24: ${s.email ? health(s.failures.IS24, `connected as ${esc(s.email)}`, s.blocked) : '❌ not connected, /connect'}`,
    `🏢 Immomio: ${s.immomioEmail ? `connected as ${esc(s.immomioEmail)}` : 'not connected, /immomio'}`,
    `🤖 ChatGPT${s.chatgpt.plan ? ` ${esc(s.chatgpt.plan[0].toUpperCase() + s.chatgpt.plan.slice(1))}` : ''}: ${health(s.failures.LLM, s.chatgpt.email ? `connected as ${esc(s.chatgpt.email)}` : 'connected')}`,
    `🧠 Model: ${esc(s.model)} · thinking ${esc(s.thinking || 'default')}`,
    `📤 Auto-send: ${s.autoSend ? 'on' : 'off'}`,
    '',
    '<b>📊 Listings</b>',
    `📬 Waiting for you: <b>${n('awaiting_approval')}</b>`,
    `⏳ In progress: ${n('discovered') + n('approved') + n('submitting')}`,
    `📨 Sent: ${n('sent')}`,
    ...(n('unknown_outcome') ? [`⚠️ Check on IS24: ${n('unknown_outcome')}`] : []),
    ...(n('failed') + n('analysis_failed') ? [`❌ Not sent: ${n('failed') + n('analysis_failed')}`] : []),
    `🙈 Not a match: ${n('dismissed')}`,
    `👀 Online before I started: ${n('existing')}`,
  ];
  return html(lines.join('\n'), [
    [s.paused ? { text: '▶️ Resume', callback_data: 'x:pause' } : { text: '⏸ Pause', callback_data: 'x:pause' }],
    [{ text: `📬 Waiting (${n('awaiting_approval')})`, callback_data: 'x:waiting' }, { text: `📨 Sent (${n('sent') + n('unknown_outcome') + n('failed')})`, callback_data: 'x:sent' }],
    [{ text: '⚙️ Settings', callback_data: 'x:settings' }],
  ]);
}

// One way to everything you can change; each button opens that setting's own question or view.
// admin: the shared ChatGPT login, and who is on this agent. Each search's schedule is set on the search (🔍 Search → 🔎 Searches).
export function settingsView({ autoSend, admin }) {
  return html('<b>⚙️ Settings</b>\nTap what you want to change.', [
    [{ text: '🔍 Search', callback_data: 'x:requirements' }, { text: '👤 About you', callback_data: 'x:about' }],
    [{ text: '✍️ Agent\'s style', callback_data: 'x:style' }, { text: '🧠 Model', callback_data: 'k:model' }],
    [{ text: `📤 Auto-send: ${autoSend ? 'on' : 'off'}`, callback_data: 'k:autoSend' }],
    [{ text: '🔗 ImmoScout24', callback_data: 'x:reconnect:/connect' }, { text: '🔗 Immomio', callback_data: 'x:reconnect:/immomio' }],
    ...(admin ? [[{ text: '🔗 ChatGPT', callback_data: 'x:reconnect:/login' }, { text: '👥 People', callback_data: 'x:users' }]] : []),
  ]);
}

// users: [{ id, email, ready, admin }]. Each button removes that person after a confirmation.
export function usersView(users) {
  const lines = users.map(user => `${user.admin ? '👑' : user.ready ? '✅' : '⏳'} ${esc(user.email || 'IS24 not connected')} · <code>${esc(user.id)}</code>`);
  return html(`<b>👥 People on this agent</b>\n\n${lines.join('\n')}\n\n✅ set up · ⏳ still in setup · 👑 admin`,
    [[{ text: '➕ Invite', callback_data: 'x:invite' }], ...users.filter(user => !user.admin).map(user => [{ text: `🗑 ${user.email || user.id}`, callback_data: `x:rm:${user.id}` }])]);
}
export function removeUserView(id) {
  return html(`<b>Remove <code>${esc(id)}</code>?</b>\nThey stop getting listings and the bot ignores them. Their data stays on the server, in a folder named removed-${esc(id)}-….`,
    [[{ text: '🗑 Yes, remove', callback_data: `x:rm:${id}:yes` }], [{ text: 'Cancel', callback_data: 'x:users:edit' }]]);
}

// Newest first; each number re-sends that listing with its buttons.
export function waitingView(reviews) {
  if (!reviews.length) return html('📬 Nothing is waiting for you.', []);
  const shown = reviews.slice(-20).reverse();
  const lines = shown.map((review, index) => `${index + 1}. ${link(review)}\n      ${esc(review.snapshot.price ?? '?')} € · ${esc(review.snapshot.rooms ?? '?')} Zi. · ${esc(review.snapshot.area ?? '?')} m²`);
  const more = reviews.length > shown.length ? `\n\n…and ${reviews.length - shown.length} older.` : '';
  return html(`<b>📬 Waiting for you</b>\n\n${lines.join('\n')}${more}\n\nTap a number to show that listing again with its buttons.`, [
    ...rows(shown.map((review, index) => ({ text: String(index + 1), callback_data: `x:show:${compactId(review.id)}` })), 5),
    [{ text: `🧹 Clear all ${reviews.length}`, callback_data: 'x:clear' }],
  ]);
}
// Clearing dismisses every waiting listing, so it asks once more.
export function clearView(count) {
  return html(`<b>🧹 Clear all ${count} waiting listings?</b>\nThey are dismissed and no message is sent. New listings still come in.`,
    [[{ text: `🧹 Yes, clear all ${count}`, callback_data: `x:clear:${count}` }], [{ text: 'Cancel', callback_data: 'x:waiting:edit' }]]);
}

const OUTCOME = { sent: '✅', unknown_outcome: '⚠️', failed: '❌' };
export function sentView(reviews) {
  const shown = reviews.filter(review => OUTCOME[review.status]).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 20);
  if (!shown.length) return html('📨 No applications sent yet.', []);
  const lines = shown.map(review => `${OUTCOME[review.status]} ${link(review)}\n      ${when(review.finishedAt)}${review.approvedBy === 'auto' ? ' · auto-sent' : ''}${review.status === 'sent' ? '' : ` · ${esc(review.detail || '')}`}`);
  return html(`<b>📨 Applications</b>\n\n${lines.join('\n')}\n\n✅ accepted by IS24 · ⚠️ uncertain, check on IS24 · ❌ not sent`, []);
}

// models: [{ id, name, thinking: [levels], defaultThinking }]. Step 1 of 2: the model.
export function modelView(models, current, thinking) {
  return html(`<b>🤖 ChatGPT model</b>\nNow: ${esc(current)} · thinking ${esc(thinking || 'default')}\n\n1️⃣ Pick a model, then 2️⃣ how hard it should think.`,
    fit(models.map((model, index) => ({ text: `${model.id === current ? '✓ ' : ''}${model.name}`, callback_data: `x:m:${index}:${fingerprint(model.id)}` })), 2));
}
// Step 2 of 2: a thinking level the chosen model supports.
export function thinkingView(model, modelIndex, current, thinking) {
  const active = model.id === current ? thinking || model.defaultThinking : null;
  const label = level => `${level === active ? '✓ ' : ''}${level}`;
  const fallback = model.defaultThinking ? `\nIts default: ${esc(model.defaultThinking)}.` : '';
  return html(`<b>🧠 Thinking for ${esc(model.name)}</b>\nMore thinking: better judgement and drafts, but slower and more of your plan's usage.${fallback}`,
    fit(model.thinking.map(level => ({ text: label(level), callback_data: `x:t:${modelIndex}:${level}:${fingerprint(model.id)}` })), 3));
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
  ].join('\n'), [[{ text: '🔎 Searches', callback_data: 'x:searches' }, editButton(edit)]]);
}

// catalog: the admin's [{ name, url, intervalMs, quietHours }]. selected: the names this person picked.
// Only the admin adds them, sets how often and when they run, renames and removes them.
export function searchesView({ catalog, selected, admin }) {
  const lines = catalog.map(search => `${admin ? `<a href="${esc(new URL(search.url).href)}">${esc(search.name)}</a>` : `<b>${esc(search.name)}</b>`}: ${schedule(search)}`).join('\n');
  const empty = admin ? 'None yet. Tap ➕ Add for the first one.' : 'None yet. The admin adds them.';
  return html(`<b>🔎 Which searches do you want listings from?</b>\nTap to pick. Your rent, rooms, living space and requirements are applied to each. Each search runs as often and pauses at night as shown${admin ? '; ⚙️ changes that, renames or removes it' : ''}.\n\n${lines || empty}`, [
    ...catalog.map(({ name }, index) => [{ text: `${selected.includes(name) ? '✅' : '⬜'} ${name}`, callback_data: `x:st:${index}:${fingerprint(name)}` },
      ...(admin ? [{ text: '⚙️', callback_data: `x:se:${index}:${fingerprint(name)}` }] : [])]),
    ...(admin ? [[{ text: '➕ Add', callback_data: 'x:sa' }]] : []),
    [{ text: 'Done', callback_data: 'x:sd' }],
  ]);
}
// One search of the admin's list. using: how many people picked it.
export function searchView(search, index, using) {
  const mark = fingerprint(search.name);
  return html(`<b>🔎 ${esc(search.name)}</b>\n<a href="${esc(new URL(search.url).href)}">Open on ImmoScout24</a>\n⏱ Every ${every(search.intervalMs)}\n🌙 Night pause: ${nightPause(search.quietHours)}\n${using === 1 ? '1 person uses it.' : `${using || 'Nobody'} ${using ? 'people use' : 'uses'} it.`}`, [
    [{ text: `⏱ ${every(search.intervalMs)}`, callback_data: `x:si:${index}:${mark}` }, { text: `🌙 ${search.quietHours ? nightPause(search.quietHours) : 'Off'}`, callback_data: `x:sq:${index}:${mark}` }],
    [{ text: '✏️ Rename', callback_data: `x:sn:${index}:${mark}` }, { text: '🗑 Remove', callback_data: `x:sr:${index}:${mark}` }],
    [{ text: '← Back', callback_data: 'x:searches:edit' }],
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
  return html(`<b>Remove ${esc(name)}?</b>\n${using === 1 ? '1 person uses it and will be told.' : using ? `${using} people use it and will be told.` : 'Nobody uses it.'}`,
    [[{ text: '🗑 Yes, remove', callback_data: `x:sr:${index}:${fingerprint(name)}:yes` }], [{ text: 'Cancel', callback_data: 'x:searches:edit' }]]);
}

// How ChatGPT writes, and everything else it gets with each listing (the fixed safety rules are not shown).
export function styleView(style, edit) {
  return html([
    '<b>✍️ The agent\'s writing style</b>',
    'How ChatGPT writes your applications. 🧠 Remember on a draft adds a line here.',
    quote(style || 'None yet: polite and concise. For example "Formal, short, always mention that I am a non-smoker."'),
    '', '<b>What ChatGPT gets for each new listing</b>',
    '• this writing style', '• your 🎯 requirements, from 🔍 Search', '• your 👤 About you and contact details', '• the listing itself, as data, never as instructions',
  ].join('\n'), [[editButton(edit), ...(style ? [{ text: '🗑 Remove', callback_data: 'c:style:-' }] : [])]]);
}
// persona: the stored persona.* values without the prefix; email: the IS24 login, which IS24 sends along.
const SALUTATION = { FEMALE: 'Frau', MALE: 'Herr' };
export function aboutView(persona, email, edit) {
  const address = [[persona.strasse, persona.hausnummer].filter(Boolean).join(' '), [persona.plz, persona.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return html([
    '<b>👤 About you</b>', '', '<b>Contact details</b> · go into IS24\'s contact form',
    esc([SALUTATION[persona.anrede], persona.vorname, persona.nachname].filter(Boolean).join(' ') || 'No name yet'),
    `✉️ ${esc(email || 'not connected')} (your IS24 login)`, `📞 ${esc(persona.telefon || '–')}`, `🏠 ${esc(address || '–')}`,
    '', '<b>About you</b> · free text for ChatGPT, which writes your applications', quote(persona.about || 'Nothing yet. Applications then mention only your name.'),
    '', `<b>IS24 Selbstauskunft</b>: ${persona.sendProfile === true ? 'attached to applications' : 'not attached'}`,
  ].join('\n'), [[editButton(edit)]]);
}
