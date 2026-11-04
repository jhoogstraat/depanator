import { parseRange } from './url-translator.js';

const MINUTE = 60_000;
function line(max) {
  return value => {
    const text = String(value).trim();
    if (!text || text.length > max || /[\r\n]/.test(text)) throw new Error(`Please send one line of at most ${max} characters.`);
    return text;
  };
}
function text(max) {
  return value => {
    const result = String(value).trim();
    if (!result || result.length > max) throw new Error(`Please send between 1 and ${max} characters.`);
    return result;
  };
}
function pattern(regex, hint) {
  return value => {
    const result = String(value).trim();
    if (!regex.test(result)) throw new Error(hint);
    return result;
  };
}
// A range as IS24 writes it ("800-1500", "-1500", "2-"). single(text): the range a lone number means.
function range(single, hint) {
  return value => {
    const text = String(value).trim().replace(',', '.');
    const stated = /^[\d.]+$/.test(text) ? single(text) : text;
    try { parseRange(stated, ''); return stated; } catch { throw new Error(hint); }
  };
}
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
function streetAndNumber(value) {
  const text = String(value).trim().replace(/\s+/g, ' ');
  const [, street, number] = /^(.*?\D)[\s,]*(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d*\s?[a-zA-Z]?)?)$/.exec(text) ?? [];
  if (!street || street.length > 80 || number.length > 10) throw new Error('Please write the street and then the house number, for example Musterstraße 12a.');
  return { 'persona.strasse': street.trim(), 'persona.hausnummer': number.replace(/\s/g, '') };
}

// The forms Telegram opens in the chat (forms.js). Each edits its fields at once; `setup` forms are part of setup.
export const FORMS = {
  search: { title: '🔍 What you are looking for', setup: true,
    intro: 'Rent, rooms and living space are checked exactly. Your requirements are read by ChatGPT for every listing that passes them.' },
  profile: { title: '👤 About you', setup: true, intro: 'Used for your applications: contact details go into IS24\'s contact form, the text about you goes to ChatGPT, which writes the message.' },
  style: { title: '✍️ The agent\'s writing style', intro: 'How ChatGPT writes your applications: tone, length, what to always mention. It still states only facts from 👤 About you.' },
};

// Every setting the chat can change. `form` settings are edited in that form; the others are asked in the chat,
// in setup order. `setup: false` settings have a default and are changed from /settings.
// Persona values fill the IS24 contact request; the LLM may use only them.
export const FIELDS = [
  { key: 'rent', form: 'search', label: 'Highest warm rent in €', hint: 'A number, or a range such as 800-1500. Empty: any rent.', placeholder: '1500',
    parse: range(text => `-${text}`, 'Please write a rent like 1500 or 800-1500.'), optional: true },
  { key: 'rooms', form: 'search', label: 'Rooms', hint: 'At least this many, or a range such as 2-3. Empty: any.', placeholder: '2',
    parse: range(text => `${text}-`, 'Please write rooms like 2 or 2-3.'), optional: true },
  { key: 'area', form: 'search', label: 'Living space in m²', hint: 'At least this much, or a range such as 50-80. Empty: any.', placeholder: '50',
    parse: range(text => `${text}-`, 'Please write a living space like 50 or 50-80.'), optional: true },
  { key: 'preferences', form: 'search', label: 'Requirements', type: 'textarea', section: '🎯 Requirements',
    hint: 'Everything else that matters to you, in your own words. Listings that clearly break one are skipped without asking you; every other listing comes to you.',
    placeholder: 'Quiet, with a balcony. At most 2nd floor without a lift. No swap flats.', parse: text(2000) },
  { key: 'persona.anrede', form: 'profile', section: 'Contact details', label: 'Salutation', type: 'select', choices: [['FEMALE', 'Frau'], ['MALE', 'Herr'], ['NO_SALUTATION', 'No salutation']] },
  { key: 'persona.vorname', form: 'profile', label: 'First name', parse: line(60), autocomplete: 'given-name' },
  { key: 'persona.nachname', form: 'profile', label: 'Last name', parse: line(60), autocomplete: 'family-name' },
  { key: 'persona.telefon', form: 'profile', label: 'Phone', hint: 'Landlords often call the first applicants.', placeholder: '+49 170 1234567', type: 'tel', autocomplete: 'tel',
    parse: pattern(/^\+?[\d\s/()-]{5,25}$/, 'Please write a phone number, e.g. +49 170 1234567.'), optional: true },
  // Stored as persona.strasse and persona.hausnummer.
  { key: 'address', form: 'profile', label: 'Street and house number', placeholder: 'Musterstraße 12a', autocomplete: 'street-address', optional: true, parse: streetAndNumber,
    keys: ['persona.strasse', 'persona.hausnummer'], read: values => [values['persona.strasse'], values['persona.hausnummer']].filter(Boolean).join(' ') },
  { key: 'persona.plz', form: 'profile', label: 'Postcode', placeholder: '10115', inputmode: 'numeric', autocomplete: 'postal-code', parse: pattern(/^\d{5}$/, 'Please write a 5-digit postcode.'), optional: true },
  { key: 'persona.ort', form: 'profile', label: 'City', placeholder: 'Berlin', autocomplete: 'address-level2', parse: line(60), optional: true },
  { key: 'persona.about', form: 'profile', section: 'About you, for ChatGPT', label: 'About you', type: 'textarea', optional: true, parse: text(1000),
    hint: 'Free text that ChatGPT uses when it writes your applications. Applications mention only what you write here.',
    placeholder: 'Software developer, permanent job, 3,800 € net. Non-smoker, no pets. Moving in from March. SCHUFA and proof of income ready.' },
  { key: 'persona.sendProfile', form: 'profile', section: 'IS24 Selbstauskunft', label: 'Attach my IS24 Selbstauskunft to applications', type: 'checkbox',
    hint: 'Your tenant profile on immobilienscout24.de (Mieterprofil / Selbstauskunft). Landlords see what you filled in there; check it on IS24 first.' },
  { key: 'style', form: 'style', label: 'Agent\'s writing style', type: 'textarea', empty: 'none', optional: true, setup: false, parse: text(1000),
    hint: 'Leave empty for a polite, concise default.', placeholder: 'Formal and short. Always mention that I am a non-smoker.' },
  { key: 'autoSend', label: 'Auto-send', ask: 'Should I send applications myself when a listing clearly fits? You get the listing and the sent message afterwards. Unclear matches always ask you first.', default: false,
    choices: [[false, 'Ask me each time'], [true, 'Auto-send clear matches']], setup: false },
  { key: 'model', label: 'ChatGPT model', ask: 'Which ChatGPT model should review listings? It must be available to your plan.', default: 'gpt-6-luna', setup: false, parse: pattern(/^[a-zA-Z0-9._-]{1,60}$/, 'Please send a model name like gpt-6-luna.') },
  // '' = the model's own default. Chosen together with the model (🧠 Model), from the levels it supports.
  { key: 'thinking', label: 'Thinking', ask: 'How hard should ChatGPT think?', default: '', empty: 'default', optional: true, setup: false, parse: pattern(/^[a-z]{1,20}$/, 'Please pick a thinking level from /settings → 🧠 Model.') },
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
      return { key, label, type, hint, placeholder, section, optional: Boolean(optional), autocomplete, inputmode,
        ...(field.choices && { options: field.choices.map(([choice, text]) => ({ value: choice, text })) }),
        value: set ? value ?? '' : prefill[key] ?? (type === 'checkbox' ? false : ''), prefilled: !set && prefill[key] !== undefined };
    });
    return { part, ...FORMS[part], fields };
  }
  // Saves a filled-in form at once, or nothing: the first invalid field throws, naming it.
  saveForm(part, input) {
    if (!Object.hasOwn(FORMS, part) || !input || typeof input !== 'object') throw new Error('Unknown form');
    const changes = {};
    for (const field of FIELDS.filter(entry => entry.form === part)) {
      const raw = field.type === 'checkbox' ? input[field.key] : typeof input[field.key] === 'string' ? input[field.key].trim() : '';
      if (raw === '' && !field.optional && field.type !== 'checkbox') throw new Error(`${field.label}: please fill this in.`);
      let value;
      try { value = parse(field, raw); } catch (error) { throw new Error(`${field.label}: ${error.message}`); }
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
  apply() {
    const value = key => this.values[key] ?? FIELD[key]?.default;
    const limit = key => value(key) ? parseRange(value(key), key) : { min: null, max: null };
    Object.assign(this.config, {
      chatId: this.values.chatId ?? '', accountEmail: this.values.accountEmail ?? '', immomioEmail: this.values.immomioEmail ?? '', preferences: value('preferences') ?? '',
      searches: this.values.searches ?? [], limits: { price: limit('rent'), rooms: limit('rooms'), livingSpace: limit('area') },
      autoSend: value('autoSend'), paused: value('paused'), style: value('style') ?? '',
    });
    this.config.llm.model = value('model');
    this.config.llm.thinking = value('thinking');
    const persona = this.config.persona;
    for (const key of Object.keys(persona)) delete persona[key];
    for (const key of PERSONA) if (this.values[`persona.${key}`]) persona[key] = this.values[`persona.${key}`];
    if (this.config.accountEmail) persona.email = this.config.accountEmail;
  }
}
