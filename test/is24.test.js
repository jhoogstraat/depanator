import test from 'node:test';
import assert from 'node:assert/strict';
import { IS24Adapter, listingUrl, readExpose, contactRequest } from '../src/is24.js';
import { loginRequired } from '../src/is24-auth.js';
import { validateSearchUrl, buildMobileApiUrl } from '../src/url-translator.js';
const searchUrl='https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten';
const config={searchUrl,maxPages:3,accountEmail:'me@example.com',persona:{vorname:'Me',nachname:'Example',email:'me@example.com'}};
const snapshot={expose_id:'123',title:'Home',price:900,area:60,rooms:2,address:'Berlin',image_url:'',url:listingUrl('123'),description:'Full listing description',amenities:['Balcony: yes']};
function network(pages) {
  let calls=0;
  return {fetch:async url=>{ const page=Number(new URL(url).searchParams.get('pagenumber')); calls++; return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=> ({resultListItems:pages[page-1],numberOfPages:pages.length})};},count:()=>calls};
}
const item=id=>({id,title:'Home',published:'vor 2 Stunden',paywallListing:{active:true},attributes:[{label:'',value:'1.234 €'},{label:'',value:'54 m²'},{label:'',value:'2,5 Zi.'}],address:{line:'Berlin'}});
test('strict translation rejects every known widening route',()=>{
  for (const query of ['furniture=true','equipment=fridge','heatingtypes=floorheating','unknown=true','price=-900&price=-1200','onlywithbalcony=false','built-in-kitchen=true','equipment=','newbuilding=false','pets-allowed=true','energy-efficiency=A','apartmenttypes=bogus']) assert.equal(validateSearchUrl(`${searchUrl}?${query}`).ok,false,query);
  for (const url of [searchUrl.replace('www.','evil'),searchUrl.replace('wohnung-mieten','nonsense'),searchUrl.replace('wohnung-mieten','haus-kaufen'),searchUrl.replace('wohnung-mieten','wohnung-mieten-tausch'),searchUrl.replace(/wohnung-mieten.*$/,'wohnung-bis-1000-euro-warm?price=-1500'),searchUrl.replace(/wohnung-mieten.*$/,'penthouse-mieten?apartmenttypes=loft'),searchUrl.replace('https:','http:')]) assert.equal(validateSearchUrl(url).ok,false,url);
  const valid=validateSearchUrl(`${searchUrl}?price=-1000&equipment=balcony,elevator&onlywithkitchen=true&utm_source=test`);
  assert.equal(valid.ok,true);
  assert.equal(buildMobileApiUrl(valid.canonical,{page:2}),'https://api.mobile.immobilienscout24.de/search/list?geocodes=%2Fde%2Fberlin%2Fberlin&searchType=region&realestatetype=apartmentrent&pricetype=calculatedtotalrent&price=-1000&equipment=balcony%2Clift%2CbuiltinKitchen&sorting=-firstactivation&pagenumber=2&pagesize=20');
});
test('pagination never stops on duplicates and exposes capped coverage',async()=>{
  const full=Array.from({length:20},(_,i)=>item(i+1));
  const fixture=network([full,full,[item(99)]]);
  const result=await new IS24Adapter(config,fixture).search();
  assert.equal(fixture.count(),3); assert.equal(result.complete,true); assert.equal(result.listings.length,21);
  assert.deepEqual([result.listings[0].price,result.listings[0].area,result.listings[0].rooms],[1234,54,2.5],'live unlabeled attribute format');
  assert.deepEqual([result.listings[0].published,result.listings[0].earlyAccess],['vor 2 Stunden',true]);
  const capped=await new IS24Adapter({...config,maxPages:2},network([full,full,full])).search();
  assert.equal(capped.complete,false); assert.equal(capped.pages,2);
  // Newest first: a routine poll stops once a page ends with an already known listing...
  const routine=network([full,full,[item(99)]]);
  const known=await new IS24Adapter(config,routine).search({known:id=>id==='20'});
  assert.equal(routine.count(),1); assert.deepEqual([known.complete,known.caughtUp,known.listings.length],[true,true,20]);
  // ...but a known listing promoted to the top of page 1 does not hide the new ones below.
  const promoted=network([full,full,[item(99)]]);
  assert.equal((await new IS24Adapter(config,promoted).search({known:id=>id==='1'})).listings.length,21);
  assert.equal(result.caughtUp,false,'a first check has not caught up');
});
test('malformed/block search fails rather than reporting empty coverage',async()=>{
  const adapter=new IS24Adapter(config,{fetch:async()=>({ok:true,status:200,headers:{get:()=> 'text/html'}})});
  await assert.rejects(adapter.search(),/unavailable/);
  assert.throws(()=>listingUrl('123/../account'),/Invalid/);
  await assert.rejects(new IS24Adapter(config,network([[item('bad')]])).search(),/Invalid/);
});
// The shape of the app's expose JSON (trimmed from a live listing).
const expose = (contactData = {}) => ({
  sections: [
    { type: 'TOP_ATTRIBUTES', attributes: [{ label: 'Kaltmiete 20,53 €/m²', text: '680 €' }, { label: 'Zimmer', text: '1' }, { label: 'Wohnfläche', text: '33,13 m²' }, { label: 'Warmmiete', text: '890 €' }] },
    { type: 'TITLE', title: 'Erstbezug: Studio mit Terrasse' },
    { type: 'MAP', addressLine1: 'Pasewalker Straße 96', addressLine2: '13127 Französisch Buchholz, Berlin' },
    { type: 'ATTRIBUTE_LIST', title: 'Hauptkriterien', attributes: [{ type: 'TEXT', label: 'Etage:', text: '0 von 4' }, { type: 'CHECK', label: 'Balkon/Terrasse:' }] },
    { type: 'TEXT_AREA', title: 'Objektbeschreibung', text: 'Ruhig zur Gartenseite.' },
  ],
  contact: { premiumProfileRequiredForContacting: 'false', contactData: { formFieldConfig: { firstnameField: 'MANDATORY', lastnameField: 'MANDATORY', emailAddressField: 'MANDATORY', phoneNumberField: 'OPTIONAL', moveInDateField: 'OPTIONAL' }, ...contactData } },
});
const persona = { anrede: 'FEMALE', vorname: 'Me', nachname: 'Example', email: 'me@example.com' };

test('listing details come from the app API and keep warm and cold rent apart', () => {
  assert.deepEqual(readExpose(expose(), 'calculatedtotalrent'), { title: 'Erstbezug: Studio mit Terrasse', price: 890, area: 33.13, rooms: 1,
    address: 'Pasewalker Straße 96, 13127 Französisch Buchholz, Berlin', description: 'Objektbeschreibung\nRuhig zur Gartenseite.', amenities: ['Balkon/Terrasse: ja', 'Etage: 0 von 4'] });
  assert.equal(readExpose(expose(), 'rentpermonth').price, 680);
  const changed = expose();
  changed.sections[0].attributes.pop();
  assert.throws(() => readExpose(changed, 'calculatedtotalrent'), /no price/, 'never falls back to cold rent');
});

test('contact requests carry only approved data and refuse fields they cannot fill', () => {
  const { body } = contactRequest(expose(), persona, 'Hallo!', 'sso-1');
  assert.deepEqual(body['expose.contactForm'], { salutation: 'FEMALE', firstname: 'Me', lastname: 'Example', emailAddress: 'me@example.com', message: 'Hallo!', privacyPolicyAccepted: true, profileType: 'BASIC', sendProfile: false });
  assert.equal(contactRequest(expose(), { ...persona, sendProfile: true }, 'Hallo!').body['expose.contactForm'].sendProfile, true, 'the IS24 profile is attached only when chosen');
  assert.equal(body.ssoId, 'sso-1');
  assert.match(contactRequest(expose({ formFieldConfig: { incomeField: 'MANDATORY' } }), persona, 'Hallo!').reason, /requires income, which I cannot fill in/);
  assert.match(contactRequest(expose({ formFieldConfig: { phoneNumberField: 'MANDATORY' } }), persona, 'Hallo!').reason, /requires a phone number\. Add it in \/prompt/);
  assert.match(contactRequest({ ...expose(), contact: { premiumProfileRequiredForContacting: 'true' } }, persona, 'Hallo!').reason, /Premium/);
});

function sending({ status = 200, email = config.accountEmail, error } = {}) {
  const posts = [];
  const fetch = async (url, request = {}) => {
    if (request.method === 'POST') { posts.push({ url, body: JSON.parse(request.body), auth: request.headers.Authorization }); if (error) throw error; return { ok: status < 300, status, text: async () => '{"message":"nope"}' }; }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => expose() };
  };
  const session = { email, ssoId: 'sso-1', accessToken: async () => 'token' };
  return { adapter: new IS24Adapter({ ...config, persona }, { session, fetch }), posts };
}
const review = { snapshot: { expose_id: '123' }, draft: 'Hallo!' };

test('send: one request after the last approval check; answers map to sent, failed or unknown', async () => {
  const ok = sending();
  assert.deepEqual(await ok.adapter.send(review, { beforeSubmit: async () => true }), { outcome: 'sent', detail: 'IS24 accepted the request' });
  assert.deepEqual([ok.posts.length, ok.posts[0].url, ok.posts[0].auth, ok.posts[0].body['expose.contactForm'].message], [1, 'https://api.mobile.immobilienscout24.de/expose/123/contact?referrer=resultlist', 'Bearer token', 'Hallo!']);
  assert.equal((await sending({ status: 400 }).adapter.send(review, { beforeSubmit: async () => true })).outcome, 'failed');
  assert.equal((await sending({ status: 500 }).adapter.send(review, { beforeSubmit: async () => true })).outcome, 'unknown_outcome', 'a server error may come after delivery');
  assert.equal((await sending({ error: new Error('socket hang up') }).adapter.send(review, { beforeSubmit: async () => true })).outcome, 'unknown_outcome');
  const revoked = sending();
  assert.equal((await revoked.adapter.send(review, { beforeSubmit: async () => false })).outcome, 'failed');
  const other = sending({ email: 'other@example.com' });
  assert.match((await other.adapter.send(review, { beforeSubmit: async () => true })).detail, /differs/);
  assert.equal(revoked.posts.length + other.posts.length, 0, 'nothing is sent without a valid approval and account');
});

test('authentication asks the owner to connect until IS24 access works, and propagates outages', async () => {
  let connected = false, prompts = 0;
  const session = { accessToken: async () => { if (!connected) throw loginRequired(); return 'token'; } };
  const adapter = new IS24Adapter(config, { session });
  await adapter.authenticate(async () => { prompts++; connected = true; });
  await adapter.authenticate(async () => { throw new Error('Unexpected prompt'); });
  assert.equal(prompts, 1);
  session.accessToken = async () => { throw new Error('offline'); };
  await assert.rejects(adapter.authenticate(async () => { prompts++; }), /offline/);
  assert.equal(prompts, 1);
});
