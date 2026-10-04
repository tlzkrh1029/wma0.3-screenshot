// Build the WMA dashboard page: embed data/tv-history.json into dashboard/template.html.
//
// Usage: node scripts/build-board.mjs [out]   (default dist/wma-board.html)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2] || path.join('dist', 'wma-board.html');
const raw = JSON.parse(await readFile(path.join('data', 'tv-history.json'), 'utf8'));
const template = await readFile(path.join('dashboard', 'template.html'), 'utf8');

// Trim precision to keep the page small: market caps to whole dollars,
// dominance to 4 decimals, prices to 2 decimals (6 significant digits below $1).
const round = (sym, v) => {
  if (sym.endsWith('.D')) return Math.round(v * 1e4) / 1e4;
  if (sym.startsWith('CRYPTOCAP:')) return Math.round(v);
  return v >= 1 ? Math.round(v * 100) / 100 : Number(v.toPrecision(6));
};
const series = {};
for (const [sym, tfs] of Object.entries(raw.series)) {
  series[sym] = {};
  for (const [tf, s] of Object.entries(tfs)) {
    const keep = s.c.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
    series[sym][tf] = { t: keep.map((i) => s.t[i]), c: keep.map((i) => round(sym, s.c[i])) };
  }
}
const data = JSON.stringify({ fetchedAt: raw.fetchedAt, loggedIn: raw.loggedIn, series });
const marker = '/*__DATA__*/null';
if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, template.replace(marker, () => data));
console.log(`wrote ${out} (${Math.round(data.length / 1024)} KB of data)`);
