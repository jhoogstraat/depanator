// IS24 contactor: fills and submits the contact form on a page owned by is24.js.
// Exactly one submit click per apply(); captchas are never solved (fail closed).

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const IS24_EXPOSE_URL = 'https://www.immobilienscout24.de/expose';
const LOGIN_URL_RE = /\/login|\/registrierung|sso\.immobilienscout24/;
const SESSION_EXPIRED = 'SESSION_EXPIRED (IS24 login required — the bot asks you to log in again)';
const MAX_SCREENSHOTS = 20;
// Persona key -> contact form <select> name. Their values must equal an option label.
export const FORM_SELECTS = { anrede: 'salutation', einzug: 'moveInDateType', personen: 'numberOfPersons', haustiere: 'hasPets', beschaeftigung: 'employmentRelationship', einkommen: 'income', unterlagen: 'applicationPackageCompleted' };
const OK_BUTTON = '.DatePicker_datepicker-okay-button__JxpMI';
// Timing in ms (formerly the 'balanced' preset).
const T = {
  spaRenderWait:   [1500, 3500],
  formWaitTimeout:  8000,
  anredeJitter:    [80, 200],
  fieldJitter:     [50, 150],
  typeDelay:       [15, 40],
  postTypeJitter:  [300, 1000],
};

const jitter = (min, max = min) => new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
const typeDelay = () => Math.round(T.typeDelay[0] + Math.random() * (T.typeDelay[1] - T.typeDelay[0]));

export class IS24Contactor {
  constructor({ page = null, persona = {}, screenshotDir = null } = {}) {
    this.page = page;
    this.persona = persona;
    this.screenshotDir = screenshotDir;
  }

  /** Failure screenshot (contains personal data): private dir, newest MAX_SCREENSHOTS kept. Never throws. */
  async _screenshot(name) {
    const dir = this.screenshotDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await this.page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
      const files = readdirSync(dir)
        .map((file) => ({ file, mtimeMs: statSync(join(dir, file)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { file } of files.slice(MAX_SCREENSHOTS)) unlinkSync(join(dir, file));
    } catch {}
  }

  /** Navigate via in-page location assignment (same-document hash changes resolve too). */
  async _navigate(url, { timeout = 20000 } = {}) {
    if (url === 'about:blank' && this.page?.url() === 'about:blank') return;
    const nav = this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
    await this.page.evaluate((u) => { window.location.href = u; }, url);
    await nav;
  }

  /**
   * Navigate to an IS24 expose contact form, fill it, and submit once.
   * Returns { success: true, detail } or { success: false, reason }.
   */
  async apply(exposeId, message, { beforeSubmit, onSubmitAttempt } = {}) {
    const fail = async (reason, tag) => {
      await this._screenshot(`${exposeId}_${tag}`);
      return { success: false, reason };
    };
    try {
      await this._navigate(`${IS24_EXPOSE_URL}/${exposeId}#/basicContact/email`);
      await jitter(...T.spaRenderWait);

      // AWS WAF perimeter captcha (Ich bin kein Roboter)
      const perimeterCaptcha = await this.page.evaluate(() =>
        document.title.includes('Ich bin kein Roboter')
        || !!document.querySelector('#captcha-container')
        || typeof window.awsWafCaptcha !== 'undefined'
      ).catch(() => false);
      if (perimeterCaptcha) return fail('PERIMETER_CAPTCHA (AWS WAF — solve in browser to continue)', 'perimeter_captcha');

      const loggedIn = await this.page.evaluate(() => {
        const flag = window.IS24 && window.IS24.expose && window.IS24.expose.userLoggedIn;
        return typeof flag === 'boolean' ? flag : null;
      }).catch(() => null);
      const currentUrl = this.page.url();
      if (loggedIn === false || LOGIN_URL_RE.test(currentUrl)) return fail(SESSION_EXPIRED, 'session_expired');
      if (!currentUrl.includes(String(exposeId))) return fail('Unexpected page after navigation', 'unexpected_page');

      if (await this._isDeactivated()) return fail('DEACTIVATED (listing no longer available)', 'deactivated');

      await this._openContactFormIfNeeded();
      if (!(await this._waitForForm(T.formWaitTimeout))) {
        return await this._isPremiumListing()
          ? fail('PREMIUM_ONLY (Nachricht opened a Plus/Suchen+ upsell instead of the contact form)', 'premium_upsell')
          : fail('NO_FORM (contact form not found)', 'no_form');
      }

      await this._fillForm(message);
      let formStillOpen = await this._isContactFormOpen();
      // Some IS24 variants close/return to the expose page during SPA transitions.
      // If a visible "Nachricht" contact button is present, reopen and refill once.
      if (!formStillOpen && await this._openContactFormIfNeeded() && await this._waitForForm(T.formWaitTimeout)) {
        await this._fillForm(message);
        formStillOpen = await this._isContactFormOpen();
      }
      if (!formStillOpen) return fail('SUBMIT_FAILED (contact form closed before submit)', 'form_closed_before_submit');

      // Approval/account/form checks happen at the final shared submit seam.
      if (!beforeSubmit) throw new Error('Approval beforeSubmit hook required');
      await beforeSubmit(this.page);
      await this._clickAbschicken(onSubmitAttempt);

      const { verified, detail } = await this._verifySubmission();
      if (!verified) return fail(`SUBMIT_FAILED (${detail})`, 'submit_failed');
      return { success: true, detail };
    } catch (err) {
      return fail(`ERROR: ${err.message}`, 'error');
    } finally {
      // Blank the page so the filled form (personal data) does not linger.
      if (!this.page.isClosed()) await this._navigate('about:blank', { timeout: 5000 }).catch(() => {});
    }
  }

  /**
   * Open a listing's contact form and read its dropdown options without filling or submitting anything.
   * Returns { personaKey: [option labels] }; the persona must use these labels exactly.
   */
  async readFormOptions(exposeId) {
    try {
      await this._navigate(`${IS24_EXPOSE_URL}/${exposeId}#/basicContact/email`);
      await jitter(...T.spaRenderWait);
      if (LOGIN_URL_RE.test(this.page.url())) throw new Error(SESSION_EXPIRED);
      await this._openContactFormIfNeeded();
      if (!(await this._waitForForm(T.formWaitTimeout))) throw new Error('The contact form did not open');
      return await this.page.evaluate((selects) => Object.fromEntries(Object.entries(selects).flatMap(([key, name]) => {
        const el = document.querySelector(`select[name="${name}"]`);
        const labels = el ? Array.from(el.options).filter((o) => o.value).map((o) => o.textContent.trim()).filter(Boolean) : [];
        return labels.length ? [[key, labels]] : [];
      })), FORM_SELECTS);
    } finally {
      if (!this.page.isClosed()) await this._navigate('about:blank', { timeout: 5000 }).catch(() => {});
    }
  }

  async _isPremiumListing() {
    try {
      return await this.page.evaluate(() => {
        const visible = (el) => { if (!el) return false; const s = window.getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0; };
        // Broad Plus words appear in normal IS24 chrome; require an actual visible gate/CTA.
        const plusTextRe = /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus)/i;
        const plusGateRe = /(Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied werden|zum PLUS-Mitglied|Kontakt nur|nur mit .{0,30}Plus|exklusiv .{0,30}Plus|Plus .{0,30}kontaktieren)/i;
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="modal"], [class*="Modal"], [class*="upsell"], [class*="Upsell"], [class*="paywall"], [class*="Paywall"]'))
          .filter(visible)
          .map((el) => el.textContent?.trim() || '')
          .filter(Boolean);
        return candidates.some((text) => plusTextRe.test(text) && plusGateRe.test(text));
      });
    } catch { return false; }
  }

  async _isDeactivated() {
    try {
      return await this.page.evaluate(() => {
        const text = document.body?.innerText || '';
        // IS24 shows these when listing is gone
        if (/(nicht mehr (verfügbar|verfuegbar|aktuell)|(Anzeige|Angebot|Objekt).{0,30}nicht gefunden|(Anzeige|Inserat).{0,30}existiert nicht|wurde deaktiviert|Objekt wurde.{0,30}entfernt|Leider wurde das Objekt|Diese Seite existiert nicht|Angebot ist abgelaufen|wurde bereits vergeben|ist bereits vergeben|bereits (vermittelt|vermietet|verkauft)|nicht mehr online|expose.{0,10}not found)/i.test(text)) return true;
        // 404 redirects or page title says "not found"
        if (/Seite nicht gefunden|Page not found|404/i.test(document.title || '')) return true;
        return false;
      });
    } catch { return false; }
  }

  async _waitForForm(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._isContactFormOpen()) return true;
      await this._openContactFormIfNeeded();
      await jitter(500, 1500);
    }
    return false;
  }

  async _openContactFormIfNeeded() {
    try {
      if (await this._isContactFormOpen()) return true;
      const clicked = await this.page.evaluate(() => {
        const visible = (el) => { if (!el) return false; const s = window.getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0; };
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const btn = buttons.find((el) => {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return visible(el) && /^(Nachricht|Kontakt aufnehmen|Anbieter kontaktieren|Vermieter kontaktieren)$/i.test(text);
        });
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center', inline: 'center' });
        btn.click();
        return true;
      });
      if (clicked) await jitter(800, 1500);
      return clicked;
    } catch { return false; }
  }

  async _dismissOverlays() {
    try {
      await this.page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = btn.textContent?.trim() || '';
          if (/alle.*akzeptieren|akzeptieren.*alle|alles.*erlauben|zustimmen/i.test(text)) { btn.click(); return; }
        }
        for (const btn of btns) {
          const text = btn.textContent?.trim() || '';
          if (/speichern|auswählen|bestätigen/i.test(text) && btn.offsetParent) { btn.click(); return; }
        }
      });
      await jitter(1000, 2000);
    } catch {}
  }

  async _fillForm(message) {
    await this._dismissOverlays();
    const p = this.persona;

    // Inject page helpers (re-injected on every fill; a full reload clears them).
    await this.page.evaluate(() => {
      window.__setSelect = function (sel, text) {
        const el = document.querySelector(sel);
        if (!el) return;
        for (const o of el.options) {
          if (o.textContent.trim() === text || o.value === text) {
            el.value = o.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      };
      window.__getSelectText = function (sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        return el.options[el.selectedIndex]?.textContent?.trim() || null;
      };
      // Native value setter + input event: the only reliable way past IS24's React
      // controlled inputs. `full` adds a focus event and the inserted data.
      window.__setValue = function (el, v, full) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        if (full) el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: v === '' ? 'deleteContent' : 'insertText', ...(full ? { data: v } : {}) }));
      };
      // Set + re-verify up to `tries` times (delay base + n*step ms) so React can settle.
      window.__retrySet = function (el, v, tries, base, step) {
        return new Promise((resolve) => {
          let n = 0;
          const attempt = () => {
            window.__setValue(el, v, true);
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (el.value === v) return resolve(true);
            if (++n < tries) setTimeout(attempt, base + n * step);
            else resolve(false);
          };
          attempt();
        });
      };
      window.__clearInput = function (sel) {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.focus();
        window.__setValue(el, '');
        return true;
      };
    });

    // Anrede: only the persona's own answer, never a guessed default.
    const currentAnrede = await this.page.evaluate(() => window.__getSelectText('select[name="salutation"]'));
    if (p.anrede && currentAnrede !== p.anrede) {
      await this.page.evaluate((a) => window.__setSelect('select[name="salutation"]', a), p.anrede);
      await jitter(...T.anredeJitter);
    }

    const dropdowns = [
      ['select[name="moveInDateType"]', p.einzug],
      ['select[name="numberOfPersons"]', p.personen],
      ['select[name="hasPets"]', p.haustiere],
      ['select[name="employmentRelationship"]', p.beschaeftigung],
      ['select[name="income"]', p.einkommen],
      ['select[name="applicationPackageCompleted"]', p.unterlagen],
    ];
    for (const [sel, val] of dropdowns) {
      if (!val) continue;
      const current = await this.page.evaluate((s) => window.__getSelectText(s), sel);
      if (current === val) continue;
      await this.page.evaluate(({ s, v }) => window.__setSelect(s, v), { s: sel, v: val });
      await jitter(...T.anredeJitter);
    }

    // Fill pet details when haustiere is "Ja"
    if (p.haustiere === 'Ja' && p.haustiere_zusatz) {
      const petSel = 'input[name="petsInHousehold"]';
      const petExists = await this.page.evaluate((s) => !!document.querySelector(s), petSel);
      if (petExists) {
        await this.page.evaluate((s) => document.querySelector(s)?.focus(), petSel);
        await jitter(100, 200);
        await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return;
          window.__setValue(el, v);
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { s: petSel, v: p.haustiere_zusatz });
        await jitter(...T.postTypeJitter);
      }
    }

    // Fill move-in date when einzug is "genaues Datum"
    const dateSelector = 'input#moveInDate';
    const parts = p.einzug_datum ? p.einzug_datum.split('-') : [];
    const germanDate = parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : p.einzug_datum;
    if (p.einzug === 'genaues Datum' && p.einzug_datum) {
      // Retry — React may need a moment to render the date input after select change
      let exists = false;
      for (let i = 0; i < 5; i++) {
        exists = await this.page.evaluate((sel) => !!document.querySelector(sel), dateSelector);
        if (exists) break;
        await jitter(200, 400);
      }
      if (exists) {
        // 1) Set the date text via native setter
        // 2) Open calendar — IS24 reads the pre-filled value and should pre-select it
        // 3) Click OK to confirm through the calendar picker (proper React state update)
        // Block SPA hash changes so the form doesn't close.
        const targetDay = parseInt(parts[2], 10);
        const targetMonth = parseInt(parts[1], 10);
        const targetYear = parseInt(parts[0], 10);

        // Step 1: set date text + block hash changes
        await this.page.evaluate(({ sel, date }) => {
          window.__blockHash = true;
          window.__originalHash = location.hash;
          const _ps = history.pushState, _rs = history.replaceState;
          history.pushState = function (...a) { if (window.__blockHash) return; return _ps.apply(this, a); };
          history.replaceState = function (...a) { if (window.__blockHash) return; return _rs.apply(this, a); };
          const el = document.querySelector(sel);
          if (!el) return;
          window.__setValue(el, date);
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { sel: dateSelector, date: germanDate });
        await jitter(200, 400);

        // Step 2: focus to open calendar (should see the pre-filled date)
        await this.page.evaluate((sel) => document.querySelector(sel)?.focus(), dateSelector);
        await jitter(500, 800);

        // Step 3: click OK to confirm
        await this.page.evaluate((ok) => { document.querySelector(ok)?.click(); }, OK_BUTTON);
        await jitter(400, 600);

        // If calendar still open after OK, retry with manual navigation + day pick
        const stillOpen = await this.page.evaluate(() =>
          !!document.querySelector('.DatePicker_datepicker-days-wrapper__qCgH-')
        );
        if (stillOpen) {
          process.stderr.write('[contactor] Calendar still open — retrying with day pick\n');
          await this._pickCalendarDay(targetDay, targetMonth, targetYear);
          await jitter(400, 600);
        }

        // Unblock hash changes + restore form
        await this.page.evaluate(() => {
          window.__blockHash = false;
          if (!location.hash.includes('basicContact')) {
            location.hash = window.__originalHash || '#/basicContact/email';
          }
        });
        await jitter(300, 500);
      }
    }

    // Text inputs — only stringify non-undefined values (never "undefined" in the DOM)
    const fields = [
      { sel: 'input[name="firstName"]', val: p.vorname },
      { sel: 'input[name="lastName"]', val: p.nachname },
      { sel: 'input[name="emailAddress"]', val: p.email },
      { sel: 'input[name="phoneNumber"]', val: p.telefon },
      { sel: 'input[name="street"]', val: p.strasse },
      { sel: 'input[name="houseNumber"]', val: p.hausnummer != null ? String(p.hausnummer) : '' },
      { sel: 'input[name="postcode"]', val: p.plz != null ? String(p.plz) : '' },
      { sel: 'input[name="city"]', val: p.ort },
    ];

    for (const { sel, val } of fields) {
      if (!val) continue;
      const elState = await this.page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        return { disabled: el.disabled, value: el.value || '' };
      }, sel);
      if (!elState) continue;

      // Disabled field (IS24 pre-fills + locks e.g. email) — skip if correct, native-set if wrong
      if (elState.disabled) {
        if (elState.value === val) continue;
        await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (el) window.__setValue(el, v);
        }, { s: sel, v: val });
        await jitter(100, 200);
        continue;
      }

      await this.page.evaluate((s) => window.__clearInput(s), sel);
      await jitter(...T.fieldJitter);
      await this.page.click(sel);
      await jitter(50, 150);
      await this.page.keyboard.type(val, { delay: typeDelay() });

      await jitter(100, 200);
      const actual = await this.page.evaluate((s) => document.querySelector(s)?.value || null, sel);
      if (actual !== val) {
        // IS24's React onChange can reject keyboard.type() values — clear, then
        // set + verify across several ticks so React's render cycle can settle.
        const stuck = await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return false;
          window.__setValue(el, '');
          return window.__retrySet(el, v, 6, 30, 15);
        }, { s: sel, v: val });
        if (!stuck) process.stderr.write(`[contactor] Failed to fill ${sel} after retries\n`);
      }
    }

    // Do NOT fill global expose-page helpers like `vonplz`/`nachplz` here.
    // Those names are used by IS24's "Was kostet ein Umzug?" calculator outside
    // the contact form; clicking them closes the contact form and scrolls to the page body.

    // Message textarea (optional — not every IS24 listing has one)
    const textareaSel = 'textarea[name="message"]';
    const hasTextarea = await this.page.evaluate((s) => !!document.querySelector(s), textareaSel);

    if (hasTextarea) {
      // Clear via native setter — Ctrl+A is intercepted by IS24's React.
      await this.page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) window.__setValue(el, '');
      }, textareaSel);
      await jitter(100, 200);

      await this.page.click(textareaSel);
      await jitter(100, 200);
      await this.page.keyboard.type(message, { delay: typeDelay() });
      await jitter(200, 400);

      const actualMsg = await this.page.evaluate((s) => document.querySelector(s)?.value || '', textareaSel);
      if (actualMsg !== message) {
        await this.page.evaluate(({ sel, msg }) => {
          const el = document.querySelector(sel);
          if (!el) return;
          window.__setValue(el, '');
          el.dispatchEvent(new Event('change', { bubbles: true }));
          // Not awaited: IS24's React may revert the value after the first set.
          window.__retrySet(el, msg, 4, 50, 20);
        }, { sel: textareaSel, msg: message });
        await jitter(200, 400);
      }
    }

    // Final verify: IS24 auto-fill can asynchronously revert fields after the bot types.
    for (const { sel, val } of fields) {
      if (!val) continue;
      const actual = await this.page.evaluate((s) => document.querySelector(s)?.value || '', sel);
      if (actual !== val) {
        await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          return el ? window.__retrySet(el, v, 4, 40, 20) : false;
        }, { s: sel, v: val });
        await jitter(100, 200);
      }
    }

    // Final verify: IS24's React date picker can reformat or discard the date
    // after other fields are filled (auto-fill hooks, SPA re-renders).
    if (p.einzug === 'genaues Datum' && p.einzug_datum) {
      const currentDate = await this.page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? el.value : null;
      }, dateSelector);
      if (currentDate !== germanDate) {
        await this.page.evaluate(({ sel, date }) => {
          const el = document.querySelector(sel);
          if (!el) return;
          window.__setValue(el, date, true);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          // Re-open calendar so IS24's React picks it up
          el.focus();
        }, { sel: dateSelector, date: germanDate });
        await jitter(300, 500);
        await this.page.evaluate((ok) => { document.querySelector(ok)?.click(); }, OK_BUTTON);
        await jitter(300, 500);
      }
    }
  }

  /** Step the open date picker to month/year, click the day, then OK. Real awaited delays between steps. */
  async _pickCalendarDay(day, month, year) {
    const readMonth = () => this.page.evaluate(() => {
      const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
      const el = document.querySelector('.DatePicker_datepicker-current-month__HB2Ak');
      if (!el) return null;
      const p = el.textContent.trim().split(/\s+/);
      const m = months.indexOf(p[0]);
      return m >= 0 ? { month: m + 1, year: parseInt(p[1]) } : null;
    });
    let cur = await readMonth();
    if (!cur) return;
    for (let c = 0; c < 24 && !(cur.year === year && cur.month === month); c++) {
      const forward = cur.year < year || (cur.year === year && cur.month < month);
      await this.page.evaluate((sel) => { document.querySelector(sel)?.click(); }, forward
        ? '.DatePicker_datepicker-next-month-button__V6X0I'
        : '.DatePicker_datepicker-previous-month-button__N37Co');
      await jitter(150);
      const nextCur = await readMonth();
      if (!nextCur) break;
      cur = nextCur;
    }
    if (cur.month === month && cur.year === year) {
      const clicked = await this.page.evaluate((d) => {
        for (const b of document.querySelectorAll('.DatePicker_datepicker-day-cell__Bomtx')) {
          if (b.textContent.trim() === String(d) && !b.disabled) { b.click(); return true; }
        }
        return false;
      }, day);
      if (clicked) await jitter(150);
    }
    await this.page.evaluate((ok) => { document.querySelector(ok)?.click(); }, OK_BUTTON);
  }

  async _isContactFormOpen() {
    try {
      return await this.page.evaluate(() => {
        const visible = (el) => { if (!el) return false; const s = window.getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0; };
        const hasSubmit = Array.from(document.querySelectorAll('button')).some((b) => visible(b) && /Abschicken|Senden|Kontaktanfrage senden/i.test(b.textContent || ''));
        // Message textarea is optional; some IS24 forms also use alternate email/phone names.
        const fieldSelectors = [
          'input[name="firstName"]',
          'input[name="lastName"]',
          'input[name="emailAddress"]',
          'input[name="email"]',
          'input[type="email"]',
          'input[name="phoneNumber"]',
          'input[name="phone"]',
          'input[type="tel"]',
          'textarea[name="message"]',
          'select[name="salutation"]',
        ];
        const hasField = fieldSelectors.some((sel) => visible(document.querySelector(sel)));
        return hasSubmit && hasField;
      });
    } catch { return false; }
  }

  async _clickAbschicken(onSubmitAttempt) {
    // Mark uncertainty BEFORE sending the browser command: transport loss can
    // occur after the click but before the response. Never retry this command.
    onSubmitAttempt?.();
    const clicked = await this.page.evaluate(() => {
      const visible = (el) => { if (!el) return false; const s = window.getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0; };
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => visible(b) && !b.disabled && /^(Abschicken|Senden|Kontaktanfrage senden)$/i.test((b.textContent || '').trim()));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new Error('Submit button not found or not clickable');
  }

  /** Observe the page after the single submit click. Never clicks or resubmits. */
  async _verifySubmission() {
    await jitter(1500, 2500);
    const deadline = Date.now() + 5_000;
    let sawValidation = false;

    while (Date.now() < deadline) {
      const state = await this.page.evaluate(() => {
        const visible = (el) => { if (!el) return false; const s = window.getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0; };
        const allText = document.body?.innerText || '';
        const msgTextarea = document.querySelector('textarea[name="message"]');
        const contactContainer = (el) => el?.closest('[class*="contact"], [class*="modal"], [class*="overlay"], [class*="ReactModal"], form');
        const submitBtn = Array.from(document.querySelectorAll('button')).find(b =>
          /Abschicken|Senden|Kontaktanfrage senden/i.test(b.textContent || '') &&
          // Only count submit buttons inside a modal/contact container unless the textarea
          // is present (form is open — any matching button is relevant).
          (msgTextarea || contactContainer(b))
        );
        const confirmed = document.querySelector('[class*="StatusMessage_status-confirm"]') !== null;
        // "Anmelden" text on an expose page usually comes from a Plus upsell, not a
        // logout. Only flag loggedOut when no IS24 user-menu indicator is present.
        const urlShowsLogin = /\/login|\/registrierung|sso\.immobilienscout24/.test(window.location.href);
        const hasUserMenu = Array.from(document.querySelectorAll('a, button, span, img'))
          .filter(visible)
          .some(el => {
            const txt = (el.textContent || '').trim();
            const alt = (el.getAttribute('alt') || '');
            return /\b(Mein Konto|Mein ImmoScout24|Abmelden|account|user)\b/i.test(txt)
              || /^[a-z0-9._%-]{3,}\.{3}$/i.test(txt)  // truncated username like "bowiclg454..."
              || /avatar|user|account|profile/i.test(el.className || '')
              || /avatar|user|account/i.test(alt);
          });
        const loggedOut = !hasUserMenu && (
          urlShowsLogin
          || /\bAnmelden\b|Jetzt einloggen|Einloggen|Loggen Sie sich ein|Bitte melden Sie sich an/i.test(allText)
          || Array.from(document.querySelectorAll('a, button')).some((el) => /\bAnmelden\b|Jetzt einloggen|Einloggen/i.test(el.textContent || ''))
        );
        return {
          confirmed,
          successText: /Kontaktanfrage.{0,80}(gesendet|verschickt|erfolgreich)|Nachricht.{0,80}(gesendet|verschickt)|Vielen Dank.{0,120}(Nachricht|Kontaktanfrage)/i.test(allText),
          loggedOut,
          formGone: !msgTextarea && !submitBtn,
          captcha: /Roboter|Sicherheitsprüfung|Sicherheitsabfrage/i.test(allText),
          serverError: /Es ist ein Fehler aufgetreten/i.test(allText),
          hasErrors: document.querySelectorAll('[class*="error"], [class*="invalid"], [aria-invalid="true"]').length > 0,
          validationText: /(Bitte füllen|Pflichtfeld|fehlerhaft|korrigieren|benötigt)/i.test(allText),
          errorText: document.querySelector('[class*="StatusMessage_status-error"]')?.textContent?.trim() || null,
        };
      });

      if (state.confirmed || state.successText) return { verified: true, detail: state.confirmed ? 'confirmed (modal)' : 'confirmed (success text)' };
      if (state.loggedOut && state.formGone) return { verified: false, detail: 'SESSION_EXPIRED (login required — form closed to expose page)' };
      // Deactivated — listing vanished during submission
      if (/nicht mehr verfügbar|Anzeige.{0,20}nicht gefunden|wurde deaktiviert|wurde bereits vergeben|ist bereits vergeben/i.test(state.errorText || '')) {
        return { verified: false, detail: 'DEACTIVATED (listing removed during submission)' };
      }
      // Captchas are never solved: fail closed, the outcome stays uncertain.
      if (state.captcha) return { verified: false, detail: 'captcha (unsolved)' };
      if (state.serverError) return { verified: false, detail: 'PREMIUM_ONLY (Es ist ein Fehler aufgetreten. — Plus/Suchen+ required)' };
      if (state.hasErrors || state.validationText) {
        // IS24 often flashes validation highlights during async submission; re-check until the deadline.
        sawValidation = true;
        await jitter(800, 1500);
        continue;
      }
      if (state.formGone) return { verified: false, detail: 'SUBMIT_UNCONFIRMED (form closed without confirmation)' };
      await jitter(800, 1200);
    }

    // Deadline fallback — form is gone only when both optional textarea AND submit button vanished.
    const fallback = await this.page.evaluate(() => {
      const hasTextarea = !!document.querySelector('textarea[name="message"]');
      const contactContainer = (el) => el?.closest('[class*="contact"], [class*="modal"], [class*="overlay"], [class*="ReactModal"], form');
      const hasSubmit = Array.from(document.querySelectorAll('button')).some(b =>
        /Abschicken|Senden|Kontaktanfrage senden/i.test(b.textContent || '') && (hasTextarea || contactContainer(b))
      );
      const allText = document.body?.innerText || '';
      return {
        formGone: !hasTextarea && !hasSubmit,
        loggedOut: /\bAnmelden\b|Jetzt einloggen|Einloggen|Loggen Sie sich ein|Bitte melden Sie sich an/i.test(allText)
          || Array.from(document.querySelectorAll('a, button')).some((el) => /\bAnmelden\b|Jetzt einloggen|Einloggen/i.test(el.textContent || '')),
        successText: /Kontaktanfrage.{0,80}(gesendet|verschickt|erfolgreich)|Nachricht.{0,80}(gesendet|verschickt)|Vielen Dank.{0,120}(Nachricht|Kontaktanfrage)/i.test(allText),
        serverError: /Es ist ein Fehler aufgetreten/i.test(allText),
      };
    });

    if (fallback.successText) return { verified: true, detail: 'confirmed (success text)' };
    if (fallback.formGone && fallback.loggedOut) return { verified: false, detail: 'SESSION_EXPIRED (login required — form closed to expose page)' };
    if (fallback.formGone) return { verified: false, detail: sawValidation ? 'SUBMIT_UNCONFIRMED (form closed after transient validation)' : 'SUBMIT_UNCONFIRMED (form closed without confirmation)' };
    if (fallback.serverError) return { verified: false, detail: 'PREMIUM_ONLY (Es ist ein Fehler aufgetreten. — Plus/Suchen+ required)' };
    if (sawValidation) return { verified: false, detail: 'validation errors persisted' };
    return { verified: false, detail: 'no confirmation after 5s' };
  }
}
