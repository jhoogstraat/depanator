import { createHash } from 'node:crypto';
import { compactId } from './review.js';

// The Telegram menu (☰ next to the message field). Hidden but still working: /start, /setup, /interval.
export const COMMANDS = [
  ['status', 'Overview: search now, waiting and sent'],
  ['pause', 'Pause or resume searching'],
  ['criteria', 'What a listing must have'],
  ['prompt', 'What ChatGPT is told; your writing style'],
  ['model', 'ChatGPT model and thinking level'],
  ['autosend', 'Send clear matches without asking'],
  ['connect', 'Reconnect ImmoScout24'],
  ['immomio', 'Connect Immomio for listings that apply there'],
  ['login', 'Reconnect ChatGPT'],
];
export const MENU_HINT = 'Everything is in the menu: tap ☰ next to the message field.';

// Buttons name an option by index plus a short fingerprint, so a stale button never picks a different option.
export const fingerprint = label => createHash('sha256').update(String(label)).digest('base64url').slice(0, 4);
export const rows = (buttons, perRow) => Array.from({ length: Math.ceil(buttons.length / perRow) }, (_, index) => buttons.slice(index * perRow, index * perRow + perRow));
// Every view is HTML; anything not written here (listing titles, your texts) goes through esc().
export const esc = value => String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
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
    [{ text: '🔍 Search', callback_data: 'k:searchUrl' }, { text: `⏱ ${s.interval}`, callback_data: 'k:pollIntervalMs' }, { text: '🌙 Night', callback_data: 'k:quietHours' }],
    [{ text: '🔄 Refresh', callback_data: 'x:status' }],
  ]);
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

export const criteriaLines = preferences => String(preferences || '').split('\n').map(line => line.trim()).filter(Boolean);
export function criteriaView(preferences) {
  const lines = criteriaLines(preferences);
  return html(`<b>🎯 Criteria</b>\nChatGPT skips listings that clearly miss one of these; every other listing comes to you.\n\n${lines.map((line, index) => `${index + 1}. ${esc(line)}`).join('\n') || 'None yet.'}`, [
    [{ text: '➕ Add', callback_data: 'x:ca' }, { text: '✏️ Rewrite all', callback_data: 'k:preferences' }],
    ...rows(lines.length > 1 ? lines.map((line, index) => ({ text: `🗑 ${index + 1}`, callback_data: `x:cd:${index}:${fingerprint(line)}` })) : [], 5),
  ]);
}

// What ChatGPT gets with each listing that you control (the fixed safety rules are not shown).
// about: [[label, value]] of your details as ChatGPT gets them (unset ones left out).
export function promptView({ style, preferences, about }) {
  const block = body => `<blockquote expandable>${esc(body)}</blockquote>`;
  const facts = about.map(([label, value]) => `${label}: ${value}`).join('\n');
  return html([
    '<b>📝 What ChatGPT gets for each new listing</b>',
    '', '<b>✍️ Your writing style</b>', block(style || 'None yet. Tap below to add one, e.g. "Formal, short, mention that I am a non-smoker."'),
    '', '<b>🎯 Criteria</b>', block(criteriaLines(preferences).join('\n')),
    '', '<b>👤 About you</b>', block(facts || 'Nothing yet.'),
    '', 'Plus the listing itself, which ChatGPT treats as data, never as instructions.',
  ].join('\n'), [
    [{ text: '✍️ Style', callback_data: 'k:style' }, { text: '🎯 Criteria', callback_data: 'x:criteria' }, { text: '👤 About you', callback_data: 'x:about' }],
    ...(style ? [[{ text: '🗑 Remove style', callback_data: 'c:style:-' }]] : []),
  ]);
}
// fields: [[key, label, display]]; each button changes that detail.
export function aboutView(fields) {
  return html(`<b>👤 About you</b>\nApplications state only these facts. Tap one to change it.\n\n${fields.map(([, label, value]) => `${esc(label)}: ${esc(value)}`).join('\n')}`,
    rows(fields.map(([key, label]) => ({ text: label, callback_data: `k:${key}` })), 2));
}
