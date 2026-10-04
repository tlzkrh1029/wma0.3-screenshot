// Build the screener UI mockup (dashboard/screener.html).
// Real data: the coin universe (data/universe.json) and the BTC/ETH multiples computed by
// build-tf-compare. Every other coin's multiples are generated in the page for layout review.
//
// Usage: node scripts/build-screener.mjs [out]   (default dist/screener.html)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2] || path.join('dist', 'screener.html');
const tmp = path.join(os.tmpdir(), `tfc-${process.pid}`);
execFileSync(process.execPath, ['scripts/build-tf-compare.mjs', `${tmp}.html`], { env: { ...process.env, DATA_JSON: `${tmp}.json` }, stdio: 'inherit' });
const tfc = JSON.parse(await readFile(`${tmp}.json`, 'utf8'));
await rm(`${tmp}.html`, { force: true }); await rm(`${tmp}.json`, { force: true });
const raw = JSON.parse(await readFile(path.join('data', 'tv-history.json'), 'utf8'));
const universe = JSON.parse(await readFile(path.join('data', 'universe.json'), 'utf8'));
const template = await readFile(path.join('dashboard', 'screener.html'), 'utf8');

const REAL = ['CRYPTO:BTCUSD', 'CRYPTOCAP:BTC', 'CRYPTO:ETHUSD', 'CRYPTOCAP:ETH'];
const real = {};
for (const sym of REAL) real[sym] = tfc.tickers[sym];

// BTC daily closes on a continuous day axis (gaps forward-filled): the market factor for generated coins.
const DAY = 86400;
const d1 = raw.series['CRYPTO:BTCUSD']['1D'];
const start = Math.floor(d1.t[0] / DAY), end = Math.floor(d1.t.at(-1) / DAY);
const byDay = new Map(d1.t.map((t, i) => [Math.floor(t / DAY), d1.c[i]]));
const btc = [];
let lastC = d1.c[0];
for (let d = start; d <= end; d++) { if (byDay.has(d)) lastC = byDay.get(d); btc.push(Number(lastC.toPrecision(6))); }

const coins = universe.coins.map((c) => ({ r: c.rank, s: c.sym, n: c.name, k: c.ko || null, x: c.ex, mc: Math.round(c.mcap) }));
const data = JSON.stringify({ fetchedAt: tfc.fetchedAt, universeAt: universe.fetchedAt, days: tfc.days, tfs: tfc.tfs, real, btc: { start, c: btc }, coins });
const marker = '/*__DATA__*/null';
if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, template.replace(marker, () => data));
console.log(`wrote ${out} (${Math.round(data.length / 1024)} KB of data, ${coins.length} coins)`);
