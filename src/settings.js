import { parseRange } from './url-translator.js';

const MINUTE = 60_000;
// Control characters, and the ones that reorder or hide text (bidi overrides, byte order mark): never part of a setting.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/;
// A typed or filled-in value without surrounding space and with \n line ends; throws on hidden characters.
export function clean(value) {
  const text = String(value).replace(/\r\n?/g, '\n').trim();
  if (HIDDEN.test(text)) throw new Error('Bitte entferne unsichtbare Zeichen oder Steuerzeichen.');
  return text;
}
// A parse function with the rules the form page checks while typing: maxLength, and pattern ({ source, flags }) with its message.
const rule = (parse, limits) => Object.assign(parse, limits);
function line(max, regex = null, hint = `Bitte schreib eine Zeile mit höchstens ${max} Zeichen.`) {
  return rule(value => {
    const text = clean(value);
    if (!text || text.length > max || /\n/.test(text) || (regex && !regex.test(text))) throw new Error(hint);
    return text;
  }, { maxLength: max, ...(regex && { pattern: { source: regex.source, flags: regex.flags }, message: hint }) });
}
function text(max) {
  return rule(value => {
    const result = clean(value);
    if (!result || result.length > max) throw new Error(`Bitte schreib zwischen 1 und ${max} Zeichen.`);
    return result;
  }, { maxLength: max });
}
// A range as IS24 writes it ("800-1500", "-1500", "2-"), each end at most `most`. single(text): the range a lone number means.
const RANGE = /^\s*(?:\d+(?:[.,]\d+)?)?\s*(?:-\s*(?:\d+(?:[.,]\d+)?)?)?\s*$/;
function range(single, hint, most) {
  return rule(value => {
    const text = clean(value).replace(/\s+/g, '').replaceAll(',', '.');
    const stated = /^[\d.]+$/.test(text) ? single(text) : text;
    let parsed;
    try { parsed = parseRange(stated, ''); } catch { throw new Error(hint); }
    if ([parsed.min, parsed.max].some(end => end !== null && (end > most || end <= 0))) throw new Error(`Bitte bleib zwischen 0 und ${most}.`);
    return stated;
  }, { maxLength: 20, pattern: { source: RANGE.source, flags: '' }, message: hint });
}
// The ChatGPT model and thinking level ('' = the model's default) until the admin picks one.
export const DEFAULT_LLM = { model: 'gpt-6-luna', thinking: '' };

// Every time the agent shows or schedules by. ponytail: German time fixed; IS24 is a German site. Make it a setting if that ever changes.
export const TIME_ZONE = 'Europe/Berlin';
// Night pause "from-to" in German time (from > to wraps past midnight); '' = around the clock.
export function isQuiet(quietHours, now = Date.now()) {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(quietHours || '');
  if (!match) return false;
  const [from, to] = [Number(match[1]), Number(match[2])];
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: TIME_ZONE }).formatToParts(now).find(part => part.type === 'hour').value);
  return from > to ? hour >= from || hour < to : hour >= from && hour < to;
}

// The searches of the admin's list that a person picked, and whether every one of them is in its night pause.
export const pickedSearches = (catalog, names) => catalog.filter(search => names.includes(search.name));
export const allQuiet = (searches, now = Date.now()) => searches.length > 0 && searches.every(search => isQuiet(search.quietHours, now));

// "Musterstraße 12a" as IS24 wants it: street and house number apart.
const streetAndNumber = rule(value => {
  const text = clean(value).replace(/\s+/g, ' ');
  const [, street, number] = /^(.*?\D)[\s,]*(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d*\s?[a-zA-Z]?)?)$/.exec(text) ?? [];
  if (!street || street.length > 80 || number.length > 10) throw new Error('Bitte schreib erst die Straße, dann die Hausnummer, zum Beispiel Musterstraße 12a.');
  return { 'persona.strasse': street.trim(), 'persona.hausnummer': number.replace(/\s/g, '') };
}, { maxLength: 100 });
// Names and places: letters, spaces and the punctuation they use.
const NAME = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
const PLACE = /^[\p{L}\p{M}][\p{L}\p{M}\d' .()\/-]*$/u;

// The forms Telegram opens in the chat (forms.js). Each edits its fields at once; `setup` forms are part of setup.
const FORMS = {
  search: { title: '🔍 Was du suchst', setup: true,
    intro: 'Warmmiete, Zimmer und Wohnfläche werden genau geprüft. Deinen AI-Filter liest ChatGPT bei jedem Inserat, das diese Grenzen erfüllt.' },
  profile: { title: '👤 Über dich', setup: true, intro: 'Für deine Bewerbungen: Die Kontaktdaten kommen ins Kontaktformular von IS24, der Text über dich geht an ChatGPT, das die Nachricht schreibt.' },
  style: { title: '✍️ Schreibstil', intro: 'Wie ChatGPT deine Bewerbungen schreibt: Ton, Länge, was immer rein soll. Fakten kommen weiterhin nur aus 👤 Über dich.' },
};

// Before one style text and one example, the style came in parts; on load they are folded into these two.
const STYLE_PARTS = [['greeting', 'Anrede'], ['introduction', 'Einleitung'], ['mainPart', 'Hauptteil'], ['closing', 'Schluss']];
function foldStyleParts(values, store) {
  const old = STYLE_PARTS.flatMap(([name]) => [`style.${name}`, `style.${name}.example`]).filter(key => key in values);
  if (!old.length) return;
  const fold = (base, suffix) => [values[base], ...STYLE_PARTS.map(([name, title]) => values[`style.${name}${suffix}`] && `${title}: ${values[`style.${name}${suffix}`]}`)].filter(Boolean).join('\n\n');
  const merged = { style: fold('style', ''), 'style.example': [values['style.example'], ...STYLE_PARTS.map(([name]) => values[`style.${name}.example`])].filter(Boolean).join('\n') };
  for (const [key, value] of Object.entries(merged)) if (value) { store.saveSetting(key, value); values[key] = value; }
  for (const key of old) { store.deleteSetting(key); delete values[key]; }
}

// Every setting the chat can change. `form` settings are edited in that form; the others are asked in the chat,
// in setup order. `setup: false` settings have a default and are changed from /settings.
// Persona values fill the IS24 contact request; the LLM may use only them.
const FIELDS = [
  // Ranges are a From and a To box on the form page, each with a number keyboard, sent as one "from-to".
  { key: 'rent', form: 'search', label: 'Warmmiete in €', type: 'range', inputmode: 'numeric', hint: 'Leer: beliebig.', placeholder: ['beliebig', '1500'],
    parse: range(text => `-${text}`, 'Bitte gib die Miete als Zahlen an, zum Beispiel 800 und 1500.', 20_000), optional: true },
  { key: 'rooms', form: 'search', label: 'Zimmer', type: 'range', inputmode: 'decimal', hint: 'Leer: beliebig.', placeholder: ['2', 'beliebig'],
    parse: range(text => `${text}-`, 'Bitte gib die Zimmer als Zahlen an, zum Beispiel 2 und 3.', 20), optional: true },
  { key: 'area', form: 'search', label: 'Wohnfläche in m²', type: 'range', inputmode: 'decimal', hint: 'Leer: beliebig.', placeholder: ['50', 'beliebig'],
    parse: range(text => `${text}-`, 'Bitte gib die Wohnfläche als Zahlen an, zum Beispiel 50 und 80.', 1000), optional: true },
  { key: 'preferences', form: 'search', label: 'AI-Filter', type: 'textarea', section: '🎯 AI-Filter',
    hint: 'Alles, was dir sonst wichtig ist, in deinen eigenen Worten. Inserate, die klar dagegen verstoßen, überspringe ich ohne Rückfrage; alle anderen kommen zu dir.',
    placeholder: 'Ruhig, mit Balkon. Ohne Aufzug höchstens 2. Stock. Keine Tauschwohnungen.', parse: text(2000) },
  { key: 'persona.anrede', form: 'profile', section: 'Kontaktdaten', label: 'Anrede', type: 'select', choices: [['FEMALE', 'Frau'], ['MALE', 'Herr'], ['NO_SALUTATION', 'Keine Anrede']] },
  { key: 'persona.vorname', form: 'profile', label: 'Vorname', parse: line(60, NAME, 'Bitte schreib deinen Vornamen in Buchstaben, höchstens 60.'), autocomplete: 'given-name' },
  { key: 'persona.nachname', form: 'profile', label: 'Nachname', parse: line(60, NAME, 'Bitte schreib deinen Nachnamen in Buchstaben, höchstens 60.'), autocomplete: 'family-name' },
  { key: 'persona.telefon', form: 'profile', label: 'Telefon', hint: 'Vermieter rufen oft die ersten Bewerber an.', placeholder: '+49 170 1234567', type: 'tel', autocomplete: 'tel',
    parse: line(25, /^\+?[\d\s/()-]{5,25}$/, 'Bitte gib eine Telefonnummer an, z. B. +49 170 1234567.'), optional: true },
  // Stored as persona.strasse and persona.hausnummer.
  { key: 'address', form: 'profile', label: 'Straße und Hausnummer', placeholder: 'Musterstraße 12a', autocomplete: 'street-address', optional: true, parse: streetAndNumber,
    keys: ['persona.strasse', 'persona.hausnummer'], read: values => [values['persona.strasse'], values['persona.hausnummer']].filter(Boolean).join(' ') },
  { key: 'persona.plz', form: 'profile', label: 'PLZ', placeholder: '10115', inputmode: 'numeric', autocomplete: 'postal-code', parse: line(5, /^\d{5}$/, 'Bitte gib eine fünfstellige PLZ an.'), optional: true },
  { key: 'persona.ort', form: 'profile', label: 'Ort', placeholder: 'Berlin', autocomplete: 'address-level2', parse: line(60, PLACE, 'Bitte gib einen Ort an, höchstens 60 Zeichen.'), optional: true },
  { key: 'persona.about', form: 'profile', section: 'Über dich, für ChatGPT', label: 'Über dich', type: 'textarea', optional: true, parse: text(1000),
    hint: 'Freitext, den ChatGPT für deine Bewerbungen nutzt. Bewerbungen erwähnen nur, was du hier schreibst.',
    placeholder: 'Softwareentwickler, unbefristet angestellt, 3.800 € netto. Nichtraucher, keine Haustiere. Einzug ab März. SCHUFA und Gehaltsnachweise liegen bereit.' },
  { key: 'persona.sendProfile', form: 'profile', section: 'IS24 Selbstauskunft', label: 'Meine IS24-Selbstauskunft an Bewerbungen anhängen', type: 'checkbox',
    hint: 'Dein Mieterprofil auf immobilienscout24.de (Selbstauskunft). Vermieter sehen, was du dort ausgefüllt hast; prüf es vorher auf IS24.' },
  { key: 'style', form: 'style', label: 'So soll ich schreiben', type: 'textarea', optional: true, setup: false, parse: text(2000),
    hint: 'Ton, Länge, Sprache, Anrede und Gruß, was immer rein soll. Leer: höflich und knapp.',
    placeholder: 'Förmlich und kurz, höchstens 120 Wörter, immer auf Deutsch. Sprich die Kontaktperson mit Namen an, wenn das Inserat einen nennt. Bitte um eine Besichtigung. Unterschreib mit meinem vollen Namen.' },
  { key: 'style.example', form: 'style', label: 'Beispielnachricht', type: 'textarea', optional: true, setup: false, parse: text(2000),
    hint: 'Optional. Eine ganze Bewerbung, die dir gefällt. ChatGPT nimmt sie als Vorbild für Ton und Form, nicht als Text zum Abschreiben.',
    placeholder: 'Sehr geehrte Frau Müller,\nmein Name ist Alex Doe …\nMit freundlichen Grüßen\nAlex Doe' },
  { key: 'autoSend', label: 'Auto-Senden', ask: 'Soll ich Bewerbungen selbst senden, wenn ein Inserat klar passt? Du bekommst danach das Inserat und die gesendete Nachricht. Bei unklaren Treffern frage ich dich immer zuerst.', default: false,
    choices: [[false, 'Jedes Mal fragen'], [true, 'Klare Treffer automatisch senden']], setup: false },
  { key: 'paused', label: 'Suche', ask: 'Soll ich nach neuen Inseraten suchen?', default: false, setup: false, choices: [[false, 'Suche läuft'], [true, 'Pausiert']] },
];
const FIELD = Object.fromEntries(FIELDS.map(field => [field.key, field]));
const stored = field => field.keys ?? [field.key];
const PERSONA = ['anrede', 'vorname', 'nachname', 'telefon', 'strasse', 'hausnummer', 'plz', 'ort', 'about', 'sendProfile'];
// How often and when each of the admin's searches runs. A new search starts with the admin's last choice.
// Being early matters most; every 2 minutes is a good balance. Hardly anyone publishes listings at night.
export const SCHEDULE = { intervalMs: 2 * MINUTE, quietHours: '22-7' };
export const INTERVALS = [1, 2, 3, 5, 10, 30].map(minutes => minutes * MINUTE);
export const NIGHT_PAUSES = ['22-7', '20-8', ''];
export const every = ms => ms % MINUTE ? `${ms / 1000} Sek.` : `${ms / MINUTE} Min.`;
export const nightPause = quietHours => quietHours ? quietHours.split('-').map(hour => `${hour.padStart(2, '0')}:00`).join('–') : 'aus';
// Set by pairing or an invite and by connecting IS24 or Immomio, never typed.
const INTERNAL = ['chatId', 'admin', 'accountEmail', 'immomioEmail'];

// A typed, tapped or written answer as the value to store. '' skips an optional field.
function parse(field, raw) {
  if (field.type === 'checkbox') return raw === true;
  if (field.optional && raw === '') return '';
  if (!field.choices) return field.parse(raw);
  if (!field.choices.some(([choice]) => choice === raw)) throw new Error('Bitte wähl eine der Optionen.');
  return raw;
}

// The configuration made in the chat. `config` is one live object shared by every module, updated in place.
export class Settings {
  constructor(store, runtime) {
    this.store = store;
    this.values = store.settings();
    foldStyleParts(this.values, store);
    this.config = { ...runtime, llm: { ...runtime.llm }, persona: {} };
    this.listeners = [];
    this.apply();
  }
  onChange(listener) { this.listeners.push(listener); }
  field(key) { return FIELD[key]; }
  // [value, label] pairs for button answers; empty for typed answers.
  choices(key) { return FIELD[key].choices || []; }
  // The next unanswered setup step: the pseudo-steps `is24` (connect the account), `searches` (pick from the
  // admin's list; everyone comes back here if their last one is removed) and `form` (fill in one form), then a field.
  next() {
    if (!this.values.accountEmail) return { key: 'is24' };
    if (!this.values.searches?.length) return { key: 'searches' };
    const unset = field => field.setup !== false && stored(field).some(key => this.values[key] === undefined);
    const part = Object.keys(FORMS).find(name => FORMS[name].setup && FIELDS.some(field => field.form === name && unset(field)));
    if (part) return { key: 'form', part };
    return FIELDS.find(field => !field.form && unset(field)) || null;
  }
  complete() { return Boolean(this.values.chatId) && !this.next(); }
  display(key) {
    const value = this.values[key] ?? FIELD[key]?.default;
    if (value === undefined) return 'nicht gesetzt';
    if (value === '') return FIELD[key]?.empty ?? 'übersprungen';
    return this.choices(key).find(([choice]) => choice === value)?.[1] ?? String(value);
  }
  // Validates, persists and applies. Errors are user-facing. '' skips an optional field.
  set(key, raw) {
    const field = FIELD[key];
    if (!field && !INTERNAL.includes(key)) throw new Error(`Unknown setting ${key}`);
    if (field?.keys) throw new Error(`${key} is set through its form`);
    return this.assign(key, field ? parse(field, raw) : raw);
  }
  // One form's fields with their values. prefill: { key: value } for fields never set, e.g. from the IS24 account.
  form(part, prefill = {}) {
    if (!Object.hasOwn(FORMS, part)) throw new Error('Unbekanntes Formular');
    const fields = FIELDS.filter(field => field.form === part).map(field => {
      const set = stored(field).some(key => this.values[key] !== undefined);
      const value = field.read ? field.read(this.values) : this.values[field.key];
      const { key, label, type = 'text', hint, placeholder, section, optional, autocomplete, inputmode } = field;
      const { maxLength, pattern, message } = field.parse ?? {};
      return { key, label, type, hint, placeholder, section, optional: Boolean(optional), autocomplete, inputmode, maxLength, pattern, message,
        ...(field.choices && { options: field.choices.map(([choice, text]) => ({ value: choice, text })) }),
        value: set ? value ?? '' : prefill[key] ?? (type === 'checkbox' ? false : ''), prefilled: !set && prefill[key] !== undefined };
    });
    return { part, ...FORMS[part], fields, hidden: HIDDEN.source }; // hidden: characters the page refuses, like clean().
  }
  // Saves a filled-in form at once, or nothing: the first invalid field throws, naming it (error.field: its key).
  // Only the form's own fields, each of its type: text as a string, a checkbox as true or false, a choice as one of its options.
  saveForm(part, input) {
    if (typeof part !== 'string' || !Object.hasOwn(FORMS, part) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unbekanntes Formular');
    const fields = FIELDS.filter(entry => entry.form === part);
    if (Object.keys(input).some(key => !fields.some(field => field.key === key))) throw new Error('Diese Seite ist veraltet. Öffne sie neu aus dem Chat.');
    const changes = {};
    for (const field of fields) {
      const fail = message => Object.assign(new Error(`${field.label}: ${message}`), { field: field.key });
      const raw = input[field.key] ?? (field.type === 'checkbox' ? false : '');
      if (field.type === 'checkbox' ? typeof raw !== 'boolean' : !field.choices && typeof raw !== 'string') throw fail('dieser Wert ist nicht erlaubt.');
      if (raw === '' && !field.optional) throw fail('bitte ausfüllen.');
      let value;
      try { value = parse(field, typeof raw === 'string' && !field.choices ? raw.trim() : raw); } catch (error) { throw fail(error.message); }
      Object.assign(changes, field.keys ? (value === '' ? Object.fromEntries(field.keys.map(key => [key, ''])) : value) : { [field.key]: value });
    }
    for (const [key, value] of Object.entries(changes)) if (this.values[key] !== value) this.assign(key, value);
    return changes;
  }
  // A value from the agent itself, not the chat.
  assign(key, value) {
    this.store.saveSetting(key, value);
    this.values[key] = value;
    this.apply();
    for (const listener of this.listeners) listener(key);
    return value;
  }
  // The writing style, { instructions, example } with only what is set; null if nothing is.
  style() {
    const style = Object.fromEntries([['instructions', this.values.style], ['example', this.values['style.example']]].filter(([, text]) => text));
    return Object.keys(style).length ? style : null;
  }
  apply() {
    const value = key => this.values[key] ?? FIELD[key]?.default;
    const limit = key => value(key) ? parseRange(value(key), key) : { min: null, max: null };
    Object.assign(this.config, {
      chatId: this.values.chatId ?? '', accountEmail: this.values.accountEmail ?? '', immomioEmail: this.values.immomioEmail ?? '', preferences: value('preferences') ?? '',
      searches: this.values.searches ?? [], limits: { price: limit('rent'), rooms: limit('rooms'), livingSpace: limit('area') },
      autoSend: value('autoSend'), paused: value('paused'), style: this.style(),
    });
    const persona = this.config.persona;
    for (const key of Object.keys(persona)) delete persona[key];
    for (const key of PERSONA) if (this.values[`persona.${key}`]) persona[key] = this.values[`persona.${key}`];
    if (this.config.accountEmail) persona.email = this.config.accountEmail;
  }
}
