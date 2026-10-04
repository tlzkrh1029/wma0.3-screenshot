// Capture TradingView CRYPTOCAP market-cap charts for the top-N coins by market cap.
//
// Env:
//   TOP_N      number of coins to capture (default 2)
//   EXTRA_SYMBOLS  comma-separated CRYPTOCAP tickers to capture as well (e.g. ARBI)
//   LAYOUT_ID  shared TradingView chart layout id (default Bf3gbmLa)
//   OUT_DIR    output directory (default screenshots/<YYYY-MM-DD>)
//   TV_SESSIONID, TV_SESSIONID_SIGN  TradingView login cookies (optional)
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const TOP_N = Number(process.env.TOP_N || 2);
const LAYOUT_ID = process.env.LAYOUT_ID || 'Bf3gbmLa';
const today = new Date().toISOString().slice(0, 10);
const OUT_DIR = process.env.OUT_DIR || path.join('screenshots', today);

async function topCoins(n) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${await res.text()}`);
  const coins = await res.json();
  return coins.map((c) => ({ rank: c.market_cap_rank, symbol: c.symbol.toUpperCase(), name: c.name }));
}

async function loginCookies() {
  const { TV_SESSIONID, TV_SESSIONID_SIGN } = process.env;
  if (!TV_SESSIONID || !TV_SESSIONID_SIGN) return [];
  const base = { domain: '.tradingview.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' };
  return [
    { ...base, name: 'sessionid', value: TV_SESSIONID },
    { ...base, name: 'sessionid_sign', value: TV_SESSIONID_SIGN },
  ];
}

// Close upsell / promo dialogs that cover the chart.
async function dismissPopups(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    const close = page.locator('[data-dialog-name] [data-name="close"], [role="dialog"] button[aria-label="Close"], [data-name="close"]');
    const n = await close.count();
    for (let j = 0; j < n; j++) {
      const btn = close.nth(j);
      if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2_000 }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
}

// Keep the run read-only: the layout belongs to the logged-in account, so any
// write (autosave of the symbol change, panel state, settings) must not reach it.
async function blockWrites(context) {
  const blocked = new Set();
  await context.route(/^https:\/\/([a-z0-9-]+\.)*tradingview\.com\//, (route) => {
    const req = route.request();
    if (req.method() === 'GET' || req.method() === 'HEAD' || req.method() === 'OPTIONS') return route.continue();
    const u = new URL(req.url());
    const key = `${req.method()} ${u.host}${u.pathname}`;
    if (!blocked.has(key)) {
      blocked.add(key);
      console.log('blocked write:', key);
    }
    return route.abort();
  });
}

// Close the right-side watchlist panel and switch the chart to fullscreen mode.
async function enlargeChart(page) {
  const watchlist = page.locator('button[data-name="base"]').first();
  if (await watchlist.count()) {
    // aria-pressed stays "false" even when the panel is open; the class tracks it.
    const cls = (await watchlist.getAttribute('class')) || '';
    const open = /isActive/i.test(cls);
    console.log('watchlist button found, open =', open);
    if (open) await watchlist.click();
    // Move the pointer off the button so its tooltip is not captured.
    await page.mouse.move(0, 1_000);
  } else {
    console.log('watchlist button not found');
  }
  await page.waitForTimeout(1_000);

  // The header toolbar is wider than the viewport, so the fullscreen button sits
  // off-screen; use TradingView's Shift+F hotkey and fall back to a DOM click.
  const isFullscreen = () => page.evaluate(() => Boolean(document.fullscreenElement));
  if (!(await isFullscreen())) {
    await page.keyboard.press('Shift+F');
    await page.waitForTimeout(1_500);
  }
  if (!(await isFullscreen())) {
    await page.locator('#header-toolbar-fullscreen').dispatchEvent('click').catch(() => {});
    await page.waitForTimeout(1_500);
  }
  console.log('fullscreen =', await isFullscreen());
  await page.waitForTimeout(3_000);
}

// CoinGecko symbols do not always match TradingView's CRYPTOCAP tickers
// (Arbitrum is ARB on CoinGecko but CRYPTOCAP:ARBI), so look them up.
async function resolveTicker(symbol) {
  const url = `https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(symbol)}&exchange=CRYPTOCAP&hl=0&lang=en&domain=production`;
  try {
    const res = await fetch(url, { headers: { origin: 'https://www.tradingview.com' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const caps = ((await res.json()).symbols || []).map((s) => s.symbol).filter((s) => !s.includes('.'));
    if (caps.includes(symbol)) return symbol;
    return caps.find((s) => s.startsWith(symbol)) || null;
  } catch (err) {
    console.error(`symbol search failed for ${symbol}: ${err.message}`);
    return symbol;
  }
}

async function capture(page, coin) {
  const ticker = `CRYPTOCAP:${coin.ticker}`;
  const url = `https://www.tradingview.com/chart/${LAYOUT_ID}/?symbol=${encodeURIComponent(ticker)}`;
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  // Give the data feed and indicators time to finish drawing.
  await page.waitForTimeout(15_000);
  await dismissPopups(page);
  await enlargeChart(page);
  const prefix = coin.rank ? String(coin.rank).padStart(2, '0') : 'extra';
  const file = path.join(OUT_DIR, `${prefix}_${coin.ticker}.png`);
  await page.screenshot({ path: file });
  console.log(`saved ${file} (${ticker})`);
}

const coins = [];
for (const coin of await topCoins(TOP_N)) {
  const ticker = await resolveTicker(coin.symbol);
  if (ticker) coins.push({ ...coin, ticker });
  else console.error(`no CRYPTOCAP ticker for ${coin.rank}.${coin.symbol}; skipped`);
}
for (const extra of (process.env.EXTRA_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
  if (!coins.some((c) => c.ticker === extra)) coins.push({ rank: null, symbol: extra, ticker: extra });
}
console.log('capturing:', coins.map((c) => `${c.rank ?? 'extra'}.${c.ticker}`).join(', '));
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  timezoneId: 'Asia/Seoul',
});
await blockWrites(context);
const cookies = await loginCookies();
if (cookies.length) await context.addCookies(cookies);
console.log(cookies.length ? 'using TradingView login cookies' : 'no login cookies; viewing anonymously');
const page = await context.newPage();
let failed = 0;
for (const coin of coins) {
  try {
    await capture(page, coin);
    if (coin === coins[0]) {
      const loggedIn = await page.evaluate(() => Boolean(window.user && window.user.username)).catch(() => null);
      console.log('logged in:', loggedIn);
    }
  } catch (err) {
    failed++;
    console.error(`failed ${coin.symbol}: ${err.message}`);
    await page.screenshot({ path: path.join(OUT_DIR, `FAILED_${coin.symbol}.png`) }).catch(() => {});
  }
}
await browser.close();
if (failed) process.exitCode = 1;
