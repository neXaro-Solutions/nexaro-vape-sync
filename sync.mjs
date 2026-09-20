import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { extractDealerPrice } from './price.mjs';

const ROOT = process.cwd();
const MASTER = process.env.MASTER_CSV || path.join(ROOT, 'data', 'master.csv');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

const ALLOWED = new Set(['Einweg E-Zigaretten','Prefilled Pod Kits','Zubehör','ELFA Liquid']);
const MAX_TARGETS = Number(process.env.MAX_CATEGORY_TARGETS || 50);
const MAX_PAGES = Number(process.env.MAX_PAGES_PER_TARGET || 30);
const MAX_DETAILS = Number(process.env.MAX_DETAIL_PAGES || 600);
const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD || 0.72);
const REVIEW_THRESHOLD = Number(process.env.MATCH_REVIEW_THRESHOLD || 0.58);

function parseCsv(text) {
  const rows=[]; let row=[], field='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(c==='"' && q && n==='"'){ field+='"'; i++; continue; }
    if(c==='"'){ q=!q; continue; }
    if(c===';' && !q){ row.push(field); field=''; continue; }
    if((c==='\n'||c==='\r')&&!q){ if(c==='\r'&&n==='\n')i++; row.push(field); field=''; if(row.some(x=>x.trim()))rows.push(row); row=[]; continue; }
    field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row);}
  if(!rows.length)return[];
  const headers=rows.shift().map(x=>x.trim());
  return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,(r[i]??'').trim()])));
}
function norm(s='') {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/&/g,' und ')
    .replace(/\b(ve|stk|stuck|stück|2x|10er|10x|10er pack|pack)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ').trim();
}
function tokens(s){ return new Set(norm(s).split(' ').filter(x=>x.length>1)); }
function similarity(a,b){
  const A=tokens(a), B=tokens(b); if(!A.size||!B.size)return 0;
  let inter=0; for(const x of A) if(B.has(x))inter++;
  const j=inter/(A.size+B.size-inter);
  const containment=inter/Math.min(A.size,B.size);
  return 0.65*j+0.35*containment;
}
function parseMoney(v){ const n=Number(String(v).replace(/[^0-9,.-]/g,'').replace(/\./g,'').replace(',','.')); return Number.isFinite(n)?n:null; }
function makeId(i){ return `NX-VAPE-${String(i+1).padStart(4,'0')}`; }
function classify(category='', name=''){
  const s=norm(`${category} ${name}`);
  if(/elfliq|elfa liquid/.test(s)) return 'ELFA Liquid';
  if(/prefilled|pre filled|pod kit|podkit|refillable pod|pod filter|wavi pod|tappo.*pod/.test(s)) return 'Prefilled Pod Kits';
  if(/zubehoer|accessor|coil|verdampfer|tank|ladegeraet|charging|kabel|akku|battery|case|tasche/.test(s)) return 'Zubehör';
  if(/einweg|disposable|elfbar 600|elfbar 800|lost mary 600|lost mary 800|bm600|qm600|tappo/.test(s)) return 'Einweg E-Zigaretten';
  return category || '';
}
function loadMaster(){
  if(!fs.existsSync(MASTER)) { console.warn('Kein lokaler Master-Katalog: reiner Händler-Erstabgleich ohne bestehende Produktzuordnung.'); return []; }
  const rows=parseCsv(fs.readFileSync(MASTER,'utf8'));
  return rows.map((r,i)=>({
    neXaroId: makeId(i),
    sourceId: r['Artikelnummer'] || '',
    category: classify(r['Kategorie'], r['Artikelname']),
    name: r['Artikelname'] || '',
    ekPdf: parseMoney(r['EK-Preis laut PDF (€)']),
    pack: r['Verpackungseinheit'] || '',
    image: r['Produktfoto'] || '',
    pdfPage: r['PDF-Seite'] || ''
  })).filter(x=>x.name && ALLOWED.has(x.category));
}
async function visible(page, selectors){
  for(const s of selectors.filter(Boolean)){
    const l=page.locator(s).first();
    if(await l.count() && await l.isVisible().catch(()=>false)) return l;
  }
  return null;
}
async function login(page){
  const user=await visible(page,['input[name="username"]','input[name="user"]','input[name="customer"]','input[name="kundennummer"]','input[name="customerNumber"]','input[type="email"]','input[type="text"]']);
  const pass=await visible(page,['input[name="password"]','input[name="pass"]','input[type="password"]']);
  if(!user||!pass) throw new Error('Loginfelder nicht erkannt. Die Seite wurde möglicherweise bereits als eingeloggte Sitzung geöffnet oder die Selektoren haben sich geändert.');
  await user.fill(process.env.DEALER_USER || '');
  await pass.fill(process.env.DEALER_PASSWORD || '');
  const submit=await visible(page,['button[type="submit"]','input[type="submit"]','button:has-text("Einloggen")','button:has-text("Login")','input[value*="Einloggen"]']);
  if(!submit) throw new Error('Login-Button nicht erkannt.');
  await Promise.allSettled([page.waitForLoadState('domcontentloaded',{timeout:30000}),submit.click()]);
  await page.waitForTimeout(800);
}
function looksHtml(url){ return !/\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|webp)(\?|$)/i.test(url); }
async function discoverLinks(page){
  const links=await page.locator('a[href]').evaluateAll(as=>as.map(a=>({href:a.href,text:(a.innerText||'').trim()})));
  const seen=new Map();
  for(const x of links){ if(!x.href || !looksHtml(x.href)) continue; const t=norm(x.text); const u=x.href.toLowerCase();
    if(/ezigaretten|prefilled|einweg|elfliq|liquid|zubehoer|zubehör|pod|disposable/.test(`${t} ${u}`)) seen.set(x.href,x);
  }
  return [...seen.values()].slice(0,MAX_TARGETS);
}
async function extractListing(page){
  return page.locator('a[href]').evaluateAll(as=>{
    const out=[]; const seen=new Set();
    for(const a of as){
      const href=a.href; if(!href || seen.has(href)) continue;
      const card=a.closest('.product--box,.product-box,.product,.product--box-content,article,[data-product-id],[data-article-id]');
      if(!card) continue;
      const text=(card.innerText||'').trim();
      const img=card.querySelector('img');
      const title=(card.querySelector('.product--title,.product-title,[class*="title"],h2,h3')?.innerText||a.innerText||text.split('\n')[0]||'').trim();
      const price=(card.querySelector('.price,.product--price,[class*="price"]')?.innerText||'').trim();
      const status=(card.innerText||'').match(/sofort[^\n]{0,80}|nicht verfügbar[^\n]{0,80}|lieferzeit[^\n]{0,80}/i)?.[0]||'';
      if(title) { seen.add(href); out.push({url:href,name:title,price,status,image:img?.src||''}); }
    }
    return out;
  });
}
async function extractDetail(page,url,listing){
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForTimeout(300);
  const d=await page.locator('body').evaluate(()=>{
    const text=document.body?.innerText||'';
    const pick=(re)=>{const m=text.match(re);return m?m[1].trim():''};
    const imgs=[...document.images].map(i=>i.currentSrc||i.src).filter(Boolean);
    return {
      title:(document.querySelector('h1')?.innerText||'').trim(),
      articleNo:pick(/Artikel-?Nr\.?\s*[:#]?\s*([A-Z0-9._/-]+)/i),
      ean:pick(/EAN\s*[:#]?\s*(\d{8,14})/i),
      price:null, // Derived below from the product-specific price context.
      availability:(text.match(/(?:sofort[^\n]{0,120}|lieferzeit[^\n]{0,120}|nicht verfügbar[^\n]{0,120})/i)||[''])[0],
      images:imgs,
      body:text.slice(0,12000)
    };
  });
  const parsed=extractDealerPrice({body:d.body,title:d.title||listing?.name||'',listingPrice:listing?.price||''});
  return {url, listing, ...d, ...parsed, price:parsed.priceCandidate, category:classify('',d.title||listing?.name||'')};
}
async function main(){
  if(!process.env.DEALER_USER||!process.env.DEALER_PASSWORD) throw new Error('DEALER_USER und DEALER_PASSWORD müssen als Secrets/Umgebungsvariablen gesetzt werden.');
  const master=loadMaster();
  fs.writeFileSync(path.join(OUT,'master-normalized.json'),JSON.stringify(master,null,2));
  const browser=await chromium.launch({headless:process.env.HEADLESS!=='false',args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const root=process.env.DEALER_LOGIN_URL||'https://e-zigaretten-handel.de/ezigaretten/';
  await page.goto(root,{waitUntil:'domcontentloaded',timeout:45000});
  await login(page);
  const categoryLinks=[]; // Nur die ausdrücklich freigegebene /ezigaretten/-Kategorie und ihre Folgeseiten.
  const listingMap=new Map(); let pagesVisited=0;
  const targets=[{href:process.env.PRODUCT_ROOT_URL||root,text:'E-Zigaretten'}];
  for(const target of targets){
    let url=target.href;
    const seenPages=new Set();
    const baseCategory=new URL(target.href);
    for(let p=0;p<MAX_PAGES;p++){
      if(!looksHtml(url)||seenPages.has(url)) break;
      seenPages.add(url);
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
      if(response?.status()===404 && p>0) break;
      if(response && !response.ok()) throw new Error(`Katalogseite nicht abrufbar: HTTP ${response.status()} (${url})`);
      pagesVisited++;
      const items=(await extractListing(page)).filter(x=>{
        try { const u=new URL(x.url); return u.hostname===baseCategory.hostname && !u.searchParams.has('p'); }
        catch { return false; }
      });
      const before=listingMap.size;
      for(const item of items) listingMap.set(item.url,item);
      if(!items.length || listingMap.size===before) break;
      const next=page.locator('a[rel="next"],a:has-text("Nächste"),a:has-text("Weiter")').first();
      const href=await next.count()?await next.getAttribute('href'):null;
      const nextUrl=href?new URL(href,page.url()).href:new URL(baseCategory.href);
      if(!href) nextUrl.searchParams.set('p',String(p+2));
      url=href?nextUrl:nextUrl.href;
    }
  }
  if(!listingMap.size) throw new Error('Keine Produktlinks erkannt; Katalogstruktur und Anmeldung prüfen.');
  const listings=[...listingMap.values()];
  const details=[]; let n=0;
  for(const item of listings){
    if(n++>=MAX_DETAILS) break;
    try{ details.push(await extractDetail(page,item.url,item)); }
    catch(e){ details.push({url:item.url,listing:item,error:String(e?.message||e)}); }
  }
  await browser.close();
  const mapped=[]; const used=new Set();
  for(const d of details){
    const candidates=master.map(m=>({m,score:similarity(`${m.name} ${m.category}`,`${d.title||d.listing?.name||''} ${d.category||''}`)})).sort((a,b)=>b.score-a.score);
    const best=candidates[0]; const second=candidates[1];
    const confidence=best?.score||0;
    const status=confidence>=MATCH_THRESHOLD?'AUTO_MATCH':confidence>=REVIEW_THRESHOLD?'REVIEW':'UNMATCHED';
    if(status==='AUTO_MATCH' && used.has(best.m.neXaroId)){ mapped.push({status:'DUPLICATE_MATCH',confidence,detail:d,candidate:best.m}); continue; }
    if(status==='AUTO_MATCH') used.add(best.m.neXaroId);
    mapped.push({status,confidence,secondConfidence:second?.score||0,detail:{url:d.url,title:d.title||d.listing?.name||'',articleNo:d.articleNo||'',ean:d.ean||'',price:d.price,priceStatus:d.priceStatus||'missing',priceSource:d.priceSource||'missing',netBasisVerified:false,availability:d.availability||'',image:(d.images||[])[0]||d.listing?.image||''},candidate:best?.m||null});
  }
  const summary={version:'2.1.0',generatedAt:new Date().toISOString(),masterCount:master.length,categoryLinks:categoryLinks.length,listingCandidates:listings.length,detailPages:details.length,pagesVisited,mappedAuto:mapped.filter(x=>x.status==='AUTO_MATCH').length,review:mapped.filter(x=>x.status==='REVIEW').length,unmatched:mapped.filter(x=>x.status==='UNMATCHED').length,duplicateMatches:mapped.filter(x=>x.status==='DUPLICATE_MATCH').length,priceCandidates:details.filter(x=>Number(x.priceCandidate)>0).length,priceMissing:details.filter(x=>!Number(x.priceCandidate)).length,priceReview:details.filter(x=>x.priceStatus==='requires_variant_or_tier_review').length,confirmedNetPrices:0,limitReached:pagesVisited>=MAX_PAGES};
  // Owner policy: complete VE by default; individual items only after per-product owner approval and supplier confirmation.
  // Never infer a pack size from the number of pods in a product's name ("2X").
  // Bundles with options must be reviewed as a complete bundle before ordering.
  const veDraft=details.map(d=>{
    const title=d.title||d.listing?.name||'';
    const explicit=/\bVE\s*[:=]?\s*(\d{1,5})\s*(?:St[üu]ck|Stk\.?|pcs)?\b/i.exec(title);
    const units=explicit?Number(explicit[1]):null;
    const bundle=/\bBUNDLE\b|\bPROMO\b|\bAKTION\b/i.test(title);
    return {
      supplier_article_no:d.articleNo||null,ean:d.ean||null,title,url:d.url,
      category:d.category||null,default_order_unit:'VE',minimum_order_ve:1,quantity_step_ve:1,
      individual_sale_supplier_available:null,individual_sale_owner_approved:false,
      individual_purchase_net_confirmed:null,individual_sale_net_price:null,
      individual_sale_eligible:false,individual_sale_status:'blocked_pending_supplier_and_owner_verification',
      pieces_per_ve:units,packaging_status:explicit?'explicit_ve':bundle?'bundle_review':'unknown_ve',
      purchase_net_per_ve_candidate:Number(d.priceCandidate)>0?d.priceCandidate:null,
      purchase_price_basis:'net_owner_confirmed',price_source:d.priceSource||'missing',
      price_status:d.priceStatus||'missing',customer_orderable:false,
      review_required:!explicit || d.priceStatus!=='unit_price_candidate',
      // Gross margin, not a markup: VK = EK / (1 - margin/100).
      standard_margin_percent:25,minimum_margin_percent:15,vat_percent:19,
    };
  });
  fs.writeFileSync(path.join(OUT,'ve-catalog-draft.json'),JSON.stringify(veDraft,null,2));
  const csvFields=['supplier_article_no','ean','title','url','category','default_order_unit','minimum_order_ve','quantity_step_ve','pieces_per_ve','packaging_status','purchase_net_per_ve_candidate','purchase_price_basis','price_source','price_status','customer_orderable','review_required','individual_sale_supplier_available','individual_sale_owner_approved','individual_purchase_net_confirmed','individual_sale_net_price','individual_sale_eligible','individual_sale_status','standard_margin_percent','minimum_margin_percent','vat_percent'];
  const csvCell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  fs.writeFileSync(path.join(OUT,'ve-catalog-draft.csv'),
    '\uFEFF'+[csvFields.join(';'),...veDraft.map(row=>csvFields.map(k=>csvCell(row[k])).join(';'))].join('\n'));
  summary.veExplicit=veDraft.filter(x=>x.packaging_status==='explicit_ve').length;
  summary.veBundleReview=veDraft.filter(x=>x.packaging_status==='bundle_review').length;
  summary.veUnknown=veDraft.filter(x=>x.packaging_status==='unknown_ve').length;
  summary.customerOrderable=0;
  summary.individualSaleApproved=0;
  fs.writeFileSync(path.join(OUT,'summary.json'),JSON.stringify(summary,null,2));
  fs.writeFileSync(path.join(OUT,'mapping.json'),JSON.stringify(mapped,null,2));
  fs.writeFileSync(path.join(OUT,'dealer-products.json'),JSON.stringify(details,null,2));
  console.log(`neXaro VAPE Sync 2.1.0: ${master.length} Master / ${listings.length} Händler-Links / ${details.length} Detailseiten`);
  console.log(JSON.stringify(summary,null,2));
}
main().catch(e=>{ console.error(e?.stack||e); process.exit(1); });
