// Build data/universe.json: every coin listed on Upbit, Bithumb or Binance spot, ranked by CoinGecko
// market cap, without stablecoins and security tokens.
//
// - Listings: Upbit (all markets), Bithumb (KRW), Binance spot (USDT/FDUSD/USDC/BTC/TRY/EUR quotes).
// - Market caps: CoinGecko /coins/markets (top 3000 by CoinGecko rank); a symbol takes the CoinGecko coin
//   with the largest market cap among those sharing it.
// - Left out: members of the CoinGecko categories below (stablecoins, including gold/silver-backed and
//   yield-bearing ones; tokenized stocks, ETFs, funds, treasuries, credit, real estate, pre-IPO shares),
//   plus data/exclusions.json overrides: {"ids": {"SYM": {"id": "coingecko-id", "reason": "..."}},
//   "exclude": {"SYM": {"kind": "stablecoin" | "security", "reason": "..."}}, "keep": {"SYM": "reason"}}.
//   "ids" fixes a symbol whose largest-market-cap CoinGecko coin is not the asset the exchanges list;
//   its optional "also": [...] names other exchange symbols for the same coin, whose listings count too.
//   Ranks are renumbered over the coins that remain.
//
// Usage: node scripts/build-universe.mjs   (in the sandbox: NODE_USE_ENV_PROXY=1)
import { readFile, writeFile } from 'node:fs/promises';

export const STABLE_CATS = [
  'stablecoins', 'usd-stablecoin', 'eur-stablecoin', 'fiat-backed-stablecoin', 'crypto-backed-stablecoin', 'algorithmic-stablecoin',
  'commodity-backed-stablecoin', 'yield-bearing-stablecoins', 'synthetic-dollar', 'bridged-stablecoins', 'bank-issued-stablecoin',
  'us-treasury-backed-stablecoin', 'try-stablecoins', 'krw-stablecoin', 'tokenized-gold', 'tokenized-silver',
];
export const SECURITY_CATS = [
  'tokenized-stock', 'xstocks-ecosystem', 'bstocks-ecosystem', 'tokenized-exchange-traded-funds-etfs', 'tokenized-treasuries',
  'tokenized-t-bills', 'tokenized-treasury-bonds-t-bonds', 'tokenized-money-market-fund-mmfs', 'tokenized-credit', 'tokenized-private-credit',
  'tokenized-pre-ipo-stocks', 'real-estate', 'tokenized-closed-end-funds-cefs', 'tokenized-exchange-traded-product-etps',
  'tokenized-commodity-exchange-traded-products-etps', 'tokenized-non-us-government-securities', 'tokenized-bank-deposit',
  'republic-tokenized-pre-ipo-assets', 'tessera-tokenized-pre-ipo-assets', 'robinhood-chain-stocks-ecosystem',
  'remora-markets-tokenized-rstocks', 'prestocks-ecosystem', 'openstock-ecosystem',
];

// read the overrides first, so a broken file fails before any network calls (only a missing file is allowed)
let overrides = { ids: {}, exclude: {}, keep: {} };
try { overrides = { ...overrides, ...JSON.parse(await readFile('data/exclusions.json', 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
const aliases = new Map(Object.entries(overrides.ids).flatMap(([sym, o]) => (o.also || []).map((a) => [a, sym])));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, headers = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', ...headers } });
    if (res.status === 429) { await sleep(20_000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error(`still rate limited: ${url}`);
}

const upbit = new Map();
for (const m of await get('https://api.upbit.com/v1/market/all')) {
  const base = m.market.split('-')[1];
  if (!upbit.has(base)) upbit.set(base, m.korean_name);
}
const bithumb = new Set(Object.keys((await get('https://api.bithumb.com/public/ticker/ALL_KRW')).data).filter((k) => k !== 'date'));
const binance = new Set((await get('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')).symbols
  .filter((s) => s.status === 'TRADING' && ['USDT', 'FDUSD', 'USDC', 'BTC', 'TRY', 'EUR'].includes(s.quoteAsset)).map((s) => s.baseAsset));
const listed = new Set([...upbit.keys(), ...bithumb, ...binance]);

const markets = [];
for (let page = 1; page <= 12; page++) {
  markets.push(...await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`));
  await sleep(3000);
}
const best = new Map();
for (const c of markets) {
  const sym = c.symbol.toUpperCase();
  if (overrides.ids[sym] || aliases.has(sym) || !listed.has(sym) || !c.market_cap) continue;
  if (!best.has(sym) || c.market_cap > best.get(sym).market_cap) best.set(sym, c);
}
// The ranked pages shift while they are fetched (market caps move), so a coin can fall between two pages.
// Listed symbols that found no coin are looked up directly, with the same top-3000 rule; CoinGecko leaves
// wrapped and staked tokens (WBTC, WBETH, BNSOL) unranked, so they stay unmatched.
const gaps = [...listed].filter((s) => !best.has(s) && !overrides.ids[s] && !aliases.has(s));
for (let i = 0; i < gaps.length; i += 40) {
  const batch = gaps.slice(i, i + 40).map((s) => encodeURIComponent(s.toLowerCase())).join(',');
  for (const c of await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&include_tokens=all&per_page=250&symbols=${batch}`)) {
    const sym = c.symbol.toUpperCase();
    if (!listed.has(sym) || !c.market_cap || !c.market_cap_rank || c.market_cap_rank > 3000) continue;
    if (!best.has(sym) || c.market_cap > best.get(sym).market_cap) best.set(sym, c);
  }
  await sleep(3000);
}
// symbols pinned to a CoinGecko id (looked up directly, so they need not be in the top 3000)
const symsOf = (sym) => [sym, ...(overrides.ids[sym]?.also || [])];
const pinned = Object.entries(overrides.ids).filter(([sym]) => symsOf(sym).some((x) => listed.has(x)));
if (pinned.length) {
  const rows = await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${pinned.map(([, o]) => o.id).join(',')}`);
  for (const [sym, o] of pinned) {
    const c = rows.find((r) => r.id === o.id);
    if (!c) throw new Error(`data/exclusions.json: CoinGecko id ${o.id} for ${sym} not found`);
    if (c.market_cap) best.set(sym, { ...c, symbol: sym });
  }
}
// one row per CoinGecko coin: two symbols on the same coin need an "ids" pin with "also"
{ const seen = new Map();
  for (const [sym, c] of best) { if (seen.has(c.id)) throw new Error(`CoinGecko ${c.id} matched by both ${seen.get(c.id)} and ${sym}; pin it in data/exclusions.json "ids" with "also"`); seen.set(c.id, sym); } }

// category membership by CoinGecko id
const why = new Map(); // id -> {kind, cats}
for (const [kind, cats] of [['stablecoin', STABLE_CATS], ['security', SECURITY_CATS]]) {
  for (const cat of cats) {
    for (let page = 1; page <= 8; page++) {
      const rows = await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=250&page=${page}`);
      for (const r of rows) {
        const w = why.get(r.id) || { kind, cats: [] };
        if (kind === 'security') w.kind = 'security'; // a tokenized share that is also listed as a stablecoin counts as a security
        w.cats.push(cat); why.set(r.id, w);
      }
      await sleep(3000);
      if (rows.length < 250) break;
    }
  }
}
const exOf = (sym) => ['U', 'B', 'N'].filter((x) => symsOf(sym).some((y) => (x === 'U' ? upbit.has(y) : x === 'B' ? bithumb.has(y) : binance.has(y)))).join('');
const kept = [], excluded = [];
for (const c of [...best.values()].sort((a, b) => b.market_cap - a.market_cap)) {
  const sym = c.symbol.toUpperCase();
  const row = { sym, id: c.id, name: c.name, ko: symsOf(sym).map((y) => upbit.get(y)).find(Boolean) || null, mcap: c.market_cap, ex: exOf(sym) };
  const w = why.get(c.id), manual = overrides.exclude[sym];
  if (overrides.keep[sym]) kept.push(row);
  else if (manual) excluded.push({ ...row, kind: manual.kind, why: manual.reason });
  else if (w) excluded.push({ ...row, kind: w.kind, why: `CoinGecko: ${w.cats.join(', ')}` });
  else kept.push(row);
}
const coins = kept.map((c, i) => ({ rank: i + 1, ...c }));
const unmatched = [...listed].filter((s) => !best.has(s) && !aliases.has(s)).sort();
await writeFile('data/universe.json', JSON.stringify({
  fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  rule: 'Upbit, Bithumb or Binance spot listings ranked by CoinGecko market cap; stablecoins and security tokens left out (see excluded)',
  coins, excluded, unmatched,
}));
console.log(`coins ${coins.length}, excluded ${excluded.length} (stablecoin ${excluded.filter((e) => e.kind === 'stablecoin').length}, security ${excluded.filter((e) => e.kind === 'security').length}), unmatched ${unmatched.length}`);
