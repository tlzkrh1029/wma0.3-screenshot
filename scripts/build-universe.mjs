// Build data/universe.json: every coin listed on Upbit, Bithumb or Binance spot, ranked by CoinGecko
// market cap, without stablecoins and security tokens.
//
// - Listings: Upbit (all markets), Bithumb (KRW), Binance spot (USDT/FDUSD/USDC/BTC/TRY/EUR quotes).
// - Matching: CoinGecko's own tickers for the three exchanges name the coin behind each traded symbol (coin_id),
//   which settles symbols shared by several coins. A symbol those tickers do not cover takes the CoinGecko coin
//   with the largest market cap among those sharing it. Either way the coin must be in CoinGecko's top 3000.
// - Market caps: CoinGecko /coins/markets.
// - Left out: members of the CoinGecko categories below (stablecoins, including gold/silver-backed and
//   yield-bearing ones; tokenized stocks, ETFs, funds, treasuries, credit, real estate, pre-IPO shares),
//   plus data/exclusions.json overrides: {"ids": {"SYM": {"id": "coingecko-id", "reason": "..."}},
//   "exclude": {"SYM": {"kind": "stablecoin" | "security", "reason": "..."}}, "keep": {"SYM": "reason"}}.
//   "ids" fixes a symbol whose largest-market-cap CoinGecko coin is not the asset the exchanges list;
//   its optional "also": [...] names other exchange symbols for the same coin, whose listings count too.
//   Ranks are renumbered over the coins that remain.
// - Each coin records how it was matched: "exchange" (exchange tickers), "symbol" (largest market cap) or "pin".
//
// Env: COINGECKO_DEMO_KEY  CoinGecko Demo API key (optional; without it the keyless API is used, much slower)
//      REPORT              write a JSON report here: symbols where the two matching methods disagree, and symbols
//                          dropped because another symbol already holds their coin (they need an "ids" pin)
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
// CoinGecko: the Demo key allows 100 calls a minute; the keyless API about 10-30 shared per IP
const CG_KEY = process.env.COINGECKO_DEMO_KEY || '';
const CG_PAUSE = CG_KEY ? 800 : 3000;
const cg = (pathAndQuery) => get(`https://api.coingecko.com/api/v3/${pathAndQuery}`, CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {});
const report = { differs: [], duplicates: [] };
async function getRes(url, headers = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', ...headers } });
    if (res.status === 429) { await sleep(20_000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  }
  throw new Error(`still rate limited: ${url}`);
}
async function get(url, headers = {}) { return (await getRes(url, headers)).json(); }
const cgRes = (pathAndQuery) => getRes(`https://api.coingecko.com/api/v3/${pathAndQuery}`, CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {});

const upbit = new Map();
for (const m of await get('https://api.upbit.com/v1/market/all')) {
  const base = m.market.split('-')[1];
  if (!upbit.has(base)) upbit.set(base, m.korean_name);
}
const bithumb = new Set(Object.keys((await get('https://api.bithumb.com/public/ticker/ALL_KRW')).data).filter((k) => k !== 'date'));
const binance = new Set((await get('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')).symbols
  .filter((s) => s.status === 'TRADING' && ['USDT', 'FDUSD', 'USDC', 'BTC', 'TRY', 'EUR'].includes(s.quoteAsset)).map((s) => s.baseAsset));
const listed = new Set([...upbit.keys(), ...bithumb, ...binance]);

const symsOf = (sym) => [sym, ...(overrides.ids[sym]?.also || [])];
const free = (sym) => !overrides.ids[sym] && !aliases.has(sym); // not settled by a pin

// CoinGecko's tickers for the three exchanges: symbol -> coin_id. A ticker whose coin has no market cap points at an
// unrelated coin with the same symbol (e.g. Bithumb PROS -> pharos-2), so it is ignored; so are anomalous tickers.
const exCoin = new Map(), exAnom = new Map(); // sym -> Map(coin_id -> market cap): normal / anomalous tickers
const exNamed = new Map(); // sym -> Set(coin_id): every coin any ticker names, with or without a market cap
const add = (map, sym, id, v) => { const m = map.get(sym) || new Map(); m.set(id, Math.max(m.get(id) || 0, v)); map.set(sym, m); };
for (const ex of ['upbit', 'bithumb', 'binance']) {
  // order=base_target pages stably; a ticker whose anomaly flag flips mid-fetch still moves, so check the count
  for (let pass = 0; pass < 3; pass++) {
    const seen = new Set(); let total = 0;
    for (let page = 1; page <= 40; page++) {
      const res = await cgRes(`exchanges/${ex}/tickers?page=${page}&order=base_target`);
      total = Number(res.headers.get('total')) || total;
      const { tickers = [] } = await res.json();
      for (const t of tickers) {
        seen.add(`${t.base}/${t.target}`);
        const sym = String(t.base || '').toUpperCase();
        if (!listed.has(sym) || !t.coin_id) continue;
        (exNamed.get(sym) || exNamed.set(sym, new Set()).get(sym)).add(t.coin_id);
        if (t.coin_mcap_usd > 0) add(t.is_anomaly ? exAnom : exCoin, sym, t.coin_id, t.coin_mcap_usd);
      }
      await sleep(CG_PAUSE);
      if (tickers.length < 100) break;
    }
    if (!total || seen.size >= total) break;
    console.warn(`${ex}: got ${seen.size} of ${total} tickers, fetching again`);
  }
}
// normal tickers first (anomalous ones flag a price, not a different coin); several coins: the largest market cap wins
const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0][0];
const exPick = new Map([...new Set([...exCoin.keys(), ...exAnom.keys()])].map((sym) => [sym, top(exCoin.get(sym) || exAnom.get(sym))]));

const markets = [];
for (let page = 1; page <= 12; page++) {
  markets.push(...await cg(`coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`));
  await sleep(CG_PAUSE);
}
// largest market cap per symbol: the match for symbols the exchange tickers do not cover, and a cross-check otherwise
const bySymbol = new Map();
for (const c of markets) {
  const sym = c.symbol.toUpperCase();
  if (!free(sym) || !listed.has(sym) || !c.market_cap) continue;
  if (!bySymbol.has(sym) || c.market_cap > bySymbol.get(sym).market_cap) bySymbol.set(sym, c);
}
// The ranked pages shift while they are fetched (market caps move), so a coin can fall between two pages.
// Listed symbols that found no coin are looked up directly, with the same top-3000 rule; CoinGecko leaves
// wrapped and staked tokens (WBTC, WBETH, BNSOL) unranked, so they stay unmatched.
const gaps = [...listed].filter((s) => !bySymbol.has(s) && !exPick.has(s) && free(s));
for (let i = 0; i < gaps.length; i += 40) {
  const batch = gaps.slice(i, i + 40).map((s) => encodeURIComponent(s.toLowerCase())).join(',');
  for (const c of await cg(`coins/markets?vs_currency=usd&include_tokens=all&per_page=250&symbols=${batch}`)) {
    const sym = c.symbol.toUpperCase();
    if (!listed.has(sym) || !c.market_cap || !c.market_cap_rank || c.market_cap_rank > 3000) continue;
    if (!bySymbol.has(sym) || c.market_cap > bySymbol.get(sym).market_cap) bySymbol.set(sym, c);
  }
  await sleep(CG_PAUSE);
}
// coins named by the exchange tickers that the ranked pages missed, looked up by id (a longer id list is refused)
const byId = new Map(markets.map((c) => [c.id, c]));
const needIds = [...new Set([...exPick].filter(([sym]) => free(sym)).map(([, id]) => id))].filter((id) => !byId.has(id));
for (let i = 0; i < needIds.length; i += 120) {
  for (const c of await cg(`coins/markets?vs_currency=usd&per_page=250&ids=${needIds.slice(i, i + 120).join(',')}`)) byId.set(c.id, c);
  await sleep(CG_PAUSE);
}
const best = new Map(), how = new Map();
for (const sym of listed) {
  if (!free(sym)) continue;
  const c = byId.get(exPick.get(sym)), s = bySymbol.get(sym);
  if (c?.market_cap && c.market_cap_rank && c.market_cap_rank <= 3000) {
    best.set(sym, { ...c, symbol: sym, cgSymbol: c.symbol }); how.set(sym, 'exchange');
    if (s && s.id !== c.id) report.differs.push({ sym, exchange: { id: c.id, name: c.name, mcap: c.market_cap }, largest: { id: s.id, name: s.name, mcap: s.market_cap } });
  } else if (s && exPick.has(sym) && exPick.get(sym) !== s.id) {
    // the exchanges name another coin (outside the top 3000): leave the symbol unmatched rather than guess
    const x = byId.get(exPick.get(sym));
    report.differs.push({ sym, exchange: { id: exPick.get(sym), name: x?.name, mcap: x?.market_cap, rank: x?.market_cap_rank ?? null }, largest: { id: s.id, name: s.name, mcap: s.market_cap }, matched: null });
  } else if (s) { best.set(sym, { ...s, cgSymbol: s.symbol }); how.set(sym, 'symbol'); }
}
// symbols pinned to a CoinGecko id (looked up directly, so they need not be in the top 3000)
const pinned = Object.entries(overrides.ids).filter(([sym]) => symsOf(sym).some((x) => listed.has(x)));
if (pinned.length) {
  const rows = await cg(`coins/markets?vs_currency=usd&ids=${pinned.map(([, o]) => o.id).join(',')}`);
  for (const [sym, o] of pinned) {
    const c = rows.find((r) => r.id === o.id);
    if (!c) throw new Error(`data/exclusions.json: CoinGecko id ${o.id} for ${sym} not found`);
    if (c.market_cap) { best.set(sym, { ...c, symbol: sym, cgSymbol: c.symbol }); how.set(sym, 'pin'); }
    // a pin that the exchange tickers contradict is worth a look
    // only when no ticker for the symbol (or its aliases) names the pinned coin
    const named = symsOf(sym).flatMap((y) => [...(exNamed.get(y) || [])]);
    const x = exPick.get(sym); if (x && x !== o.id && !named.includes(o.id)) report.differs.push({ sym, pin: o.id, exchange: { id: x } });
  }
}
// One row per CoinGecko coin. Two exchange symbols on the same coin need an "ids" pin with "also"; until then the
// symbol that is the coin's own symbol (else the one on more exchanges) is kept and the other is reported.
const exOf = (sym) => ['U', 'B', 'N'].filter((x) => symsOf(sym).some((y) => (x === 'U' ? upbit.has(y) : x === 'B' ? bithumb.has(y) : binance.has(y)))).join('');
{ const seen = new Map();
  for (const [sym, c] of [...best]) {
    const other = seen.get(c.id);
    if (!other) { seen.set(c.id, sym); continue; }
    if (how.get(sym) === 'pin' && how.get(other) === 'pin') throw new Error(`CoinGecko ${c.id} is pinned for both ${other} and ${sym}`);
    // a symbol guess that its own exchange tickers contradict (they name a coin without a market cap) loses to a verified match
    const contradicted = (x) => how.get(x) === 'symbol' && exNamed.has(x) && !exNamed.get(x).has(c.id);
    const score = (x) => (how.get(x) === 'pin' ? 100 : 0) + (contradicted(x) ? -20 : 0) + (x === String(c.cgSymbol).toUpperCase() ? 10 : 0) + exOf(x).length;
    const [keep, drop] = score(sym) > score(other) ? [sym, other] : [other, sym];
    best.delete(drop); seen.set(c.id, keep);
    report.duplicates.push({ id: c.id, name: c.name, kept: keep, dropped: drop, how: { [keep]: how.get(keep), [drop]: how.get(drop) }, droppedNames: [...(exNamed.get(drop) || [])] });
  }
}

// category membership by CoinGecko id
const why = new Map(); // id -> {kind, cats}
for (const [kind, cats] of [['stablecoin', STABLE_CATS], ['security', SECURITY_CATS]]) {
  for (const cat of cats) {
    for (let page = 1; page <= 8; page++) {
      const rows = await cg(`coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=250&page=${page}`);
      for (const r of rows) {
        const w = why.get(r.id) || { kind, cats: [] };
        if (kind === 'security') w.kind = 'security'; // a tokenized share that is also listed as a stablecoin counts as a security
        w.cats.push(cat); why.set(r.id, w);
      }
      await sleep(CG_PAUSE);
      if (rows.length < 250) break;
    }
  }
}
const kept = [], excluded = [];
for (const c of [...best.values()].sort((a, b) => b.market_cap - a.market_cap)) {
  const sym = c.symbol.toUpperCase();
  const row = { sym, id: c.id, name: c.name, ko: symsOf(sym).map((y) => upbit.get(y)).find(Boolean) || null, mcap: c.market_cap, ex: exOf(sym), match: how.get(sym) };
  const w = why.get(c.id), manual = overrides.exclude[sym];
  if (overrides.keep[sym]) kept.push(row);
  else if (manual) excluded.push({ ...row, kind: manual.kind, why: manual.reason });
  else if (w) excluded.push({ ...row, kind: w.kind, why: `CoinGecko: ${w.cats.join(', ')}` });
  else kept.push(row);
}
const coins = kept.map((c, i) => ({ rank: i + 1, ...c }));
const dropped = new Set(report.duplicates.map((d) => d.dropped));
const unmatched = [...listed].filter((s) => !best.has(s) && !aliases.has(s) && !dropped.has(s)).sort();
await writeFile('data/universe.json', JSON.stringify({
  fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  rule: 'Upbit, Bithumb or Binance spot listings ranked by CoinGecko market cap; stablecoins and security tokens left out (see excluded)',
  coins, excluded, unmatched,
}));
console.log(`coins ${coins.length}, excluded ${excluded.length} (stablecoin ${excluded.filter((e) => e.kind === 'stablecoin').length}, security ${excluded.filter((e) => e.kind === 'security').length}), unmatched ${unmatched.length}; ` +
  `matched by exchange tickers ${[...how.values()].filter((h) => h === 'exchange').length}, by symbol ${[...how.values()].filter((h) => h === 'symbol').length}, pinned ${pinned.length}; ` +
  `${report.differs.length} disagreements, ${report.duplicates.length} duplicate symbols`);
if (process.env.REPORT) await writeFile(process.env.REPORT, JSON.stringify(report, null, 1));
