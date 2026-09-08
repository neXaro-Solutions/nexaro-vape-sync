import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ALLOWED_GROUPS = ['Einwegzigaretten', 'Prefilled Pods', 'Zubehör', 'ELFA Liquid'];
const DEFAULT_URL = 'https://e-zigaretten-handel.de/ezigaretten/';
const SEARCH_TERMS = ['ELFBAR', 'ELFA', 'LOST MARY', 'ELFLIQ'];
const MAX_SEARCH_PAGES = Number(process.env.MAX_SEARCH_PAGES || 50);
const MAX_DETAIL_PAGES = Number(process.env.MAX_DETAIL_PAGES || 250);

function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim(); }

function brandOf(p = {}) {
  const s = `${p.searchTerm || ''} ${p.name || ''} ${p.category || ''} ${p.variant || ''} ${p.url || ''} ${p.text || ''} ${p.breadcrumbs || ''}`.toLowerCase();
  if (/lost\s*mary/.test(s)) return 'LOST MARY';
  if (/elfliq/.test(s)) return 'ELFLIQ';
  if (/elfa/.test(s)) return 'ELFA';
  if (/elfbar/.test(s)) return 'ELFBAR';
  return '';
}

function groupOf(p = {}) {
  const s = `${p.category || ''} ${p.breadcrumbs || ''} ${p.name || ''} ${p.variant || ''} ${p.url || ''} ${p.text || ''}`.toLowerCase();
  const search = `${p.searchTerm || ''}`.toLowerCase();

  // Strong category signals first. These are intentionally based on the dealer's
  // visible category/breadcrumb context when available.
  if (/elfliq|elfliq|elfa[- _]?liquid|elfbar[- _]?elfliq/.test(s)) return 'ELFA Liquid';
  if (/prefilled|pre[- ]?filled|prefill(ed)?|prefilled[- _]?pods?|pod[- _]?kits?|podkit|pod kits?/.test(s)) return 'Prefilled Pods';
  if (/zubehör|zubehoer|accessor(y|ies)|ladegerät|charging\s*(station|case|cable)?|drip\s*tip|case|tasche|kabel/.test(s)) return 'Zubehör';
  if (/einweg|disposable|elfbar\s*(600|800|max)|lost\s*mary\s*(bm|qm)|\beb[- _]?600\b|\bqm[- _]?600\b|\bbm[- _]?600\b|tappo/.test(s)) return 'Einwegzigaretten';

  // Manufacturer-search fallback: only use this when the product itself strongly
  // indicates a disposable/prefilled/liquid item. Never classify a generic brand
  // match as Zubehör just because it was found by a manufacturer search.
  if (/elfliq/.test(search) || /elfliq/.test(s)) return 'ELFA Liquid';
  if (/prefilled|pre[- ]?filled|pod/.test(s)) return 'Prefilled Pods';
  if (/disposable|einweg|600|800|bm600|qm600/.test(s)) return 'Einwegzigaretten';
  return '';
}

function normalize(p = {}) {
  const brand = brandOf(p);
  const nexaroGroup = groupOf(p);
  if (!brand || !nexaroGroup) return null;
  return {
    orderNo: clean(p.orderNo),
    ean: clean(p.ean),
    name: clean(p.name),
    variant: clean(p.variant),
    category: clean(p.category),
    breadcrumbs: clean(p.breadcrumbs),
    url: clean(p.url),
    brand,
    searchTerm: clean(p.searchTerm),
    nexaroGroup
  };
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    if (!selector) continue;
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
  ]);
  const pass = await firstVisible(page, [
    process.env.LOGIN_PASSWORD_SELECTOR,
    'input[name="password"]', 'input[name="pass"]', 'input[type="password"]'
  ]);
  if (!user || !pass) throw new Error('Loginfelder nicht erkannt. Optional LOGIN_USER_SELECTOR / LOGIN_PASSWORD_SELECTOR als GitHub Secret setzen.');
  await user.fill(process.env.DEALER_USER);
  await pass.fill(process.env.DEALER_PASSWORD);
  const submit = await firstVisible(page, [
    process.env.LOGIN_SUBMIT_SELECTOR,
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Einloggen")', 'button:has-text("Login")',
    'input[value*="Einloggen"]'
  ]);
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
      type: (i.getAttribute('type') || '').toLowerCase(),
      name: i.getAttribute('name') || '',
      placeholder: i.getAttribute('placeholder') || ''
    })),
    text: (form.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200)
  })));
  return forms.find(f => /\/search(?:$|[?])/i.test(f.action) && f.inputs.some(i => !['password','submit','button','hidden'].includes(i.type)))
    || forms.find(f => /suche|search/i.test(`${f.text} ${f.action}`) && f.inputs.some(i => !['password','submit','button','hidden'].includes(i.type)))
    || null;
}

async function searchDealer(page, term) {
  const formInfo = await findSearchForm(page);
  if (!formInfo) throw new Error(`Suchformular für ${term} nicht erkannt.`);
  let input = null;
  const selectors = [
    `form[action*="/search"] input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"])`,
    'form input[name="search"]', 'form input[name="q"]', 'form input[name="query"]',
    'form input[type="search"]', 'form input[placeholder*="Such"]',
    'form input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"])'
  ];
  for (const selector of selectors) {
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

async function extractContext(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const crumbs = [...document.querySelectorAll('[class*="breadcrumb"], [class*="breadcrumbs"], nav[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs')]
      .map(x => (x.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    const headings = [...document.querySelectorAll('h1,h2,h3')].map(x => (x.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12).join(' | ');
    return { breadcrumbs: crumbs, headings, title: document.title || '', bodyText: text.slice(0, 5000) };
  });
}

async function extractProducts(page, searchTerm, pageContext = {}) {
  const candidates = await page.locator([
    '[data-product-id]', '[data-article-id]',
    '.product--box', '.product-box', '.product-box-container',
    '.product-item', '.product-tile', '.product-card', '.product',
    '.productlist-item', '.product-list-item', 'article.product', 'li.product', 'article'
  ].join(',')).evaluateAll((nodes, ctx) => nodes.map(node => {
    const text = (node.innerText || '').trim().replace(/\s+/g, ' ');
    const cells = [...node.querySelectorAll('td')].map(x => x.innerText.trim());
    const links = [...node.querySelectorAll('a[href]')].filter(a => (a.innerText || '').trim() || a.href);
    const titleNode = node.querySelector([
      '.product--title', '.product-title', '.product-name', '.product--name',
      '.product__title', '.name', '.title', 'h1', 'h2', 'h3', 'h4', '[itemprop="name"]'
    ].join(','));
    const a = links.find(x => /product|artikel|p\/|detail/i.test(x.getAttribute('href') || '')) || links[0];
    const name = (titleNode?.innerText || a?.innerText || cells[2] || '').trim().replace(/\s+/g, ' ');
    const localCrumbs = [...node.querySelectorAll('[class*="breadcrumb"], [class*="category"], [class*="manufacturer"], [class*="brand"]')]
      .map(x => (x.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    return {
      orderNo: cells[0] || node.getAttribute('data-product-id') || node.getAttribute('data-article-id') || '',
      ean: node.getAttribute('data-ean') || '',
      name,
      variant: node.querySelector('.variant, [class*="variant"]')?.innerText?.trim() || cells[3] || '',
      category: node.getAttribute('data-category') || '',
      breadcrumbs: [ctx.breadcrumbs, localCrumbs, ctx.headings].filter(Boolean).join(' | '),
      url: a?.href || location.href,
      text,
      searchTerm
    };
  }), { ...pageContext });
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
      if (likely && href) out.push({ text: text.slice(0,80), href, rel });
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
    if (seen.has(href)) continue;
    seen.add(href);
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(500);
    const context = await extractContext(page);
    const items = await extractProducts(page, term, context);
    raw.push(...items);
    visited.push({ term, url: page.url(), path: new URL(page.url()).pathname, candidateCount: items.length, pageIndex: visited.length + 1 });
    const next = await discoverPaginationLinks(page);
    for (const n of next) {
      if (!seen.has(n.href) && n.href !== resultUrl && queue.length < MAX_SEARCH_PAGES) queue.push(n.href);
    }
  }
  return { raw, visited, resultUrl };
}

async function extractDetailContext(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const crumbs = [...document.querySelectorAll('[class*="breadcrumb"], [class*="breadcrumbs"], nav[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs')]
      .map(x => (x.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map(x => (x.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12).join(' | ');
    const category = [...document.querySelectorAll('[class*="category"], [class*="manufacturer"], [class*="brand"], [itemprop="category"]')]
      .map(x => (x.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10).join(' | ');
    return { breadcrumbs: crumbs, headings, category, bodyText: text.slice(0, 6000) };
  });
}

async function enrichUnclassified(page, candidates) {
  const byUrl = new Map();
  for (const p of candidates) {
    if (!p.url || !/^https?:/i.test(p.url)) continue;
    if (!byUrl.has(p.url)) byUrl.set(p.url, p);
  }
  const targets = [...byUrl.values()].filter(p => !groupOf(p)).slice(0, MAX_DETAIL_PAGES);
  const enriched = [];
  for (const p of targets) {
    try {
      await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(250);
      const d = await extractDetailContext(page);
      enriched.push({ ...p, breadcrumbs: clean(`${p.breadcrumbs || ''} ${d.breadcrumbs || ''}`), category: clean(`${p.category || ''} ${d.category || ''}`), text: clean(`${p.text || ''} ${d.headings || ''} ${d.bodyText || ''}`) });
    } catch (e) {
      enriched.push({ ...p, detailError: String(e?.message || e) });
    }
  }
  return enriched;
}

async function safeDiagnostics(page) {
  return await page.evaluate(({ allowed }) => {
    const forms = [...document.forms].map(f => ({
      method: f.method || 'get',
      actionPath: (() => { try { return new URL(f.action || location.href).pathname; } catch { return ''; } })(),
      passwordInputs: f.querySelectorAll('input[type="password"]').length,
      submitInputs: f.querySelectorAll('button[type="submit"], input[type="submit"]').length
    }));
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const lower = bodyText.toLowerCase();
    return {
      title: document.title,
      url: location.href,
      pathname: location.pathname,
      forms,
      passwordFieldCount: document.querySelectorAll('input[type="password"]').length,
      bodyTextLength: bodyText.length,
      loginMarkers: {
        logout: /abmelden|ausloggen|logout|log out/.test(lower),
        customerArea: /kundencenter|mein konto|my account|kundenkonto/.test(lower),
        loginFormStillVisible: document.querySelectorAll('input[type="password"]').length > 0
      },
      allowedGroups: allowed
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

  const diagnostics = await safeDiagnostics(page);
  diagnostics.searchTerms = SEARCH_TERMS;
  diagnostics.maxSearchPages = MAX_SEARCH_PAGES;
  diagnostics.maxDetailPages = MAX_DETAIL_PAGES;

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

  // First pass with search/category context.
  const firstPass = raw.map(normalize).filter(Boolean);
  const unclassified = raw.filter(p => !groupOf(p) && brandOf(p));

  // Second pass: visit unique product detail pages and read breadcrumbs/category text.
  const enriched = await enrichUnclassified(page, unclassified);
  const secondPass = enriched.map(normalize).filter(Boolean);

  const products = [...firstPass, ...secondPass];
  const unique = [...new Map(products.map(p => [`${p.url}|${p.name}|${p.variant}|${p.nexaroGroup}`, p])).values()];
  const counts = Object.fromEntries(ALLOWED_GROUPS.map(g => [g, unique.filter(p => p.nexaroGroup === g).length]));
  const brandCounts = Object.fromEntries(['ELFBAR','ELFA','LOST MARY','ELFLIQ'].map(b => [b, unique.filter(p => p.brand === b).length]));

  diagnostics.finalUrl = page.url();
  diagnostics.searchResults = searchResults;
  diagnostics.visitedSearchPages = visited;
  diagnostics.rawCandidateCount = raw.length;
  diagnostics.firstPassCount = firstPass.length;
  diagnostics.unclassifiedBrandCandidates = unclassified.length;
  diagnostics.detailPagesVisited = Math.min(unclassified.length, MAX_DETAIL_PAGES);
  diagnostics.enrichedCount = secondPass.length;
  diagnostics.filteredProductCount = unique.length;
  diagnostics.counts = counts;
  diagnostics.brandCounts = brandCounts;
  diagnostics.status = unique.length ? 'ok' : 'no_products_found';
  diagnostics.generatedAt = new Date().toISOString();
  diagnostics.pagesVisited = visited.length;
  diagnostics.note = 'Hersteller-Suche über ELFBAR, ELFA, LOST MARY und ELFLIQ. Suchseiten werden mit Suchbegriff, Breadcrumbs und Seitenkontext ausgewertet. Nicht eindeutig klassifizierte Markentreffer werden zusätzlich über Produktdetailseiten angereichert. Danach werden nur die vier neXaro-Gruppen übernommen.';

  await fs.mkdir('out', { recursive: true });
  await fs.writeFile('out/diagnostics.json', JSON.stringify(diagnostics, null, 2), 'utf8');
  await fs.writeFile('out/products.json', JSON.stringify({ version: '9.0.0', syncedAt: diagnostics.generatedAt, source: diagnostics.finalUrl, searchTerms: SEARCH_TERMS, allowedGroups: ALLOWED_GROUPS, count: unique.length, counts, brandCounts, products: unique }, null, 2), 'utf8');
  await fs.writeFile('out/summary.json', JSON.stringify({ version: '9.0.0', syncedAt: diagnostics.generatedAt, source: diagnostics.finalUrl, searchTerms: SEARCH_TERMS, allowedGroups: ALLOWED_GROUPS, count: unique.length, counts, brandCounts, status: diagnostics.status }, null, 2), 'utf8');

  console.log(`neXaro VAPE Sync 9.0.0: ${unique.length} Produkte`);
  console.log(JSON.stringify(counts));
  console.log(`Hersteller: ${JSON.stringify(brandCounts)}`);
  console.log(`Diagnose: ${diagnostics.status}; Suchbegriffe: ${SEARCH_TERMS.length}; Suchseiten: ${visited.length}; Rohkandidaten: ${raw.length}; Detailseiten: ${diagnostics.detailPagesVisited}; Nachanreicherung: ${secondPass.length}`);
} finally {
  await browser.close();
}
