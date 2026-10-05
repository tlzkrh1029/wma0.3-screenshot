// Map each coin in data/universe.json to its TradingView tickers:
//   CRYPTO:{CODE}USD (price) and CRYPTOCAP:{CODE} (market cap).
// TradingView uses its own CODE, which often differs from the exchange symbol
// (ARB -> ARBI, POL -> POLYG), so we search by symbol and by name, pick the
// CRYPTO candidate whose description matches the coin name, then confirm the
// CRYPTOCAP ticker with the same CODE exists.
//
// Usage: node scripts/resolve-tickers.mjs [topN] [--new-only]   (default: every coin in the universe) -> data/tickers.json
// Existing entries in data/tickers.json with "manual": true are kept as they are. Such entries may add
// "usdFrom" / "capFrom" (YYYY-MM-DD): bars before that day are dropped, e.g. history of an older coin
// that TradingView kept under the same ticker.
// Each entry records the CoinGecko coin it was resolved for ("cg"). With --new-only, entries whose coin is unchanged
// and that have both tickers are kept; only coins that are new, re-matched, or missing a ticker are searched (the
// weekly refresh). A manual entry whose coin leaves the universe moves to "retired" (keyed by CoinGecko id) and
// comes back when that coin returns, under any symbol. A manual entry whose symbol now means another coin keeps its
// old "cg", so it is reported every run until someone checks it and updates "cg".
// A search that stays rate limited fails the run instead of saving a coin without tickers.
// Env REPORT: write what changed (resolved, manualChanged, restored, retired) to this JSON file.
import { readFile, writeFile } from 'node:fs/promises';

const NEW_ONLY = process.argv.includes('--new-only');
const TOP = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) || Infinity);
const universe = JSON.parse(await readFile('data/universe.json', 'utf8')).coins.slice(0, TOP);
let previous = {}, retired = {};
try {
  const f = JSON.parse(await readFile('data/tickers.json', 'utf8'));
  previous = Object.fromEntries(f.coins.map((c) => [c.sym, c])); retired = { ...(f.retired || {}) };
} catch {}
const FULL = !Number.isFinite(TOP);
// manual entries whose symbol left the universe, by CoinGecko id (a renamed symbol, or a coin that left)
const inUniverse = new Set(universe.map((c) => c.sym));
const orphanManual = new Map(Object.values(previous).filter((c) => c.manual && c.cg && !inUniverse.has(c.sym)).map((c) => [c.cg, c]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function search(text, exchange) {
  const url = `https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(text)}&exchange=${exchange}&hl=0&lang=en&domain=production`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { origin: 'https://www.tradingview.com' } });
      if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).symbols || [];
    } catch (err) { if (attempt === 3) throw err; await sleep(1500); }
  }
  throw new Error(`TradingView symbol search still rate limited: ${url}`);
}
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, '');
const prevName = (s) => { const m = /\(prev\.?\s*([^)]+)\)/i.exec(s || ''); return m ? norm(m[1]) : ''; };
function nameScore(desc, coin) {
  const d = norm(desc), n = norm(coin.name), p = prevName(desc);
  if (!d) return 0;
  if (d === n) return 3;
  if (d.startsWith(n) || n.startsWith(d)) return 2;
  if (d.includes(n) || n.includes(d) || (p && (p === n || p === norm(coin.sym)))) return 1;
  return 0;
}

const out = [], resolved = [], manualChanged = [], restored = [];
for (const coin of universe) {
  let prev = previous[coin.sym];
  // a manual fix follows its coin: back from "retired", or over from the coin's previous symbol
  if (FULL && !prev?.manual && (retired[coin.id] || orphanManual.has(coin.id))) {
    const m = retired[coin.id] || orphanManual.get(coin.id);
    restored.push({ sym: coin.sym, from: m.sym, usd: m.usd, cap: m.cap });
    delete retired[coin.id]; orphanManual.delete(coin.id); prev = { ...m, sym: coin.sym };
  }
  const same = prev && (prev.cg ?? coin.id) === coin.id;
  if (prev?.manual) {
    // a manual fix belongs to the asset it was made for: when the symbol now means another coin, keep the old "cg"
    // so this is reported on every run until someone checks the tickers and updates "cg"
    if (!same) manualChanged.push({ sym: coin.sym, was: prev.cg, now: coin.id, usd: prev.usd, cap: prev.cap });
    out.push({ ...prev, rank: coin.rank, cg: same ? coin.id : prev.cg }); continue;
  }
  if (NEW_ONLY && same && prev.usd && prev.cap) { out.push({ ...prev, rank: coin.rank, name: coin.name, cg: coin.id }); continue; }
  const cands = new Map();
  for (const q of [coin.sym, coin.name]) {
    for (const s of await search(q, 'CRYPTO')) {
      if (s.type !== 'spot' || !/USD$/.test(s.symbol)) continue;
      cands.set(s.symbol, s.description);
    }
    await sleep(250);
  }
  const scored = [...cands.entries()].map(([symbol, desc]) => {
    const code = symbol.replace(/USD$/, '');
    let score = nameScore(desc, coin) * 10;
    if (code === coin.sym) score += 5;
    else if (code.startsWith(coin.sym)) score += 2;
    return { symbol, code, desc, score };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  let cap = null;
  if (best) {
    const caps = await search(best.code, 'CRYPTOCAP');
    if (caps.some((s) => s.symbol === best.code)) cap = `CRYPTOCAP:${best.code}`;
    await sleep(250);
  }
  const confident = !!best && best.score >= 25 && !!cap && (scored.length < 2 || scored[1].score < best.score);
  out.push({
    rank: coin.rank, sym: coin.sym, name: coin.name, cg: coin.id,
    usd: best ? `CRYPTO:${best.symbol}` : null, cap, tvName: best?.desc ?? null,
    confidence: confident ? 'high' : best ? 'check' : 'none',
    alternatives: scored.slice(1, 4).map((s) => `${s.symbol} (${s.desc})`),
  });
  resolved.push({ ...out.at(-1), was: prev ? { cg: prev.cg ?? null, usd: prev.usd, cap: prev.cap } : null });
  console.log(`${String(coin.rank).padStart(3)} ${coin.sym.padEnd(8)} -> ${(out.at(-1).usd || '-').padEnd(22)} ${(cap || '-').padEnd(18)} ${out.at(-1).confidence.padEnd(5)} ${best?.desc ?? ''}`);
}
// manual fixes of coins that left the universe wait in "retired" for the coin to come back
const retiredNow = [];
if (FULL) for (const [cg, m] of orphanManual) { retired[cg] = m; retiredNow.push({ sym: m.sym, cg, usd: m.usd, cap: m.cap }); }
await writeFile('data/tickers.json', JSON.stringify({ resolvedAt: new Date().toISOString(), coins: out, ...(Object.keys(retired).length ? { retired } : {}) }, null, 1));
console.log(`wrote data/tickers.json (${out.length} coins, ${resolved.length} resolved now, ${out.filter((c) => c.confidence !== 'high' && !c.manual).length} to check)`);
if (process.env.REPORT) await writeFile(process.env.REPORT, JSON.stringify({ resolved, manualChanged, restored, retired: retiredNow }, null, 1));
