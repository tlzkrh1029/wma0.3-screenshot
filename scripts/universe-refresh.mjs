// Summarize a weekly universe refresh (run by .github/workflows/refresh-universe.yml after build-universe,
// resolve-tickers --new-only and check-tickers --json).
//
// Compares the new data/universe.json and data/tickers.json with the previous ones and decides:
// - structural=no: the same coins with the same CoinGecko matches (market caps and ranks moved); commit directly.
// - structural=yes: coins were added, removed or matched to another CoinGecko coin, or a symbol needs a pin;
//   open a pull request for review. Re-matched coins get an entry in data/mapping-log.json.
// Writes the review text (Korean, for the owner) to --body, and structural/title to $GITHUB_OUTPUT when set.
//
// Usage: node scripts/universe-refresh.mjs --old-universe old.json --old-tickers old.json --universe-report r.json
//          --resolve-report r.json --check check.json --body body.md
import { readFile, writeFile, appendFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const readJson = async (p, def = null) => { if (!p) return def; try { return JSON.parse(await readFile(p, 'utf8')); } catch { return def; } };
const oldU = await readJson(opt('--old-universe'), { coins: [], excluded: [], unmatched: [] });
const oldT = await readJson(opt('--old-tickers'), { coins: [] });
const newU = JSON.parse(await readFile('data/universe.json', 'utf8'));
const newT = JSON.parse(await readFile('data/tickers.json', 'utf8'));
const uRep = await readJson(opt('--universe-report'), { differs: [], duplicates: [] });
const rRep = await readJson(opt('--resolve-report'), { resolved: [], manualChanged: [] });
const check = await readJson(opt('--check'), []);
const today = new Date().toISOString().slice(0, 10);

const oldBy = new Map(oldU.coins.map((c) => [c.sym, c])), newBy = new Map(newU.coins.map((c) => [c.sym, c]));
const tickBy = new Map(newT.coins.map((c) => [c.sym, c])), checkBy = new Map(check.map((c) => [c.sym, c]));
const added = newU.coins.filter((c) => !oldBy.has(c.sym));
const removed = oldU.coins.filter((c) => !newBy.has(c.sym));
const rematched = newU.coins.filter((c) => oldBy.has(c.sym) && oldBy.get(c.sym).id !== c.id);
const pinDiffers = uRep.differs.filter((d) => d.pin);
const structural = added.length + removed.length + rematched.length + uRep.duplicates.length + rRep.manualChanged.length > 0;

const EX = { U: '업비트', B: '빗썸', N: '바이낸스' };
const exName = (x) => [...(x || '')].map((k) => EX[k]).filter(Boolean).join('·') || '-';
const usd = (v) => (v == null ? '-' : v >= 1 ? `$${v.toPrecision(4)}` : `$${v.toPrecision(3)}`);
const cap = (v) => (v == null ? '-' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${(v / 1e6).toFixed(1)}M`);
const cell = (s) => String(s ?? '-').replace(/\|/g, '\\|');
const priceNote = (sym) => {
  const c = checkBy.get(sym); if (!c) return '거래소 가격과 일치';
  const p = c.price;
  return c.priceOff ? `**거래소 ${usd(p.exchange)} / TradingView ${usd(p.tradingview)} / CoinGecko ${usd(p.coingecko)}**` : c.notes.join('; ');
};
const whyRemoved = (c) => {
  const ex = newU.excluded.find((e) => e.sym === c.sym);
  if (ex) return ex.kind === 'stablecoin' ? '스테이블코인으로 분류됨' : '증권형 토큰으로 분류됨';
  if (newU.unmatched.includes(c.sym)) return 'CoinGecko 3,000위 밖이거나 매칭되는 코인이 없음';
  return '세 거래소 모두에서 상장 폐지';
};

const todo = [];
for (const c of [...added, ...rematched]) {
  const k = checkBy.get(c.sym), t = tickBy.get(c.sym) || {};
  if (k?.priceOff) todo.push(`- **${c.sym}**: TradingView 티커 ${t.usd || '-'}의 가격이 거래소와 다릅니다 (${priceNote(c.sym)}). 다른 코인의 티커일 수 있습니다.`);
  else if (!t.usd && !t.cap) todo.push(`- **${c.sym}**: TradingView 티커를 찾지 못했습니다.`);
  else if (t.confidence && t.confidence !== 'high') todo.push(`- **${c.sym}**: 티커 해석 확신도가 낮습니다 (${t.confidence}; 후보 ${(t.alternatives || []).join(', ') || '없음'}).`);
}
for (const d of uRep.duplicates) todo.push(`- **${d.dropped}**: ${d.kept}와 같은 코인(${d.name}, ${d.id})을 가리켜서 빠졌습니다. 같은 코인이면 data/exclusions.json "ids"의 ${d.kept} 항목에 "also": ["${d.dropped}"]를 넣어야 합니다.`);
for (const d of pinDiffers) todo.push(`- **${d.sym}**: 고정(pin)한 코인은 ${d.pin}인데, 거래소 티커는 ${d.exchange.id}를 가리킵니다.`);
for (const m of rRep.manualChanged) todo.push(`- **${m.sym}**: 손으로 고친 티커(${[m.usd, m.cap].filter(Boolean).join(' · ')})인데 CoinGecko 코인이 ${m.was}에서 ${m.now}로 바뀌었습니다. 티커가 여전히 맞는지 봐야 합니다.`);
const lines = [];
lines.push(`CoinGecko 기준으로 종목 목록(업비트·빗썸·바이낸스 상장 코인)을 다시 만들고, 새로 들어온 종목의 TradingView 티커를 찾아 거래소 가격과 대조했습니다. (${today})`, '');
lines.push('| 항목 | 값 |', '|---|---|',
  `| 종목 수 | ${oldU.coins.length} → ${newU.coins.length} |`, `| 새 종목 | ${added.length} |`, `| 빠진 종목 | ${removed.length} |`,
  `| CoinGecko 매칭이 바뀐 종목 | ${rematched.length} |`, `| 확인이 필요한 것 | ${todo.length} |`, '');
if (added.length) {
  lines.push('### 새 종목', '', '| 순위 | 심볼 | 이름 | 거래소 | TradingView 티커 | 해석 확신도 | 가격 대조 |', '|---|---|---|---|---|---|---|');
  for (const c of added) {
    const t = tickBy.get(c.sym) || {};
    lines.push(`| ${c.rank} | ${cell(c.sym)} | ${cell(c.name)} | ${exName(c.ex)} | ${cell([t.usd, t.cap].filter(Boolean).join(' · ') || '없음')} | ${cell(t.confidence)} | ${cell(priceNote(c.sym))} |`);
  }
  lines.push('');
}
if (removed.length) {
  lines.push('### 빠진 종목', '', '| 심볼 | 이름 | 이유 |', '|---|---|---|');
  for (const c of removed) lines.push(`| ${cell(c.sym)} | ${cell(c.name)} | ${whyRemoved(c)} |`);
  lines.push('', '빠진 종목의 일봉 파일은 병합 후 매일 수집에서 지워집니다(한 번에 10% 넘게 지우게 되면 수집이 멈추고 알립니다).', '');
}
if (rematched.length) {
  lines.push('### CoinGecko 매칭이 바뀐 종목', '', '같은 심볼이 다른 CoinGecko 코인을 가리키게 되었습니다. 매핑 기록(data/mapping-log.json)에 자동으로 추가했습니다. 매칭 방식: exchange = 거래소 티커, symbol = 같은 심볼 중 시가총액 최대, pin = 고정.', '',
    '| 심볼 | 이전 | 현재 | 매칭 방식 | 새 TradingView 티커 | 가격 대조 |', '|---|---|---|---|---|---|');
  for (const c of rematched) {
    const o = oldBy.get(c.sym), t = tickBy.get(c.sym) || {};
    lines.push(`| ${cell(c.sym)} | ${cell(`${o.name} (${o.id})`)} | ${cell(`${c.name} (${c.id})`)} | ${cell(c.match)} | ${cell([t.usd, t.cap].filter(Boolean).join(' · ') || '없음')} | ${cell(priceNote(c.sym))} |`);
  }
  lines.push('');
}
if (todo.length) lines.push('### 확인이 필요한 것', '', ...todo, '');
const others = check.filter((c) => c.priceOff && oldBy.has(c.sym) && !rematched.some((r) => r.sym === c.sym));
if (others.length) {
  lines.push(`<details><summary>기존 종목 중 가격이 거래소와 1.5배 넘게 다른 것 (${others.length}종, 거래량이 적은 거래소 시세 탓일 수 있음)</summary>`, '',
    '| 심볼 | 거래소 | 거래소 가격 | TradingView | CoinGecko |', '|---|---|---|---|---|');
  for (const c of others) lines.push(`| ${cell(c.sym)} | ${cell(c.price.ex)} | ${usd(c.price.exchange)} | ${usd(c.price.tradingview)} | ${usd(c.price.coingecko)} |`);
  lines.push('', '</details>', '');
}
lines.push(structural ? '이 PR을 병합하면 다음 매일 수집이 새 티커의 전체 이력을 받고 사이트에 반영합니다.' : '구조 변화가 없어서 시가총액과 순위만 바로 반영했습니다.');
lines.push('', '종목 목록과 시가총액: Data provided by CoinGecko (https://www.coingecko.com/)');

// record re-matched coins in the mapping log, and the date of this check
{
  const log = await readJson('data/mapping-log.json', null);
  if (log) {
    for (const c of rematched) {
      const o = oldBy.get(c.sym);
      log.entries.unshift({ date: today, sym: c.sym, kind: 'coingecko', was: `${o.name} (${o.id})`, now: `${c.name} (${c.id})`,
        why: `주간 갱신에서 ${c.match === 'exchange' ? 'CoinGecko 거래소 티커' : c.match === 'pin' ? '고정(pin)' : '같은 심볼 중 시가총액 최대'} 기준으로 매칭이 바뀜` });
    }
    log.checkedAt = today;
    await writeFile('data/mapping-log.json', JSON.stringify(log, null, 1) + '\n');
  }
}
const parts = [added.length && `새 종목 ${added.length}`, removed.length && `빠진 종목 ${removed.length}`, rematched.length && `매칭 변경 ${rematched.length}`,
  todo.length && `확인 ${todo.length}`].filter(Boolean);
const title = `주간 종목 갱신 (${today}): ${parts.join(', ') || '구조 변화 없음'}`;
const body = lines.join('\n');
if (opt('--body')) await writeFile(opt('--body'), body);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `structural=${structural ? 'yes' : 'no'}\ntitle=${title}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${title}\n\n${body}\n`);
console.log(title);
