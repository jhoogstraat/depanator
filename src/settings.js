import { searchFilters } from './is24.js';
import { FORM_SELECTS } from './is24-contactor.js';

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
const FORM_QUESTIONS = {
  anrede: ['Salutation', 'How should applications address you?'],
  einzug: ['Move-in', 'When can you move in?'],
  personen: ['People', 'How many people will live in the apartment?'],
  haustiere: ['Pets?', 'Do you have pets?'],
  beschaeftigung: ['Employment', 'What is your employment situation?'],
  einkommen: ['Income', 'What is your household net income per month?'],
  unterlagen: ['Documents', 'Do you have your application documents ready (SCHUFA, income proof, ...)?'],
};

// Every setting the chat can change, in guided-setup order. `setup: false` settings have a default and
// are only changed from /settings. Persona values fill the IS24 contact form and are verified before submit.
export const FIELDS = [
  { key: 'accountEmail', label: 'IS24 login email', ask: 'Which email address do you log in to ImmobilienScout24 with?', parse: value => pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'That does not look like an email address.')(value).toLowerCase() },
  { key: 'searchUrl', label: 'Search', ask: 'Open immobilienscout24.de, search for apartments to rent with all your filters, and paste the address of the results page here.', parse: value => { const url = String(value).trim(); searchFilters(url); return url; } },
  { key: 'preferences', label: 'What you look for', ask: 'Describe what you are looking for and what is a must. Listings that clearly do not fit are dismissed without asking you. Example: "Quiet, balcony, max. 2nd floor without lift, no swap flats."', parse: text(2000) },
  { key: 'persona.vorname', label: 'First name', ask: 'Your first name, as it should appear in applications?', parse: line(60) },
  { key: 'persona.nachname', label: 'Last name', ask: 'Your last name?', parse: line(60) },
  { key: 'persona.telefon', label: 'Phone', ask: 'Your phone number? Landlords often call the first applicants.', parse: pattern(/^\+?[\d\s/()-]{5,25}$/, 'Please send a phone number, e.g. +49 170 1234567.'), optional: true },
  { key: 'persona.strasse', label: 'Street', ask: 'Your current street, without the house number?', parse: line(80), optional: true },
  { key: 'persona.hausnummer', label: 'House number', ask: 'Your house number?', parse: line(10), optional: true },
  { key: 'persona.plz', label: 'Postcode', ask: 'Your postcode?', parse: pattern(/^\d{5}$/, 'Please send a 5-digit postcode.'), optional: true },
  { key: 'persona.ort', label: 'City', ask: 'Your current city?', parse: line(60), optional: true },
  // Options come from a real contact form (formOptions), so values always match IS24's labels exactly.
  // IS24 requires a salutation, so it cannot be skipped.
  ...Object.entries(FORM_QUESTIONS).map(([name, [label, ask]]) => ({ key: `persona.${name}`, label, ask, form: true, optional: name !== 'anrede' })),
  { key: 'persona.einzug_datum', label: 'Move-in date', ask: 'Earliest move-in date? Write it as YYYY-MM-DD, for example 2027-03-01.', parse: value => { const date = pattern(/^\d{4}-\d{2}-\d{2}$/, 'Please write the date as YYYY-MM-DD.')(value); if (Number.isNaN(Date.parse(date))) throw new Error('That date does not exist.'); return date; }, optional: true },
  { key: 'persona.haustiere_zusatz', label: 'Which pets', ask: 'Which pets, if any? For example "1 cat".', parse: line(100), optional: true },
  { key: 'pollIntervalMs', label: 'Check every', ask: 'How often should I check for new listings? Being early matters most; every 2 minutes is a good balance.', default: 2 * MINUTE,
    choices: [1, 2, 3, 5, 10, 30].map(minutes => [minutes * MINUTE, `${minutes} min`]) },
  { key: 'autoSend', label: 'Auto-send', ask: 'Should I send applications myself when a listing clearly fits? You get the listing and the sent message afterwards. Unclear matches always ask you first.', default: false,
    choices: [[false, 'Ask me each time'], [true, 'Auto-send clear matches']] },
  { key: 'model', label: 'ChatGPT model', ask: 'Which ChatGPT model should review listings? It must be available to your plan.', default: 'gpt-6-luna', setup: false, parse: pattern(/^[a-zA-Z0-9._-]{1,60}$/, 'Please send a model name like gpt-6-luna.') },
  { key: 'maxPages', label: 'Pages per check', ask: 'How many result pages may one check read? Checks stop at the first page with listings I know, so this mostly limits the very first check.', default: 5, setup: false,
    choices: [1, 3, 5, 10].map(pages => [pages, String(pages)]) },
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
  choices(key) {
    const field = FIELD[key];
    if (field.form) return (this.values.formOptions?.[key.slice('persona.'.length)] || []).map(label => [label, label]);
    return field.choices || [];
  }
  // The next unanswered setup step: a field, or the pseudo-step `formOptions` (read the contact form).
  next() {
    for (const field of FIELDS) {
      if (field.setup === false || this.values[field.key] !== undefined) continue;
      if (field.form && this.values.formOptions === undefined) return { key: 'formOptions' };
      return field;
    }
    return null;
  }
  complete() { return Boolean(this.values.chatId) && !this.next(); }
  display(key) {
    const value = this.values[key] ?? FIELD[key]?.default;
    if (value === undefined) return 'not set';
    if (value === '') return 'skipped';
    return this.choices(key).find(([choice]) => choice === value)?.[1] ?? String(value);
  }
  // Validates, persists and applies. Errors are user-facing. '' skips an optional field.
  set(key, raw) {
    const field = FIELD[key];
    let value = raw;
    if (field) {
      const choices = this.choices(key);
      if (field.optional && raw === '') value = '';
      else if (choices.length || field.form) { if (!choices.some(([choice]) => choice === raw)) throw new Error('Please pick one of the buttons.'); }
      else value = field.parse(raw);
    } else if (!['chatId', 'formOptions'].includes(key)) throw new Error(`Unknown setting ${key}`);
    this.store.saveSetting(key, value);
    this.values[key] = value;
    // New form options: answers the form no longer offers are asked again (setup is incomplete until then).
    if (key === 'formOptions') {
      for (const field of FIELDS.filter(field => field.form && this.values[field.key] !== undefined)) {
        const answer = this.values[field.key];
        if (answer === '' ? !field.optional || this.choices(field.key).length : !this.choices(field.key).some(([choice]) => choice === answer)) {
          this.store.deleteSetting(field.key);
          delete this.values[field.key];
        }
      }
    }
    this.apply();
    for (const listener of this.listeners) listener(key);
    return value;
  }
  apply() {
    const value = key => this.values[key] ?? FIELD[key]?.default;
    Object.assign(this.config, {
      chatId: this.values.chatId ?? '', accountEmail: value('accountEmail') ?? '', searchUrl: value('searchUrl') ?? '', preferences: value('preferences') ?? '',
      pollIntervalMs: value('pollIntervalMs'), maxPages: value('maxPages'), autoSend: value('autoSend'),
    });
    this.config.llm.model = value('model');
    const persona = this.config.persona;
    for (const key of Object.keys(persona)) delete persona[key];
    for (const field of FIELDS) {
      if (field.key.startsWith('persona.') && this.values[field.key]) persona[field.key.slice('persona.'.length)] = this.values[field.key];
    }
    if (this.config.accountEmail) persona.email = this.config.accountEmail;
  }
}
