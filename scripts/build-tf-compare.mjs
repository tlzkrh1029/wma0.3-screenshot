// Build the timeframe-comparison mockup: for every ticker and timeframe,
// compute the close / WMA(200) multiple as it stood on each day, using the
// in-progress bar (what a TradingView chart showed that day), then embed the
// result in dashboard/tf-compare.html.
//
// Usage: node scripts/build-tf-compare.mjs [out]   (default dist/tf-compare.html)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const LEN = 200;
const FALLBACK_MIN = 12; // fallback WMA needs at least this many bars
const SAMPLE_EVERY = 7;  // keep one day per week (always including the last day)
const DAY = 86400;

const out = process.argv[2] || path.join('dist', 'tf-compare.html');
const raw = JSON.parse(await readFile(path.join('data', 'tv-history.json'), 'utf8'));
const template = await readFile(path.join('dashboard', 'tf-compare.html'), 'utf8');

const TFS = ['1D', '2D', '3D', '4D', '5D', '6D', '1W', '8D', '9D', '10D', '2W', '3W',
  '1M', '2M', '3M', '4M', '6M', '8M', '10M', '12M'];

// Multiple of the in-progress bar k when today's close is c:
// WMA_n = (n*c + sum_{j=1..n-1} (n-j) * C[k-j]) / (n(n+1)/2)
function prevSums(C, n) {
  // S[k] = sum_{j=1..n-1} (n-j) * C[k-j], defined when k >= n-1
  const S = new Array(C.length).fill(null);
  for (let k = n - 1; k < C.length; k++) {
    let s = 0;
    for (let j = 1; j < n; j++) s += (n - j) * C[k - j];
    S[k] = s;
  }
  return S;
}
function fallbackAt(C, k, c) {
  const n = Math.min(LEN, k + 1);
  if (n < FALLBACK_MIN) return null;
  let s = 0;
  for (let j = 1; j < n; j++) s += (n - j) * C[k - j];
  return c / ((n * c + s) / (n * (n + 1) / 2));
}

const dayOf = (t) => Math.floor(t / DAY);
let lastDay = -Infinity, firstDay = Infinity;
for (const tfs of Object.values(raw.series)) {
  lastDay = Math.max(lastDay, dayOf(tfs['1D'].t.at(-1)));
  firstDay = Math.min(firstDay, dayOf(tfs['1D'].t[0]));
}
const sampleDays = [];
for (let d = lastDay; d >= firstDay; d -= SAMPLE_EVERY) sampleDays.push(d);
sampleDays.reverse();

const q = (m) => (m == null || !Number.isFinite(m) ? null : Math.round(m * 1000)); // 3 decimals as int
const tickers = {};
for (const [sym, tfs] of Object.entries(raw.series)) {
  const daily = tfs['1D'];
  const dIdx = new Map(daily.t.map((t, i) => [dayOf(t), i]));
  // daily close on/just before a sample day (early history has gaps)
  const sampleRows = sampleDays.map((d) => {
    for (let back = 0; back < 4; back++) if (dIdx.has(d - back)) return dIdx.get(d - back);
    return d >= dayOf(daily.t[0]) ? -1 : null;
  });
  const entry = { m: {}, fb: {}, cur: {}, curFb: {}, bars: {} };
  for (const tf of TFS) {
    const s = tfs[tf];
    if (!s || !s.t.length) { entry.m[tf] = sampleDays.map(() => null); entry.bars[tf] = 0; continue; }
    const T = s.t, C = s.c, S = prevSums(C, LEN);
    entry.bars[tf] = T.length;
    // for each daily row, the TF bar containing it (last bar opened on or before that day)
    const barOfDay = new Array(daily.t.length);
    let k = -1;
    for (let i = 0; i < daily.t.length; i++) {
      while (k + 1 < T.length && dayOf(T[k + 1]) <= dayOf(daily.t[i])) k++;
      barOfDay[i] = k;
    }
    const mAt = (i) => {
      const kk = barOfDay[i], c = daily.c[i];
      if (kk < LEN - 1 || S[kk] == null) return null;
      return c / ((LEN * c + S[kk]) / (LEN * (LEN + 1) / 2));
    };
    const fbAt = (i) => (barOfDay[i] < 0 ? null : fallbackAt(C, barOfDay[i], daily.c[i]));
    entry.m[tf] = sampleRows.map((i) => (i == null || i < 0 ? null : q(mAt(i))));
    const last = daily.t.length - 1;
    entry.cur[tf] = mAt(last);
    // fallback history wherever the real WMA 200 is missing (early history, short timeframes)
    if (entry.m[tf].some((v, j) => v == null && sampleRows[j] != null && sampleRows[j] >= 0)) {
      entry.fb[tf] = sampleRows.map((i, j) => (entry.m[tf][j] != null || i == null || i < 0 ? null : q(fbAt(i))));
    }
    if (entry.cur[tf] == null) entry.curFb[tf] = fbAt(last);
  }
  tickers[sym] = entry;
}

const data = JSON.stringify({ fetchedAt: raw.fetchedAt, loggedIn: raw.loggedIn, days: sampleDays, tickers });
const marker = '/*__DATA__*/null';
if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, template.replace(marker, () => data));
console.log(`wrote ${out} (${Math.round(data.length / 1024)} KB of data, ${sampleDays.length} samples)`);
