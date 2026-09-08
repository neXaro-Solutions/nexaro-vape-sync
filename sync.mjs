import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ALLOWED_GROUPS = ['Einwegzigaretten', 'Prefilled Pods', 'Zubehör', 'ELFA Liquid'];
const DEFAULT_URL = 'https://e-zigaretten-handel.de/ezigaretten/';
const SEARCH_TERMS = ['ELFBAR', 'ELFA', 'LOST MARY', 'ELFLIQ'];
const MAX_SEARCH_PAGES = Number(process.env.MAX_SEARCH_PAGES || 50);
const MAX_CATEGORY_TARGETS = Number(process.env.MAX_CATEGORY_TARGETS || 50);
const MAX_CATEGORY_PAGES = Number(process.env.MAX_CATEGORY_PAGES || 30);

const normalizeText = (v='') => String(v).replace(/\s+/g, ' ').trim();

function classify(name = '', category = '', variant = '', url = '', context = '') {
  const s = normalizeText(`${name} ${category} ${variant} ${url} ${context}`).toLowerCase();
  // ELFA/ELFBAR liquids first so "ELFA" does not become a device/disposable.
  if (/elfliq|elfa[- _]?liquid|elfbar[- _]?elfliq/.test(s)) return 'ELFA Liquid';
  if (/prefilled|pre[- ]?filled|prefill(ed)?|pod[- _]?kits?|podkit|pod kits?/.test(s)) return 'Prefilled Pods';
  if (/zubehör|zubehoer|accessor(y|ies)|coil|coils|verdampfer|tank|drip tip|case|tasche|ladegerät|charging|kabel|akku|battery|pod holder|display|ständer|stand/.test(s)) return 'Zubehör';
  if (/einweg|disposable|elfbar 600|elfbar 800|lost mary bm|lost mary qm|tappo|eb[- _]?600|qm[- _]?600|bm[- _]?600/.test(s)) return 'Einwegzigaretten';
  // Brand-aware fallback for products whose model name omits the group keyword.
  if (/elfbar|lost mary/.test(s) && !/liquid|elfliq/.test(s)) return 'Einwegzigaretten';
  return '';
}

function normalize(p = {}) {
  const context = p.context || '';
  const haystack = normalizeText(`${p.name} ${p.category} ${p.variant} ${p.url} ${p.text || ''} ${context}`).toLowerCase();
  const allowedBrand = /elfbar|elfa|lost mary|elfliq/.test(haystack);
  const nexaroGroup = classify(p.name, p.category, p.variant, p.url, context);
  if (!allowedBrand || !nexaroGroup) return null;
  return {
    orderNo: normalizeText(p.orderNo),
    ean: normalizeText(p.ean),
    name: normalizeText(p.name),
    variant: normalizeText(p.variant),
    category: normalizeText(p.category),
    url: normalizeText(p.url),
    nexaroGroup,
    manufacturerHint: /lost mary/i.test(haystack) ? 'LOST MARY' : /elfliq/i.test(haystack) ? 'ELFLIQ' : /elfa/i.test(haystack) ? 'ELFA' : 'ELFBAR'
  };
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function login(page) {
  const user = await firstVisible(page, [
    process.env.LOGIN_USER_SELECTOR,
    'input[name="username"]','input[name="user"]','input[name="customer"]',
    'input[name="kundennummer"]','input[name="customerNumber"]','input[type="email"]','input[type="text"]'
  ].filter(Boolean));
  const pass = await firstVisible(page, [
    process.env.LOGIN_PASSWORD_SELECTOR,'input[name="password"]','input[name="pass"]','input[type="password"]'
  ].filter(Boolean));
  if (!user || !pass) throw new Error('Loginfelder nicht erkannt. Optional LOGIN_USER_SELECTOR / LOGIN_PASSWORD_SELECTOR als GitHub Secret setzen.');
  await user.fill(process.env.DEALER_USER);
  await pass.fill(process.env.DEALER_PASSWORD);
  const submit = await firstVisible(page, [
    process.env.LOGIN_SUBMIT_SELECTOR,'button[type="submit"]','input[type="submit"]',
    'button:has-text("Einloggen")','button:has-text("Login")','input[value*="Einloggen"]'
  ].filter(Boolean));
  if (!submit) throw new Error('Login-Button nicht erkannt. Optional LOGIN_SUBMIT_SELECTOR als GitHub Secret setzen.');
  await Promise.allSettled([page.waitForLoadState('domcontentloaded',{timeout:30000}), submit.click()]);
  await page.waitForTimeout(1200);
}

async function extractProducts(page, context='') {
  return await page.locator([
    '[data-product-id]','[data-article-id]','.product--box','.product-box','.product-box-container',
    '.product-item','.product-tile','.product-card','.product','.productlist-item','.product-list-item',
    'article.product','li.product','article'
  ].join(',')).evaluateAll((nodes, context) => nodes.map(node => {
    const text = (node.innerText || '').trim().replace(/\s+/g,' ');
    const cells = [...node.querySelectorAll('td')].map(x => x.innerText.trim());
    const links = [...node.querySelectorAll('a[href]')];
    const titleNode = node.querySelector('.product--title,.product-title,.product-name,.product--name,.product__title,.name,.title,h1,h2,h3,h4,[itemprop="name"]');
    const a = links.find(x => /product|artikel|p\/|detail/i.test(x.getAttribute('href') || '')) || links.find(x => (x.innerText||'').trim()) || links[0];
    const name = (titleNode?.innerText || a?.innerText || cells[2] || '').trim().replace(/\s+/g,' ');
    return {
      orderNo: cells[0] || node.getAttribute('data-product-id') || node.getAttribute('data-article-id') || '',
      ean: node.getAttribute('data-ean') || '', name,
      variant: node.querySelector('.variant,[class*="variant"]')?.innerText?.trim() || cells[3] || '',
      category: node.getAttribute('data-category') || '', url: a?.href || location.href, text, context
    };
  }), context);
}

async function linksByTerms(page, terms) {
  const wanted = terms.map(x=>x.toLowerCase());
  return await page.locator('a[href]').evaluateAll((nodes, wanted) => {
    const out=[];
    for (const a of nodes) {
      const text=(a.innerText||a.textContent||'').trim().replace(/\s+/g,' ');
      const href=a.href||'';
      const blob=`${text} ${href}`.toLowerCase();
      if (wanted.some(t=>blob.includes(t))) out.push({text:text.slice(0,120),href});
    }
    return [...new Map(out.map(x=>[x.href,x])).values()];
  }, wanted);
}

async function discoverCategoryLinks(page) {
  return await page.locator('a[href]').evaluateAll(nodes => {
    const terms=/einweg|disposable|prefilled|pre-filled|pod|zubehör|zubehoer|accessor|elfliq|elfa|elfbar|lost.?mary/i;
    const out=[];
    for(const a of nodes){
      const text=(a.innerText||a.textContent||'').replace(/\s+/g,' ').trim();
      const href=a.href||'';
      if(href && terms.test(`${text} ${href}`)) out.push({text:text.slice(0,120),href});
    }
    return [...new Map(out.map(x=>[x.href,x])).values()];
  });
}

async function discoverPaginationLinks(page) {
  return await page.locator('a[href]').evaluateAll(nodes => {
    const out=[];
    for(const a of nodes){
      const text=(a.innerText||a.textContent||'').replace(/\s+/g,' ').trim();
      const rel=(a.getAttribute('rel')||'').toLowerCase();
      const aria=(a.getAttribute('aria-label')||'').toLowerCase();
      const href=a.href||'';
      const cls=(a.className||'').toString().toLowerCase();
      const likely=rel==='next' || /next|weiter|vor|seite|page|pagination|pager/.test(`${text} ${aria} ${cls} ${href}`) || /[?&](p|page|seite)=\d+/i.test(href);
      if(likely&&href) out.push({text:text.slice(0,80),href,rel});
    }
    return [...new Map(out.map(x=>[x.href,x])).values()];
  });
}

async function crawlPages(page, seedUrls, context, maxPages) {
  const queue=[...seedUrls], seen=new Set(), raw=[], visited=[];
  while(queue.length && visited.length<maxPages){
    const href=queue.shift();
    if(seen.has(href)) continue; seen.add(href);
    await page.goto(href,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(400);
    const items=await extractProducts(page,context);
    raw.push(...items);
    visited.push({context,url:page.url(),path:new URL(page.url()).pathname,candidateCount:items.length,pageIndex:visited.length+1});
    const next=await discoverPaginationLinks(page);
    for(const n of next){ if(!seen.has(n.href) && !queue.includes(n.href) && queue.length<maxPages) queue.push(n.href); }
  }
  return {raw,visited};
}

async function trySearch(page, term) {
  const forms=await page.locator('form').evaluateAll(forms=>forms.map(form=>({
    action:form.action||location.href, method:(form.method||'get').toLowerCase(),
    inputs:[...form.querySelectorAll('input,textarea,select')].map(i=>({type:(i.getAttribute('type')||'').toLowerCase(),name:i.getAttribute('name')||'',placeholder:i.getAttribute('placeholder')||''})),
    text:normalizeText(form.innerText||'').slice(0,200)
  })));
  const candidates=forms.filter(f=>f.inputs.some(i=>!['password','submit','button','hidden'].includes(i.type)) && /suche|search/i.test(`${f.text} ${f.action} ${f.inputs.map(i=>i.name+' '+i.placeholder).join(' ')}`));
  if(!candidates.length) return {ok:false,reason:'search_form_not_found'};
  const selectors=[
    'form input[type="search"]','form input[name="search"]','form input[name="q"]','form input[name="query"]',
    'form input[placeholder*="Such"]','form input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"])'
  ];
  let input=null;
  for(const s of selectors){const loc=page.locator(s).first(); if(await loc.count()){input=loc;break;}}
  if(!input) return {ok:false,reason:'search_input_not_found'};
  await input.fill(term);
  const form=input.locator('xpath=ancestor::form[1]');
  const submit=await firstVisible(form,['button[type="submit"]','input[type="submit"]']);
  if(submit) await Promise.allSettled([page.waitForLoadState('domcontentloaded',{timeout:30000}),submit.click()]);
  else {await input.press('Enter'); await page.waitForLoadState('domcontentloaded',{timeout:30000}).catch(()=>{});}
  await page.waitForTimeout(700);
  return {ok:true,url:page.url()};
}

const loginUrl=process.env.DEALER_LOGIN_URL||process.env.DEALER_URL||DEFAULT_URL;
if(!process.env.DEALER_USER||!process.env.DEALER_PASSWORD) throw new Error('DEALER_USER und DEALER_PASSWORD müssen als GitHub Actions Secrets gesetzt sein.');

const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:45000});
  await login(page);

  const diagnostics={version:'10.1.0',loginUrl,searchTerms:SEARCH_TERMS,allowedGroups:ALLOWED_GROUPS,maxSearchPages:MAX_SEARCH_PAGES,maxCategoryTargets:MAX_CATEGORY_TARGETS,maxCategoryPages:MAX_CATEGORY_PAGES,generatedAt:new Date().toISOString()};
  const raw=[]; const visited=[]; const searchResults=[];

  // Primary: manufacturer searches, but preserve the working V8 category crawler as fallback.
  for(const term of SEARCH_TERMS){
    await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:45000});
    await login(page);
    try{
      const s=await trySearch(page,term);
      if(!s.ok){ searchResults.push({term,ok:false,reason:s.reason}); continue; }
      const crawled=await crawlPages(page,[s.url],term,MAX_SEARCH_PAGES);
      raw.push(...crawled.raw); visited.push(...crawled.visited);
      searchResults.push({term,ok:true,resultUrl:s.url,pagesVisited:crawled.visited.length,candidates:crawled.raw.length});
    }catch(e){ searchResults.push({term,ok:false,error:String(e?.message||e)}); }
  }

  // If searches produced little/no data, use the same post-login navigation that produced 944 raw candidates in V8.
  let fallback={used:false,candidates:0,pages:0};
  if(raw.length < 100){
    await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:45000});
    await login(page);
    const links=await discoverCategoryLinks(page);
    const targets=[...new Map(links.map(x=>[x.href,x])).values()].slice(0,MAX_CATEGORY_TARGETS);
    const crawled=await crawlPages(page,targets.map(x=>x.href),'CATEGORY_NAV',MAX_CATEGORY_PAGES*targets.length);
    raw.push(...crawled.raw); visited.push(...crawled.visited);
    fallback={used:true,candidates:crawled.raw.length,pages:crawled.visited.length,targets:targets.length,links:links.length};
  }

  // Detail enrichment: for promising candidates, fetch the product page and capture title/breadcrumb/category text.
  const prelim=raw.map(x=>({...x}));
  const detailTargets=[...new Map(prelim.filter(x=>x.url && /^https?:/i.test(x.url)).map(x=>[x.url,x])).values()].slice(0,300);
  let detailCount=0;
  for(const item of detailTargets){
    try{
      await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:30000});
      await page.waitForTimeout(200);
      const detail=await page.evaluate(()=>({
        title:document.title||'',
        h1:document.querySelector('h1')?.innerText||'',
        crumbs:[...document.querySelectorAll('.breadcrumb,.breadcrumbs,[aria-label*="breadcrumb"],nav')].map(x=>x.innerText||'').join(' '),
        body:(document.body?.innerText||'').slice(0,6000)
      }));
      item.context=normalizeText(`${item.context||''} ${detail.title} ${detail.h1} ${detail.crumbs} ${detail.body}`);
      detailCount++;
    }catch{}
  }

  const products=raw.map(normalize).filter(Boolean);
  const unique=[...new Map(products.map(p=>[`${p.orderNo}|${p.ean}|${p.name}|${p.variant}|${p.url}`,p])).values()];
  const counts=Object.fromEntries(ALLOWED_GROUPS.map(g=>[g,unique.filter(p=>p.nexaroGroup===g).length]));
  const manufacturers={ELFBAR:0,ELFA:0,'LOST MARY':0,ELFLIQ:0};
  for(const p of unique) manufacturers[p.manufacturerHint]=(manufacturers[p.manufacturerHint]||0)+1;

  diagnostics.finalUrl=page.url();
  diagnostics.searchResults=searchResults;
  diagnostics.fallback=fallback;
  diagnostics.rawCandidateCount=raw.length;
  diagnostics.filteredProductCount=unique.length;
  diagnostics.counts=counts;
  diagnostics.manufacturers=manufacturers;
  diagnostics.pagesVisited=visited.length;
  diagnostics.detailPagesVisited=detailCount;
  diagnostics.status=unique.length?'ok':'no_products_found';
  diagnostics.note='Hybrid-Sync: Hersteller-Suche zuerst; bei zu wenigen Ergebnissen Rückfall auf die funktionierende eingeloggte Kategorie-Navigation. Produktdetailseiten werden zur Gruppenerkennung nachangereichert. Nur die vier neXaro-Gruppen und ELFBAR/ELFA/LOST MARY/ELFLIQ werden übernommen.';

  await fs.mkdir('out',{recursive:true});
  await fs.writeFile('out/diagnostics.json',JSON.stringify(diagnostics,null,2),'utf8');
  await fs.writeFile('out/products.json',JSON.stringify({version:'10.1.0',syncedAt:diagnostics.generatedAt,source:diagnostics.finalUrl,searchTerms:SEARCH_TERMS,allowedGroups:ALLOWED_GROUPS,count:unique.length,counts,manufacturers,products:unique},null,2),'utf8');
  await fs.writeFile('out/summary.json',JSON.stringify({version:'10.1.0',syncedAt:diagnostics.generatedAt,source:diagnostics.finalUrl,searchTerms:SEARCH_TERMS,allowedGroups:ALLOWED_GROUPS,count:unique.length,counts,manufacturers,status:diagnostics.status,fallback},null,2),'utf8');
  console.log(`neXaro VAPE Sync 10.1.0: ${unique.length} Produkte`);
  console.log(JSON.stringify(counts));
  console.log(`Hersteller: ${JSON.stringify(manufacturers)}`);
  console.log(`Diagnose: ${diagnostics.status}; Suchseiten: ${visited.length}; Rohkandidaten: ${raw.length}; Detailseiten: ${detailCount}; Fallback: ${fallback.used?'ja':'nein'}`);
} finally { await browser.close(); }
