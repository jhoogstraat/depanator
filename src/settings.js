import { searchFilters } from './is24.js';

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
// Every setting the chat can change, in guided-setup order. `setup: false` settings have a default and
// are changed from the menu. Persona values fill the IS24 contact request; the LLM may use only them.
export const FIELDS = [
  { key: 'searchUrl', label: 'Search', ask: 'Open immobilienscout24.de, search for apartments to rent with all your filters, and paste the address of the results page here.', parse: value => { const url = String(value).trim(); searchFilters(url); return url; } },
  { key: 'preferences', label: 'Criteria', ask: 'Describe what you are looking for and what is a must. Listings that clearly do not fit are dismissed without asking you. Example: "Quiet, balcony, max. 2nd floor without lift, no swap flats."', parse: text(2000) },
  { key: 'persona.anrede', label: 'Salutation', ask: 'How should landlords address you?', choices: [['FEMALE', 'Frau'], ['MALE', 'Herr'], ['NO_SALUTATION', 'No salutation']] },
  { key: 'persona.vorname', label: 'First name', ask: 'Your first name, as it should appear in applications?', parse: line(60) },
  { key: 'persona.nachname', label: 'Last name', ask: 'Your last name?', parse: line(60) },
  { key: 'persona.telefon', label: 'Phone', ask: 'Your phone number? Landlords often call the first applicants.', parse: pattern(/^\+?[\d\s/()-]{5,25}$/, 'Please send a phone number, e.g. +49 170 1234567.'), optional: true },
  { key: 'persona.strasse', label: 'Street', ask: 'Your current street, without the house number?', parse: line(80), optional: true },
  { key: 'persona.hausnummer', label: 'House number', ask: 'Your house number?', parse: line(10), optional: true },
  { key: 'persona.plz', label: 'Postcode', ask: 'Your postcode?', parse: pattern(/^\d{5}$/, 'Please send a 5-digit postcode.'), optional: true },
  { key: 'persona.ort', label: 'City', ask: 'Your current city?', parse: line(60), optional: true },
  { key: 'persona.about', label: 'About you', ask: 'What should landlords know about you? For example household, job, income, move-in date, pets, documents (SCHUFA, proof of income). Applications state only what you write here. Or let your IS24 Selbstauskunft speak for you.', parse: text(1000), optional: true,
    shortcut: ['Use IS24 Selbstauskunft', { 'persona.about': '', 'persona.sendProfile': true }] },
  { key: 'persona.sendProfile', label: 'Attach Selbstauskunft', ask: 'Should applications also include your IS24 Selbstauskunft (tenant profile), or only the message?',
    choices: [[true, 'Attach Selbstauskunft'], [false, 'Message only']] },
  { key: 'pollIntervalMs', label: 'Check every', ask: 'How often should I check for new listings? Being early matters most; every 2 minutes is a good balance.', default: 2 * MINUTE,
    choices: [1, 2, 3, 5, 10, 30].map(minutes => [minutes * MINUTE, `${minutes} min`]) },
  { key: 'autoSend', label: 'Auto-send', ask: 'Should I send applications myself when a listing clearly fits? You get the listing and the sent message afterwards. Unclear matches always ask you first.', default: false,
    choices: [[false, 'Ask me each time'], [true, 'Auto-send clear matches']], setup: false },
  { key: 'model', label: 'ChatGPT model', ask: 'Which ChatGPT model should review listings? It must be available to your plan.', default: 'gpt-6-luna', setup: false, parse: pattern(/^[a-zA-Z0-9._-]{1,60}$/, 'Please send a model name like gpt-6-luna.') },
  // '' = the model's own default. Chosen together with the model (/model), from the levels it supports.
  { key: 'thinking', label: 'Thinking', ask: 'How hard should ChatGPT think?', default: '', empty: 'default', optional: true, setup: false, parse: pattern(/^[a-z]{1,20}$/, 'Please pick a thinking level from /model.') },
  { key: 'style', label: 'Writing style', empty: 'none', ask: 'How should applications be written? For example: "Formal, short, always mention that I am a non-smoker." Applications still state only facts you gave me.', setup: false, parse: text(1000), optional: true },
  { key: 'paused', label: 'Searching', ask: 'Should I search for new listings?', default: false, setup: false, choices: [[false, 'Searching'], [true, 'Paused']] },
];
const FIELD = Object.fromEntries(FIELDS.map(field => [field.key, field]));

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
  // The next unanswered setup step: the pseudo-step `is24` (connect the account), then a field.
  next() {
    if (!this.values.accountEmail) return { key: 'is24' };
    return FIELDS.find(field => field.setup !== false && this.values[field.key] === undefined) || null;
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
    let value = raw;
    if (field) {
      const choices = this.choices(key);
      if (field.optional && raw === '') value = '';
      else if (choices.length) { if (!choices.some(([choice]) => choice === raw)) throw new Error('Please pick one of the buttons.'); }
      else value = field.parse(raw);
    } else if (!['chatId', 'accountEmail'].includes(key)) throw new Error(`Unknown setting ${key}`); // Set by pairing / connecting IS24.
    this.store.saveSetting(key, value);
    this.values[key] = value;
    this.apply();
    for (const listener of this.listeners) listener(key);
    return value;
  }
  apply() {
    const value = key => this.values[key] ?? FIELD[key]?.default;
    Object.assign(this.config, {
      chatId: this.values.chatId ?? '', accountEmail: this.values.accountEmail ?? '', searchUrl: value('searchUrl') ?? '', preferences: value('preferences') ?? '',
      pollIntervalMs: value('pollIntervalMs'), maxPages: 1, autoSend: value('autoSend'), paused: value('paused'), style: value('style') ?? '',
    });
    // maxPages: one page (the 20 newest) per check; more new listings between two checks do not happen.
    this.config.llm.model = value('model');
    this.config.llm.thinking = value('thinking');
    const persona = this.config.persona;
    for (const key of Object.keys(persona)) delete persona[key];
    for (const field of FIELDS) {
      if (field.key.startsWith('persona.') && this.values[field.key]) persona[field.key.slice('persona.'.length)] = this.values[field.key];
    }
    if (this.config.accountEmail) persona.email = this.config.accountEmail;
  }
}
