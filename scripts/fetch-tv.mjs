// Download full close-price history for TradingView tickers over TradingView's
// chart WebSocket, so the dashboard uses the exact bars TradingView draws.
//
// Env:
//   TV_SESSIONID, TV_SESSIONID_SIGN  TradingView login cookies (optional; without
//                                    them the anonymous token is used)
//   TICKERS_FILE JSON file of coins with resolved {cap, usd} tickers (overrides TV_SYMBOLS)
//   TV_SYMBOLS   comma-separated tickers (default: the six dashboard tickers)
//   TV_TFS       comma-separated resolutions (default: the 20 dashboard timeframes)
//   OUT          output file (default data/tv-history.json)
//   OUT_DIR      instead of OUT: one file per ticker with daily closes ({id, d0, c}: c[i] is the close of
//                unix day d0 + i, null where TradingView has no bar). Only the 1D timeframe is fetched.
//   MODE         with OUT_DIR: 'recent' (default) fetches the last RECENT_BARS bars and merges them into
//                each ticker's file (a ticker without a file, or with a file older than that window, gets its
//                whole history); 'full' fetches every ticker's whole history again.
//   RECENT_BARS  bars fetched in recent mode (default 60, which also picks up late revisions)
//   MAX_FAILED   with OUT_DIR: share of tickers allowed to fail before the run fails (default 0.2). A failed
//                ticker keeps its previous file; _status.json in OUT_DIR lists the failures. With TICKERS_FILE,
//                files of tickers no longer in it are removed, unless that would remove more than a tenth of the
//                files (a truncated tickers file, say); then nothing is removed and the run fails after writing.
//                Set ALLOW_PRUNE=1 to remove them anyway.
import WebSocket from 'ws';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// TICKERS_FILE (e.g. data/tickers.json) lists coins with their resolved tickers; otherwise TV_SYMBOLS.
const SYMBOLS = process.env.TICKERS_FILE
  ? JSON.parse(await readFile(process.env.TICKERS_FILE, 'utf8')).coins.flatMap((c) => [c.cap, c.usd]).filter(Boolean)
  : (process.env.TV_SYMBOLS || 'CRYPTO:BTCUSD,CRYPTOCAP:BTC,CRYPTOCAP:BTC.D,CRYPTO:ETHUSD,CRYPTOCAP:ETH,CRYPTOCAP:ETH.D')
    .split(',').map((s) => s.trim()).filter(Boolean);
const TFS = (process.env.TV_TFS || '1D,2D,3D,4D,5D,6D,1W,8D,9D,10D,2W,3W,1M,2M,3M,4M,6M,8M,10M,12M').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = process.env.OUT || path.join('data', 'tv-history.json');
const OUT_DIR = process.env.OUT_DIR || null;
const MODE = process.env.MODE || 'recent';
const RECENT_BARS = Number(process.env.RECENT_BARS || 60);
const MAX_FAILED = Number(process.env.MAX_FAILED ?? 0.2);
const CHUNK = 5000;
const MAX_ROUNDS = 12;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function authToken() {
  const { TV_SESSIONID, TV_SESSIONID_SIGN } = process.env;
  if (!TV_SESSIONID || !TV_SESSIONID_SIGN) return { token: 'unauthorized_user_token', loggedIn: false };
  const res = await fetch('https://www.tradingview.com/', {
    headers: { cookie: `sessionid=${TV_SESSIONID}; sessionid_sign=${TV_SESSIONID_SIGN}`, 'user-agent': UA },
  });
  const html = await res.text();
  const m = html.match(/"auth_token":"([^"]+)"/);
  if (!m) throw new Error(`login cookies did not yield an auth_token (HTTP ${res.status}); they may have expired`);
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${m[1]}`);
  return { token: m[1], loggedIn: true };
}

// ---- wire format: "~m~<len>~m~<payload>", heartbeats are "~h~<n>" payloads ----
const frame = (payload) => `~m~${payload.length}~m~${payload}`;
function parseFrames(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const m = /^~m~(\d+)~m~/.exec(raw.slice(i));
    const end = m ? i + m[0].length + Number(m[1]) : -1;
    // The declared length may not match JS string length for non-ASCII text;
    // if it doesn't land on the next frame, split the rest on the delimiters.
    if (!m || (end < raw.length && !raw.startsWith('~m~', end))) {
      out.push(...raw.slice(i).split(/~m~\d+~m~/).filter(Boolean));
      break;
    }
    out.push(raw.slice(i + m[0].length, end));
    i = end;
  }
  return out;
}

class TVClient {
  constructor(ws) {
    this.ws = ws;
    this.listeners = new Set();
    this.rejecters = new Set();
    this.closed = null;
    const abort = (reason) => {
      this.closed = reason;
      for (const reject of [...this.rejecters]) reject(new Error(reason));
    };
    ws.on('close', (code) => abort(`connection closed (code ${code})`));
    ws.on('error', (err) => abort(`connection error: ${err.message}`));
    ws.on('message', (data) => {
      for (const payload of parseFrames(data.toString())) {
        if (payload.startsWith('~h~')) { ws.send(frame(payload)); continue; }
        let msg;
        try { msg = JSON.parse(payload); } catch { continue; }
        // protocol/critical errors without a chart session apply to the whole connection
        if ((msg.m === 'protocol_error' || msg.m === 'critical_error') && !String(msg.p?.[0] ?? '').startsWith('cs_')) {
          abort(`${msg.m}: ${JSON.stringify(msg.p).slice(0, 200)}`);
          continue;
        }
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  send(m, p) { this.ws.send(frame(JSON.stringify({ m, p }))); }
  // Resolve with the first message for which pick() returns a non-undefined value.
  wait(pick, timeoutMs = 45_000, label = 'message') {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error(this.closed));
      const done = () => { clearTimeout(timer); this.listeners.delete(fn); this.rejecters.delete(fail); };
      const fail = (err) => { done(); reject(err); };
      const timer = setTimeout(() => fail(new Error(`timeout waiting for ${label}`)), timeoutMs);
      const fn = (msg) => {
        let v;
        try { v = pick(msg); } catch (err) { v = err; }
        if (v === undefined) return;
        done();
        v instanceof Error ? reject(v) : resolve(v);
      };
      this.listeners.add(fn);
      this.rejecters.add(fail);
    });
  }
}

let sessionSeq = 0;
async function fetchSeries(client, symbol, tf, { count = CHUNK, more = true } = {}) {
  const cs = `cs_wma${++sessionSeq}`;
  const bars = new Map(); // time -> close
  const onData = (msg) => {
    if ((msg.m === 'timescale_update' || msg.m === 'du') && msg.p?.[0] === cs) {
      for (const b of msg.p[1]?.sds_1?.s || []) if (Number.isFinite(b.v?.[4])) bars.set(b.v[0], b.v[4]);
    }
  };
  client.listeners.add(onData);
  const failed = (msg) => {
    if (msg.p?.[0] !== cs) return undefined;
    if (['symbol_error', 'series_error', 'critical_error', 'protocol_error'].includes(msg.m)) {
      return new Error(`${msg.m}: ${JSON.stringify(msg.p.slice(1)).slice(0, 200)}`);
    }
    return undefined;
  };
  const completed = (ms) => {
    const p = client.wait((msg) => failed(msg) ?? (msg.m === 'series_completed' && msg.p[0] === cs ? true : undefined), ms, `${symbol} ${tf} data`);
    p.catch(() => {}); // awaited below; avoid an unhandled rejection if we bail out first
    return p;
  };
  try {
    // Register waits before sending so replies that arrive in one batch are not missed.
    const resolved = client.wait((msg) => failed(msg) ?? (msg.m === 'symbol_resolved' && msg.p[0] === cs ? msg.p[2] : undefined), 45_000, `${symbol} resolve`);
    resolved.catch(() => {});
    let next = completed(60_000);
    client.send('chart_create_session', [cs, '']);
    client.send('switch_timezone', [cs, 'Etc/UTC']);
    client.send('resolve_symbol', [cs, 'sds_sym_1', '=' + JSON.stringify({ symbol, adjustment: 'splits' })]);
    client.send('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', tf, count, '']);
    const meta = await resolved;
    await next;
    // Older history comes in further chunks; keep asking until a round adds nothing.
    let added = more && bars.size >= CHUNK ? Infinity : 0;
    for (let round = 1; added > 0; round++) {
      if (round > MAX_ROUNDS) throw new Error(`still receiving data after ${MAX_ROUNDS} extra chunks; history may be truncated`);
      const before = bars.size;
      next = completed(45_000);
      client.send('request_more_data', [cs, 'sds_1', CHUNK]);
      await next; // a timeout here fails the series instead of silently truncating it
      added = bars.size - before;
    }
    const sorted = [...bars.entries()].sort((a, b) => a[0] - b[0]);
    return {
      description: meta?.description ?? null,
      t: sorted.map(([t]) => t),
      c: sorted.map(([, c]) => c),
    };
  } finally {
    client.listeners.delete(onData);
    client.send('chart_delete_session', [cs]);
  }
}

const { token, loggedIn } = await authToken();
console.log(loggedIn ? 'using logged-in auth token' : 'using anonymous token');

// One chart connection, reopened if TradingView closes it during a long run.
let client = null;
async function connect() {
  if (client && !client.closed) return client;
  const ws = new WebSocket(process.env.TV_WS_URL || 'wss://data.tradingview.com/socket.io/websocket?type=chart', {
    headers: { Origin: 'https://www.tradingview.com', 'User-Agent': UA },
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  client = new TVClient(ws);
  client.send('set_auth_token', [token]);
  client.send('set_locale', ['en', 'US']);
  return client;
}
// Fetch with one retry on a fresh connection.
async function fetchWithRetry(symbol, tf, opts) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await fetchSeries(await connect(), symbol, tf, opts); } catch (err) {
      last = err;
      if (client?.closed || attempt === 0) { try { client?.ws.close(); } catch {} client = null; }
    }
  }
  throw last;
}

if (OUT_DIR) await runDaily();
else await runHistory();
try { client?.ws.close(); } catch {}

async function runHistory() {
  const out = { fetchedAt: new Date().toISOString(), loggedIn, series: {} };
  // the bars are in UTC; drop nulls the feed may contain
  let failures = 0;
  for (const symbol of SYMBOLS) {
    out.series[symbol] = {};
    for (const tf of TFS) {
      try {
        const s = await fetchWithRetry(symbol, tf);
        out.series[symbol][tf] = s;
        const first = s.t.length ? new Date(s.t[0] * 1000).toISOString().slice(0, 10) : '-';
        const last = s.t.length ? new Date(s.t.at(-1) * 1000).toISOString().slice(0, 10) : '-';
        console.log(`${symbol} ${tf}: ${s.t.length} bars, ${first} .. ${last}, last close ${s.c.at(-1)}`);
      } catch (err) {
        failures++;
        console.error(`${symbol} ${tf} failed: ${err.message}`);
      }
    }
  }
  if (failures) {
    // Keep the previously committed file intact rather than replacing it with a partial one.
    console.error(`${failures} series failed; ${OUT} was not updated`);
    process.exit(1);
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`wrote ${OUT}`);
}

// Daily closes, one file per ticker, merged with what is already there.
async function runDaily() {
  const DAY = 86400;
  const fileOf = (id) => path.join(OUT_DIR, id.replace(/[^A-Za-z0-9.]+/g, '_') + '.json');
  const toDays = (s) => s.t.map((t, i) => [Math.floor(t / DAY), s.c[i]]).filter(([, c]) => Number.isFinite(c));
  const fromPairs = (pairs) => {
    const d0 = pairs[0][0], c = new Array(pairs.at(-1)[0] - d0 + 1).fill(null);
    for (const [d, v] of pairs) c[d - d0] = v;
    return { d0, c };
  };
  await mkdir(OUT_DIR, { recursive: true });
  const failed = []; let ok = 0, full = 0;
  for (const symbol of SYMBOLS) {
    let prev = null;
    try { prev = JSON.parse(await readFile(fileOf(symbol), 'utf8')); } catch {}
    try {
      let pairs, merged;
      if (MODE === 'recent' && prev?.c?.length) {
        pairs = toDays(await fetchWithRetry(symbol, '1D', { count: RECENT_BARS, more: false }));
        const prevEnd = prev.d0 + prev.c.length - 1;
        // a window that does not reach back to the stored data means a long pause: refetch everything
        if (!pairs.length || pairs[0][0] > prevEnd + 1) pairs = null;
        else {
          const end = Math.max(prevEnd, pairs.at(-1)[0]), c = prev.c.concat(new Array(end - prevEnd).fill(null));
          for (const [d, v] of pairs) if (d >= prev.d0) c[d - prev.d0] = v;
          merged = { d0: prev.d0, c };
        }
      }
      if (!merged) {
        pairs = toDays(await fetchWithRetry(symbol, '1D'));
        if (!pairs.length) throw new Error('no bars');
        merged = fromPairs(pairs); full++;
      }
      await writeFile(fileOf(symbol), JSON.stringify({ id: symbol, ...merged }));
      ok++;
      const last = merged.d0 + merged.c.length - 1;
      console.log(`${symbol}: ${merged.c.filter((v) => v != null).length} bars to ${new Date(last * DAY * 1000).toISOString().slice(0, 10)}, last close ${merged.c.at(-1)}`);
    } catch (err) {
      failed.push({ id: symbol, error: err.message });
      console.error(`${symbol} failed (previous file kept): ${err.message}`);
    }
  }
  let removed = 0, pruneRefused = 0;
  if (process.env.TICKERS_FILE) {
    const keep = new Set(SYMBOLS.map((id) => path.basename(fileOf(id))));
    const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    const stale = files.filter((f) => !keep.has(f));
    if (stale.length > files.length / 10 && process.env.ALLOW_PRUNE !== '1') {
      pruneRefused = stale.length;
      console.error(`::error::${stale.length} of ${files.length} files in ${OUT_DIR} are not in ${process.env.TICKERS_FILE}; ` +
        'not removing them (is the tickers file complete?). Set ALLOW_PRUNE=1 to remove them.');
    } else for (const f of stale) { await rm(path.join(OUT_DIR, f)); removed++; }
  }
  const status = { fetchedAt: new Date().toISOString(), mode: MODE, loggedIn, total: SYMBOLS.length, ok, full, removed, pruneRefused, failed };
  await writeFile(path.join(OUT_DIR, '_status.json'), JSON.stringify(status, null, 1));
  console.log(`daily closes: ${ok} ok (${full} full histories), ${failed.length} failed, ${removed} old files removed`);
  if (failed.length > SYMBOLS.length * MAX_FAILED) {
    console.error(`too many failures (${failed.length} of ${SYMBOLS.length})`);
    process.exit(1);
  }
  if (pruneRefused) process.exit(1);
}
