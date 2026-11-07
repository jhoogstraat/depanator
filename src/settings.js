import { parseRange } from './url-translator.js';

const MINUTE = 60_000;
// Control characters, and the ones that reorder or hide text (bidi overrides, byte order mark): never part of a setting.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/;
// A typed or filled-in value without surrounding space and with \n line ends; throws on hidden characters.
export function clean(value) {
  const text = String(value).replace(/\r\n?/g, '\n').trim();
  if (HIDDEN.test(text)) throw new Error('Please remove invisible or control characters.');
  return text;
}
// A parse function with the rules the form page checks while typing: maxLength, and pattern ({ source, flags }) with its message.
const rule = (parse, limits) => Object.assign(parse, limits);
function line(max, regex = null, hint = `Please write one line of at most ${max} characters.`) {
  return rule(value => {
    const text = clean(value);
    if (!text || text.length > max || /\n/.test(text) || (regex && !regex.test(text))) throw new Error(hint);
    return text;
  }, { maxLength: max, ...(regex && { pattern: { source: regex.source, flags: regex.flags }, message: hint }) });
}
function text(max) {
  return rule(value => {
    const result = clean(value);
    if (!result || result.length > max) throw new Error(`Please write between 1 and ${max} characters.`);
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
    if ([parsed.min, parsed.max].some(end => end !== null && (end > most || end <= 0))) throw new Error(`Please stay between 0 and ${most}.`);
    return stated;
  }, { maxLength: 20, pattern: { source: RANGE.source, flags: '' }, message: hint });
}
// The ChatGPT model when nobody picked one: for writing (each person's `model`) and screening (the admin's `screening`).
const DEFAULT_MODEL = 'gpt-6-luna';
export const SCREENING = { model: DEFAULT_MODEL, thinking: '' };

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
  if (!street || street.length > 80 || number.length > 10) throw new Error('Please write the street and then the house number, for example Musterstraße 12a.');
  return { 'persona.strasse': street.trim(), 'persona.hausnummer': number.replace(/\s/g, '') };
}, { maxLength: 100 });
// Names and places: letters, spaces and the punctuation they use.
const NAME = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
const PLACE = /^[\p{L}\p{M}][\p{L}\p{M}\d' .()\/-]*$/u;

// The forms Telegram opens in the chat (forms.js). Each edits its fields at once; `setup` forms are part of setup.
const FORMS = {
  search: { title: '🔍 What you are looking for', setup: true,
    intro: 'Rent, rooms and living space are checked exactly. Your requirements are read by ChatGPT for every listing that passes them.' },
  profile: { title: '👤 About you', setup: true, intro: 'Used for your applications: contact details go into IS24\'s contact form, the text about you goes to ChatGPT, which writes the message.' },
  style: { title: '✍️ The agent\'s writing style', intro: 'How ChatGPT writes your applications: tone, length, what to always mention. It still states only facts from 👤 About you.' },
};

// The parts of an application, each with its own instructions and example wording in the ✍️ style form.
// `overall` keeps the key `style`, where the single style text was stored before.
export const STYLE_SECTIONS = [
  { name: 'overall', key: 'style', title: 'Overall', hint: 'Tone, length and language of the whole message. Leave everything empty for a polite, concise default.',
    placeholder: 'Formal and short, at most 120 words. Always in German.', example: 'A whole application you like.' },
  { name: 'greeting', key: 'style.greeting', title: 'Greeting', hint: 'How to address the landlord.',
    placeholder: 'Use the contact\'s name when the listing gives one.', example: 'Sehr geehrte Frau Müller,' },
  { name: 'introduction', key: 'style.introduction', title: 'Introduction', hint: 'How to introduce you. The facts still come only from 👤 About you.',
    placeholder: 'Start with my job and that I am a non-smoker.', example: 'mein Name ist Alex Doe, ich arbeite als Softwareentwickler …' },
  { name: 'mainPart', key: 'style.mainPart', title: 'Main part', hint: 'Why this flat, and what to ask for.',
    placeholder: 'Mention one detail of the listing I like. Ask for a viewing.', example: 'Besonders gefällt mir der Balkon …' },
  { name: 'closing', key: 'style.closing', title: 'Closing', hint: 'How to end and sign off.',
    placeholder: 'Offer to send documents. Sign with my full name.', example: 'Über eine Einladung zur Besichtigung freue ich mich sehr.\nMit freundlichen Grüßen\nAlex Doe' },
];

// Every setting the chat can change. `form` settings are edited in that form; the others are asked in the chat,
// in setup order. `setup: false` settings have a default and are changed from /settings.
// Persona values fill the IS24 contact request; the LLM may use only them.
const FIELDS = [
  { key: 'rent', form: 'search', label: 'Highest warm rent in €', hint: 'A number, or a range such as 800-1500. Empty: any rent.', placeholder: '1500',
    parse: range(text => `-${text}`, 'Please write a rent like 1500 or 800-1500.', 20_000), optional: true },
  { key: 'rooms', form: 'search', label: 'Rooms', hint: 'At least this many, or a range such as 2-3. Empty: any.', placeholder: '2',
    parse: range(text => `${text}-`, 'Please write rooms like 2 or 2-3.', 20), optional: true },
  { key: 'area', form: 'search', label: 'Living space in m²', hint: 'At least this much, or a range such as 50-80. Empty: any.', placeholder: '50',
    parse: range(text => `${text}-`, 'Please write a living space like 50 or 50-80.', 1000), optional: true },
  { key: 'preferences', form: 'search', label: 'Requirements', type: 'textarea', section: '🎯 Requirements',
    hint: 'Everything else that matters to you, in your own words. Listings that clearly break one are skipped without asking you; every other listing comes to you.',
    placeholder: 'Quiet, with a balcony. At most 2nd floor without a lift. No swap flats.', parse: text(2000) },
  { key: 'persona.anrede', form: 'profile', section: 'Contact details', label: 'Salutation', type: 'select', choices: [['FEMALE', 'Frau'], ['MALE', 'Herr'], ['NO_SALUTATION', 'No salutation']] },
  { key: 'persona.vorname', form: 'profile', label: 'First name', parse: line(60, NAME, 'Please write your first name in letters, at most 60.'), autocomplete: 'given-name' },
  { key: 'persona.nachname', form: 'profile', label: 'Last name', parse: line(60, NAME, 'Please write your last name in letters, at most 60.'), autocomplete: 'family-name' },
  { key: 'persona.telefon', form: 'profile', label: 'Phone', hint: 'Landlords often call the first applicants.', placeholder: '+49 170 1234567', type: 'tel', autocomplete: 'tel',
    parse: line(25, /^\+?[\d\s/()-]{5,25}$/, 'Please write a phone number, e.g. +49 170 1234567.'), optional: true },
  // Stored as persona.strasse and persona.hausnummer.
  { key: 'address', form: 'profile', label: 'Street and house number', placeholder: 'Musterstraße 12a', autocomplete: 'street-address', optional: true, parse: streetAndNumber,
    keys: ['persona.strasse', 'persona.hausnummer'], read: values => [values['persona.strasse'], values['persona.hausnummer']].filter(Boolean).join(' ') },
  { key: 'persona.plz', form: 'profile', label: 'Postcode', placeholder: '10115', inputmode: 'numeric', autocomplete: 'postal-code', parse: line(5, /^\d{5}$/, 'Please write a 5-digit postcode.'), optional: true },
  { key: 'persona.ort', form: 'profile', label: 'City', placeholder: 'Berlin', autocomplete: 'address-level2', parse: line(60, PLACE, 'Please write a city name, at most 60 characters.'), optional: true },
  { key: 'persona.about', form: 'profile', section: 'About you, for ChatGPT', label: 'About you', type: 'textarea', optional: true, parse: text(1000),
    hint: 'Free text that ChatGPT uses when it writes your applications. Applications mention only what you write here.',
    placeholder: 'Software developer, permanent job, 3,800 € net. Non-smoker, no pets. Moving in from March. SCHUFA and proof of income ready.' },
  { key: 'persona.sendProfile', form: 'profile', section: 'IS24 Selbstauskunft', label: 'Attach my IS24 Selbstauskunft to applications', type: 'checkbox',
    hint: 'Your tenant profile on immobilienscout24.de (Mieterprofil / Selbstauskunft). Landlords see what you filled in there; check it on IS24 first.' },
  ...STYLE_SECTIONS.flatMap(section => [
    { key: section.key, form: 'style', section: section.title, label: 'Instructions', type: 'textarea', optional: true, setup: false, parse: text(1000), hint: section.hint, placeholder: section.placeholder },
    { key: `${section.key}.example`, form: 'style', label: 'Example wording', type: 'textarea', optional: true, setup: false, parse: text(2000),
      hint: 'Optional. ChatGPT takes it as a model for tone and form, not as text to copy.', placeholder: section.example },
  ]),
  { key: 'autoSend', label: 'Auto-send', ask: 'Should I send applications myself when a listing clearly fits? You get the listing and the sent message afterwards. Unclear matches always ask you first.', default: false,
    choices: [[false, 'Ask me each time'], [true, 'Auto-send clear matches']], setup: false },
  // ✍️ Writing model: writes and rewrites this person's messages. Screening uses the admin's (SCREENING).
  { key: 'model', label: 'Writing model', ask: 'Which ChatGPT model should write your messages? It must be available to the ChatGPT plan.', default: DEFAULT_MODEL, setup: false, parse: line(60, /^[a-zA-Z0-9._-]{1,60}$/, 'Please send a model name like gpt-6-luna.') },
  // '' = the model's own default. Chosen together with the model (🧠 Model), from the levels it supports.
  { key: 'thinking', label: 'Thinking', ask: 'How hard should ChatGPT think?', default: '', empty: 'default', optional: true, setup: false, parse: line(60, /^[a-z]{1,20}$/, 'Please pick a thinking level from /settings → 🧠 Model.') },
  { key: 'paused', label: 'Searching', ask: 'Should I search for new listings?', default: false, setup: false, choices: [[false, 'Searching'], [true, 'Paused']] },
];
const FIELD = Object.fromEntries(FIELDS.map(field => [field.key, field]));
const stored = field => field.keys ?? [field.key];
const PERSONA = ['anrede', 'vorname', 'nachname', 'telefon', 'strasse', 'hausnummer', 'plz', 'ort', 'about', 'sendProfile'];
// How often and when each of the admin's searches runs. A new search starts with the admin's last choice.
// Being early matters most; every 2 minutes is a good balance. Hardly anyone publishes listings at night.
export const SCHEDULE = { intervalMs: 2 * MINUTE, quietHours: '22-7' };
export const INTERVALS = [1, 2, 3, 5, 10, 30].map(minutes => minutes * MINUTE);
export const NIGHT_PAUSES = ['22-7', '20-8', ''];
export const every = ms => ms % MINUTE ? `${ms / 1000} s` : `${ms / MINUTE} min`;
export const nightPause = quietHours => quietHours ? quietHours.split('-').map(hour => `${hour.padStart(2, '0')}:00`).join('–') : 'off';
// Set by pairing or an invite and by connecting IS24 or Immomio, never typed.
const INTERNAL = ['chatId', 'admin', 'accountEmail', 'immomioEmail'];

// A typed, tapped or written answer as the value to store. '' skips an optional field.
function parse(field, raw) {
  if (field.type === 'checkbox') return raw === true;
  if (field.optional && raw === '') return '';
  if (!field.choices) return field.parse(raw);
  if (!field.choices.some(([choice]) => choice === raw)) throw new Error('Please pick one of the options.');
  return raw;
}

// The configuration made in the chat. `config` is one live object shared by every module, updated in place.
export class Settings {
  constructor(store, runtime) {
    this.store = store;
    this.values = store.settings();
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
    if (value === undefined) return 'not set';
    if (value === '') return FIELD[key]?.empty ?? 'skipped';
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
    if (!Object.hasOwn(FORMS, part)) throw new Error('Unknown form');
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
    if (typeof part !== 'string' || !Object.hasOwn(FORMS, part) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown form');
    const fields = FIELDS.filter(entry => entry.form === part);
    if (Object.keys(input).some(key => !fields.some(field => field.key === key))) throw new Error('This page is outdated. Open it again from the chat.');
    const changes = {};
    for (const field of fields) {
      const fail = message => Object.assign(new Error(`${field.label}: ${message}`), { field: field.key });
      const raw = input[field.key] ?? (field.type === 'checkbox' ? false : '');
      if (field.type === 'checkbox' ? typeof raw !== 'boolean' : !field.choices && typeof raw !== 'string') throw fail('this value is not allowed.');
      if (raw === '' && !field.optional) throw fail('please fill this in.');
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
  // The writing style per section, { overall: { instructions, example }, ... } with only what is set; null if nothing is.
  style() {
    const sections = STYLE_SECTIONS.map(({ name, key }) => [name, Object.fromEntries([['instructions', this.values[key]], ['example', this.values[`${key}.example`]]].filter(([, text]) => text))]);
    const set = sections.filter(([, section]) => Object.keys(section).length);
    return set.length ? Object.fromEntries(set) : null;
  }
  apply() {
    const value = key => this.values[key] ?? FIELD[key]?.default;
    const limit = key => value(key) ? parseRange(value(key), key) : { min: null, max: null };
    Object.assign(this.config, {
      chatId: this.values.chatId ?? '', accountEmail: this.values.accountEmail ?? '', immomioEmail: this.values.immomioEmail ?? '', preferences: value('preferences') ?? '',
      searches: this.values.searches ?? [], limits: { price: limit('rent'), rooms: limit('rooms'), livingSpace: limit('area') },
      autoSend: value('autoSend'), paused: value('paused'), style: this.style(),
    });
    this.config.llm.model = value('model');
    this.config.llm.thinking = value('thinking');
    const persona = this.config.persona;
    for (const key of Object.keys(persona)) delete persona[key];
    for (const key of PERSONA) if (this.values[`persona.${key}`]) persona[key] = this.values[`persona.${key}`];
    if (this.config.accountEmail) persona.email = this.config.accountEmail;
  }
}
