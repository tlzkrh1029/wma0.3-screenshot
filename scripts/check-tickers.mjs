// Check the coin matches against the exchanges' own prices: the latest TradingView USD close and CoinGecko's price
// against the price on Binance (USDT), Upbit or Bithumb (KRW, converted at their USDT price), and the latest
// CRYPTOCAP close against CoinGecko's market cap. A ticker or CoinGecko coin that belongs to another coin with
// the same symbol is usually off by far more than a day's move, so the coins listed here need a look: a wrong
// TradingView ticker gets a "manual": true entry in data/tickers.json, a wrong CoinGecko coin an "ids" pin in
// data/exclusions.json. A market cap that is off with a matching price usually means TradingView and CoinGecko
// count the circulating supply differently.
//
// Usage: node scripts/check-tickers.mjs [--daily-dir data/daily] [--ratio 1.5] [--json out.json]
//        (in the sandbox: NODE_USE_ENV_PROXY=1; env COINGECKO_DEMO_KEY is used when set)
//   --json  also write the flagged coins as JSON ({sym, rank, usd, cap, prices, notes, priceOff}); priceOff marks a
//           TradingView or CoinGecko price more than --ratio off the exchange price, the case that needs a fix
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DAILY_DIR = opt('--daily-dir', path.join('data', 'daily'));
const RATIO = Number(opt('--ratio', 1.5));
const JSON_OUT = opt('--json', null);
const CG_KEY = process.env.COINGECKO_DEMO_KEY || '';
const universe = JSON.parse(await readFile(path.join('data', 'universe.json'), 'utf8'));
const tickers = JSON.parse(await readFile(path.join('data', 'tickers.json'), 'utf8'));
const today = Math.floor(Date.now() / 86400000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  const key = CG_KEY && url.startsWith('https://api.coingecko.com/') ? { 'x-cg-demo-api-key': CG_KEY } : {};
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', ...key } });
    if (res.status === 429) { await sleep(20_000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error(`still rate limited: ${url}`);
}
// exchange prices in USD, by exchange symbol
const exPrice = new Map();
{
  // only pairs that still trade: a delisted pair keeps its last price
  const trading = new Map((await get('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')).symbols
    .filter((x) => x.status === 'TRADING').map((x) => [x.symbol, x]));
  const bn = await get('https://data-api.binance.vision/api/v3/ticker/price');
  for (const q of ['USDC', 'FDUSD', 'USDT']) for (const r of bn) { const x = trading.get(r.symbol); if (x?.quoteAsset === q) exPrice.set(x.baseAsset, { usd: Number(r.price), ex: 'Binance' }); }
  const ub = (await get('https://api.upbit.com/v1/market/all')).filter((m) => m.market.startsWith('KRW-')).map((m) => m.market);
  const ut = [];
  for (let i = 0; i < ub.length; i += 100) ut.push(...await get(`https://api.upbit.com/v1/ticker?markets=${ub.slice(i, i + 100).join(',')}`));
  const uKrw = ut.find((r) => r.market === 'KRW-USDT')?.trade_price;
  for (const r of ut) { const sym = r.market.slice(4); if (!exPrice.has(sym) && uKrw) exPrice.set(sym, { usd: r.trade_price / uKrw, ex: 'Upbit' }); }
  const bt = (await get('https://api.bithumb.com/public/ticker/ALL_KRW')).data, bKrw = Number(bt.USDT?.closing_price);
  for (const [sym, r] of Object.entries(bt)) if (sym !== 'date' && !exPrice.has(sym) && bKrw) exPrice.set(sym, { usd: Number(r.closing_price) / bKrw, ex: 'Bithumb' });
}
let overrides = { ids: {} };
try { overrides = { ...overrides, ...JSON.parse(await readFile(path.join('data', 'exclusions.json'), 'utf8')) }; } catch {}
const exOf = (sym) => [sym, ...(overrides.ids[sym]?.also || [])].map((x) => exPrice.get(x)).find(Boolean) || null;

const cg = new Map();
const ids = universe.coins.map((c) => c.id);
for (let i = 0; i < ids.length; i += 120) { // a longer id list is refused (HTTP 403)
  for (const r of await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids=${ids.slice(i, i + 120).join(',')}`)) cg.set(r.id, r);
  await sleep(CG_KEY ? 800 : 3000);
}

async function last(id) {
  try {
    const f = JSON.parse(await readFile(path.join(DAILY_DIR, id.replace(/[^A-Za-z0-9.]+/g, '_') + '.json'), 'utf8'));
    for (let i = f.c.length - 1; i >= 0; i--) if (f.c[i] != null) return { v: f.c[i], day: f.d0 + i, first: f.d0 };
  } catch {}
  return null;
}
const off = (a, b) => (a > 0 && b > 0 ? Math.max(a / b, b / a) : Infinity);
const fmt = (x) => (x == null ? '-' : x >= 1e6 ? x.toExponential(2) : x.toPrecision(4));
const byTicker = new Map(tickers.coins.map((t) => [t.sym, t]));
const rows = [], flagged = [];
for (const u of universe.coins) {
  const t = byTicker.get(u.sym) || {}, g = cg.get(u.id) || {};
  const usd = t.usd ? await last(t.usd) : null, cap = t.cap ? await last(t.cap) : null;
  const notes = [];
  if (!t.usd && !t.cap) notes.push('no tickers');
  if (t.usd && !usd) notes.push('no USD data');
  if (t.cap && !cap) notes.push('no CAP data');
  if (usd && today - usd.day > 3) notes.push(`USD last bar ${today - usd.day}d old`);
  if (cap && today - cap.day > 3) notes.push(`CAP last bar ${today - cap.day}d old`);
  const x = exOf(u.sym);
  const tvx = usd && x ? off(usd.v, x.usd) : null, cgx = g.current_price && x ? off(g.current_price, x.usd) : null;
  const cr = cap && g.market_cap ? off(cap.v, g.market_cap) : null;
  if (tvx != null && tvx > RATIO) notes.push(`TradingView price x${tvx.toFixed(2)} off ${x.ex}`);
  if (cgx != null && cgx > RATIO) notes.push(`CoinGecko price x${cgx.toFixed(2)} off ${x.ex}`);
  if (!x) notes.push('no exchange price');
  if (cr != null && cr > RATIO) notes.push(`cap x${cr.toFixed(2)} off CoinGecko`);
  if (t.confidence && t.confidence !== 'high') notes.push(`resolver: ${t.confidence}`);
  if (notes.length) flagged.push({ sym: u.sym, rank: u.rank, name: u.name, usd: t.usd ?? null, cap: t.cap ?? null, tvName: t.tvName ?? null,
    price: { exchange: x?.usd ?? null, ex: x?.ex ?? null, tradingview: usd?.v ?? null, coingecko: g.current_price ?? null },
    mcap: { tradingview: cap?.v ?? null, coingecko: g.market_cap ?? null }, notes,
    priceOff: (tvx != null && tvx > RATIO) || (cgx != null && cgx > RATIO) });
  if (notes.length) rows.push(`${String(u.rank).padStart(3)} ${u.sym.padEnd(9)} ${(t.usd || '-').padEnd(22)} ${(t.cap || '-').padEnd(20)} ` +
    `price ex ${fmt(x?.usd)} tv ${fmt(usd?.v)} cg ${fmt(g.current_price)}  cap tv ${fmt(cap?.v)} cg ${fmt(g.market_cap)}  ${u.name} | ${t.tvName ?? ''} | ${notes.join('; ')}`);
}
console.log(rows.join('\n'));
console.log(`${rows.length} of ${universe.coins.length} coins to look at`);
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(flagged, null, 1));
