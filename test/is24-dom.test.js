import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { extractDetails, readAccount, verifyForm } from '../src/is24.js';

// Offline Chromium fixtures exercise the real serialized DOM functions. No
// remote navigation, site credentials, production profile, or submission.
const fixture = `<!doctype html><html><body>
<header>Angemeldet als me@example.com</header>
<main><h1>Local fixture home</h1>
<div class="is24qa-kaltmiete">950,00 €</div>
<div class="is24qa-gesamtmiete">1.250,50 €</div>
<div class="is24qa-wohnflaeche">60.5 m²</div>
<div class="is24qa-zimmer">1.5 Zimmer</div>
<div class="is24-expose-address">Berlin, Example 1</div>
<section id="is24-expose-description">Full description.<span style="display:none"> Additional collapsed description.</span></section>
<section id="is24-expose-equipment">Kitchen and balcony.</section>
<dl><dt>Balcony</dt><dd>Yes</dd><dt>Heating</dt><dd>Central</dd></dl>
</main></body></html>`;
const persona = {vorname:'Me',nachname:'Example',email:'me@example.com',anrede:'Frau',einkommen:'1.000 - 2.000 €'};
const form = `<form data-testid="contact-form">
<textarea name="message">Exact approved message.</textarea>
<input name="firstName" value="Me"><input name="lastName" value="Example"><input name="emailAddress" value="me@example.com">
<select name="salutation"><option value="FEMALE" selected>Frau</option></select>
<select name="income"><option value="RANGE_2" selected>1.000 - 2.000 €</option></select>
<button type="button">Senden</button>
</form>`;

test('offline bundled Chromium DOM fixtures',{timeout:30000},async t=>{
  const browser = await puppeteer.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request',request=>request.abort());
    await t.test('semantic rent priority and decimal parsing',async()=>{
      await page.setContent(fixture);
      const warm=await page.evaluate(extractDetails,{priceType:'calculatedtotalrent'});
      assert.equal(warm.price,1250.5);assert.equal(warm.area,60.5);assert.equal(warm.rooms,1.5);
      assert.match(warm.description,/Additional collapsed description/);
      assert.deepEqual(warm.amenities,['Balcony: Yes','Heating: Central']);
      const cold=await page.evaluate(extractDetails,{priceType:'rentpermonth'});
      assert.equal(cold.price,950);
      await page.evaluate(()=>document.querySelector('.is24qa-gesamtmiete').remove());
      await assert.rejects(page.evaluate(extractDetails,{priceType:'calculatedtotalrent'}),/Missing listing numeric/);
    });
    await t.test('actual hidden account markers and untrusted page prose',async()=>{
      await page.setContent(fixture + '<span data-testid="account-email" style="visibility:hidden">other@example.com</span>');
      assert.equal(await page.evaluate(readAccount),'me@example.com');
      await page.evaluate(()=>document.querySelector('header').remove());
      await page.evaluate(()=>{document.querySelector('main').append('Angemeldet als me@example.com');});
      assert.equal(await page.evaluate(readAccount),null);
      await page.evaluate(()=>{const node=document.querySelector('[data-testid="account-email"]');node.style.visibility='visible';});
      assert.equal(await page.evaluate(readAccount),'other@example.com');
      await page.setContent('<header>Angemeldet als me@example.com</header><nav>Angemeldet als other@example.com</nav>');
      assert.equal(await page.evaluate(readAccount),null);
    });
    await t.test('exact message, persona, selects and unchecked claims',async()=>{
      await page.setContent(fixture+form);
      await verifyForm(page,'Exact approved message.',persona);
      await page.evaluate(()=>document.querySelector('textarea').value='Regenerated message');
      await assert.rejects(verifyForm(page,'Exact approved message.',persona),/Exact approved/);
      await page.evaluate(()=>document.querySelector('textarea').value='Exact approved message.');
      await assert.rejects(verifyForm(page,'Exact approved message.',{...persona,email:'other@example.com'}),/Exact approved/);
      await assert.rejects(verifyForm(page,'Exact approved message.',{...persona,einkommen:''}),/Exact approved/);
      await page.evaluate(()=>{const claim=document.createElement('input');claim.type='checkbox';claim.checked=true;document.querySelector('form').append(claim);});
      await assert.rejects(verifyForm(page,'Exact approved message.',persona),/Exact approved/);
    });
    await t.test('modal-hidden/incomplete details and captcha fail closed',async()=>{
      await page.setContent(fixture);
      await page.evaluate(()=>document.querySelector('#is24-expose-description').style.visibility='hidden');
      // Equipment alone is not the full description: enforce main prose exists.
      await assert.rejects(page.evaluate(extractDetails),/Incomplete/);
      await page.setContent(fixture+'<div id="captcha-container">Challenge</div>');
      await assert.rejects(page.evaluate(extractDetails),/blocked/);
    });
  } finally {await browser.close();}
});
