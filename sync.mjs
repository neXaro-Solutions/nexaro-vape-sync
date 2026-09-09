import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ALLOWED_GROUPS = ['Einwegzigaretten', 'Prefilled Pods', 'Zubehör', 'ELFA Liquid'];
const DEFAULT_URL = 'https://e-zigaretten-handel.de/ezigaretten/';
const SEARCH_TERMS = ['ELFBAR', 'ELFA', 'LOST MARY', 'ELFLIQ'];
const MAX_SEARCH_PAGES = Number(process.env.MAX_SEARCH_PAGES || 50);
const BLOCKED_EXTENSIONS = /\.(pdf|zip|rar|7z|jpg|jpeg|png|gif|webp|svg|mp4|mp3|docx?|xlsx?|csv)(?:[?#].*)?$/i;
function isHtmlUrl(href='') { try { const u=new URL(href); return (u.protocol==='http:'||u.protocol==='https:') && !BLOCKED_EXTENSIONS.test(u.pathname); } catch { return false; } }

function classify(name = '', category = '', variant = '', url = '', context = '') {
  const s = `${name} ${category} ${variant} ${url} ${context}`.toLowerCase();
  if (/elfliq|elfa[- _]?liquid|elfbar[- _]?elfliq/.test(s)) return 'ELFA Liquid';
  if (/prefilled|pre[- ]?filled|prefill(ed)?|pod[- _]?kits?|podkit|pod kits?/.test(s)) return 'Prefilled Pods';
  if (/zubehör|zubehoer|accessor(y|ies)|coil|coils|verdampfer|tank|drip tip|case|tasche|ladegerät|charging|kabel|akku|battery|pod holder|display|ständer|stand/.test(s)) return 'Zubehör';
  if (/einweg|disposable|elfbar 600|elfbar 800|lost mary bm|lost mary qm|tappo|eb[- _]?600|qm[- _]?600|bm[- _]?600/.test(s)) return 'Einwegzigaretten';
  if (/elfbar|lost mary/.test(s) && !/liquid|elfliq/.test(s)) return 'Einwegzigaretten';
  return '';
}

function normalize(p = {}) {
  const context = p.context || '';
  const haystack = `${p.name} ${p.category} ${p.variant} ${p.url} ${p.text || ''} ${context}`.toLowerCase();
  const allowedBrand = /elfbar|elfa|lost mary|elfliq/.test(haystack);
  const nexaroGroup = classify(p.name, p.category, p.variant, p.url, context);
  if (!allowedBrand || !nexaroGroup) return null;
  return {
    orderNo: String(p.orderNo ?? '').trim(),
    ean: String(p.ean ?? '').trim(),
    name: String(p.name ?? '').trim(),
    variant: String(p.variant ?? '').trim(),
    category: String(p.category ?? '').trim(),
    url: String(p.url ?? '').trim(),
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
    'input[name="username"]', 'input[name="user"]', 'input[name="customer"]',
    'input[name="kundennummer"]', 'input[name="customerNumber"]',
    'input[type="text"]', 'input[type="email"]'
  ].filter(Boolean));
  const pass = await firstVisible(page, [
    process.env.LOGIN_PASSWORD_SELECTOR,
    'input[name="password"]', 'input[name="pass"]', 'input[type="password"]'
  ].filter(Boolean));
  if (!user || !pass) throw new Error('Loginfelder nicht erkannt. Optional LOGIN_USER_SELECTOR / LOGIN_PASSWORD_SELECTOR als GitHub Secret setzen.');
  await user.fill(process.env.DEALER_USER);
  await pass.fill(process.env.DEALER_PASSWORD);
  const submit = await firstVisible(page, [
    process.env.LOGIN_SUBMIT_SELECTOR,
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Einloggen")', 'button:has-text("Login")',
    'input[value*="Einloggen"]'
  ].filter(Boolean));
  if (!submit) throw new Error('Login-Button nicht erkannt. Optional LOGIN_SUBMIT_SELECTOR als GitHub Secret setzen.');
  await Promise.allSettled([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
    submit.click()
  ]);
  await page.waitForTimeout(1500);
}

async function findSearchForm(page) {
  const forms = await page.locator('form').evaluateAll(forms => forms.map(form => ({
    action: form.action || location.href,
    method: (form.method || 'get').toLowerCase(),
    inputs: [...form.querySelectorAll('input, textarea, select')].map(i => ({
      tag: i.tagName.toLowerCase(),
      type: (i.getAttribute('type') || '').toLowerCase(),
      name: i.getAttribute('name') || '',
      placeholder: i.getAttribute('placeholder') || '',
      value: i.value || ''
    })),
    text: (form.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200)
  })));
  const candidate = forms.find(f => /\/search(?:$|[?])/i.test(f.action) && f.inputs.some(i => !['password','submit','button','hidden'].includes(i.type)))
    || forms.find(f => /suche|search/i.test(`${f.text} ${f.action}`) && f.inputs.some(i => !['password','submit','button','hidden'].includes(i.type)));
  return candidate || null;
}

async function searchDealer(page, term) {
  const formInfo = await findSearchForm(page);
  if (!formInfo) throw new Error(`Suchformular für ${term} nicht erkannt.`);
  let input = null;
  for (const selector of [
    `form[action*="/search"] input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"])`,
    'form input[name="search"]', 'form input[name="q"]', 'form input[name="query"]',
    'form input[type="search"]', 'form input[placeholder*="Such"]', 'form input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"])'
  ]) {
    const loc = page.locator(selector).first();
    if (await loc.count()) { input = loc; break; }
  }
  if (!input) throw new Error(`Suchfeld für ${term} nicht erkannt.`);
  await input.fill(term);
  const form = input.locator('xpath=ancestor::form[1]');
  const submit = await firstVisible(form, ['button[type="submit"]', 'input[type="submit"]']);
  if (submit) {
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
      submit.click()
    ]);
  } else {
    await input.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(900);
  return page.url();
}

async function extractProducts(page, context = '') {
  const candidates = await page.locator([
    '[data-product-id]', '[data-article-id]',
    '.product--box', '.product-box', '.product-box-container',
    '.product-item', '.product-tile', '.product-card',
    '.product', '.productlist-item', '.product-list-item',
    'article.product', 'li.product', 'article'
  ].join(',')).evaluateAll(nodes => nodes.map(node => {
    const text = (node.innerText || '').trim().replace(/\s+/g, ' ');
    const cells = [...node.querySelectorAll('td')].map(x => x.innerText.trim());
    const links = [...node.querySelectorAll('a[href]')].filter(a => (a.innerText || '').trim());
    const titleNode = node.querySelector([
      '.product--title', '.product-title', '.product-name', '.product--name',
      '.product__title', '.name', '.title', 'h1', 'h2', 'h3', 'h4', '[itemprop="name"]'
    ].join(','));
    const a = links.find(x => /product|artikel|p\/|detail/i.test(x.getAttribute('href') || '')) || links[0];
    const name = (titleNode?.innerText || a?.innerText || cells[2] || '').trim().replace(/\s+/g, ' ');
    return {
      orderNo: cells[0] || node.getAttribute('data-product-id') || node.getAttribute('data-article-id') || '',
      ean: node.getAttribute('data-ean') || '',
      name,
      variant: node.querySelector('.variant, [class*="variant"]')?.innerText?.trim() || cells[3] || '',
      category: node.getAttribute('data-category') || '',
      url: a?.href || location.href,
      text, context
    };
  }), context);
  return candidates.filter(x => x.name && x.name.length >= 2 && x.name.length <= 180);
}

async function discoverPaginationLinks(page) {
  return await page.locator('a[href]').evaluateAll(nodes => {
    const out = [];
    for (const a of nodes) {
      const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
      const rel = (a.getAttribute('rel') || '').toLowerCase();
      const aria = (a.getAttribute('aria-label') || '').toLowerCase();
      const href = a.href || '';
      const cls = (a.className || '').toString().toLowerCase();
      const likely = rel === 'next' || /next|weiter|vor|seite|page|pagination|pager/.test(`${text} ${aria} ${cls} ${href}`) || /[?&](p|page|seite)=\d+/i.test(href);
      if (likely && href && !/\.(pdf|zip|rar|7z|jpg|jpeg|png|gif|webp|svg|mp4|mp3|docx?|xlsx?|csv)(?:[?#].*)?$/i.test(href)) out.push({ text: text.slice(0,80), href, rel });
    }
    return [...new Map(out.map(x => [x.href, x])).values()];
  });
}

async function crawlSearch(page, term) {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(500);
  const resultUrl = await searchDealer(page, term);
  const queue = [resultUrl];
  const seen = new Set();
  const raw = [];
  const visited = [];
  while (queue.length && visited.length < MAX_SEARCH_PAGES) {
    const href = queue.shift();
    if (seen.has(href) || !isHtmlUrl(href)) continue;
    seen.add(href);
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(500);
    const items = await extractProducts(page, term);
    raw.push(...items);
    visited.push({ term, url: page.url(), path: new URL(page.url()).pathname, candidateCount: items.length, pageIndex: visited.length + 1 });
    const next = await discoverPaginationLinks(page);
    for (const n of next) {
      if (isHtmlUrl(n.href) && !seen.has(n.href) && n.href !== resultUrl && queue.length < MAX_SEARCH_PAGES) queue.push(n.href);
    }
  }
  return { raw, visited, resultUrl };
}

async function safeDiagnostics(page, discoveredLinks) {
  return await page.evaluate(({ allowed }) => {
    const forms = [...document.forms].map(f => ({
      method: f.method || 'get',
      actionPath: (() => { try { return new URL(f.action || location.href).pathname; } catch { return ''; } })(),
      passwordInputs: f.querySelectorAll('input[type="password"]').length,
      submitInputs: f.querySelectorAll('button[type="submit"], input[type="submit"]').length
    }));
    const counts = {};
    for (const selector of ['table tbody tr','[data-product-id]','.product--box','.product-box','.product-item','.product-tile','.product-card','article.product','li.product']) {
      counts[selector] = document.querySelectorAll(selector).length;
    }
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const lower = bodyText.toLowerCase();
    return {
      title: document.title,
      url: location.href,
      pathname: location.pathname,
      forms,
      passwordFieldCount: document.querySelectorAll('input[type="password"]').length,
      productSelectorCounts: counts,
      bodyTextLength: bodyText.length,
      loginMarkers: {
        logout: /abmelden|ausloggen|logout|log out/.test(lower),
        customerArea: /kundencenter|mein konto|my account|kundenkonto/.test(lower),
        loginFormStillVisible: document.querySelectorAll('input[type="password"]').length > 0
      },
      allowedGroups: allowed,
      discoveredCategoryLinkCount: 0
    };
  }, { allowed: ALLOWED_GROUPS });
}

const loginUrl = process.env.DEALER_LOGIN_URL || process.env.DEALER_URL || DEFAULT_URL;
if (!process.env.DEALER_USER || !process.env.DEALER_PASSWORD) throw new Error('DEALER_USER und DEALER_PASSWORD müssen als GitHub Actions Secrets gesetzt sein.');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await login(page);

  const diagnostics = await safeDiagnostics(page, []);
  diagnostics.searchTerms = SEARCH_TERMS;
  diagnostics.maxSearchPages = MAX_SEARCH_PAGES;

  const raw = [];
  const visited = [];
  const searchResults = [];
  for (const term of SEARCH_TERMS) {
    try {
      const result = await crawlSearch(page, term);
      raw.push(...result.raw);
      visited.push(...result.visited);
      searchResults.push({ term, resultUrl: result.resultUrl, pagesVisited: result.visited.length, candidates: result.raw.length });
    } catch (e) {
      searchResults.push({ term, error: String(e?.message || e) });
    }
  }

  const products = raw.map(normalize).filter(Boolean);
  const unique = [...new Map(products.map(p => [`${p.orderNo}|${p.ean}|${p.name}|${p.variant}|${p.url}`, p])).values()];
  const counts = Object.fromEntries(ALLOWED_GROUPS.map(g => [g, unique.filter(p => p.nexaroGroup === g).length]));
  const manufacturers = { ELFBAR: 0, ELFA: 0, 'LOST MARY': 0, ELFLIQ: 0 };
  for (const p of unique) manufacturers[p.manufacturerHint] = (manufacturers[p.manufacturerHint] || 0) + 1;
  diagnostics.manufacturers = manufacturers;

  diagnostics.finalUrl = page.url();
  diagnostics.searchResults = searchResults;
  diagnostics.visitedSearchPages = visited;
  diagnostics.rawCandidateCount = raw.length;
  diagnostics.filteredProductCount = unique.length;
  diagnostics.counts = counts;
  diagnostics.status = unique.length ? 'ok' : 'no_products_found';
  diagnostics.detailPagesVisited = detailCount;
  diagnostics.generatedAt = new Date().toISOString();
  diagnostics.pagesVisited = visited.length;
  diagnostics.note = unique.length
    ? 'V10.4: V8-Crawler als Basis beibehalten, breite Pagination-Erkennung; Nicht-HTML-Dateien werden ausgeschlossen. Suchbegriff wird als Kontext mitgeführt. Nur ELFBAR/ELFA/LOST MARY/ELFLIQ und die vier neXaro-Gruppen werden übernommen.'
    : 'Login/Suche lief durch, aber keine passenden Produktkarten wurden erkannt. Die Diagnose enthält die erkannten Such-URLs und Seiten.';

  await fs.mkdir('out', { recursive: true });
  await fs.writeFile('out/diagnostics.json', JSON.stringify(diagnostics, null, 2), 'utf8');
  await fs.writeFile('out/products.json', JSON.stringify({ version: '10.4.0', syncedAt: diagnostics.generatedAt, source: diagnostics.finalUrl, searchTerms: SEARCH_TERMS, allowedGroups: ALLOWED_GROUPS, count: unique.length, counts, manufacturers, products: unique }, null, 2), 'utf8');
  await fs.writeFile('out/summary.json', JSON.stringify({ version: '10.4.0', syncedAt: diagnostics.generatedAt, source: diagnostics.finalUrl, searchTerms: SEARCH_TERMS, allowedGroups: ALLOWED_GROUPS, count: unique.length, counts, status: diagnostics.status, manufacturers }, null, 2), 'utf8');

  console.log(`neXaro VAPE Sync 10.4.0: ${unique.length} Produkte`);
  console.log(JSON.stringify(counts));
  console.log(`Hersteller: ${JSON.stringify(manufacturers)}`);
  console.log(`Diagnose: ${diagnostics.status}; Suchbegriffe: ${SEARCH_TERMS.length}; Suchseiten: ${visited.length}; Rohkandidaten: ${raw.length}; Detailseiten: ${detailCount}`);
} finally {
  await browser.close();
}
