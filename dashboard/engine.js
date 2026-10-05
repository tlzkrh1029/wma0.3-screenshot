// WMA 200 multiple engine, shared by the screener page (inlined by scripts/build-site.mjs) and the Node build,
// which precomputes every coin's summary with it. No DOM access here.
//
// createEngine({ tfs, days, start, n }):
//   tfs    timeframes, e.g. ['1D', ..., '12M']
//   days   weekly sample days (unix day numbers, ascending, the last one is the latest day)
//   start  first unix day of the shared day axis; n = number of days on it
export function createEngine({ tfs, days, start, n }) {
  const TFS = tfs, DAY0 = start, ND = n, S = days.length, DAYMS = 86400000;

  function hundredths(m) { return Math.floor((Math.round(m * 1000) + 5) / 10); }
  function zone(m) { const c = hundredths(m); if (c <= 30) return 'u2'; if (c <= 40) return 'u1'; if (c >= 240) return 'o2'; if (c >= 220) return 'o1'; return 'n'; }
  const underLevel = (m) => { const z = zone(m); return z === 'u2' ? 2 : z === 'u1' ? 1 : 0; };
  const overLevel = (m) => { const z = zone(m); return z === 'o2' ? 2 : z === 'o1' ? 1 : 0; };

  // ---------- calendar: TradingView-style bar buckets on the shared day axis ----------
  // nD bars restart every January 1st, 2W/3W at the year's first Monday, nM every January; 1W is Monday-based.
  function keyFn(tf) {
    const m = /^(\d+)([DWM])$/.exec(tf), k = Number(m[1]), u = m[2];
    return (d) => {
      if (u === 'D' && k === 1) return d;
      const t = new Date(d * DAYMS), y = t.getUTCFullYear(), jan1 = Date.UTC(y, 0, 1) / DAYMS;
      if (u === 'D') return y * 1000 + Math.floor((d - jan1) / k);
      if (u === 'W') {
        if (k === 1) return Math.floor((d + 3) / 7);
        // multi-week bars restart at the first Monday on or after January 1st; the days before it
        // finish the previous year's cycle (TradingView behaviour, checked against its 2W/3W bars)
        const firstMon = (yy) => { const j = Date.UTC(yy, 0, 1) / DAYMS; return j + ((1 - ((j + 4) % 7) + 7) % 7); };
        const cy = d >= firstMon(y) ? y : y - 1;
        return cy * 100 + Math.floor(Math.floor((d - firstMon(cy)) / 7) / k);
      }
      return y * 100 + Math.floor(t.getUTCMonth() / k);
    };
  }
  const BAR = {};
  for (const tf of TFS) {
    const f = keyFn(tf), a = new Int32Array(ND); let b = -1, prev = null;
    for (let i = 0; i < ND; i++) { const k = f(DAY0 + i); if (k !== prev) { b++; prev = k; } a[i] = b; }
    BAR[tf] = a;
  }
  const SIDX = days.map((d) => d - DAY0); // sample day -> day index
  // sample index covering each day (sample k covers the days after sample k-1 up to sample k)
  const SOF = new Int32Array(ND).fill(-1);
  { let k = 0; for (let i = 0; i < ND; i++) { while (k < S && SIDX[k] < i) k++; SOF[i] = k < S ? k : -1; } }

  // One timeframe of one daily series starting at day index s0. c is forward-filled; ok marks the days that
  // have a TradingView bar (null = every day). A bucket only becomes a bar once a day inside it has a bar,
  // as on TradingView; days without a bar stay on the latest bar. Returns the bar of each day (bi), closes
  // per bar and, per bar b >= 199, V[b] = sum_{j=1..199} (200-j) * C[b-j], so the in-progress multiple on
  // day i is c / ((200c + V[b]) / 20100).
  function tfSeries(c, s0, tf, ok) {
    const idx = BAR[tf], base = idx[s0];
    let bi = null, nb;
    if (ok) { // bar numbers that skip buckets without a bar
      bi = new Int32Array(ND).fill(-1); nb = 0; let prev = -1;
      for (let i = s0; i < ND; i++) { if (ok[i] && idx[i] !== prev) { nb++; prev = idx[i]; } bi[i] = nb - 1; }
    } else nb = idx[ND - 1] - base + 1;
    const Cb = new Float64Array(nb);
    if (bi) { for (let i = s0; i < ND; i++) if (bi[i] >= 0) Cb[bi[i]] = c[i]; }
    else for (let i = s0; i < ND; i++) Cb[idx[i] - base] = c[i];
    const V = new Float64Array(nb).fill(NaN);
    if (nb >= 200) {
      let A = 0, B = 0;
      for (let i = 0; i < 199; i++) { A += (i + 1) * Cb[i]; B += Cb[i]; }
      V[199] = A;
      for (let e = 199; e < nb - 1; e++) { A = A + 199 * Cb[e] - B; B = B + Cb[e] - Cb[e - 199]; V[e + 1] = A; }
    }
    return { bi, idx, base, Cb, V };
  }
  const barOf = (ts, i) => (ts.bi ? ts.bi[i] : ts.idx[i] - ts.base);
  function mAt(ts, c, i) {
    const b = barOf(ts, i);
    if (b < 199 || Number.isNaN(ts.V[b])) return null;
    const x = c[i]; return x / ((200 * x + ts.V[b]) / 20100);
  }
  function fbAt(ts, c, i) {
    const b = barOf(ts, i), w = Math.min(200, b + 1);
    if (b < 0 || w < 12) return null;
    let s = 0; for (let j = 1; j < w; j++) s += (w - j) * ts.Cb[b - j];
    const x = c[i]; return x / ((w * x + s) / (w * (w + 1) / 2));
  }

  // ---------- market-cap data check ----------
  // Implied supply (cap / price) moves slowly or in one-way steps (issuance, unlocks, burns); a stablecoin's
  // supply also shrinks and grows. Flagged:
  // (a) spikes: a day more than 3% off the median of the bars around it (the same number of bars on each
  //     side, at least 2, within a week), padded by a week;
  // (b) a calendar month whose implied supply swings more than 8% and mostly comes back;
  // (c) level errors that come and go over months (not for pegged coins): the level (median of 5-7 bars on
  //     each side, so a short glitch or the first and last days never set it) is more than 6% above the low
  //     level (10th percentile) of both the year before and the year after, or more than 6% below the high
  //     level (90th percentile) of both, and the level of one side comes back on the other side within the
  //     year, so a one-way step followed by a drift the other way is not flagged.
  // Ranges closer than 31 days are merged. Only days where both tickers have a bar count.
  const median = (a) => { const w = Float64Array.from(a).sort(); return w[w.length >> 1]; };
  // 10th and 90th percentile of v over the 365 days before (dir 1) or after (dir -1) each index, excluding the
  // index itself and NaN entries
  function yearLevels(day, v, dir) {
    const len = day.length, lo = new Float64Array(len).fill(NaN), hi = new Float64Array(len).fill(NaN), w = [];
    const pos = (x) => { let a = 0, b = w.length; while (a < b) { const m = (a + b) >> 1; if (w[m] < x) a = m + 1; else b = m; } return a; };
    const at = (q) => (dir > 0 ? q : len - 1 - q);
    for (let q = 0, t = 0; q < len; q++) {
      const i = at(q);
      for (; t < q && Math.abs(day[at(t)] - day[i]) > 365; t++) { const x = v[at(t)]; if (!Number.isNaN(x)) w.splice(pos(x), 1); }
      if (w.length) { lo[i] = w[Math.floor(0.1 * (w.length - 1))]; hi[i] = w[Math.ceil(0.9 * (w.length - 1))]; }
      if (!Number.isNaN(v[i])) w.splice(pos(v[i]), 0, v[i]);
    }
    return { lo, hi };
  }
  function suspectFrom(cap, price, L, okCap, okPrice) {
    const day = [], sup = [], px = [];
    for (let i = L; i < ND; i++) {
      if (!(price[i] > 0) || !(cap[i] > 0) || (okCap && !okCap[i]) || (okPrice && !okPrice[i])) continue;
      day.push(DAY0 + i); sup.push(cap[i] / price[i]); px.push(price[i]);
    }
    const len = day.length, iv = [];
    for (let i = 0, a = 0, b = 0; i < len; i++) {
      while (day[a] < day[i] - 7) a++;
      while (b < len && day[b] <= day[i] + 7) b++;
      const k = Math.min(i - a, b - 1 - i);
      if (k >= 2 && Math.abs(sup[i] / median(sup.slice(i - k, i + k + 1)) - 1) > 0.03) iv.push([day[i] - 7, day[i] + 7]);
    }
    const months = new Map();
    for (let i = 0; i < len; i++) {
      const key = new Date(day[i] * DAYMS).toISOString().slice(0, 7), s = sup[i];
      const m = months.get(key); if (!m) { months.set(key, { lo: s, hi: s, first: s, last: s, d0: day[i], d1: day[i] }); continue; }
      m.lo = Math.min(m.lo, s); m.hi = Math.max(m.hi, s); m.last = s; m.d1 = day[i];
    }
    for (const m of months.values()) { const sw = (m.hi - m.lo) / m.hi; if (sw > 0.08 && Math.abs(m.last - m.first) / m.hi < 0.6 * sw) iv.push([m.d0, m.d1]); }
    // pegged coins (stablecoins) move well under 0.5% a day; every other pilot coin moves 1.5% or more
    const moves = []; for (let i = 1; i < len; i++) if (day[i] - day[i - 1] === 1) moves.push(Math.abs(Math.log(px[i] / px[i - 1])));
    if (moves.length >= 30 && median(moves) >= 0.005) {
      const lv = new Float64Array(len).fill(NaN);
      for (let i = 0, a = 0, b = 0; i < len; i++) {
        while (day[a] < day[i] - 10) a++;
        while (b < len && day[b] <= day[i] + 10) b++;
        const k = Math.min(7, i - a, b - 1 - i);
        if (k >= 5) lv[i] = median(sup.slice(i - k, i + k + 1));
      }
      const B = yearLevels(day, lv, 1), A = yearLevels(day, lv, -1);
      // the reference level of one side shows up again on the other side within the year (within half the
      // excursion, at least 3%)
      const back = (i, refB, refA) => {
        const tol = Math.max(0.03, 0.5 * Math.min(Math.abs(Math.log(lv[i] / refB)), Math.abs(Math.log(lv[i] / refA))));
        for (let j = i + 1; j < len && day[j] - day[i] <= 365; j++) if (Math.abs(Math.log(lv[j] / refB)) <= tol) return true;
        for (let j = i - 1; j >= 0 && day[i] - day[j] <= 365; j--) if (Math.abs(Math.log(lv[j] / refA)) <= tol) return true;
        return false;
      };
      for (let i = 0; i < len; i++) {
        const up = lv[i] > 1.06 * B.lo[i] && lv[i] > 1.06 * A.lo[i] && back(i, B.lo[i], A.lo[i]);
        const down = !up && lv[i] < 0.94 * B.hi[i] && lv[i] < 0.94 * A.hi[i] && back(i, B.hi[i], A.hi[i]);
        if (up || down) iv.push([day[i], day[i]]);
      }
    }
    iv.sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of iv) { const r = out[out.length - 1]; if (r && a - r[1] <= 31) r[1] = Math.max(r[1], b); else out.push([a, b]); }
    return out;
  }
  // 1 on the days inside the ranges (day indices), for carrying the flag into WMA windows
  function badDays(ranges) {
    if (!ranges.length) return null;
    const a = new Float64Array(ND);
    for (const [d0, d1] of ranges) for (let i = Math.max(0, d0 - DAY0); i <= Math.min(ND - 1, d1 - DAY0); i++) a[i] = 1;
    return a;
  }

  // One coin's daily closes on the axis. daily maps ticker ids to {s, c}: c[j] is the close of axis day s + j,
  // null where TradingView has no bar (forward-filled here, and left out of the bar count). cap / usd are the
  // coin's ticker ids (either may be null).
  function seriesFrom(daily, cap, usd) {
    const mk = (id) => {
      const d = id && daily[id], a = new Float64Array(ND).fill(NaN), ok = new Uint8Array(ND);
      if (!d) return { a, ok, s: ND };
      let last = NaN;
      for (let i = d.s; i < ND; i++) { const x = d.c[i - d.s]; if (x != null) { last = x; ok[i] = 1; } a[i] = last; }
      return { a, ok, s: d.s };
    };
    const c = mk(cap), p = mk(usd);
    const suspect = c.s < ND && p.s < ND ? suspectFrom(c.a, p.a, Math.max(c.s, p.s), c.ok, p.ok) : [];
    return { cap: c.a, price: p.a, okCap: c.ok, okUsd: p.ok, Lcap: c.s, Lusd: p.s, suspect, bad: badDays(suspect) };
  }

  // Analyse one ticker. daily=true checks every day (signals keep the strongest level of each week);
  // otherwise only the weekly sample days. detail=true also returns per-sample multiples, fallback
  // values, timeframe masks and the exact last 0.3 / 2.4 days. ok marks the days with a bar: only those
  // count as signal days, and a sample day shows a value only if a bar is at most 3 days old (as the
  // timeframe board does), so longer gaps stay empty instead of drawing a flat line.
  // bad (1 on flagged market-cap days) marks a signal as suspect when that day is flagged or flagged days
  // carry at least 10% of the weight in its WMA 200.
  const SUSPECT_SHARE = 0.1;
  function analyze(series, L, { daily, detail, ok = null, bad = null }) {
    const cur = new Float32Array(TFS.length).fill(NaN), u = new Uint8Array(S), o = new Uint8Array(S), has = new Uint8Array(S);
    const curSusp = new Uint8Array(TFS.length), sus = new Uint8Array(S); // suspect current value / a suspect signal that week
    // the same for reference (fewer than 200 bars) signals, detail only
    const susf = detail ? new Uint8Array(S) : null, susfM = detail ? new Uint32Array(S) : null;
    // per day: bit 1 = some timeframe hit 0.3 (2.4), bit 2 = one of those hits is not suspect (daily mode)
    const d2u = daily ? new Uint8Array(ND) : null, d2o = daily ? new Uint8Array(ND) : null;
    const e = detail ? { m: {}, fb: {}, cur: {}, curFb: {}, tfsig: {}, sig: { u: new Array(S).fill(0), uM: new Array(S).fill(0), o: new Array(S).fill(0), oM: new Array(S).fill(0), uf: new Array(S).fill(0), ufM: new Array(S).fill(0), of: new Array(S).fill(0), ofM: new Array(S).fill(0) } } : null;
    const dayU = detail ? new Uint8Array(ND) : null, dayO = detail ? new Uint8Array(ND) : null, dayUM = detail ? new Uint32Array(ND) : null, dayOM = detail ? new Uint32Array(ND) : null;
    const bump = (lv, mask, k, level, bit) => { if (!level) return; if (level > lv[k]) { lv[k] = level; mask[k] = bit; } else if (level === lv[k]) mask[k] |= bit; };
    if (L >= ND) return { cur, u, o, has, e, curSusp, sus, lastU2: -1, lastU2Susp: false };
    // tfSeries expects forward-filled input: a bar's flag must be the flag of the day its close comes from
    if (bad && ok) { bad = Float64Array.from(bad); for (let i = L + 1; i < ND; i++) if (!ok[i]) bad[i] = bad[i - 1]; }
    // per week: bit 1 = a suspect hit, bit 2 = a hit that is not suspect; level-2 bits per side for weekly mode
    const w2u = daily ? null : new Uint8Array(S), w2o = daily ? null : new Uint8Array(S), susM = detail ? new Uint32Array(S) : null;
    TFS.forEach((tf, j) => {
      const ts = tfSeries(series, L, tf, ok), bit = 1 << j;
      const tb = bad && tfSeries(bad, L, tf, ok);
      // this timeframe's own weekly levels (sp: bit 1 = a suspect hit, bit 2 = a hit that is not suspect)
      const ps = detail ? (e.tfsig[tf] = { u: new Uint8Array(S), o: new Uint8Array(S), uf: new Uint8Array(S), of: new Uint8Array(S), sp: new Uint8Array(S), spf: new Uint8Array(S) }) : null;
      const suspAt = (i) => { if (!tb) return false; if (bad[i]) return true; const b = barOf(tb, i); return b >= 199 && (200 * bad[i] + tb.V[b]) / 20100 >= SUSPECT_SHARE; };
      // reference value over n < 200 bars: the same 10% test with that shorter window's weights
      const suspFb = (i) => {
        if (!tb) return false; if (bad[i]) return true;
        const b = barOf(tb, i), w = Math.min(200, b + 1); let x = 0;
        for (let q = 1; q < w; q++) x += (w - q) * tb.Cb[b - q];
        return x / (w * (w + 1) / 2) >= SUSPECT_SHARE;
      };
      if (detail) e.m[tf] = new Array(S).fill(null);
      let fbArr = null, lastBar = -1;
      const visit = (i) => {
        const bar = !ok || ok[i]; if (bar) lastBar = i;
        const k = SOF[i]; if (k < 0) return;
        const v = mAt(ts, series, i), fresh = i - lastBar <= 3, sample = i === SIDX[k] && fresh;
        if (v != null) {
          if (fresh) has[k] = 1;
          if (detail && sample) e.m[tf][k] = Math.round(v * 1000);
          if (!bar) return;
          const ul = underLevel(v), ol = overLevel(v);
          if (ul > u[k]) u[k] = ul; if (ol > o[k]) o[k] = ol;
          if (ps) { if (ul > ps.u[k]) ps.u[k] = ul; if (ol > ps.o[k]) ps.o[k] = ol; if (ul > ps.uf[k]) ps.uf[k] = ul; if (ol > ps.of[k]) ps.of[k] = ol; }
          if (ul || ol) {
            const sp = suspAt(i); sus[k] |= sp ? 1 : 2; if (sp && susM) susM[k] |= bit; if (ps) ps.sp[k] |= sp ? 1 : 2;
            if (d2u && ul === 2) d2u[i] |= sp ? 1 : 3;
            if (d2o && ol === 2) d2o[i] |= sp ? 1 : 3;
            if (w2u && ul === 2) w2u[k] |= sp ? 1 : 3;
            if (w2o && ol === 2) w2o[k] |= sp ? 1 : 3;
          }
          if (detail) {
            bump(e.sig.u, e.sig.uM, k, ul, bit); bump(e.sig.o, e.sig.oM, k, ol, bit); bump(e.sig.uf, e.sig.ufM, k, ul, bit); bump(e.sig.of, e.sig.ofM, k, ol, bit);
            if (ul > dayU[i]) { dayU[i] = ul; dayUM[i] = bit; } else if (ul && ul === dayU[i]) dayUM[i] |= bit;
            if (ol > dayO[i]) { dayO[i] = ol; dayOM[i] = bit; } else if (ol && ol === dayO[i]) dayOM[i] |= bit;
          }
        } else if (detail && (sample || (daily && bar))) {
          // fallback (fewer than 200 bars): reference values and faded signals only
          const f = fbAt(ts, series, i); if (f == null) return;
          if (sample) (fbArr ||= new Array(S).fill(null))[k] = Math.round(f * 1000);
          if (bar) {
            const fu = underLevel(f), fo = overLevel(f);
            bump(e.sig.uf, e.sig.ufM, k, fu, bit); bump(e.sig.of, e.sig.ofM, k, fo, bit);
            if (fu > ps.uf[k]) ps.uf[k] = fu; if (fo > ps.of[k]) ps.of[k] = fo;
            if (fu || fo) { const sp = suspFb(i); ps.spf[k] |= sp ? 1 : 2; susf[k] |= sp ? 1 : 2; if (sp) susfM[k] |= bit; }
          }
        }
      };
      if (daily) for (let i = L; i < ND; i++) visit(i);
      else for (let k = 0; k < S; k++) if (SIDX[k] >= L) visit(SIDX[k]);
      // current values only if the ticker still has a recent bar
      let live = !ok; for (let i = ND - 1; i >= Math.max(L, ND - 4) && !live; i--) live = !!ok[i];
      const m = live ? mAt(ts, series, ND - 1) : null; if (m != null) { cur[j] = m; curSusp[j] = suspAt(ND - 1) ? 1 : 0; }
      if (detail) { if (fbArr) e.fb[tf] = fbArr; e.cur[tf] = m; if (m == null && live) e.curFb[tf] = fbAt(ts, series, ND - 1); }
    });
    // exact last 0.3 / 2.4 day (daily mode); suspect when every hit that day is suspect
    const lastHit = (d2) => { if (!d2) return -1; for (let i = ND - 1; i >= L; i--) if (d2[i]) return i; return -1; };
    const lastU2 = lastHit(d2u), lastO2 = lastHit(d2o);
    const lastU2Susp = lastU2 >= 0 && !(d2u[lastU2] & 2), lastO2Susp = lastO2 >= 0 && !(d2o[lastO2] & 2);
    // a week counts as suspect only when every hit that week is suspect; susM lists the suspect timeframes
    if (detail) {
      e.sig.sus = Array.from(sus, (x) => (x === 1 ? 1 : 0)); e.sig.susM = Array.from(susM);
      // reference signals count as suspect in weeks without full 200-bar hits, when every one of them is suspect
      e.sig.susf = Array.from(susf, (x, k) => (!sus[k] && x === 1 ? 1 : 0)); e.sig.susfM = Array.from(susfM); e.curSusp = Object.fromEntries(TFS.map((tf, j) => [tf, !!curSusp[j]])); }
    if (detail) {
      const lastDay = (lv, mask, level) => { for (let i = ND - 1; i >= L; i--) if (lv[i] >= level) return { day: DAY0 + i, mask: lv[i] === level ? mask[i] : 0 }; return null; };
      const count = (lv, level) => { let c = 0; for (let i = L; i < ND; i++) if (lv[i] >= level) c++; return c; };
      if (daily) {
        e.last = { u2: lastDay(dayU, dayUM, 2), o2: lastDay(dayO, dayOM, 2) }; e.days = { u2: count(dayU, 2), o2: count(dayO, 2) }; e.unit = '일';
        if (e.last.u2) e.last.u2.susp = lastU2Susp; if (e.last.o2) e.last.o2.susp = lastO2Susp;
      } else {
        const lastOf = (lv, mask, level, w2) => { for (let k = S - 1; k >= 0; k--) if (lv[k] >= level) return { day: days[k], mask: lv[k] === level ? mask[k] : 0, susp: w2[k] === 1 }; return null; };
        e.last = { u2: lastOf(e.sig.u, e.sig.uM, 2, w2u), o2: lastOf(e.sig.o, e.sig.oM, 2, w2o) };
        e.days = { u2: e.sig.u.filter((x) => x >= 2).length, o2: e.sig.o.filter((x) => x >= 2).length }; e.unit = '주';
      }
    }
    return { cur, u, o, has, e, curSusp, sus, lastU2, lastU2Susp };
  }

  // Screener summary of one ticker (kind 'cap' or 'usd') of a coin, from seriesFrom()'s result.
  function summarizeTicker(sr, kind) {
    const series = kind === 'cap' ? sr.cap : sr.price, L = kind === 'cap' ? sr.Lcap : sr.Lusd, ok = kind === 'cap' ? sr.okCap : sr.okUsd;
    const a = analyze(series, L, { daily: true, detail: false, ok, bad: kind === 'cap' ? sr.bad : null });
    return { cur: a.cur, curSusp: a.curSusp, u: a.u, o: a.o, has: a.has, lastU2Day: a.lastU2 >= 0 ? DAY0 + a.lastU2 : null, lastU2Susp: a.lastU2Susp,
      suspect: kind === 'cap' ? sr.suspect : [], listed: L < ND ? DAY0 + L : null };
  }
  // Detail of one ticker for the coin page (per-sample multiples, bands, last signals).
  function detailTicker(sr, kind) {
    const series = kind === 'cap' ? sr.cap : sr.price, L = kind === 'cap' ? sr.Lcap : sr.Lusd, ok = kind === 'cap' ? sr.okCap : sr.okUsd;
    const { e } = analyze(series, L, { daily: true, detail: true, ok, bad: kind === 'cap' ? sr.bad : null });
    // a ticker without bars returns before the analysis fills these in
    const zeros = () => new Array(S).fill(0);
    return { last: { u2: null, o2: null }, days: { u2: 0, o2: 0 }, unit: '일', curSusp: {}, ...e,
      sig: { sus: zeros(), susM: zeros(), susf: zeros(), susfM: zeros(), ...e.sig }, suspect: kind === 'cap' ? sr.suspect : [] };
  }

  return { TFS, DAY0, ND, S, SIDX, SOF, BAR, hundredths, zone, underLevel, overLevel, keyFn, tfSeries, barOf, mAt, fbAt,
    suspectFrom, badDays, seriesFrom, analyze, summarizeTicker, detailTicker };
}
