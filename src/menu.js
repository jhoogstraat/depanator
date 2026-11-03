import { createHash } from 'node:crypto';
import { compactId } from './review.js';

// The Telegram menu (☰ next to the message field): two entry points, everything else is a button in the chat.
// Hidden but still working: /start, /setup, /search, /pause, /prompt, /model, /interval, /autosend, /connect, /immomio, /login. Admin only: /users, /interval.
export const COMMANDS = [
  ['status', 'Overview: search now, waiting and sent'],
  ['settings', 'Search, requirements, style, model, connections'],
];
export const MENU_HINT = 'Send /status to see what I am doing, /settings to change anything.';

// Buttons name an option by index plus a short fingerprint, so a stale button never picks a different option.
export const fingerprint = label => createHash('sha256').update(String(label)).digest('base64url').slice(0, 4);
export const rows = (buttons, perRow) => Array.from({ length: Math.ceil(buttons.length / perRow) }, (_, index) => buttons.slice(index * perRow, index * perRow + perRow));
// Every view is HTML; anything not written here (listing titles, your texts) goes through esc().
const esc = value => String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const html = (text, buttons) => ({ text, extra: { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: buttons } } });
// ponytail: German time zone fixed; IS24 is a German site. Make it a setting if that ever changes.
const when = time => time ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(time) : 'not yet';
const link = review => `<a href="https://www.immobilienscout24.de/expose/${encodeURIComponent(review.exposeId)}">${esc(review.snapshot.title)}</a>`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// status: { counts, lastPollAt, failures: { IS24, LLM }, blocked, paused, interval, autoSend, email, immomioEmail, model, thinking, chatgpt: { email, plan }, quietHours, quiet }
const hours = quietHours => quietHours.split('-').map(hour => `${hour.padStart(2, '0')}:00`);
export function statusView(s) {
  const n = key => s.counts[key] ?? 0;
  const health = (failures, ok, blocked = false) => blocked ? '⛔ blocking me, backing off' : failures ? `⚠️ ${plural(failures, 'failure')} in a row` : `✅ ${ok}`;
  const lines = [
    s.paused ? '<b>⏸ Paused</b>: I do not search. Waiting drafts and sending still work.'
      : s.quiet ? `<b>🌙 Night pause</b> until ${hours(s.quietHours)[1]}.` : `<b>🟢 Searching</b> every ${esc(s.interval)}`,
    `🌙 Night pause: ${s.quietHours ? `${hours(s.quietHours).join(' – ')}` : 'off'}`,
    `🕑 Last check: ${when(s.lastPollAt)}`,
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
// admin: the shared check interval and ChatGPT login, and who is on this agent.
export function settingsView({ interval, autoSend, admin }) {
  return html('<b>⚙️ Settings</b>\nTap what you want to change.', [
    [{ text: '🔍 Search', callback_data: 'x:requirements' }, { text: '👤 About you', callback_data: 'x:about' }],
    [{ text: '✍️ Writing style', callback_data: 'k:style' }, { text: '📝 What ChatGPT gets', callback_data: 'x:prompt' }],
    [...(admin ? [{ text: `⏱ ${interval}`, callback_data: 'k:pollIntervalMs' }] : []), { text: '🌙 Night pause', callback_data: 'k:quietHours' }],
    [{ text: '🧠 Model', callback_data: 'k:model' }, { text: `📤 Auto-send: ${autoSend ? 'on' : 'off'}`, callback_data: 'k:autoSend' }],
    [{ text: '🔗 ImmoScout24', callback_data: 'x:reconnect:/connect' }, { text: '🔗 Immomio', callback_data: 'x:reconnect:/immomio' }, ...(admin ? [{ text: '🔗 ChatGPT', callback_data: 'x:reconnect:/login' }] : [])],
    ...(admin ? [[{ text: '👥 People', callback_data: 'x:users' }]] : []),
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
    rows(models.map((model, index) => ({ text: `${model.id === current ? '✓ ' : ''}${model.name}`, callback_data: `x:m:${index}:${fingerprint(model.id)}` })), 2));
}
// Step 2 of 2: a thinking level the chosen model supports.
export function thinkingView(model, modelIndex, current, thinking) {
  const active = model.id === current ? thinking || model.defaultThinking : null;
  const label = level => `${level === active ? '✓ ' : ''}${level}${level === model.defaultThinking ? ' (default)' : ''}`;
  return html(`<b>🧠 Thinking for ${esc(model.name)}</b>\nMore thinking: better judgement and drafts, but slower and more of your plan's usage.`,
    rows(model.thinking.map(level => ({ text: label(level), callback_data: `x:t:${modelIndex}:${level}:${fingerprint(model.id)}` })), 3));
}

export const requirementLines = preferences => String(preferences || '').split('\n').map(line => line.trim()).filter(Boolean);
const span = ({ min, max }, unit) => min === null && max === null ? 'any' : min === null ? `up to ${max}${unit}` : max === null ? `from ${min}${unit}` : `${min}–${max}${unit}`;
// searches: the names you picked. limits: { price, rooms, livingSpace }, see Settings.
export function requirementsView(preferences, { searches, limits }) {
  const lines = requirementLines(preferences);
  const hard = [`🔎 Searches: ${esc(searches.join(', '))}`, `💶 Warm rent: ${span(limits.price, ' €')}`, `🚪 Rooms: ${span(limits.rooms, '')}`, `📐 Living space: ${span(limits.livingSpace, ' m²')}`];
  return html(`<b>🔍 Search</b>\n${hard.join('\n')}\n\n<b>Requirements</b>\nChatGPT skips listings that clearly break one of these; every other listing comes to you.\n\n${lines.map((line, index) => `${index + 1}. ${esc(line)}`).join('\n') || 'None yet.'}`, [
    [{ text: '🔎 Searches', callback_data: 'x:searches' }, { text: '💶 Rent', callback_data: 'k:rent' }, { text: '🚪 Rooms', callback_data: 'k:rooms' }, { text: '📐 Space', callback_data: 'k:area' }],
    [{ text: '➕ Add', callback_data: 'x:ra' }, { text: '✏️ Rewrite all', callback_data: 'k:preferences' }],
    ...rows(lines.length > 1 ? lines.map((line, index) => ({ text: `🗑 ${index + 1}`, callback_data: `x:rd:${index}:${fingerprint(line)}` })) : [], 5),
  ]);
}

// catalog: the admin's [{ name, url }]. selected: the names this person picked. Only the admin adds and removes.
export function searchesView({ catalog, selected, admin }) {
  const links = admin ? catalog.map(({ name, url }) => `<a href="${esc(new URL(url).href)}">${esc(name)}</a>`).join('\n') : '';
  const empty = admin ? 'None yet. Tap ➕ Add for the first one.' : 'None yet. The admin adds them.';
  return html(`<b>🔎 Which searches do you want listings from?</b>\nTap to pick. Your rent, rooms, living space and requirements are applied to each.\n\n${links || (catalog.length ? '' : empty)}`.trim(), [
    ...catalog.map(({ name }, index) => [{ text: `${selected.includes(name) ? '✅' : '⬜'} ${name}`, callback_data: `x:st:${index}:${fingerprint(name)}` },
      ...(admin ? [{ text: '🗑', callback_data: `x:sr:${index}:${fingerprint(name)}` }] : [])]),
    ...(admin ? [[{ text: '➕ Add', callback_data: 'x:sa' }]] : []),
    [{ text: 'Done', callback_data: 'x:sd' }],
  ]);
}
export function removeSearchView({ name }, index, using) {
  return html(`<b>Remove ${esc(name)}?</b>\n${using === 1 ? '1 person uses it and will be told.' : using ? `${using} people use it and will be told.` : 'Nobody uses it.'}`,
    [[{ text: '🗑 Yes, remove', callback_data: `x:sr:${index}:${fingerprint(name)}:yes` }], [{ text: 'Cancel', callback_data: 'x:searches:edit' }]]);
}

// What ChatGPT gets with each listing that you control (the fixed safety rules are not shown).
// about: [[label, value]] of your details as ChatGPT gets them (unset ones left out).
export function promptView({ style, preferences, about }) {
  const block = body => `<blockquote expandable>${esc(body)}</blockquote>`;
  const facts = about.map(([label, value]) => `${label}: ${value}`).join('\n');
  return html([
    '<b>📝 What ChatGPT gets for each new listing</b>',
    '', '<b>✍️ Your writing style</b>', block(style || 'None yet. Tap below to add one, e.g. "Formal, short, mention that I am a non-smoker."'),
    '', '<b>🎯 Requirements</b>', block(requirementLines(preferences).join('\n')),
    '', '<b>👤 About you</b>', block(facts || 'Nothing yet.'),
    '', 'Plus the listing itself, which ChatGPT treats as data, never as instructions.',
  ].join('\n'), [
    [{ text: '✍️ Style', callback_data: 'k:style' }, { text: '🎯 Requirements', callback_data: 'x:requirements' }, { text: '👤 About you', callback_data: 'x:about' }],
    ...(style ? [[{ text: '🗑 Remove style', callback_data: 'c:style:-' }]] : []),
  ]);
}
// fields: [[key, label, display]]; each button changes that detail.
export function aboutView(fields) {
  return html(`<b>👤 About you</b>\nApplications state only these facts. Tap one to change it.\n\n${fields.map(([, label, value]) => `${esc(label)}: ${esc(value)}`).join('\n')}`,
    rows(fields.map(([key, label]) => ({ text: label, callback_data: `k:${key}` })), 2));
}
