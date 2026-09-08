import 'dotenv/config';
import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json({ limit: '10mb' }));

function requireSyncToken(req, res, next) {
  const token = process.env.SYNC_TOKEN;
  if (!token) return res.status(503).json({ ok: false, error: 'SYNC_TOKEN ist serverseitig nicht gesetzt.' });
  const auth = req.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (supplied !== token) return res.status(401).json({ ok: false, error: 'Nicht autorisiert.' });
  next();
}

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
    qty: String(p.qty ?? '').trim(),
    price: String(p.price ?? '').trim(),
    url: String(p.url ?? '').trim(),
    nexaroGroup
  };
}

function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && quoted && n === '"') { field += '"'; i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { row.push(field); field = ''; continue; }
    if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && n === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = []; continue;
    }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const h = rows.shift().map(x => x.trim().toLowerCase());
  const idx = (...keys) => h.findIndex(x => keys.some(k => x === k || x.includes(k)));
  return rows.map(r => ({
    orderNo: r[idx('bestellnummer', 'artikelnummer')] || '',
    qty: r[idx('menge')] || '',
    ean: r[idx('ean')] || '',
    name: r[idx('name', 'artikel')] || '',
    variant: r[idx('variante')] || '',
    category: r[idx('kategorie', 'produktgruppe', 'warengruppe')] || '',
    price: r[idx('preis', 'ek', 'netto')] || ''
  }));
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
  if (!user || !pass) throw new Error('Loginfelder konnten nicht erkannt werden. LOGIN_*_SELECTOR in .env setzen.');

  await user.fill(process.env.DEALER_USER);
  await pass.fill(process.env.DEALER_PASSWORD);

  const submit = await firstVisible(page, [
    process.env.LOGIN_SUBMIT_SELECTOR,
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Einloggen")', 'button:has-text("Login")',
    'input[value*="Einloggen"]'
  ].filter(Boolean));
  if (!submit) throw new Error('Login-Button konnte nicht erkannt werden. LOGIN_SUBMIT_SELECTOR in .env setzen.');
  await Promise.allSettled([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
    submit.click()
  ]);
}

async function extractProducts(page) {
  if (process.env.CSV_EXPORT_SELECTOR) {
    const dl = await page.locator(process.env.CSV_EXPORT_SELECTOR).first().download({ timeout: 30000 });
    const stream = await dl.createReadStream(); let chunks = [];
    for await (const c of stream) chunks.push(c);
    return parseCsv(Buffer.concat(chunks).toString('utf8'));
  }

  // Generic extraction for common Shopware-style product grids/tables.
  return await page.locator('table tbody tr, .product--box, .product-box, .product--box-content, [data-product-id]').evaluateAll(nodes => {
    return nodes.map(node => {
      const text = node.innerText?.trim() || '';
      const cells = [...node.querySelectorAll('td')].map(x => x.innerText.trim());
      const a = node.querySelector('a[href]');
      const price = node.querySelector('.price, .product--price, [class*="price"]')?.innerText?.trim() || '';
      return {
        orderNo: cells[0] || node.getAttribute('data-product-id') || '',
        ean: node.getAttribute('data-ean') || '',
        name: node.querySelector('.product--title, .product-title, [class*="title"]')?.innerText?.trim() || cells[2] || text.split('\n')[0] || '',
        variant: node.querySelector('.variant, [class*="variant"]')?.innerText?.trim() || cells[3] || '',
        category: node.getAttribute('data-category') || '',
        qty: node.querySelector('[class*="stock"], [class*="quantity"]')?.innerText?.trim() || cells[5] || '',
        price,
        url: a?.href || location.href
      };
    });
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'neXaro VAPE Sync', version: '1.2.1', allowedGroups: ALLOWED_GROUPS }));

app.post('/filter', requireSyncToken, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const products = items.map(normalize).filter(Boolean);
  res.json({ count: products.length, products });
});

app.post('/sync', requireSyncToken, async (_req, res) => {
  if (!process.env.DEALER_USER || !process.env.DEALER_PASSWORD) {
    return res.status(400).json({ ok: false, error: 'DEALER_USER/DEALER_PASSWORD fehlen. Zugangsdaten nur als Server-Umgebungsvariablen setzen.' });
  }

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const loginUrl = process.env.DEALER_LOGIN_URL || process.env.DEALER_URL || 'https://e-zigaretten-handel.de/ezigaretten/';
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await login(page);

    if (process.env.PRODUCT_URL) {
      await page.goto(process.env.PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }

    const products = await extractProducts(page);
    const filtered = products.map(normalize).filter(Boolean);
    const counts = Object.fromEntries(ALLOWED_GROUPS.map(g => [g, filtered.filter(p => p.nexaroGroup === g).length]));

    res.json({ ok: true, syncedAt: new Date().toISOString(), source: page.url(), count: filtered.length, counts, allowedGroups: ALLOWED_GROUPS, products: filtered });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    await browser.close();
  }
});

app.listen(Number(process.env.PORT || 8787), '0.0.0.0', () => console.log(`neXaro VAPE Sync 1.2.1 listening on :${process.env.PORT || 8787}`));
