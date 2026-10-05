// Build the screener site from the daily closes in data/daily (written by fetch-tv.mjs with OUT_DIR).
//
// Every coin in data/universe.json is listed; its tickers come from data/tickers.json. The screener and the
// market signal board need only each ticker's summary, which is computed here with dashboard/engine.js (the
// same code the page runs) and put into the page. The coin page needs the daily closes, so they go into
// d/<n>.json files ({build, daily}) of --chunk coins each, which the page fetches when a coin is opened. A coin's
// file follows its position in data/universe.json, so it stays put from one daily build to the next; the page
// still compares each file's build id with its own and asks for a reload when they differ.
//
// Output (default dist/site): index.html, d/0.json, d/1.json, ...
// Usage: node scripts/build-site.mjs [outDir] [--daily-dir data/daily] [--tickers data/tickers.json] [--chunk 1] [--fragment]
//   --chunk     coins per daily-close file (default 1; the artifact viewer takes at most 511 files, so use 3 there)
//   --fragment  writes index.html without the document around it (for the artifact viewer, which adds its own)
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createEngine } from '../dashboard/engine.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const DAILY_DIR = opt('--daily-dir', path.join('data', 'daily'));
const TICKERS = opt('--tickers', path.join('data', 'tickers.json'));
const FRAGMENT = args.includes('--fragment');
const OUT = args.find((a) => !a.startsWith('--')) || path.join('dist', 'site');
const CHUNK = Number(opt('--chunk', 1));
if (!(CHUNK >= 1)) throw new Error('--chunk must be a positive number');
const SAMPLE_EVERY = 7;
const TFS = ['1D', '2D', '3D', '4D', '5D', '6D', '1W', '8D', '9D', '10D', '2W', '3W',
  '1M', '2M', '3M', '4M', '6M', '8M', '10M', '12M'];

const universe = JSON.parse(await readFile(path.join('data', 'universe.json'), 'utf8'));
const tickers = JSON.parse(await readFile(TICKERS, 'utf8'));
const template = await readFile(path.join('dashboard', 'screener.html'), 'utf8');
const engineSrc = await readFile(path.join('dashboard', 'engine.js'), 'utf8');
let status = null;
try { status = JSON.parse(await readFile(path.join(DAILY_DIR, '_status.json'), 'utf8')); } catch {}

// daily closes per ticker id, trimmed by usdFrom / capFrom (bars before that day belong to an older coin that
// TradingView kept under the same ticker)
const fileOf = (id) => path.join(DAILY_DIR, id.replace(/[^A-Za-z0-9.]+/g, '_') + '.json');
const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
async function load(id, from) {
  let f;
  try { f = JSON.parse(await readFile(fileOf(id), 'utf8')); } catch { return null; }
  let k = 0;
  if (from) k = Math.max(0, dayOf(from) - f.d0);
  while (k < f.c.length && f.c[k] == null) k++;
  let end = f.c.length; while (end > k && f.c[end - 1] == null) end--;
  if (k >= end) return null;
  return { d0: f.d0 + k, c: f.c.slice(k, end) };
}
const byTicker = new Map(tickers.coins.map((t) => [t.sym, t]));
const coins = [], missing = [];
for (const u of universe.coins) {
  const t = byTicker.get(u.sym) || {};
  const cap = t.cap ? await load(t.cap, t.capFrom) : null, usd = t.usd ? await load(t.usd, t.usdFrom) : null;
  if (t.cap && !cap) missing.push(t.cap);
  if (t.usd && !usd) missing.push(t.usd);
  coins.push({ u, t, cap: cap && { id: t.cap, ...cap }, usd: usd && { id: t.usd, ...usd } });
}

// one day axis from the earliest first bar to the latest bar of any ticker; weekly samples end on the last day
let first = Infinity, last = -Infinity;
for (const c of coins) for (const s of [c.cap, c.usd]) if (s) { first = Math.min(first, s.d0); last = Math.max(last, s.d0 + s.c.length - 1); }
if (!Number.isFinite(first)) throw new Error(`no daily closes found in ${DAILY_DIR}`);
const days = [];
for (let d = last; d >= first; d -= SAMPLE_EVERY) days.push(d);
days.reverse();
const E = createEngine({ tfs: TFS, days, start: first, n: last - first + 1 });

// week code: u + 3 o + 9 has, as 'a'..'r', run-length encoded (a count follows a run longer than one week)
function weeks(sum) {
  let out = '';
  for (let k = 0; k < days.length;) {
    const v = sum.u[k] + 3 * sum.o[k] + 9 * sum.has[k];
    let j = k + 1; while (j < days.length && sum.u[j] + 3 * sum.o[j] + 9 * sum.has[j] === v) j++;
    out += String.fromCharCode(97 + v) + (j - k > 1 ? j - k : '');
    k = j;
  }
  return out;
}
function encode(sum) {
  const o = { c: Array.from(sum.cur, (m) => (Number.isNaN(m) ? null : Math.round(m * 1000))), w: weeks(sum) };
  const cs = sum.curSusp.reduce((a, x, j) => a | (x ? 1 << j : 0), 0); if (cs) o.cs = cs;
  if (sum.lastU2Day != null) { o.l2 = sum.lastU2Day; if (sum.lastU2Susp) o.l2s = 1; }
  if (sum.suspect.length) o.sp = sum.suspect;
  if (sum.listed != null) o.li = sum.listed;
  return o;
}

const rows = [];
const t0 = Date.now();
for (const c of coins) {
  const daily = {};
  for (const s of [c.cap, c.usd]) if (s) daily[s.id] = { s: s.d0 - first, c: s.c };
  const sr = E.seriesFrom(daily, c.cap?.id ?? null, c.usd?.id ?? null);
  const sum = {};
  if (c.cap) sum.cap = encode(E.summarizeTicker(sr, 'cap'));
  if (c.usd) sum.usd = encode(E.summarizeTicker(sr, 'usd'));
  // market cap: the latest TradingView CRYPTOCAP close; CoinGecko's where the coin has no CRYPTOCAP ticker.
  // mcx: TradingView's cap is more than 3x off CoinGecko's (they count the circulating supply differently)
  const mc = c.cap ? c.cap.c.at(-1) : c.u.mcap, x = c.cap && c.u.mcap > 0 ? mc / c.u.mcap : 1;
  rows.push({ coin: { r: 0, s: c.u.sym, n: c.u.name, k: c.u.ko || null, x: c.u.ex, mc: Math.round(mc), ...(c.cap ? {} : { mcs: 'cg' }),
    ...(x > 3 || x < 1 / 3 ? { mcx: Number(x.toPrecision(2)) } : {}),
    cap: c.cap?.id ?? null, usd: c.usd?.id ?? null, tv: c.t.tvName ?? null, sum }, daily });
}
// daily-close files follow the universe order (rows are still in it here), not the day's market-cap rank
rows.forEach((r, i) => { r.coin.ch = Math.floor(i / CHUNK); });
const nChunks = Math.ceil(rows.length / CHUNK), byChunk = rows.slice();
rows.sort((a, b) => b.coin.mc - a.coin.mc);
rows.forEach((r, i) => { r.coin.r = i + 1; });
console.log(`summaries for ${rows.length} coins in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Build id: the fetch time plus a hash of the day axis and of which tickers sit in which file, so a page never
// reads a daily-close file laid out for another build without noticing.
const fetchedAt = status?.fetchedAt ?? new Date().toISOString();
const layout = createHash('sha1').update(JSON.stringify([first, last, CHUNK, byChunk.map((r) => [r.coin.ch, r.coin.cap, r.coin.usd])])).digest('hex');
const build = `${fetchedAt.replace(/\D/g, '').slice(0, 14)}-${layout.slice(0, 8)}`;
await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'd'), { recursive: true });
for (let ch = 0; ch < nChunks; ch++) {
  const daily = Object.assign({}, ...byChunk.slice(ch * CHUNK, (ch + 1) * CHUNK).map((r) => r.daily));
  await writeFile(path.join(OUT, 'd', `${ch}.json`), JSON.stringify({ build, daily }));
}
const excluded = universe.excluded ? Object.fromEntries(['stablecoin', 'security'].map((k) => [k, universe.excluded.filter((e) => e.kind === k).length])) : null;
const data = JSON.stringify({ fetchedAt, universeAt: universe.fetchedAt, build, excluded, failed: status?.failed?.length ?? 0, missing: missing.length,
  days, tfs: TFS, axis: { start: first, n: last - first + 1 }, coins: rows.map((r) => r.coin) });

for (const marker of ['/*__DATA__*/null', '/*__ENGINE__*/']) if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
// '<' escaped so no name in the data can close the inline script
const body = template.replace('/*__ENGINE__*/', () => engineSrc.replace(/^export /gm, '')).replace('/*__DATA__*/null', () => data.replace(/</g, '\\u003c'));
// The template is a page fragment (the artifact viewer adds the document around it); GitHub Pages needs a full
// document, so the title, fonts and styles before <header> go into its head.
const cut = body.indexOf('<header');
if (cut < 0) throw new Error('template has no <header>');
const page = `<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<meta name="robots" content="noindex, nofollow">\n${body.slice(0, cut)}</head>\n<body>\n${body.slice(cut)}\n</body>\n</html>\n`;
await writeFile(path.join(OUT, 'index.html'), FRAGMENT ? body : page);
const chunks = (await readdir(path.join(OUT, 'd'))).length;
console.log(`wrote ${OUT}/index.html (${Math.round(page.length / 1024)} KB) and ${chunks} chunk files; ` +
  `${rows.filter((r) => !r.coin.cap && !r.coin.usd).length} coins without TradingView data, ${missing.length} ticker files missing`);
