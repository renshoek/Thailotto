‘use strict’;
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto · Two-Digit Prize — Probability Model
//
//  score(d) = 0.35 × recency_freq(d, W)
//           + 0.45 × min(overdue_ratio(d), 3) / 3
//           + 0.20 × historical_base_rate(d)
//
//  Backtest findings (458 draws):
//    score >24% → actual hit 13.8%  (worse than 19% random)
//    score 17–20% → actual hit 20.9% (calibrated zone)
//    symmetry confirmed: P(“06”) = P(“60”)
// ════════════════════════════════════════════════════════════════════════════

const DIGITS        = ‘0123456789’.split(’’);
const W_REC         = 0.35;
const W_OV          = 0.45;
const W_BASE        = 0.20;
const OV_CAP        = 3.0;
const OVERCONF      = 0.24;
const CALIB_LO      = 0.17;
const CALIB_HI      = 0.20;
const OC_CORRECTION = 0.73;
const MIN_HIST      = 30;

const DB_NAME    = ‘thai-lotto-agg-db’;
const STORE_NAME = ‘agg-store’;
const CACHE_KEY  = ‘perFileAggMap_v2’;

// ── State ─────────────────────────────────────────────────────────────────
let allDraws     = [];
let recW         = 20;
let trainWin     = 0;     // 0 = all draws
let topN         = 15;
let btRows       = 20;
let cutoffIdx    = 0;     // 0 = no cutoff; >0 = train on allDraws[0..cutoffIdx-1], test rest

// ── Helpers ───────────────────────────────────────────────────────────────
const $         = id => document.getElementById(id);
const parseNums = s  => s ? s.split(’,’).map(x => x.trim()).filter(Boolean) : [];
const mirror    = n  => n.length === 2 ? n[1] + n[0] : n;
const pct1      = v  => (v * 100).toFixed(1) + ‘%’;
const pct2      = v  => (v * 100).toFixed(2) + ‘%’;

// ── Theme ─────────────────────────────────────────────────────────────────
$(‘themeToggle’).addEventListener(‘click’, () => {
const dark = document.documentElement.classList.toggle(‘dark’);
localStorage.setItem(‘theme’, dark ? ‘dark’ : ‘light’);
if (allDraws.length) renderAll();
});
{
const s = localStorage.getItem(‘theme’);
if (s === ‘dark’ || (!s && window.matchMedia(’(prefers-color-scheme: dark)’).matches))
document.documentElement.classList.add(‘dark’);
}

// ── Controls ──────────────────────────────────────────────────────────────
$(‘trainWinSel’).addEventListener(‘change’, e => {
trainWin = +e.target.value;
syncCutoffControl();
renderAll();
});

$(‘topNSel’).addEventListener(‘change’,   e => { topN   = +e.target.value; renderAll(); });
$(‘btRowsSel’).addEventListener(‘change’, e => { btRows = +e.target.value; renderAll(); });

$(‘recSlider’).addEventListener(‘input’, e => {
recW = +e.target.value;
$(‘recLbl’).textContent  = recW;
$(‘recLbl2’).textContent = recW;
renderAll();
});

$(‘cutoffSlider’).addEventListener(‘input’, e => {
cutoffIdx = +e.target.value;
updateCutoffLabel();
renderAll();
});

function syncCutoffControl() {
const isAllDraws = trainWin === 0;
const wrap = $(‘cutoffControlWrap’);
wrap.style.opacity      = isAllDraws ? ‘1’ : ‘0.35’;
wrap.style.pointerEvents = isAllDraws ? ‘’ : ‘none’;
$(‘cutoffSlider’).disabled = !isAllDraws;
if (!isAllDraws) {
cutoffIdx = 0;
$(‘cutoffSlider’).value = 0;
updateCutoffLabel();
}
}

function updateCutoffLabel() {
const lbl = $(‘cutoffLbl’);
const slider = $(‘cutoffSlider’);
if (cutoffIdx === 0 || !allDraws.length) {
lbl.textContent = ‘Off’;
lbl.style.color = ‘var(–muted-foreground)’;
} else {
const trainEnd = allDraws[cutoffIdx - 1];
const testStart = allDraws[cutoffIdx];
const remaining = allDraws.length - cutoffIdx;
lbl.textContent  = `Draw ${cutoffIdx} · trained to ${trainEnd?.dateStr} · ${remaining} draws to test`;
lbl.style.color  = ‘hsl(38,78%,42%)’;
}
}

// ── IndexedDB loader ──────────────────────────────────────────────────────
async function loadCache() {
return new Promise(resolve => {
const req = indexedDB.open(DB_NAME, 1);
req.onupgradeneeded = ev => {
if (!ev.target.result.objectStoreNames.contains(STORE_NAME))
ev.target.result.createObjectStore(STORE_NAME);
};
req.onsuccess = ev => {
const get = ev.target.result.transaction(STORE_NAME, ‘readonly’)
.objectStore(STORE_NAME).get(CACHE_KEY);
get.onsuccess = () => resolve(get.result || null);
get.onerror   = () => resolve(null);
};
req.onerror = () => resolve(null);
});
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
setStatus(’’, ‘Loading…’);
const cached = await loadCache();

if (!cached || !cached.data || !Object.keys(cached.data).length) {
setStatus(‘empty’, ‘No data — open the Analyzer page first to load files.’);
return;
}

allDraws = Array.from(new Map(Object.entries(cached.data)).entries())
.map(([dateStr, agg]) => {
const nums = parseNums((agg.results || {}).TWO || ‘’).filter(n => n.length === 2);
return { dateStr, twoNum: nums[0] || null };
})
.filter(d => d.twoNum)
.sort((a, b) => a.dateStr.localeCompare(b.dateStr));

// Configure cutoff slider range
const slider = $(‘cutoffSlider’);
slider.min   = 0;
slider.max   = allDraws.length - MIN_HIST - 1;
slider.value = 0;
updateCutoffLabel();
syncCutoffControl();

const age = cached.fetchedAt ? Math.round((Date.now() - cached.fetchedAt) / 60000) : null;
setStatus(‘live’,
`${allDraws.length} TWO draws loaded` +
(age != null ? ` · cached ${age < 60 ? age + 'm' : Math.round(age / 60) + 'h'} ago` : ‘’) +
` · ${allDraws[0]?.dateStr} → ${allDraws[allDraws.length - 1]?.dateStr}`
);

renderAll();
}

function setStatus(state, txt) {
$(‘statusText’).textContent = txt;
$(‘statusDot’).className = ‘status-dot’ + (state === ‘live’ ? ’ live’ : ‘’);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SLICES
// ═══════════════════════════════════════════════════════════════════════════

/** Training slice for current predictions (not backtest) */
function getTrainSlice() {
let base = allDraws;
if (cutoffIdx > 0 && trainWin === 0) base = allDraws.slice(0, cutoffIdx);
if (trainWin > 0) return allDraws.slice(-trainWin);
return base;
}

/** Where does the backtest start and what draws does it cover */
function getBacktestWindow() {
if (cutoffIdx > 0 && trainWin === 0) {
// Cutoff mode: train on 0..cutoffIdx-1, test from cutoffIdx onward
return { testStart: cutoffIdx, isCutoffMode: true };
}
return { testStart: MIN_HIST, isCutoffMode: false };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE MODEL
// ═══════════════════════════════════════════════════════════════════════════
function computeModel(seq, W) {
const n = seq.length;
if (n < MIN_HIST) return null;
const safeW = Math.min(W, n - 1);

const recCount  = Object.fromEntries(DIGITS.map(d => [d, 0]));
const baseCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
seq.slice(-safeW).forEach(num => { recCount[num[0]]++;  recCount[num[1]]++;  });
seq.forEach(num =>               { baseCount[num[0]]++; baseCount[num[1]]++; });

const lastSeen = Object.fromEntries(DIGITS.map(d => [d, -1]));
const gapLists = Object.fromEntries(DIGITS.map(d => [d, []]));
seq.forEach((num, i) => {
[num[0], num[1]].forEach(d => {
if (lastSeen[d] >= 0) gapLists[d].push(i - lastSeen[d]);
lastSeen[d] = i;
});
});

const baseTotal = n * 2;
const rawScore  = {};
const meta      = {};

DIGITS.forEach(d => {
const recFreq  = recCount[d]  / (2 * safeW);
const baseFreq = baseCount[d] / baseTotal;
const gaps     = gapLists[d];
const avgGap   = gaps.length >= 2 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 5.0;
const since    = lastSeen[d] >= 0 ? (n - 1 - lastSeen[d]) : n;
const ovRatio  = avgGap > 0 ? Math.min(since / avgGap, OV_CAP) : 0;

```
rawScore[d] = W_REC * recFreq + W_OV * (ovRatio / OV_CAP) + W_BASE * baseFreq;
meta[d] = { recFreq, baseFreq, avgGap, since, ovRatio };
```

});

const total     = DIGITS.reduce((s, d) => s + rawScore[d], 0);
const digitProb = {};

DIGITS.forEach(d => {
const p = rawScore[d] / total;
digitProb[d] = p;
meta[d].prob         = p;
meta[d].excessVsBase = p - meta[d].baseFreq;
meta[d].pDraw        = 1 - Math.pow(1 - p, 2);
meta[d].isOC         = p > OVERCONF;
meta[d].isCalib      = p >= CALIB_LO && p <= CALIB_HI;
meta[d].isElev       = p > CALIB_HI  && p <= OVERCONF;
});

const numProbs = {};
DIGITS.forEach(a => DIGITS.forEach(b => { numProbs[a + b] = digitProb[a] * digitProb[b]; }));

return { digitProb, digitMeta: meta, numProbs, n };
}

function cumulP(pDraw, N) { return 1 - Math.pow(1 - pDraw, N); }

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════
function renderAll() {
const slice = getTrainSlice();
const seq   = slice.map(d => d.twoNum);
const model = computeModel(seq, recW);

renderStatCards(slice, model);

const noData = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.5rem 0;">Need at least ${MIN_HIST} draws.</p>`;
if (!model) {
[‘digitBars’,‘numPredTable’,‘pairTable’,‘lookaheadTable’,‘btSummary’,‘btGrid’]
.forEach(id => { $(id) && ($(id).innerHTML = noData); });
return;
}

renderDigitBars(model);
renderNumPredTable(model);
renderPairTable(model);
renderLookahead(model);
renderBacktest();
}

// ═══════════════════════════════════════════════════════════════════════════
//  STAT CARDS
// ═══════════════════════════════════════════════════════════════════════════
function renderStatCards(slice, model) {
const last  = slice[slice.length - 1];
const topD  = model ? DIGITS.slice().sort((a, b) => model.digitProb[b] - model.digitProb[a])[0] : null;
const inCutoff = cutoffIdx > 0 && trainWin === 0;

$(‘statCards’).innerHTML = ` <div class="stat-card"> <div class="stat-card-label">Total draws</div> <div class="stat-card-value">${allDraws.length}</div> <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${allDraws[allDraws.length-1]?.dateStr}</div> </div> <div class="stat-card"${inCutoff ? ' style="border-color:hsl(38,78%,55%);"' : ''}> <div class="stat-card-label">Training on</div> <div class="stat-card-value">${slice.length}</div> <div class="stat-card-sub">${slice[0]?.dateStr} → ${last?.dateStr}${inCutoff ? '<br><span style="color:hsl(38,78%,42%);font-weight:600;">cutoff mode</span>' : ''}</div> </div> <div class="stat-card"> <div class="stat-card-label">Last in training</div> <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div> <div class="stat-card-sub">${last?.dateStr || ''}</div> </div> <div class="stat-card"> <div class="stat-card-label">Top digit</div> <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:${model?.digitMeta[topD]?.isOC ? 'hsl(5,68%,48%)' : 'var(--primary)'};">${topD || '—'}</div> <div class="stat-card-sub">${model ? pct1(model.digitProb[topD]) + (model.digitMeta[topD].isOC ? ' ⚠ OC' : model.digitMeta[topD].isCalib ? ' ✓ calibrated' : '') : ''}</div> </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DIGIT BARS
// ═══════════════════════════════════════════════════════════════════════════
function renderDigitBars(model) {
const { digitMeta } = model;
const sorted = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob);
const maxP   = digitMeta[sorted[0]].prob;
const wrap   = $(‘digitBars’);
wrap.innerHTML = ‘’;

const hdr = document.createElement(‘div’);
hdr.className = ‘dbar-hdr’;
hdr.innerHTML = `<div style="text-align:center">D</div><div>Score bar <span style="opacity:.4;font-size:.55rem;">(▏= 10%)</span></div><div style="text-align:right">Score</div><div style="text-align:right">vs base</div><div style="text-align:right">Since last</div><div></div>`;
wrap.appendChild(hdr);

sorted.forEach(d => {
const m = digitMeta[d];
const exc = (m.excessVsBase >= 0 ? ‘+’ : ‘’) + pct1(m.excessVsBase);
let barColor, pill;
if (m.isOC)         { barColor = ‘hsl(5,68%,52%)’;    pill = `<span class="cpill cpill-red">Overconfident ↓</span>`; }
else if (m.isElev)  { barColor = ‘hsl(38,78%,52%)’;   pill = `<span class="cpill cpill-amber">Elevated</span>`; }
else if (m.isCalib) { barColor = ‘hsl(142,55%,44%)’;  pill = `<span class="cpill cpill-green">Calibrated ✓</span>`; }
else                { barColor = ‘var(–primary)’;     pill = `<span class="cpill cpill-muted">Low</span>`; }

```
const row = document.createElement('div');
row.className = 'dbar-row';
row.innerHTML = `
  <div class="dbar-lbl">${d}</div>
  <div class="dbar-track">
    <div class="dbar-fill" style="width:${(m.prob/maxP*100).toFixed(1)}%;background:${barColor};"></div>
    <div class="dbar-baseline" style="left:${Math.min(99,(0.10/maxP*100)).toFixed(1)}%;"></div>
  </div>
  <div class="dbar-score" style="color:${m.isOC ? 'hsl(5,68%,48%)' : m.isCalib ? 'hsl(142,55%,40%)' : 'var(--foreground)'};">${pct1(m.prob)}</div>
  <div class="dbar-excess" style="color:${m.excessVsBase >= 0 ? 'hsl(142,55%,40%)' : 'hsl(5,68%,48%)'};">${exc}</div>
  <div class="dbar-since" style="${m.ovRatio > 1.5 ? 'color:hsl(15,78%,50%);' : ''}">${m.since} drws${m.ovRatio > 1.0 ? ' ×'+m.ovRatio.toFixed(1) : ''}</div>
  <div>${pill}</div>`;
wrap.appendChild(row);
```

});
}

// ═══════════════════════════════════════════════════════════════════════════
//  NUMBER PREDICTIONS
// ═══════════════════════════════════════════════════════════════════════════
function renderNumPredTable(model) {
const { numProbs, digitMeta } = model;
const sorted = Object.entries(numProbs).sort((a, b) => b[1] - a[1]).slice(0, topN);
const maxP   = sorted[0][1];

let html = `<table class="pt"><thead><tr><th>#</th><th>Number</th><th>Mirror</th><th colspan="2">Probability</th><th style="text-align:right">×base</th></tr></thead><tbody>`;
sorted.forEach(([num, prob], i) => {
const mir    = mirror(num);
const isSelf = num === mir;
const anyOC  = digitMeta[num[0]].isOC || digitMeta[num[1]].isOC;
const basePr = digitMeta[num[0]].baseFreq * digitMeta[num[1]].baseFreq;
const ratio  = basePr > 0 ? prob / basePr : 1;
html += `<tr> <td style="color:var(--muted-foreground);font-size:.7rem;">${i+1}</td> <td class="pt-num${anyOC?' oc-dim':''}">${num}${anyOC?'<sup style="font-size:.55rem;color:hsl(5,68%,50%);">⚠</sup>':''}</td> <td class="pt-mir">${isSelf?'—':mir}</td> <td style="min-width:80px;"> <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600;">${pct2(prob)}</div> <div class="pt-bar"><div class="pt-bar-fill" style="width:${(prob/maxP*100).toFixed(1)}%;background:${anyOC?'hsl(5,68%,52%)':'var(--primary)'};"></div></div> </td><td style="width:0;padding:0;"></td> <td style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:.75rem;font-weight:${ratio>=2?'700':'400'};color:${ratio>=2?'hsl(142,55%,40%)':'var(--muted-foreground)'};">×${ratio.toFixed(1)}</td> </tr>`;
});
html += `</tbody></table><p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55;">⚠ = contains OC digit (>24%). Mirror: "59" covers "95" — both should be purchased.</p>`;
$(‘numPredTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  UNORDERED PAIRS
// ═══════════════════════════════════════════════════════════════════════════
function renderPairTable(model) {
const { digitMeta, numProbs } = model;
const pairMap = {};
DIGITS.forEach(a => DIGITS.forEach(b => {
if (b < a) return;
pairMap[a+b] = { a, b, prob: a===b ? numProbs[a+b] : numProbs[a+b]+numProbs[b+a], anyOC: digitMeta[a].isOC||digitMeta[b].isOC };
}));
const sorted = Object.values(pairMap).sort((x,y) => y.prob-x.prob).slice(0, topN);
const maxP   = sorted[0].prob;

let html = `<table class="pt"><thead><tr><th>#</th><th>Pair</th><th>Tickets</th><th colspan="2">Combined P</th><th></th></tr></thead><tbody>`;
sorted.forEach(({ a, b, prob, anyOC }, i) => {
const isSame = a === b;
html += `<tr> <td style="color:var(--muted-foreground);font-size:.7rem;">${i+1}</td> <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)${anyOC?';opacity:.6':''}">{${a},${b}}</td> <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground);">${a+b}${isSame?'':' + '+b+a}</td> <td style="min-width:80px;"> <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600;">${pct2(prob)}</div> <div class="pt-bar"><div class="pt-bar-fill" style="width:${(prob/maxP*100).toFixed(1)}%;background:${anyOC?'hsl(5,68%,52%)':'hsl(142,55%,44%)'};"></div></div> </td><td style="width:0;padding:0;"></td> <td style="text-align:right;font-size:.65rem;">${anyOC?'<span class="cpill cpill-red">⚠ OC</span>':''}</td> </tr>`;
});
html += `</tbody></table><p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55;">Symmetry confirmed. {5,9} = "59" + "95". Combined P = 2×P(5)×P(9).</p>`;
$(‘pairTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  N-DRAW LOOKAHEAD
// ═══════════════════════════════════════════════════════════════════════════
function renderLookahead(model) {
const { digitMeta } = model;
const Ns = [1, 2, 3, 4, 6];
const topDigits = DIGITS.slice().sort((a,b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 7);

let html = `<table class="la-tbl"><thead><tr><th>Digit</th><th>Score</th>${Ns.map(n=>`<th>Next ${n}</th>`).join('')}<th>Zone</th></tr></thead><tbody>`;
topDigits.forEach(d => {
const m = digitMeta[d];
html += `<tr><td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.0625rem;">${d}</td> <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:${m.isOC?'hsl(5,68%,48%)':'var(--foreground)'};">${pct1(m.prob)}</td>`;

```
Ns.forEach(N => {
  const rawP = cumulP(m.pDraw, N);
  const adjP = m.isOC ? rawP * OC_CORRECTION : rawP;
  let cls = (m.isOC?adjP:rawP) >= 0.75 ? 'la-hi' : (m.isOC?adjP:rawP) >= 0.45 ? 'la-med' : 'la-lo';
  if (m.isOC) {
    html += `<td><div class="la-oc">${pct1(rawP)}</div><div style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:hsl(5,68%,48%);font-weight:600;">~${pct1(adjP)}</div></td>`;
  } else {
    html += `<td class="${cls}">${pct1(rawP)}</td>`;
  }
});

let pill = m.isOC ? `<span class="cpill cpill-red">OC ↓</span>` : m.isElev ? `<span class="cpill cpill-amber">Elevated</span>` : m.isCalib ? `<span class="cpill cpill-green">Calibrated ✓</span>` : `<span class="cpill cpill-muted">Low</span>`;
html += `<td>${pill}</td></tr>`;
```

});
html += `</tbody></table><p style="font-size:.7rem;color:var(--muted-foreground);margin-top:.625rem;line-height:1.55;">OC digits: raw estimate struck through, adjusted ×0.73. Green ≥75%, amber ≥45%.</p>`;
$(‘lookaheadTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WALK-FORWARD BACKTEST
// ═══════════════════════════════════════════════════════════════════════════
function runBacktest() {
const { testStart, isCutoffMode } = getBacktestWindow();
const N = allDraws.length;
if (testStart >= N) return [];

const results = [];

for (let i = testStart; i < N; i++) {
const seq   = allDraws.slice(0, i).map(d => d.twoNum);
const model = computeModel(seq, recW);
if (!model) continue;

```
const { numProbs, digitMeta } = model;
const sortedNums = Object.entries(numProbs).sort((a, b) => b[1] - a[1]);
const topList    = sortedNums.slice(0, topN);
const topNums    = topList.map(([n]) => n);

const actual  = allDraws[i].twoNum;
const dateStr = allDraws[i].dateStr;

// Pair hit: actual or mirror in top list
const pairHit      = topNums.includes(actual) || topNums.includes(mirror(actual));
const matchedNum   = topNums.includes(actual) ? actual : topNums.includes(mirror(actual)) ? mirror(actual) : null;
const actualProb   = numProbs[actual] || 0;
const actualPairP  = actual === mirror(actual) ? actualProb : Math.max(actualProb, numProbs[mirror(actual)] || 0);

// Top 3 digits at this prediction step
const topDigits3 = DIGITS.slice()
  .sort((a, b) => digitMeta[b].prob - digitMeta[a].prob)
  .slice(0, 3)
  .map(d => ({ d, prob: digitMeta[d].prob, isOC: digitMeta[d].isOC }));

// Top prediction list with OC flags and prob
const topListMeta = topList.map(([num, prob]) => ({
  num, prob,
  isOC: digitMeta[num[0]].isOC || digitMeta[num[1]].isOC,
}));

// First hit in window [i + fromK .. i + fromK + size - 1]
function firstHit(fromK, size) {
  for (let k = fromK; k < fromK + size && (i + k) < N; k++) {
    const a = allDraws[i + k].twoNum;
    if (topNums.includes(a) || topNums.includes(mirror(a))) {
      const pn = topNums.includes(a) ? a : mirror(a);
      return { drawn: a, predNum: pn, offset: k, dateStr: allDraws[i+k].dateStr, prob: numProbs[pn] || 0 };
    }
  }
  return null;
}

results.push({
  i, dateStr, actual,
  actualProb, actualPairP,
  pairHit, matchedNum,
  topDigits3, topListMeta, topNums,
  // +2: first hit in draws i..i+1 (window of 2 starting from draw 0)
  hit2: firstHit(0, 2),
  // +4: first hit in draws i..i+3 (window of 4)
  hit4: firstHit(0, 4),
});
```

}
return results;
}

function renderBacktest() {
const { isCutoffMode, testStart } = getBacktestWindow();
const btAll = runBacktest();

if (!btAll.length) {
$(‘btSummary’).innerHTML = ‘’;
$(‘btGrid’).innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.5rem 0;">${ isCutoffMode ? `No draws after cutoff draw ${cutoffIdx}. Move the slider earlier.` : 'Not enough data.' }</p>`;
return;
}

const N        = btAll.length;
const pairRate = btAll.filter(r => r.pairHit).length / N;
const hit2Rate = btAll.filter(r => r.hit2).length / N;
const hit4Rate = btAll.filter(r => r.hit4).length / N;
const avgP     = btAll.reduce((s, r) => s + r.actualPairP, 0) / N;

$(‘btSummary’).innerHTML = `${isCutoffMode ?`<div class="bt-sum-item"><div class="bt-sum-lbl">Mode</div><div class="bt-sum-val" style="color:hsl(38,78%,42%);font-size:.75rem;">After draw ${cutoffIdx} · ${allDraws[cutoffIdx]?.dateStr}</div></div>` : ''} <div class="bt-sum-item"><div class="bt-sum-lbl">Draws tested</div><div class="bt-sum-val">${N}</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Pair hit</div><div class="bt-sum-val" style="color:${pairRate>0.055?'hsl(142,55%,40%)':'var(--foreground)'};">${(pairRate*100).toFixed(1)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Hit in 2</div><div class="bt-sum-val">${(hit2Rate*100).toFixed(1)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Hit in 4</div><div class="bt-sum-val">${(hit4Rate*100).toFixed(1)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Avg P(actual)</div><div class="bt-sum-val" style="color:var(--muted-foreground);">${(avgP*100).toFixed(2)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Random baseline</div><div class="bt-sum-val" style="color:var(--muted-foreground);">${topN}%</div></div>`;

const recent = btAll.slice(-btRows);

let grid = `<div class="bt-hdr">
<div>Date</div>
<div>Drawn</div>
<div>Top digits</div>
<div>Predicted numbers</div>
<div>Pair</div>
<div>+2 draws</div>
<div>+4 draws</div>

  </div>`;

recent.forEach(r => {
// ── Top 3 digit scores at this point ──
const digitPills = r.topDigits3.map(({ d, prob, isOC }) =>
`<div style="display:flex;align-items:baseline;gap:.2rem;"> <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.8rem;color:${isOC?'hsl(5,68%,48%)':prob>=CALIB_LO?'hsl(142,55%,40%)':'var(--muted-foreground)'};">${d}</span> <span style="font-size:.6rem;color:${isOC?'hsl(5,68%,48%)':'var(--muted-foreground)'};">${pct1(prob)}${isOC?' ⚠':''}</span> </div>`
).join(’’);

```
// ── Predicted number chips ──
const chips = r.topListMeta.slice(0, 10).map(({ num, prob, isOC }) => {
  const isHit = num === r.actual || num === mirror(r.actual);
  return `<span class="bt-chip${isHit?' pair-hit':isOC?' oc-chip':''}" title="P=${pct2(prob)}${isOC?' ⚠OC':''}">
    ${num}<span class="bt-chip-prob">${(prob*100).toFixed(1)}%${isOC?'⚠':''}</span>
  </span>`;
}).join('');

// ── Pair hit cell ──
let pairCell;
if (r.pairHit) {
  const isMirror = r.matchedNum !== r.actual;
  pairCell = `<div class="bt-hit-cell">
    <div class="bt-hit-num" style="color:hsl(142,55%,40%);">${r.actual}</div>
    ${isMirror ? `<div class="bt-hit-sub">via ${r.matchedNum}</div>` : ''}
    <div class="bt-hit-prob">${(r.actualProb*100).toFixed(2)}%</div>
  </div>`;
} else {
  pairCell = `<div class="bt-miss">—</div>`;
}

// ── +2 / +4 horizon cells ──
const hitCell = info => {
  if (!info) return `<div class="bt-miss">—</div>`;
  return `<div class="bt-hit-cell">
    <div class="bt-hit-num">${info.drawn}</div>
    <div class="bt-hit-sub">${info.offset === 0 ? 'draw 0' : '+'+info.offset}</div>
    <div class="bt-hit-prob">${(info.prob*100).toFixed(2)}%</div>
  </div>`;
};

grid += `<div class="bt-row">
  <div class="bt-date">${r.dateStr}</div>
  <div>
    <div class="bt-actual" style="color:${r.pairHit?'hsl(142,55%,40%)':'var(--foreground)'};">${r.actual}</div>
    <div class="bt-actual-prob">${(r.actualPairP*100).toFixed(2)}%</div>
  </div>
  <div class="bt-digits-col">${digitPills}</div>
  <div class="bt-chips">${chips}</div>
  ${pairCell}
  ${hitCell(r.hit2)}
  ${hitCell(r.hit4)}
</div>`;
```

});

$(‘btGrid’).innerHTML = grid;
}

// ── Boot ──────────────────────────────────────────────────────────────────
init().catch(err => {
setStatus(’’, ’Error: ’ + err.message);
console.error(err);
});
