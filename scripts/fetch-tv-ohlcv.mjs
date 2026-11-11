// On-demand OHLCV bars from TradingView for analysis outside the screener (e.g. intraday timeframes of one
// ticker), fetched over TradingView's chart WebSocket. Always anonymous: this script never logs in and refuses to
// run when login cookies are present in the environment (see CLAUDE.md).
//
// Env:
//   TV_SYMBOLS  comma-separated tickers, at most 5 (e.g. UNISWAP:SPXWETH_52C77B.USD)
//   TV_TFS      comma-separated standard resolutions, at most 8 (e.g. 1D,240,180,120,60). Anonymous requests
//               get standard resolutions only; custom ones (6h = 360, 8h = 480, 12h = 720, 2D, ...) fail with
//               custom_resolution, so build those from smaller bars.
//   OUT         output file (default out/tv-ohlcv.json)
//
// Output: { fetchedAt, loggedIn: false, symbols, tfs, meta: { [symbol]: {...} },
// series: { [symbol]: { [tf]: { description, t, o, h, l, c, v } } }, errors: { "symbol tf": message } }.
// t is the bar's open time in unix seconds (UTC); v may be null. meta is TradingView's description of the ticker
// (type, exchange, currency, volume type, trading session and its time zone, price scale): intraday bars of a
// ticker with a trading session start at the session open, so timeframes built from smaller bars must count from
// there (crypto trades 24/7 and counts from 00:00 UTC).
// The log shows bar counts and date ranges only, not prices.
import WebSocket from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.env.TV_SESSIONID || process.env.TV_SESSIONID_SIGN) {
  console.error('::error::TradingView login cookies are set; this script only fetches anonymously. Remove them.');
  process.exit(1);
}
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const SYMBOLS = list(process.env.TV_SYMBOLS);
const TFS = list(process.env.TV_TFS || '1D');
const OUT = process.env.OUT || path.join('out', 'tv-ohlcv.json');
const MAX_SYMBOLS = 5, MAX_TFS = 8, CHUNK = 5000, MAX_ROUNDS = 12;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const bad = (msg) => { console.error(`::error::${msg}`); process.exit(1); };
if (!SYMBOLS.length) bad('TV_SYMBOLS is empty');
if (SYMBOLS.length > MAX_SYMBOLS) bad(`at most ${MAX_SYMBOLS} tickers per run`);
if (TFS.length > MAX_TFS) bad(`at most ${MAX_TFS} timeframes per run`);
for (const s of SYMBOLS) if (!/^[A-Z0-9_]+:[A-Za-z0-9_.!&-]+$/.test(s)) bad(`not a ticker: ${s}`);
for (const tf of TFS) if (!/^\d+[SDWM]?$/.test(tf)) bad(`not a resolution: ${tf}`);

// ---- wire format: "~m~<len>~m~<payload>", heartbeats are "~h~<n>" payloads ----
const frame = (payload) => `~m~${payload.length}~m~${payload}`;
function parseFrames(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const m = /^~m~(\d+)~m~/.exec(raw.slice(i));
    const end = m ? i + m[0].length + Number(m[1]) : -1;
    if (!m || (end < raw.length && !raw.startsWith('~m~', end))) {
      out.push(...raw.slice(i).split(/~m~\d+~m~/).filter(Boolean));
      break;
    }
    out.push(raw.slice(i + m[0].length, end));
    i = end;
  }
  return out;
}

async function connect() {
  const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket?type=chart', {
    headers: { Origin: 'https://www.tradingview.com', 'User-Agent': UA },
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const listeners = new Set();
  let closed = null;
  ws.on('close', (code) => { closed = `connection closed (code ${code})`; for (const fn of listeners) fn(null); });
  ws.on('message', (data) => {
    for (const payload of parseFrames(data.toString())) {
      if (payload.startsWith('~h~')) { ws.send(frame(payload)); continue; }
      let msg; try { msg = JSON.parse(payload); } catch { continue; }
      for (const fn of listeners) fn(msg);
    }
  });
  const send = (m, p) => ws.send(frame(JSON.stringify({ m, p })));
  send('set_auth_token', ['unauthorized_user_token']);
  send('set_locale', ['en', 'US']);
  return { ws, listeners, send, isClosed: () => closed };
}

const META_KEYS = ['pro_name', 'description', 'type', 'exchange', 'listed_exchange', 'currency_code', 'base_currency',
  'volume_type', 'timezone', 'session', 'session_display', 'subsessions', 'has_intraday', 'pricescale', 'minmov'];
function pickMeta(r) {
  const m = {};
  for (const k of META_KEYS) if (r[k] !== undefined) m[k] = r[k];
  return m;
}

let seq = 0;
function fetchSeries(client, symbol, tf) {
  return new Promise((resolve, reject) => {
    const cs = `cs_ohlcv${++seq}`, bars = new Map();
    let rounds = 0, before = 0;
    const done = (err) => {
      clearTimeout(timer); client.listeners.delete(onMsg);
      try { client.send('chart_delete_session', [cs]); } catch {}
      if (err) reject(err); else resolve(bars);
    };
    const timer = setTimeout(() => done(new Error('timeout')), 120_000);
    const onMsg = (msg) => {
      if (msg === null) return done(new Error(client.isClosed()));
      if ((msg.m === 'critical_error' || msg.m === 'protocol_error') && !String(msg.p?.[0] ?? '').startsWith('cs_')) return done(new Error(msg.m));
      if (msg.p?.[0] !== cs) return;
      if (['symbol_error', 'series_error', 'critical_error', 'protocol_error'].includes(msg.m)) {
        return done(new Error(`${msg.m}: ${JSON.stringify(msg.p.slice(1)).slice(0, 160)}`));
      }
      if (msg.m === 'timescale_update' || msg.m === 'du') {
        for (const b of msg.p[1]?.sds_1?.s || []) if (Number.isFinite(b.v?.[4])) bars.set(b.v[0], b.v.slice(0, 6));
      }
      if (msg.m === 'symbol_resolved') { const r = msg.p[2] || {}; bars.description = r.description ?? null; bars.meta = pickMeta(r); }
      if (msg.m === 'series_completed') {
        const added = bars.size - before; before = bars.size;
        // older history comes in further chunks; keep asking until a round adds nothing
        if ((rounds === 0 ? bars.size >= CHUNK : added > 0) && rounds < MAX_ROUNDS) { rounds++; client.send('request_more_data', [cs, 'sds_1', CHUNK]); }
        else done();
      }
    };
    client.listeners.add(onMsg);
    client.send('chart_create_session', [cs, '']);
    client.send('switch_timezone', [cs, 'Etc/UTC']);
    client.send('resolve_symbol', [cs, 'sds_sym_1', '=' + JSON.stringify({ symbol, adjustment: 'splits' })]);
    client.send('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', tf, CHUNK, '']);
  });
}

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const out = { fetchedAt: new Date().toISOString(), loggedIn: false, symbols: SYMBOLS, tfs: TFS, meta: {}, series: {}, errors: {} };
let ok = 0, client = null;
for (const symbol of SYMBOLS) {
  out.series[symbol] = {};
  for (const tf of TFS) {
    let bars = null;
    for (let attempt = 0; attempt < 2 && !bars; attempt++) {
      try {
        if (!client || client.isClosed()) client = await connect();
        bars = await fetchSeries(client, symbol, tf);
      } catch (err) {
        if (attempt === 1 || /series_error|symbol_error/.test(err.message)) { out.errors[`${symbol} ${tf}`] = err.message; break; }
        try { client?.ws.close(); } catch {}
        client = null;
      }
    }
    if (!bars) { console.log(`::warning::${symbol} ${tf} failed: ${out.errors[`${symbol} ${tf}`]}`); continue; }
    const rows = [...bars.values()].sort((a, b) => a[0] - b[0]);
    const col = (i) => rows.map((r) => (Number.isFinite(r[i]) ? r[i] : null));
    out.series[symbol][tf] = { description: bars.description ?? null, t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5) };
    if (bars.meta && !out.meta[symbol]) out.meta[symbol] = bars.meta;
    ok++;
    console.log(`${symbol} ${tf}: ${rows.length} bars, ${rows.length ? iso(rows[0][0]) + ' .. ' + iso(rows.at(-1)[0]) : '-'}`);
  }
}
try { client?.ws.close(); } catch {}
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`wrote ${OUT}: ${ok} series, ${Object.keys(out.errors).length} failed`);
if (!ok) process.exit(1);
