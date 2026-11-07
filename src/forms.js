import { readJson, send, verifyInitData } from './connect.js';

// The settings forms (settings.js FORMS) as a Telegram Mini App: the chat's ✏️ Edit buttons open
// /form?part=<name>, prefilled with what is set. Only the person's own signed requests read or save their settings.
// One instance per person answers their requests; a shared one without settings serves just the page.
export class FormApp {
  // prefill() -> { key: value } for fields never set. onSaved(part) after a form was saved.
  constructor({ config, settings = null, prefill = () => ({}), onSaved = () => {} }) {
    Object.assign(this, { config, settings, prefill, onSaved });
    this.route = /\/form(\/state|\/save)?$/;
  }
  close() {}
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const action = url.pathname.match(this.route)?.[1];
    if (req.method === 'GET' && !action) return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (!this.settings || !verifyInitData(req.headers['x-init-data'], this.config.telegramBotToken, this.config.chatId)) return send(res, 403);
    if (req.method === 'GET' && action === '/state') {
      try { return send(res, 200, 'application/json', JSON.stringify(this.settings.form(url.searchParams.get('part'), this.prefill()))); }
      catch { return send(res, 404); }
    }
    if (req.method !== 'POST' || action !== '/save') return send(res, 405);
    const { input, status } = await readJson(req, 32_768);
    if (status) return send(res, status);
    try { this.settings.saveForm(input?.part, input?.values); }
    catch (error) { return send(res, 400, 'application/json', JSON.stringify({ error: error.message, field: error.field })); }
    send(res, 204);
    await this.onSaved(input.part);
  }
}

const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>Einstellungen</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-secondary-bg-color,#f2f2f7);--text:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#8a8a8e);--card:var(--tg-theme-bg-color,#fff);--accent:var(--tg-theme-button-color,#2481cc);--danger:var(--tg-theme-destructive-text-color,#e5484d)}
*{box-sizing:border-box}body{margin:0;font:16px/1.4 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:20px 16px calc(24px + env(safe-area-inset-bottom))}
[hidden]{display:none!important}main{max-width:520px;margin:0 auto}
h1{font-size:22px;margin:0 0 6px}.intro{color:var(--hint);font-size:15px;margin:0 0 18px}
h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;color:var(--hint);margin:22px 4px 8px}
.card{background:var(--card);border-radius:14px;padding:14px}.field+.field{margin-top:14px}
label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}
input:not([type=checkbox]),select,textarea{width:100%;font:inherit;font-size:17px;padding:11px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--hint) 35%,transparent);background:var(--bg);color:var(--text);outline:none}
textarea{min-height:128px;resize:vertical}input:focus,select:focus,textarea:focus{border-color:var(--accent)}
.range{display:flex;gap:8px;align-items:center}.range input{flex:1;min-width:0}.range span{color:var(--hint)}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:600}.check input{width:22px;height:22px;margin:0;flex:none;accent-color:var(--accent)}
.hint{font-size:13px;color:var(--hint);margin:6px 2px 0}.from{color:var(--accent)}
.problem{font-size:13px;color:var(--danger);margin:6px 2px 0}.invalid input,.invalid select,.invalid textarea{border-color:var(--danger)}
#error{color:var(--danger);font-size:15px;margin:16px 4px 0}
#fallback{width:100%;margin-top:18px;font-size:17px;padding:14px;border:0;border-radius:12px;background:var(--accent);color:var(--tg-theme-button-text-color,#fff)}
.center{text-align:center;color:var(--hint);margin-top:40px}
</style></head><body><main>
<form id="form" hidden><h1 id="title"></h1><p class="intro" id="intro"></p><div id="fields"></div><div id="error" hidden></div><button id="fallback" hidden>Speichern</button></form>
<p class="center" id="note">Lädt…</p>
</main><script>
const tg = window.Telegram.WebApp; tg.ready(); tg.expand();
const $ = id => document.getElementById(id);
const part = new URLSearchParams(location.search).get('part') || '';
const headers = { 'X-Init-Data': tg.initData, 'Content-Type': 'application/json' };
const main = tg.MainButton, native = Boolean(tg.initData && main);
let fields = [], hidden = null;
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
function render(form) {
  fields = form.fields; hidden = new RegExp(form.hidden);
  $('title').textContent = form.title; $('intro').textContent = form.intro;
  let card = null;
  for (const field of fields) {
    if (!card || field.section) {
      if (field.section) $('fields').append(el('h2', { textContent: field.section }));
      card = el('div', { className: 'card' }); $('fields').append(card);
    }
    const id = 'f-' + field.key.replace(/\\W/g, '-');
    const box = el('div', { className: 'field' });
    let input;
    if (field.type === 'checkbox') {
      input = el('input', { type: 'checkbox', id, checked: field.value === true });
      box.append(el('label', { className: 'check', htmlFor: id }, input, el('span', { textContent: field.label })));
    } else {
      if (field.type === 'select') {
        input = el('select', { id, required: !field.optional });
        if (field.value === '') input.append(el('option', { value: '', textContent: 'Auswählen…', disabled: true, selected: true }));
        for (const option of field.options) input.append(el('option', { value: String(option.value), textContent: option.text, selected: option.value === field.value }));
      } else if (field.type === 'textarea') input = el('textarea', { id, value: field.value, required: !field.optional });
      else if (field.type === 'range') {
        // From and To, each with the number keyboard; the value is "from-to" ("800-1500", "-1500", "2-").
        const [from = '', to = ''] = field.value.split('-');
        field.inputs = [from, to].map((value, side) => el('input', { id: side ? id + '-to' : id, type: 'text', value, inputMode: field.inputmode, maxLength: 9,
          placeholder: field.placeholder[side], ariaLabel: field.label + (side ? ' bis' : ' von') }));
        input = field.inputs[0];
      } else input = el('input', { id, type: field.type, value: field.value, required: !field.optional });
      if (field.type !== 'range') {
        if (field.maxLength) input.maxLength = field.maxLength;
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.inputmode) input.inputMode = field.inputmode;
      }
      if (field.autocomplete) input.autocomplete = field.autocomplete;
      box.append(el('label', { htmlFor: id, textContent: field.label + (field.optional ? '' : ' *') }),
        field.inputs ? el('div', { className: 'range' }, field.inputs[0], el('span', { textContent: '–' }), field.inputs[1]) : input);
    }
    if (field.hint) box.append(el('p', { className: 'hint', textContent: field.hint }));
    if (field.prefilled) box.append(el('p', { className: 'hint from', textContent: 'Aus deinem ImmoScout24-Konto übernommen.' }));
    field.problem = el('p', { className: 'problem', hidden: true });
    box.append(field.problem);
    Object.assign(field, { input, box }); card.append(box);
    // Checked when leaving the field, then while typing until it is right.
    for (const each of field.inputs ?? [input]) {
      each.addEventListener('change', () => check(field, true));
      each.addEventListener('input', () => check(field, !field.problem.hidden));
    }
  }
  $('note').hidden = true; $('form').hidden = false;
  if (native) { main.setText('Speichern'); main.enable(); main.show(); } else $('fallback').hidden = false;
}
// The field's problem, as the server would name it ('' if none). show: under the field, not only on saving.
function check(field, show, problem = null) {
  const value = field.type === 'checkbox' ? '' : text(field);
  problem ??= hidden.test(value) ? 'Bitte entferne unsichtbare Zeichen oder Steuerzeichen.'
    : value && field.maxLength && value.length > field.maxLength ? 'Bitte höchstens ' + field.maxLength + ' Zeichen.'
    : value && field.pattern && !new RegExp(field.pattern.source, field.pattern.flags).test(value) ? field.message
    : !value && !field.optional && field.type !== 'checkbox' ? 'Bitte ausfüllen.' : '';
  field.input.setCustomValidity(problem);
  if (show) { field.problem.textContent = problem; field.problem.hidden = !problem; field.box.classList.toggle('invalid', Boolean(problem)); }
  return problem;
}
// A text field's value; a range joins its boxes, or is empty when both are.
function text(field) {
  if (!field.inputs) return field.input.value.trim();
  const [from, to] = field.inputs.map(input => input.value.trim());
  return from || to ? from + '-' + to : '';
}
function values() {
  return Object.fromEntries(fields.map(field => [field.key, field.type === 'checkbox' ? field.input.checked
    : field.type === 'select' ? (field.options.find(option => String(option.value) === field.input.value)?.value ?? '') : text(field)]));
}
async function save() {
  const wrong = fields.filter(field => check(field, true));
  if (wrong.length) { tg.HapticFeedback?.notificationOccurred('error'); wrong[0].input.focus(); return wrong[0].box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  main.showProgress?.(); main.disable?.();
  try {
    const res = await fetch('form/save', { method: 'POST', headers, body: JSON.stringify({ part, values: values() }) });
    if (res.ok) { tg.HapticFeedback?.notificationOccurred('success'); main.hide(); $('form').hidden = true; $('note').textContent = '✓ Gespeichert. Du kannst diese Seite schließen.'; $('note').hidden = false; return setTimeout(() => tg.close(), 900); }
    const { error, field: key } = await res.json().catch(() => ({ error: 'Diese Seite ist veraltet. Öffne sie neu aus dem Chat.' }));
    const field = fields.find(entry => entry.key === key);
    if (field) { check(field, true, error); field.input.focus(); tg.HapticFeedback?.notificationOccurred('error'); return field.box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    $('error').textContent = error; $('error').hidden = false; tg.HapticFeedback?.notificationOccurred('error'); $('error').scrollIntoView({ behavior: 'smooth' });
  } catch { $('error').textContent = 'Dein Agent ist nicht erreichbar. Versuch es noch mal.'; $('error').hidden = false; }
  finally { main.hideProgress?.(); main.enable?.(); }
}
if (native) main.onClick(save);
$('form').onsubmit = event => { event.preventDefault(); save(); };
fetch('form/state?part=' + encodeURIComponent(part), { headers }).then(res => res.ok ? res.json() : Promise.reject(res.status))
  .then(render, () => { $('note').textContent = 'Öffne diese Seite über den ✏️-Button in deinem Telegram-Chat.'; });
</script></body></html>`;
