import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ALLOWED_GROUPS = ['Einwegzigaretten', 'Prefilled Pods', 'Zubehör', 'ELFA Liquid'];

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
}

async function extractProducts(page) {
  return await page.locator('table tbody tr, .product--box, .product-box, .product--box-content, [data-product-id]').evaluateAll(nodes => nodes.map(node => {
    const text = node.innerText?.trim() || '';
    const cells = [...node.querySelectorAll('td')].map(x => x.innerText.trim());
    const a = node.querySelector('a[href]');
    return {
      orderNo: cells[0] || node.getAttribute('data-product-id') || '',
      ean: node.getAttribute('data-ean') || '',
      name: node.querySelector('.product--title, .product-title, [class*="title"]')?.innerText?.trim() || cells[2] || text.split('\n')[0] || '',
      variant: node.querySelector('.variant, [class*="variant"]')?.innerText?.trim() || cells[3] || '',
      category: node.getAttribute('data-category') || '',
      url: a?.href || location.href
    };
  }));
}

const loginUrl = process.env.DEALER_LOGIN_URL || process.env.DEALER_URL || 'https://e-zigaretten-handel.de/ezigaretten/';
if (!process.env.DEALER_USER || !process.env.DEALER_PASSWORD) throw new Error('DEALER_USER und DEALER_PASSWORD müssen als GitHub Actions Secrets gesetzt sein.');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await login(page);
  if (process.env.PRODUCT_URL) await page.goto(process.env.PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const raw = await extractProducts(page);
  const products = raw.map(normalize).filter(Boolean);
  const unique = [...new Map(products.map(p => [`${p.orderNo}|${p.ean}|${p.name}|${p.variant}`, p])).values()];
  const counts = Object.fromEntries(ALLOWED_GROUPS.map(g => [g, unique.filter(p => p.nexaroGroup === g).length]));
  const result = {
    version: '1.3.0',
    syncedAt: new Date().toISOString(),
    source: page.url(),
    allowedGroups: ALLOWED_GROUPS,
    count: unique.length,
    counts,
    products: unique
  };
  await fs.mkdir('out', { recursive: true });
  await fs.writeFile('out/products.json', JSON.stringify(result, null, 2), 'utf8');
  await fs.writeFile('out/summary.json', JSON.stringify({ ...result, products: undefined }, null, 2), 'utf8');
  console.log(`neXaro VAPE Sync 1.3.0 OK: ${unique.length} Produkte`);
  console.log(JSON.stringify(counts));
} finally {
  await browser.close();
}
