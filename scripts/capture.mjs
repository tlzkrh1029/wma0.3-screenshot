// Capture TradingView CRYPTOCAP market-cap charts for the top-N coins by market cap.
//
// Env:
//   TOP_N      number of coins to capture (default 2)
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

async function capture(page, coin) {
  const ticker = `CRYPTOCAP:${coin.symbol}`;
  const url = `https://www.tradingview.com/chart/${LAYOUT_ID}/?symbol=${encodeURIComponent(ticker)}`;
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  // Give the data feed and indicators time to finish drawing.
  await page.waitForTimeout(15_000);
  await dismissPopups(page);
  await page.waitForTimeout(1_000);
  const file = path.join(OUT_DIR, `${String(coin.rank).padStart(2, '0')}_${coin.symbol}.png`);
  await page.screenshot({ path: file });
  console.log(`saved ${file} (${ticker})`);
}

const coins = await topCoins(TOP_N);
console.log('top coins:', coins.map((c) => `${c.rank}.${c.symbol}`).join(', '));
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  timezoneId: 'Asia/Seoul',
});
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
