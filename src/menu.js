import { createHash } from 'node:crypto';
import { compactId } from './review.js';
import { INTERVALS, NIGHT_PAUSES, TIME_ZONE, every, nightPause } from './settings.js';

// The Telegram menu (☰ next to the message field): two entry points, everything else is a button in the chat.
// Hidden but still working: /start, /setup, /search, /pause, /prompt, /autosend, /connect, /immomio, /login. Admin only: /users, /model.
export const COMMANDS = [
  ['status', 'Überblick: Suche, wartende und gesendete Bewerbungen'],
  ['settings', 'Suche, Über dich, Schreibstil, Verbindungen'],
];
export const MENU_HINT = 'Schick /status, um zu sehen, was ich gerade mache, und /settings, um etwas zu ändern.';

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
// The menus are two trees, each view shown in place of the last: 📬 📨 below /status, everything else below /settings.
// Both roots are reached by their command (and /status leads to ⚙️ Settings) and end with ✖️ Close; every other view's last row leads one level up.
const back = (to, text = '← Zurück') => [{ text, callback_data: `x:${to}` }];
// The roots, /status and /settings, close instead: the menu message goes away.
const CLOSE = [{ text: '✖️ Schließen', callback_data: 'x:close' }];
const BACK = { status: back('status', '← Status'), settings: back('settings', '← Einstellungen'), admin: back('admin', '← Admin'), catalog: back('catalog', '← Suchen') };
const WHEN = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });
const when = time => time ? WHEN.format(time) : 'noch nie';
const link = review => `<a href="https://www.immobilienscout24.de/expose/${encodeURIComponent(review.exposeId)}">${esc(review.snapshot.title)}</a>`;
export const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
// How many people picked a search.
const usedBy = using => using === 1 ? '1 Person nutzt sie' : using ? `${using} Personen nutzen sie` : 'Niemand nutzt sie';

// A search's schedule as people read it: "alle 2 Min. · 🌙 22:00–07:00".
const schedule = ({ intervalMs, quietHours }) => `alle ${every(intervalMs)} · 🌙 ${quietHours ? nightPause(quietHours) : 'keine Nachtpause'}`;
// How long ago, as people say it: "gerade eben", "vor 5 Min.", "vor 3 Std.", then the date.
function ago(time, now = Date.now()) {
  if (!time) return 'noch nie';
  const minutes = Math.floor((now - time) / 60_000);
  return minutes < 1 ? 'gerade eben' : minutes < 60 ? `vor ${minutes} Min.` : minutes < 24 * 60 ? `vor ${Math.floor(minutes / 60)} Std.` : when(time);
}
// status: { counts, failures: { IS24, LLM }, blocked, paused, autoSend, email, immomioEmail,
// llm: { model, thinking } (only for the admin; internal to everyone else), chatgpt: { email, plan },
// searches: [{ name, intervalMs, quietHours, quiet, crawledAt, failures, blocked }] (the ones picked), quiet: all of them are in their night pause }
// Blocks, most important first: what I do, your listings, the searches, the connections, how ChatGPT works.
export function statusView(s) {
  const n = key => s.counts[key] ?? 0;
  const trouble = (failures, blocked) => blocked ? '⛔ blockiert mich, ich warte länger' : failures ? `⚠️ ${plural(failures, 'Fehler', 'Fehler')} in Folge` : '';
  // ✅ connected, ⚠️ connected but failing (why on the next line), ▫️ not connected and how to connect.
  const account = (name, email, failures = 0, blocked = false, connect = '') => {
    if (!email && connect) return `▫️ ${name} · nicht verbunden · ${connect}`;
    const problem = trouble(failures, blocked);
    return `${problem ? '⚠️' : '✅'} ${name}${email ? ` · ${esc(email)}` : ''}${problem ? `\n└ ${problem}` : ''}`;
  };
  const state = s.paused ? '<b>⏸ Pausiert</b>\nIch suche nicht. Wartende Entwürfe und das Senden funktionieren weiter.'
    : s.quiet ? '<b>🌙 Nachtpause</b>\nAlle deine Suchen ruhen bis zum Morgen.' : `<b>🟢 Suche läuft</b> · ${plural(s.searches.length, 'Suche', 'Suchen')}`;
  const waiting = n('awaiting_approval'), working = n('discovered') + n('approved') + n('submitting');
  const listings = [
    waiting ? `📬 <b>${waiting} ${waiting === 1 ? 'wartet' : 'warten'} auf dich</b>` : '📬 Nichts wartet auf dich',
    `📨 Gesendet: ${n('sent')}${working ? ` · ⏳ in Arbeit: ${working}` : ''}`,
    ...(n('unknown_outcome') ? [`⚠️ Auf IS24 prüfen: ${n('unknown_outcome')}`] : []),
    ...(n('failed') + n('analysis_failed') ? [`❌ Nicht gesendet: ${n('failed') + n('analysis_failed')}`] : []),
    `🙈 Passt nicht: ${n('dismissed')} · 👀 schon vor meinem Start online: ${n('existing')}`,
  ];
  const searches = s.searches.map(search => {
    const problem = search.blocked ? '⛔ IS24 blockiert sie, ich warte länger' : search.failures ? `⚠️ ${plural(search.failures, 'Fehler', 'Fehler')} in Folge` : '';
    return `<b>${esc(search.name)}</b> · ${schedule(search)}\n└ ${problem ? `${problem} · ` : ''}${search.quiet && !s.quiet ? 'ruht gerade · ' : ''}geprüft: ${ago(search.crawledAt)}`;
  });
  const plan = s.chatgpt.plan ? ` ${esc(s.chatgpt.plan[0].toUpperCase() + s.chatgpt.plan.slice(1))}` : '';
  const blocks = [
    [state],
    ['<b>📊 Inserate</b>', ...listings],
    ['<b>🔎 Suchen</b>', ...(searches.length ? searches : ['Keine ausgewählt. 🔍 Suche in /settings.'])],
    ['<b>🔗 Verbindungen</b>', account('ImmoScout24', s.email, s.failures.IS24, s.blocked, '/connect'), account('Immomio', s.immomioEmail, 0, false, '/immomio'),
      account(`ChatGPT${plan}`, s.chatgpt.email, s.failures.LLM)],
    ['<b>🤖 Agent</b>', ...(s.llm ? [`🧠 Modell: ${esc(s.llm.model)} · Denken ${esc(s.llm.thinking || 'Standard')}`] : []),
      `📤 Auto-Senden ${s.autoSend ? '<b>an</b>: klare Treffer gehen von selbst raus' : 'aus: du gibst jede Bewerbung frei'}`],
  ];
  return html(blocks.map(block => block.join('\n')).join('\n\n'), [
    [s.paused ? { text: '▶️ Fortsetzen', callback_data: 'x:pause' } : { text: '⏸ Pausieren', callback_data: 'x:pause' }],
    [{ text: `📬 Wartend (${waiting})`, callback_data: 'x:waiting' }, { text: `📨 Gesendet (${n('sent') + n('unknown_outcome') + n('failed')})`, callback_data: 'x:sent' }],
    [{ text: '⚙️ Einstellungen', callback_data: 'x:settings' }],
    CLOSE,
  ]);
}

// One way to everything you can change; each button opens that setting's view in place, 📤 switches at once.
// admin: the shared ChatGPT login, and who is on this agent. Each search's schedule is set on the search (🔍 Search → 🔎 Searches).
export function settingsView({ autoSend, admin }) {
  return html([
    '<b>⚙️ Einstellungen</b>', 'Tippe auf das, was du ändern möchtest.', '',
    autoSend ? '📤 Auto-Senden ist <b>an</b>: Klare Treffer sende ich selbst und zeige dir, was rausging. Bei unklaren frage ich dich weiterhin zuerst.'
      : '📤 Auto-Senden ist <b>aus</b>: Du gibst jede Bewerbung frei. Eingeschaltet sende ich klare Treffer selbst; bei unklaren frage ich dich weiterhin zuerst.',
  ].join('\n'), [
    [{ text: '🔍 Suche', callback_data: 'x:requirements' }, { text: '👤 Über dich', callback_data: 'x:about' }],
    [{ text: '✍️ Schreibstil', callback_data: 'x:style' }],
    [{ text: `📤 Auto-Senden: ${autoSend ? 'an' : 'aus'}`, callback_data: 'x:autosend' }],
    [{ text: '🔗 ImmoScout24', callback_data: 'x:reconnect:/connect' }, { text: '🔗 Immomio', callback_data: 'x:reconnect:/immomio' }],
    ...(admin ? [[{ text: '🛠 Admin', callback_data: 'x:admin' }]] : []),
    CLOSE,
  ]);
}

// What only the admin changes, for everyone on this agent.
export function adminView() {
  return html([
    '<b>🛠 Admin</b>', 'Nur du siehst das. Was du hier änderst, gilt für alle bei diesem Agenten.', '',
    '🔎 <b>Suchen verwalten</b>: die Suchen, aus denen alle wählen, hinzufügen, umbenennen, neu verlinken und entfernen, und festlegen, wie oft jede läuft.',
    '👥 <b>Personen</b>: Personen einladen und entfernen.',
    '🧠 <b>Modell</b>: das ChatGPT-Modell für alle. Es liest jedes neue Inserat und schreibt die Nachrichten und schreibt sie um.',
    '🔗 <b>ChatGPT</b>: das eine ChatGPT-Konto, mit dem die Inserate aller gelesen werden.',
  ].join('\n'), [
    [{ text: '🔎 Suchen verwalten', callback_data: 'x:catalog' }],
    [{ text: '🧠 Modell', callback_data: 'x:model' }],
    [{ text: '👥 Personen', callback_data: 'x:users' }, { text: '🔗 ChatGPT', callback_data: 'x:reconnect:/login' }],
    BACK.settings,
  ]);
}

// users: [{ id, email, ready, admin }]. Each button removes that person after a confirmation.
export function usersView(users) {
  const lines = users.map(user => `${user.admin ? '👑' : user.ready ? '✅' : '⏳'} ${esc(user.email || 'IS24 nicht verbunden')} · <code>${esc(user.id)}</code>`);
  return html(`<b>👥 Personen bei diesem Agenten</b>\n\n${lines.join('\n')}\n\n✅ eingerichtet · ⏳ noch in der Einrichtung · 👑 Admin`,
    [[{ text: '➕ Einladen', callback_data: 'x:invite' }], ...users.filter(user => !user.admin).map(user => [{ text: `🗑 ${user.email || user.id}`, callback_data: `x:rm:${user.id}` }]), BACK.admin]);
}
export function removeUserView(id) {
  return html(`<b><code>${esc(id)}</code> entfernen?</b>\nDie Person bekommt keine Inserate mehr und der Bot ignoriert sie. Ihre Daten bleiben auf dem Server, in einem Ordner namens removed-${esc(id)}-….`,
    [[{ text: '🗑 Ja, entfernen', callback_data: `x:rm:${id}:yes` }], back('users', 'Abbrechen')]);
}

// Newest first; each number re-sends that listing with its buttons.
export function waitingView(reviews) {
  if (!reviews.length) return html('<b>📬 Wartet auf dich</b>\n\nNichts wartet. Neue Treffer kommen hier im Chat an.', [BACK.status]);
  const shown = reviews.slice(-20).reverse();
  const lines = shown.map((review, index) => `${index + 1}. ${link(review)}\n      ${esc(review.snapshot.price ?? '?')} € · ${esc(review.snapshot.rooms ?? '?')} Zi. · ${esc(review.snapshot.area ?? '?')} m²`);
  const more = reviews.length > shown.length ? `\n\n…und ${reviews.length - shown.length} ältere.` : '';
  return html(`<b>📬 Wartet auf dich</b>\n\n${lines.join('\n')}${more}\n\nTippe auf eine Nummer, um das Inserat mit seinen Buttons noch einmal zu zeigen.`, [
    ...rows(shown.map((review, index) => ({ text: String(index + 1), callback_data: `x:show:${compactId(review.id)}` })), 5),
    [{ text: `🧹 Alle ${reviews.length} verwerfen`, callback_data: 'x:clear' }],
    BACK.status,
  ]);
}
// Clearing dismisses every waiting listing, so it asks once more.
export function clearView(count) {
  return html(`<b>🧹 ${plural(count, 'wartendes Inserat', 'wartende Inserate')} verwerfen?</b>\nSie werden verworfen und es wird keine Nachricht gesendet. Neue Inserate kommen weiterhin an.`,
    [[{ text: `🧹 Ja, alle ${count} verwerfen`, callback_data: `x:clear:${count}` }], back('waiting', 'Abbrechen')]);
}

const OUTCOME = { sent: '✅', unknown_outcome: '⚠️', failed: '❌' };
// Telegram refuses a message over 4096 characters: as many lines as fit, counted with their markup to be safe.
const fitting = (lines, room) => { let used = 0; return lines.filter(line => (used += line.length + 1) <= room); };
export function sentView(reviews) {
  const shown = reviews.filter(review => OUTCOME[review.status]).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 20);
  if (!shown.length) return html('<b>📨 Bewerbungen</b>\n\nNoch keine gesendet.', [BACK.status]);
  const lines = fitting(shown.map(review => `${OUTCOME[review.status]} ${link(review)}\n      ${when(review.finishedAt)}${review.approvedBy === 'auto' ? ' · automatisch gesendet' : ''}${review.status === 'sent' ? '' : ` · ${esc(review.detail || '')}`}`), 3800);
  return html(`<b>📨 Bewerbungen</b>\n\n${lines.join('\n')}\n\n✅ von IS24 angenommen · ⚠️ unklar, auf IS24 prüfen · ❌ nicht gesendet`, [BACK.status]);
}

// The one ChatGPT model the admin sets for everyone, for screening and writing alike.
// models: [{ id, name, thinking: [levels], defaultThinking }]. Step 1 of 2: the model.
export function modelView(models, current, thinking) {
  return html(`<b>🧠 Modell</b>\nLiest für alle bei diesem Agenten jedes neue Inserat und entscheidet, ob es sie erreicht, und schreibt die Nachrichten und schreibt sie um: ✨ Schreiben, ✏️ Umschreiben und Auto-Senden. Das Prüfen läuft viel öfter als das Schreiben, ein schnelles Modell spart also Nutzung des Abos.\n\nAktuell: <b>${esc(current)}</b> · Denken ${esc(thinking || 'Standard')}\n\n1️⃣ Wähle ein Modell, dann 2️⃣ wie gründlich es denken soll.`,
    [...fit(models.map((model, index) => ({ text: `${model.id === current ? '✓ ' : ''}${model.name}`, callback_data: `x:m:${index}:${fingerprint(model.id)}` })), 2),
      BACK.admin]);
}
// Step 2 of 2: a thinking level the chosen model supports.
export function thinkingView(model, modelIndex, current, thinking) {
  const active = model.id === current ? thinking || model.defaultThinking : null;
  const label = level => `${level === active ? '✓ ' : ''}${level}`;
  const fallback = model.defaultThinking ? `\nSein Standard: ${esc(model.defaultThinking)}.` : '';
  return html(`<b>🧠 Denken für ${esc(model.name)}</b>\nMehr Denken: bessere Einschätzungen und Entwürfe, aber langsamer und mehr Nutzung des Abos.${fallback}`,
    [...fit(model.thinking.map(level => ({ text: label(level), callback_data: `x:t:${modelIndex}:${level}:${fingerprint(model.id)}` })), 3), back('model', '← Modelle')]);
}

const span = ({ min, max }, unit) => min === null && max === null ? 'egal' : min === null ? `bis ${max}${unit}` : max === null ? `ab ${min}${unit}` : `${min}–${max}${unit}`;
const quote = body => `<blockquote expandable>${esc(body)}</blockquote>`;
// A button that opens a settings form (forms.js) in Telegram.
const editButton = (url, text = '✏️ Bearbeiten') => ({ text, web_app: { url } });

// searches: the names you picked. limits: { price, rooms, livingSpace }, see Settings. edit: the search form's address.
export function requirementsView(preferences, { searches, limits }, edit) {
  const hard = [`🔎 Suchen: ${esc(searches.join(', '))}`, `💶 Warmmiete: ${span(limits.price, ' €')}`, `🚪 Zimmer: ${span(limits.rooms, '')}`, `📐 Wohnfläche: ${span(limits.livingSpace, ' m²')}`];
  return html([
    '<b>🔍 Suche</b>', ...hard,
    '', '<b>🎯 AI-Filter</b>', quote(preferences || 'Noch keiner.'),
    'Inserate außerhalb deiner Suchen, Miete, Zimmer oder Wohnfläche erreichen dich nie. Den Rest prüft ChatGPT mit deinem AI-Filter und überspringt, was klar nicht passt; jedes andere Inserat kommt zu dir.',
  ].join('\n'), [[{ text: '🔎 Suchen', callback_data: 'x:searches' }, editButton(edit)], BACK.settings]);
}

// catalog: the admin's [{ name, url, intervalMs, quietHours }]. selected: the names this person picked.
// Everyone picks here. Only the admin adds, changes and removes searches, in 🛠 Admin (catalogView); during setup,
// before there is one to pick, the admin also adds them here (manage).
// ready: setup is done, so the list leads back to 🔍 Search; during setup, Done goes on with it.
export function searchesView({ catalog, selected, admin, ready }) {
  const manage = admin && !ready;
  const lines = catalog.map(search => `<b>${esc(search.name)}</b> · ${schedule(search)}`).join('\n');
  const empty = manage ? 'Noch keine. Tippe auf ➕ Hinzufügen für die erste.' : 'Noch keine. Der Admin fügt sie hinzu.';
  return html(`<b>🔎 Aus welchen Suchen möchtest du Inserate?</b>\nTippe zum Auswählen. Deine Miete, Zimmer, Wohnfläche und dein AI-Filter gelten für jede.\n\n${lines || empty}`, [
    ...catalog.map(({ name }, index) => [{ text: `${selected.includes(name) ? '✅' : '⬜'} ${name}`, callback_data: `x:st:${index}:${fingerprint(name)}` },
      ...(manage ? [{ text: '⚙️', callback_data: `x:se:${index}:${fingerprint(name)}` }] : [])]),
    ...(manage ? [[{ text: '➕ Hinzufügen', callback_data: 'x:sa' }]] : []),
    [{ text: ready ? '← Suche' : 'Fertig', callback_data: 'x:sd' }],
  ]);
}
// 🛠 Admin → 🔎 Manage searches: the list everyone picks from. using(name): how many people picked it.
export function catalogView(catalog, using) {
  const lines = catalog.map(search => `<a href="${esc(new URL(search.url).href)}">${esc(search.name)}</a> · ${schedule(search)}\n└ ${usedBy(using(search.name))}`).join('\n');
  return html(`<b>🔎 Suchen für alle</b>\nAlle wählen daraus in 🔍 Suche. Jede läuft so oft und pausiert nachts wie angezeigt; ⚙️ ändert das, benennt sie um, verlinkt sie neu oder entfernt sie.\n\n${lines || 'Noch keine. Tippe auf ➕ Hinzufügen für die erste.'}`, [
    ...fit(catalog.map(({ name }, index) => ({ text: `⚙️ ${name}`, callback_data: `x:se:${index}:${fingerprint(name)}` })), 2),
    [{ text: '➕ Hinzufügen', callback_data: 'x:sa' }],
    BACK.admin,
  ]);
}
// One search of the admin's list. using: how many people picked it.
export function searchView(search, index, using) {
  const mark = fingerprint(search.name);
  return html(`<b>🔎 ${esc(search.name)}</b>\n<a href="${esc(new URL(search.url).href)}">Auf ImmoScout24 öffnen</a>\n⏱ Alle ${every(search.intervalMs)}\n🌙 Nachtpause: ${search.quietHours ? nightPause(search.quietHours) : 'aus'}\n${usedBy(using)}.`, [
    [{ text: `⏱ ${every(search.intervalMs)}`, callback_data: `x:si:${index}:${mark}` }, { text: `🌙 ${search.quietHours ? nightPause(search.quietHours) : 'Aus'}`, callback_data: `x:sq:${index}:${mark}` }],
    [{ text: '✏️ Umbenennen', callback_data: `x:sn:${index}:${mark}` }, { text: '🔗 Link ändern', callback_data: `x:su:${index}:${mark}` }],
    [{ text: '🗑 Entfernen', callback_data: `x:sr:${index}:${mark}` }],
    BACK.catalog,
  ]);
}
// How often a search runs (what: 'si') or when it pauses ('sq'): each button saves one choice.
export function scheduleView(search, index, what) {
  const mark = fingerprint(search.name);
  const [title, note, options, current, label] = what === 'si'
    ? [`⏱ Wie oft soll ich ${esc(search.name)} durchsuchen?`, 'Früh dran zu sein zählt am meisten; alle 2 Minuten ist ein guter Kompromiss. Jede Prüfung kostet eine Anfrage bei IS24.', INTERVALS, search.intervalMs, value => `alle ${every(value)}`]
    : [`🌙 Wann soll ${esc(search.name)} pausieren?`, 'Nachts veröffentlicht kaum jemand Inserate. Deutsche Zeit.', NIGHT_PAUSES, search.quietHours, value => value ? nightPause(value) : 'Rund um die Uhr'];
  return html(`<b>${title}</b>\n${note}\nDas gilt für alle, die diese Suche ausgewählt haben.`, [
    ...fit(options.map((option, choice) => ({ text: `${option === current ? '✓ ' : ''}${label(option)}`, callback_data: `x:${what}:${index}:${mark}:${choice}` })), 3),
    [{ text: '← Zurück', callback_data: `x:se:${index}:${mark}` }],
  ]);
}
// listings: the newest results of the test run, so the admin can see the area and filters took effect.
export function searchAddedView(name, listings) {
  const newest = listings.slice(0, 3).map(({ title, address, url }) => `• <a href="${esc(url)}">${esc(title)}</a>${address ? `, ${esc(address)}` : ''}`).join('\n');
  return html(`✅ <b>${esc(name)}</b> funktioniert: IS24 hat geantwortet.\n\n${newest ? `Neueste Inserate:\n${newest}\n\nLiegen sie außerhalb des gewählten Gebiets, hat IS24 das Gebiet nicht aus dem Link übernommen: Entferne die Suche dann.` : 'Gerade gibt es keine Inserate, was bei einem kleinen Gebiet stimmen kann.'}`, []);
}
export function removeSearchView({ name }, index, using) {
  return html(`<b>${esc(name)} entfernen?</b>\n${usedBy(using)}${using ? ' und wird benachrichtigt' : ''}.`,
    [[{ text: '🗑 Ja, entfernen', callback_data: `x:sr:${index}:${fingerprint(name)}:yes` }], back('catalog', 'Abbrechen')]);
}

// Two texts of up to 2000 characters, shortened when together they would not fit one Telegram message.
const STYLE_ROOM = 3200;
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
// How ChatGPT writes, and everything else it gets with each listing (the fixed safety rules are not shown).
// style: Settings#style(), or null.
export function styleView(style, edit) {
  const max = (style?.instructions ?? '').length + (style?.example ?? '').length > STYLE_ROOM ? STYLE_ROOM / 2 : STYLE_ROOM;
  return html([
    '<b>✍️ Schreibstil</b>', 'Wie ChatGPT deine Bewerbungen schreibt.', '',
    quote(clip(style?.instructions || 'Noch keiner: höflich und knapp. Zum Beispiel „Förmlich, kurz, immer erwähnen, dass ich Nichtraucher bin.“', max)),
    ...(style?.example ? ['Beispielnachricht:', quote(clip(style.example, max))] : []),
    '', '<b>Was ChatGPT zu jedem neuen Inserat bekommt</b>',
    '• diesen Schreibstil', '• deinen 🎯 AI-Filter, aus 🔍 Suche', '• dein 👤 Über dich und deine Kontaktdaten', '• das Inserat selbst, als Daten, nie als Anweisungen',
  ].join('\n'), [[editButton(edit), ...(style ? [{ text: '🗑 Entfernen', callback_data: 'x:clearStyle' }] : [])], BACK.settings]);
}
// persona: the stored persona.* values without the prefix; email: the IS24 login, which IS24 sends along.
const SALUTATION = { FEMALE: 'Frau', MALE: 'Herr' };
// Blocks as in the 👤 About you form; ▫️ marks what is missing and why it matters.
export function aboutView(persona, email, edit) {
  const name = [SALUTATION[persona.anrede], persona.vorname, persona.nachname].filter(Boolean).join(' ');
  const address = [[persona.strasse, persona.hausnummer].filter(Boolean).join(' '), [persona.plz, persona.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const blocks = [
    ['<b>👤 Über dich</b>', 'Alles, was deine Bewerbungen über dich sagen, kommt von hier.'],
    ['<b>📇 Kontaktdaten</b> · gehen ins Kontaktformular von IS24',
      name ? `<b>${esc(name)}</b>` : '▫️ Noch kein Name',
      email ? `✉️ ${esc(email)} · dein IS24-Login` : '▫️ Keine E-Mail: IS24 ist nicht verbunden · /connect',
      persona.telefon ? `📞 ${esc(persona.telefon)}` : '▫️ Keine Telefonnummer · Vermieter rufen oft die ersten Bewerber an',
      address ? `🏠 ${esc(address)}` : '▫️ Keine Adresse'],
    ['<b>📝 Für ChatGPT</b> · was deine Bewerbungen über dich sagen dürfen',
      persona.about ? quote(persona.about) : '▫️ Noch nichts: Bewerbungen nennen nur deinen Namen.'],
    ['<b>📎 IS24 Selbstauskunft</b>', persona.sendProfile === true ? '✅ Hängt an jeder Bewerbung' : '▫️ Nicht angehängt'],
  ];
  return html(blocks.map(block => block.join('\n')).join('\n\n'), [[editButton(edit)], BACK.settings]);
}
