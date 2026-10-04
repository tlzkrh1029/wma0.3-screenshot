// Build the timeframe-comparison mockup: for every ticker and timeframe,
// compute the close / WMA(200) multiple as it stood on each day, using the
// in-progress bar (what a TradingView chart showed that day), then embed the
// result in dashboard/tf-compare.html.
//
// Usage: node scripts/build-tf-compare.mjs [out]   (default dist/tf-compare.html)
//        DATA_JSON=path also writes the computed data as JSON.
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
// Signal levels use the same 2-decimal value the page prints.
const hundredths = (m) => Math.floor((Math.round(m * 1000) + 5) / 10);
const underLevel = (m) => { const c = hundredths(m); return c <= 30 ? 2 : c <= 40 ? 1 : 0; };
const overLevel = (m) => { const c = hundredths(m); return c >= 240 ? 2 : c >= 220 ? 1 : 0; };
// Sample k covers the days after sample k-1 up to and including sample k.
const sampleOfDay = (d) => Math.max(0, Math.ceil((d - sampleDays[0]) / SAMPLE_EVERY));
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
  // Daily signal state across ALL timeframes: strongest level of the day and which timeframes hit it.
  const nDays = daily.t.length;
  const sig = { u: new Array(nDays).fill(0), o: new Array(nDays).fill(0), uM: new Array(nDays).fill(0), oM: new Array(nDays).fill(0),
    uf: new Array(nDays).fill(0), of: new Array(nDays).fill(0), ufM: new Array(nDays).fill(0), ofM: new Array(nDays).fill(0) };
  const bump = (lv, mask, i, level, bit) => {
    if (!level) return;
    if (level > lv[i]) { lv[i] = level; mask[i] = bit; } else if (level === lv[i]) mask[i] |= bit;
  };
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
    const bit = 1 << TFS.indexOf(tf);
    for (let i = 0; i < nDays; i++) {
      const m = mAt(i);
      if (m != null) {
        bump(sig.u, sig.uM, i, underLevel(m), bit); bump(sig.o, sig.oM, i, overLevel(m), bit);
        bump(sig.uf, sig.ufM, i, underLevel(m), bit); bump(sig.of, sig.ofM, i, overLevel(m), bit);
      } else {
        const f = fbAt(i);
        if (f != null) { bump(sig.uf, sig.ufM, i, underLevel(f), bit); bump(sig.of, sig.ofM, i, overLevel(f), bit); }
      }
    }
    const last = daily.t.length - 1;
    entry.cur[tf] = mAt(last);
    // fallback history wherever the real WMA 200 is missing (early history, short timeframes)
    if (entry.m[tf].some((v, j) => v == null && sampleRows[j] != null && sampleRows[j] >= 0)) {
      entry.fb[tf] = sampleRows.map((i, j) => (entry.m[tf][j] != null || i == null || i < 0 ? null : q(fbAt(i))));
    }
    if (entry.cur[tf] == null) entry.curFb[tf] = fbAt(last);
  }
  // Aggregate to samples: keep the strongest level inside each week so short dips are not lost.
  const agg = (lv, mask) => {
    const L = new Array(sampleDays.length).fill(0), M = new Array(sampleDays.length).fill(0);
    for (let i = 0; i < nDays; i++) {
      const k = sampleOfDay(dayOf(daily.t[i]));
      if (k >= sampleDays.length || !lv[i]) continue;
      if (lv[i] > L[k]) { L[k] = lv[i]; M[k] = mask[i]; } else if (lv[i] === L[k]) M[k] |= mask[i];
    }
    return { L, M };
  };
  const su = agg(sig.u, sig.uM), so = agg(sig.o, sig.oM), suf = agg(sig.uf, sig.ufM), sof = agg(sig.of, sig.ofM);
  entry.sig = { u: su.L, uM: su.M, o: so.L, oM: so.M, uf: suf.L, ufM: suf.M, of: sof.L, ofM: sof.M };
  // Most recent day each signal level was seen (real WMA 200 values only), with the timeframes that hit it.
  const lastOf = (lv, mask, level) => {
    for (let i = nDays - 1; i >= 0; i--) if (lv[i] >= level) return { day: dayOf(daily.t[i]), mask: lv[i] === level ? mask[i] : 0, level: lv[i] };
    return null;
  };
  const count = (lv, level) => { let n = 0; for (let i = 0; i < nDays; i++) if (lv[i] >= level) n++; return n; };
  entry.last = { u2: lastOf(sig.u, sig.uM, 2), u1: lastOf(sig.u, sig.uM, 1), o2: lastOf(sig.o, sig.oM, 2), o1: lastOf(sig.o, sig.oM, 1) };
  entry.days = { u2: count(sig.u, 2), u1: count(sig.u, 1), o2: count(sig.o, 2), o1: count(sig.o, 1), total: nDays };
  tickers[sym] = entry;
}

// Data-quality check for market-cap tickers: CRYPTOCAP:X / CRYPTO:XUSD gives an implied
// circulating supply, which should move slowly. Months where it swings more than 3% are
// flagged (and merged across one-month gaps); CRYPTOCAP:X.D inherits X's ranges.
const SUSPECT_SWING = 0.03;
function suspectRanges(capSym, pxSym) {
  const cap = raw.series[capSym]?.['1D'], px = raw.series[pxSym]?.['1D'];
  if (!cap || !px) return [];
  const price = new Map(px.t.map((t, i) => [dayOf(t), px.c[i]]));
  const months = new Map(); // 'YYYY-MM' -> [min, max, firstDay, lastDay]
  cap.t.forEach((t, i) => {
    const p = price.get(dayOf(t)); if (!p) return;
    const supply = cap.c[i] / p, key = new Date(t * 1000).toISOString().slice(0, 7);
    const m = months.get(key) || [Infinity, -Infinity, dayOf(t), dayOf(t)];
    months.set(key, [Math.min(m[0], supply), Math.max(m[1], supply), Math.min(m[2], dayOf(t)), Math.max(m[3], dayOf(t))]);
  });
  const ranges = [];
  for (const [, [lo, hi, d0, d1]] of [...months.entries()].sort()) {
    if ((hi - lo) / hi <= SUSPECT_SWING) continue;
    const prev = ranges[ranges.length - 1];
    if (prev && d0 - prev[1] <= 62) prev[1] = d1; else ranges.push([d0, d1]);
  }
  return ranges;
}
for (const sym of Object.keys(tickers)) {
  const m = /^CRYPTOCAP:([A-Z0-9]+)(\.D)?$/.exec(sym);
  tickers[sym].suspect = m ? suspectRanges(`CRYPTOCAP:${m[1]}`, `CRYPTO:${m[1]}USD`) : [];
}

const data = JSON.stringify({ fetchedAt: raw.fetchedAt, loggedIn: raw.loggedIn, days: sampleDays, tfs: TFS, tickers });
const marker = '/*__DATA__*/null';
if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, template.replace(marker, () => data));
// Optionally keep the computed data for other pages (e.g. the screener mockup).
if (process.env.DATA_JSON) await writeFile(process.env.DATA_JSON, data);
console.log(`wrote ${out} (${Math.round(data.length / 1024)} KB of data, ${sampleDays.length} samples)`);
