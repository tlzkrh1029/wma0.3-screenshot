// Build the screener page (dashboard/screener.html).
//
// Mockup (default): the coin universe (data/universe.json) and the BTC/ETH multiples computed by
// build-tf-compare are real; every other coin's multiples are generated in the page for layout review.
//
// Pilot (--pilot): only the coins in data/tickers.json, with TradingView daily closes from
// data/tv-daily.json. The page rebuilds every timeframe from the daily bars, so nothing is generated.
//
// Usage: node scripts/build-screener.mjs [out] [--pilot]
//        (default out: dist/screener.html, or dist/screener-pilot.html with --pilot)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const PILOT = args.includes('--pilot');
const out = args.find((a) => !a.startsWith('--')) || path.join('dist', PILOT ? 'screener-pilot.html' : 'screener.html');
const universe = JSON.parse(await readFile(path.join('data', 'universe.json'), 'utf8'));
const template = await readFile(path.join('dashboard', 'screener.html'), 'utf8');
const DAY = 86400;
const SAMPLE_EVERY = 7;
const TFS = ['1D', '2D', '3D', '4D', '5D', '6D', '1W', '8D', '9D', '10D', '2W', '3W',
  '1M', '2M', '3M', '4M', '6M', '8M', '10M', '12M'];

let data;
if (PILOT) data = await pilotData();
else data = await mockupData();

const marker = '/*__DATA__*/null';
if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, template.replace(marker, () => data.json));
console.log(`wrote ${out} (${Math.round(data.json.length / 1024)} KB of data, ${data.coins} coins)`);

async function pilotData() {
  const raw = JSON.parse(await readFile(path.join('data', 'tv-daily.json'), 'utf8'));
  const tickers = JSON.parse(await readFile(path.join('data', 'tickers.json'), 'utf8'));
  const uni = new Map(universe.coins.map((c) => [c.sym, c]));
  const ids = tickers.coins.flatMap((c) => [c.cap, c.usd]);
  const missing = ids.filter((id) => !raw.series[id]?.['1D']?.t?.length);
  if (missing.length) throw new Error(`data/tv-daily.json has no daily bars for: ${missing.join(', ')}`);

  // one shared day axis from the earliest first bar to the latest bar of any ticker
  const dayOf = (t) => Math.floor(t / DAY);
  let first = Infinity, last = -Infinity;
  for (const id of ids) { const t = raw.series[id]['1D'].t; first = Math.min(first, dayOf(t[0])); last = Math.max(last, dayOf(t.at(-1))); }
  // Closes per calendar day from the ticker's first bar; days without a bar are null (TradingView has
  // no bar there, so the page keeps them out of the bar count).
  const daily = {};
  for (const id of ids) {
    const { t, c } = raw.series[id]['1D'];
    const s = dayOf(t[0]), arr = new Array(dayOf(t.at(-1)) - s + 1).fill(null);
    t.forEach((x, i) => { if (Number.isFinite(c[i])) arr[dayOf(x) - s] = c[i]; });
    if (arr[0] == null) throw new Error(`${id}: first daily close is missing`);
    daily[id] = { s: s - first, c: arr };
  }
  const days = [];
  for (let d = last; d >= first; d -= SAMPLE_EVERY) days.push(d);
  days.reverse();
  const coins = tickers.coins.map((c) => {
    const u = uni.get(c.sym);
    if (!u) throw new Error(`${c.sym} is in data/tickers.json but not in data/universe.json`);
    return { r: u.rank, s: c.sym, n: u.name, k: u.ko || null, x: u.ex, mc: Math.round(u.mcap), cap: c.cap, usd: c.usd, tv: c.tvName };
  }).sort((a, b) => a.r - b.r);
  const json = JSON.stringify({ pilot: true, fetchedAt: raw.fetchedAt, universeAt: universe.fetchedAt, days, tfs: TFS,
    axis: { start: first, n: last - first + 1 }, daily, coins });
  return { json, coins: coins.length };
}

async function mockupData() {
  const tmp = path.join(os.tmpdir(), `tfc-${process.pid}`);
  execFileSync(process.execPath, ['scripts/build-tf-compare.mjs', `${tmp}.html`], { env: { ...process.env, DATA_JSON: `${tmp}.json` }, stdio: 'inherit' });
  const tfc = JSON.parse(await readFile(`${tmp}.json`, 'utf8'));
  await rm(`${tmp}.html`, { force: true }); await rm(`${tmp}.json`, { force: true });
  const raw = JSON.parse(await readFile(path.join('data', 'tv-history.json'), 'utf8'));

  const REAL = ['CRYPTO:BTCUSD', 'CRYPTOCAP:BTC', 'CRYPTO:ETHUSD', 'CRYPTOCAP:ETH'];
  const real = {};
  for (const sym of REAL) real[sym] = tfc.tickers[sym];

  // BTC daily closes on a continuous day axis (gaps forward-filled): the market factor for generated coins.
  const d1 = raw.series['CRYPTO:BTCUSD']['1D'];
  const start = Math.floor(d1.t[0] / DAY), end = Math.floor(d1.t.at(-1) / DAY);
  const byDay = new Map(d1.t.map((t, i) => [Math.floor(t / DAY), d1.c[i]]));
  const btc = [];
  let lastC = d1.c[0];
  for (let d = start; d <= end; d++) { if (byDay.has(d)) lastC = byDay.get(d); btc.push(Number(lastC.toPrecision(6))); }

  // first daily bar of each real ticker (its listing date on TradingView)
  const realFirst = Object.fromEntries(REAL.map((sym) => [sym, Math.floor(raw.series[sym]['1D'].t[0] / DAY)]));
  const coins = universe.coins.map((c) => ({ r: c.rank, s: c.sym, n: c.name, k: c.ko || null, x: c.ex, mc: Math.round(c.mcap) }));
  const json = JSON.stringify({ fetchedAt: tfc.fetchedAt, universeAt: universe.fetchedAt, days: tfc.days, tfs: tfc.tfs, real, realFirst, btc: { start, c: btc }, coins });
  return { json, coins: coins.length };
}
