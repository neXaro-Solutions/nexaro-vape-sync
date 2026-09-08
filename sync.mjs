import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ALLOWED_GROUPS = ['Einwegzigaretten', 'Prefilled Pods', 'Zubehör', 'ELFA Liquid'];
const DEFAULT_URL = 'https://e-zigaretten-handel.de/ezigaretten/';
const MAX_CATEGORY_TARGETS = Number(process.env.MAX_CATEGORY_TARGETS || 50);
const MAX_PAGES_PER_TARGET = Number(process.env.MAX_PAGES_PER_TARGET || 30);

function classify(name = '', category = '', variant = '', url = '') {
  const s = `${name} ${category} ${variant} ${url}`.toLowerCase();
  if (/elfliq|elfliq|elfa[- _]?liquid|elfbar[- _]?elfliq/.test(s)) return 'ELFA Liquid';
  if (/prefilled|pre[- ]?filled|prefill(ed)?|pod[- _]?kits?|podkit|pod kits?/.test(s)) return 'Prefilled Pods';
  if (/zubehör|zubehoer|accessor(y|ies)|coils?|verdampfer|tank|drip tip|case|tasche|ladegerät|charging|kabel|akku|battery/.test(s)) return 'Zubehör';
  if (/einweg|disposable|elfbar 600|elfbar 800|lost mary bm|tappo|eb[- ]?600|qm[- ]?600/.test(s)) return 'Einwegzigaretten';
  return '';
}

function normalize(p = {}) {
  const nexaroGroup = classify(p.name, p.category, p.variant, p.url);
  if (!nexaroGroup) return null;
  return {
    orderNo: String(p.orderNo ?? '').trim(),
    ean: String(p.ean ?? '').trim(),
    name: String(p.name ?? '').trim(),
    variant: String(p.variant ?? '').trim(),
    category: String(p.category ?? '').trim(),
    url: String(p.url ?? '').trim(),
    nexaroGroup
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

function isLikelyCategoryLink(text, href) {
  const s = `${text} ${href}`.toLowerCase();
  return /einweg|disposable|prefilled|pre[- ]?filled|pod[- _]?kit|podkit|zubehör|zubehoer|accessor|elfliq|elfa[- _]?liquid/.test(s);
}

async function discoverCategoryLinks(page) {
  const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(a => ({
    text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' '),
    href: a.href
  })));
  const seen = new Set();
  return links.filter(x => x.href && isLikelyCategoryLink(x.text, x.href)).filter(x => {
    if (seen.has(x.href)) return false;
    seen.add(x.href); return true;
  }).slice(0, 20);
}

async function extractProducts(page) {
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
      text
    };
  }));
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
  const discovered = await discoverCategoryLinks(page);
  diagnostics.discoveredCategoryLinkCount = discovered.length;
  diagnostics.discoveredCategoryLinks = discovered.map(x => ({ text: x.text.slice(0, 100), path: new URL(x.href).pathname }));

  const targets = [];
  if (process.env.PRODUCT_URL) targets.push({ href: process.env.PRODUCT_URL, source: 'PRODUCT_URL' });
  for (const link of discovered) targets.push({ href: link.href, source: 'discovered-category' });
  const uniqueTargets = [...new Map(targets.map(x => [x.href, x])).values()].slice(0, MAX_CATEGORY_TARGETS);

  const raw = [];
  const visited = [];
  const visitedPages = new Set();
  for (const target of uniqueTargets) {
    const queue = [target.href];
    let pagesForTarget = 0;
    while (queue.length && pagesForTarget < MAX_PAGES_PER_TARGET) {
      const href = queue.shift();
      if (visitedPages.has(href)) continue;
      visitedPages.add(href);
      try {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(700);
        const items = await extractProducts(page);
        pagesForTarget += 1;
        visited.push({ source: target.source, path: new URL(page.url()).pathname, url: page.url(), candidateCount: items.length, pageIndex: pagesForTarget });
        raw.push(...items);

        if (pagesForTarget < MAX_PAGES_PER_TARGET) {
          const pagination = await discoverPaginationLinks(page);
          const nextLinks = pagination
            .filter(x => !visitedPages.has(x.href))
            .filter(x => x.href !== target.href)
            .slice(0, 8);
          for (const n of nextLinks) queue.push(n.href);
        }
      } catch (e) {
        visited.push({ source: target.source, path: (() => { try { return new URL(href).pathname; } catch { return href; } })(), url: href, error: String(e?.message || e), pageIndex: pagesForTarget + 1 });
      }
    }
  }

  // If no category targets were discovered, inspect the login landing page again for diagnostics.
  if (!uniqueTargets.length) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(500);
  }

  const products = raw.map(normalize).filter(Boolean);
  const unique = [...new Map(products.map(p => [`${p.orderNo}|${p.ean}|${p.name}|${p.variant}|${p.url}`, p])).values()];
  const counts = Object.fromEntries(ALLOWED_GROUPS.map(g => [g, unique.filter(p => p.nexaroGroup === g).length]));

  diagnostics.finalUrl = page.url();
  diagnostics.visitedTargets = visited;
  diagnostics.rawCandidateCount = raw.length;
  diagnostics.filteredProductCount = unique.length;
  diagnostics.counts = counts;
  diagnostics.status = unique.length ? 'ok' : 'no_products_found';
  diagnostics.generatedAt = new Date().toISOString();
  diagnostics.pagesVisited = visitedPages.size;
  diagnostics.maxCategoryTargets = MAX_CATEGORY_TARGETS;
  diagnostics.maxPagesPerTarget = MAX_PAGES_PER_TARGET;
  diagnostics.note = unique.length ? 'Produkte erkannt; Kategorie-Ziele und Pagination wurden vollständig im gesetzten Limit durchlaufen.' : 'Login/Navigation lief durch, aber keine passenden Produktkarten wurden erkannt. Die Diagnose enthält nur Struktur-/Pfadinformationen.';

  await fs.mkdir('out', { recursive: true });
  await fs.writeFile('out/diagnostics.json', JSON.stringify(diagnostics, null, 2), 'utf8');
  await fs.writeFile('out/products.json', JSON.stringify({ version: '1.5.0', syncedAt: diagnostics.generatedAt, source: diagnostics.finalUrl, allowedGroups: ALLOWED_GROUPS, count: unique.length, counts, products: unique }, null, 2), 'utf8');
  await fs.writeFile('out/summary.json', JSON.stringify({ version: '1.5.0', syncedAt: diagnostics.generatedAt, source: diagnostics.finalUrl, allowedGroups: ALLOWED_GROUPS, count: unique.length, counts, status: diagnostics.status }, null, 2), 'utf8');

  console.log(`neXaro VAPE Sync 1.4.0: ${unique.length} Produkte`);
  console.log(JSON.stringify(counts));
  console.log(`Diagnose: ${diagnostics.status}; Kategorie-Links: ${discovered.length}; Ziele: ${uniqueTargets.length}; Rohkandidaten: ${raw.length}`);
} finally {
  await browser.close();
}
