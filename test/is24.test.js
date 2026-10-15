import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { IS24Adapter, listingUrl, readAccount, extractDetails, verifyForm } from '../src/is24.js';
import { validateSearchUrl } from '../src/url-translator.js';
import { IS24Contactor } from '../src/is24-contactor.js';
const searchUrl='https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten';
const config={searchUrl,maxPages:3,browserProfile:'/tmp/test-is24-profile',accountEmail:'me@example.com',persona:{vorname:'Me',nachname:'Example',email:'me@example.com'}};
const snapshot={expose_id:'123',title:'Home',price:900,area:60,rooms:2,address:'Berlin',image_url:'',url:listingUrl('123'),description:'Full listing description',amenities:['Balcony: yes']};
function network(pages) {
  let calls=0;
  return {fetch:async url=>{ const page=Number(new URL(url).searchParams.get('pagenumber')); calls++; return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=> ({resultListItems:pages[page-1],numberOfPages:pages.length})};},count:()=>calls};
}
const item=id=>({id,title:'Home',attributes:[{label:'',value:'1.234 €'},{label:'',value:'54 m²'},{label:'',value:'2,5 Zi.'}],address:{line:'Berlin'}});
test('container browser path and sandbox flags apply to automated and manual launch',async()=>{
  const serverConfig={...config,browser:{executablePath:'/usr/bin/chromium',disableSandbox:true}};
  let automated, manual;
  const adapter=new IS24Adapter(serverConfig,{
    launch:async options=>{automated=options;return {newPage:async()=>({}),close:async()=>{}};},
    spawn:(path,args)=>{manual={path,args};const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;},
  });
  await adapter.ensureBrowser();
  await adapter.login();
  assert.equal(automated.executablePath,'/usr/bin/chromium');
  assert.equal(manual.path,'/usr/bin/chromium');
  for(const flag of ['--no-sandbox','--disable-setuid-sandbox']) {
    assert.ok(automated.args.includes(flag));assert.ok(manual.args.includes(flag));
  }
  assert.deepEqual(new IS24Adapter(config).browserArgs(),[],'local browser keeps its sandbox by default');
});
test('strict translation rejects every known widening route',()=>{
  for (const query of ['furniture=true','equipment=fridge','heatingtypes=floorheating','unknown=true','price=-900&price=-1200','onlywithbalcony=false','built-in-kitchen=true','equipment=','newbuilding=false']) assert.equal(validateSearchUrl(`${searchUrl}?${query}`,{strict:true}).ok,false,query);
  for (const url of [searchUrl.replace('www.','evil'),searchUrl.replace('wohnung-mieten','nonsense'),searchUrl.replace('https:','http:')]) assert.equal(validateSearchUrl(url,{strict:true}).ok,false,url);
  const valid=validateSearchUrl(`${searchUrl}?price=-1000&equipment=balcony&utm_source=test`,{strict:true});
  assert.equal(valid.ok,true);
  assert.equal(new URL(valid.mobileUrl).searchParams.get('price'),'-1000');
  assert.equal(new URL(valid.mobileUrl).searchParams.has('exclusioncriteria'),false);
});
test('pagination never stops on duplicates and exposes capped coverage',async()=>{
  const full=Array.from({length:20},(_,i)=>item(i+1));
  const fixture=network([full,full,[item(99)]]);
  const result=await new IS24Adapter(config,fixture).search();
  assert.equal(fixture.count(),3); assert.equal(result.complete,true); assert.equal(result.listings.length,21);
  assert.deepEqual([result.listings[0].price,result.listings[0].area,result.listings[0].rooms],[1234,54,2.5],'live unlabeled attribute format');
  const capped=await new IS24Adapter({...config,maxPages:2},network([full,full,full])).search();
  assert.equal(capped.complete,false); assert.equal(capped.pages,2);
});
test('malformed/block search fails rather than reporting empty coverage',async()=>{
  const adapter=new IS24Adapter(config,{fetch:async()=>({ok:true,status:200,headers:{get:()=> 'text/html'}})});
  await assert.rejects(adapter.search(),/unavailable/);
  assert.throws(()=>listingUrl('123/../account'),/Invalid/);
  await assert.rejects(new IS24Adapter(config,network([[item('bad')]])).search(),/Invalid/);
});
function fixture({account=config.accountEmail,detail={},success=true,throwAfterClick=false,revoke=false}={}) {
  let clicks=0;
  const page={goto:async()=>({ok:()=>true}),url:()=>snapshot.url,evaluate:async(fn)=>fn===readAccount ? account : fn===extractDetails ? {...snapshot,...detail} : true};
  const contactor={apply:async(id,draft,key,tabs,options)=>{await options.beforeSubmit(page); options.onSubmitAttempt(); clicks++; if(throwAfterClick) throw new Error('transport lost'); return {success,detail:'confirmation'};}};
  const adapter=new IS24Adapter(config,{launch:async()=>({newPage:async()=>page,close:async()=>{}}),contactor});
  return {adapter,clicks:()=>clicks,beforeSubmit:async()=>!revoke};
}
test('account mismatch, unverified identity, changed snapshot, revocation fail before click',async()=>{
  for(const options of [{account:null},{account:'other@example.com'},{detail:{price:901}},{revoke:true}]) {
    const f=fixture(options); const result=await f.adapter.send({snapshot,draft:'Exact approved text'},{beforeSubmit:f.beforeSubmit});
    assert.equal(result.outcome,'failed'); assert.equal(f.clicks(),0);
  }
});
test('single submit maps confirmation to sent and all uncertainty to unknown',async()=>{
  for(const options of [{},{success:false},{throwAfterClick:true}]) {
    const f=fixture(options); const result=await f.adapter.send({snapshot,draft:'Exact approved text'},{beforeSubmit:f.beforeSubmit});
    assert.equal(result.outcome,options.success===false||options.throwAfterClick?'unknown_outcome':'sent'); assert.equal(f.clicks(),1);
  }
});
test('shutdown and restore guards can still prevent click after final async validation',async()=>{
  for (const mode of ['shutdown', 'restore']) {
    const f=fixture();
    const beforeSubmit=async()=>{ if(mode==='shutdown') f.adapter.cancelLogin(); return true; };
    const result=await f.adapter.send({snapshot,draft:'Exact approved text'},{beforeSubmit,assertCanSubmit:()=>{if(mode==='restore') throw new Error('Restore reconciliation required');}});
    assert.equal(result.outcome,'failed'); assert.equal(f.clicks(),0);
    await f.adapter.close();
  }
});
test('browser tasks serialize to preserve page and account context',async()=>{
  const adapter=new IS24Adapter(config); const order=[];
  await Promise.all([adapter.serial(async()=>{order.push('a');await new Promise(r=>setTimeout(r,10));order.push('b');}),adapter.serial(async()=>order.push('c'))]);
  assert.deepEqual(order,['a','b','c']);
});
test('contactor has one submit call and captcha cannot trigger resubmit',async()=>{
  const source=await readFile(new URL('../src/is24-contactor.js',import.meta.url),'utf8');
  assert.equal((source.match(/await this\._clickAbschicken\(/g)||[]).length,1);
  const contactor=new IS24Contactor(null,{});
  let commands=0; let marks=0;
  contactor.page={evaluate:async()=>{commands++;return true;}};
  await contactor._clickAbschicken(()=>marks++);
  assert.equal(commands,1);assert.equal(marks,1);
  assert.equal(await contactor._solveCaptcha(),false);
});
test('account proof excludes listing/contact email and ambiguous account indicators',()=>{
  const oldDocument=globalThis.document;
  const visible=text=>({textContent:text,innerText:text,getClientRects:()=>[{}]});
  try {
    globalThis.document={body:{innerText:'angemeldet als me@example.com'},querySelectorAll:()=>[]};
    assert.equal(readAccount(),null);
    globalThis.document.querySelectorAll=selector=>selector.startsWith('header')?[visible('Angemeldet als me@example.com')]:[];
    assert.equal(readAccount(),'me@example.com');
    globalThis.document.querySelectorAll=selector=>selector.startsWith('header')?[]:[visible('me@example.com'),visible('other@example.com')];
    assert.equal(readAccount(),null);
  } finally { globalThis.document=oldDocument; }
});
test('details snapshot extracts complete section text and rejects incomplete/block pages',()=>{
  const oldDocument=globalThis.document;
  const element=(text,full=text)=>({innerText:text,textContent:full,getClientRects:()=>[{}]});
  const dd={...element('yes'),tagName:'DD'};
  const dt={...element('Balcony'),nextElementSibling:dd};
  const mappings={h1:[element('Home')],'.is24qa-gesamtmiete':[element('900 €')],'.is24qa-wohnflaeche':[element('60 m²')],'.is24qa-zimmer':[element('2')],'.is24-expose-address, [data-testid="expose-address"]':[element('Berlin')],dl:[{querySelectorAll:()=>[dt]}]};
  try {
    globalThis.document={body:{innerText:'Active home'},querySelector:()=>null,querySelectorAll:selector=>selector.startsWith('#is24-expose-description')?[element('Collapsed excerpt','Entire full description')]:mappings[selector]||[]};
    const detail=extractDetails();
    assert.equal(detail.description,'Entire full description');assert.deepEqual(detail.amenities,['Balcony: yes']);assert.equal(detail.price,900);
    globalThis.document.body.innerText='Ich bin kein Roboter';assert.throws(extractDetails,/blocked/);
    globalThis.document.body.innerText='Home';mappings.dl=[];assert.throws(extractDetails,/Incomplete/);
  } finally {globalThis.document=oldDocument;}
});

test('final form verification binds exact message and identity, rejects site defaults',async()=>{
  const oldDocument=globalThis.document;
  const values={'textarea[name="message"]':{value:'Approved draft'},'input[name="firstName"]':{value:'Me'},'input[name="lastName"]':{value:'Example'},'input[name="emailAddress"]':{value:'me@example.com'}};
  const form={querySelector:selector=>values[selector]||null,querySelectorAll:()=>[]};
  const page={evaluate:async(fn,arg)=>fn(arg)};
  try {
    globalThis.document={querySelector:()=>form};
    await verifyForm(page,'Approved draft',config.persona);
    values['textarea[name="message"]'].value='Changed draft';
    await assert.rejects(verifyForm(page,'Approved draft',config.persona),/Exact approved/);
    values['textarea[name="message"]'].value='Approved draft';
    values['input[name="emailAddress"]'].value='other@example.com';
    await assert.rejects(verifyForm(page,'Approved draft',config.persona),/Exact approved/);
    values['input[name="emailAddress"]'].value='me@example.com';
    values['select[name="income"]']={value:'High income'};
    await assert.rejects(verifyForm(page,'Approved draft',config.persona),/Exact approved/);
  } finally {globalThis.document=oldDocument;}
});
