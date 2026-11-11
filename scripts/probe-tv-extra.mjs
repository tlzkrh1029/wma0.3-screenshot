// One-off probe (not for merging): do TradingView's news, ideas and fundamentals endpoints answer anonymous requests
// from a GitHub runner, and what shape do the answers have? Records status codes, sizes, field names and item counts
// only; no article, idea or other text content is written out.
import { mkdir, writeFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/', Accept: 'application/json, text/html;q=0.9, */*;q=0.8' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYMS = ['NASDAQ:AAPL', 'AMEX:SOXL', 'HKEX:7709'];
const FIELDS = ['description', 'type', 'sector', 'industry', 'market_cap_basic', 'price_earnings_ttm', 'earnings_per_share_basic_ttm',
  'total_revenue_ttm', 'net_income_ttm', 'dividends_yield_current', 'beta_1_year', 'earnings_release_next_date', 'number_of_employees'];

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return { array: v.length, item: v.length && depth < 3 ? shape(v[0], depth + 1) : undefined };
  if (typeof v === 'object') {
    if (depth >= 3) return { object: Object.keys(v).length };
    const o = {}; for (const k of Object.keys(v).slice(0, 40)) o[k] = shape(v[k], depth + 1); return o;
  }
  return typeof v === 'string' ? `string(${v.length})` : typeof v;
}
async function probe(name, url, opts = {}) {
  const t0 = Date.now(), rec = { name, url: url.replace(/\?.*$/, '?…') };
  try {
    const res = await fetch(url, { headers: { ...H, ...(opts.headers || {}) }, method: opts.method || 'GET', body: opts.body, redirect: 'manual' });
    const text = await res.text();
    Object.assign(rec, { status: res.status, type: res.headers.get('content-type'), bytes: text.length, ms: Date.now() - t0 });
    if (res.status >= 300 && res.status < 400) rec.location = (res.headers.get('location') || '').replace(/\?.*$/, '?…');
    let json = null; try { json = JSON.parse(text); } catch {}
    if (json) { rec.shape = shape(json); rec.json = json; } else if (opts.html) rec.html = opts.html(text);
  } catch (err) { rec.error = String(err.message || err); }
  await sleep(1500);
  return rec;
}
const out = { probedAt: new Date().toISOString(), loggedIn: false, results: [] };
const add = (r) => { const { json, ...keep } = r; out.results.push(keep); console.log(`${r.name}: ${r.status ?? r.error} ${r.bytes ?? ''}`); return json; };

for (const sym of SYMS) {
  const [ex, tk] = sym.split(':'), enc = encodeURIComponent(sym), slug = `${ex}-${tk}`;
  // ---- news ----
  const h1 = add(await probe(`news v2 headlines ${sym}`, `https://news-headlines.tradingview.com/v2/headlines?client=web&lang=en&symbol=${enc}`));
  const h2 = add(await probe(`news-flow ${sym}`, `https://news-mediator.tradingview.com/news-flow/v2/news?filter=lang%3Aen&filter=symbol%3A${enc}&client=screener&streaming=false`));
  const items = (Array.isArray(h1) ? h1 : h1?.items) || h2?.items || [];
  const last = out.results[out.results.length - 1], prev = out.results[out.results.length - 2];
  const meta = (arr) => ({ count: arr.length, providers: [...new Set(arr.map((x) => x.provider?.name || x.provider || x.source).filter(Boolean))].slice(0, 8),
    newest: arr[0]?.published ? new Date(arr[0].published * 1000).toISOString() : null, oldest: arr.at(-1)?.published ? new Date(arr.at(-1).published * 1000).toISOString() : null });
  if (Array.isArray(h1) || h1?.items) prev.items = meta(Array.isArray(h1) ? h1 : h1.items);
  if (h2?.items) last.items = meta(h2.items);
  const id = items[0]?.id;
  if (id) {
    const st = add(await probe(`news story ${sym}`, `https://news-headlines.tradingview.com/v2/story?id=${encodeURIComponent(id)}&lang=en`));
    if (st) out.results[out.results.length - 1].storyFields = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, typeof v === 'string' ? `string(${v.length})` : Array.isArray(v) ? `array(${v.length})` : typeof v]));
  }
  // ---- ideas ----
  add(await probe(`ideas page ${sym}`, `https://www.tradingview.com/symbols/${slug}/ideas/`, { html: (t) => ({ ideaLinks: (t.match(/\/chart\/[A-Za-z0-9]+\/[A-Za-z0-9]+-/g) || []).length, hasInitialState: /window\.initData|__INITIAL_STATE__|"ideas"/.test(t) }) }));
  add(await probe(`ideas component-data ${sym}`, `https://www.tradingview.com/symbols/${slug}/ideas/?component-data-only=1`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }));
  // ---- fundamentals ----
  add(await probe(`scanner symbol ${sym}`, `https://scanner.tradingview.com/symbol?symbol=${enc}&fields=${FIELDS.join(',')}&no_404=true`));
  const scan = add(await probe(`scanner scan by ticker ${sym}`, `https://scanner.tradingview.com/global/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: [sym] }, columns: FIELDS }) }));
  if (scan?.data?.[0]?.d) out.results[out.results.length - 1].nonNull = FIELDS.filter((f, i) => scan.data[0].d[i] !== null && scan.data[0].d[i] !== undefined);
  add(await probe(`financials page ${sym}`, `https://www.tradingview.com/symbols/${slug}/financials-overview/`, { html: (t) => ({ title: /<title>/.test(t), mentionsRevenue: /revenue/i.test(t) }) }));
}
await mkdir('probe-out', { recursive: true });
await writeFile('probe-out/probe.json', JSON.stringify(out, null, 1));
