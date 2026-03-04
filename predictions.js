‘use strict’;
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto · Two-Digit Prize — Probability Model (predictions.js)
//
//  Model weights (backtest-validated, 458 draws 2006-2026):
//    score(d) = 0.35 × recency_freq(d, W)
//             + 0.45 × min(overdue_ratio(d), 3) / 3
//             + 0.20 × historical_base_rate(d)
//    prob(d)  = score(d) / Σ score
//
//  Confirmed:  P(“06”) = P(“60”)  (Z=−1.52, not significant — symmetry real)
//  Overconf:   score > 24% → actual hit 13.8% — WORSE than random 19%
//  Calibrated: 17–20%     → actual hit 20.9% — best honest zone
//  OC factor:  0.73× correction (13.8% / 19% ≈ 0.73)
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
let allDraws  = [];   // [{dateStr, twoNum}] oldest→newest
let recW      = 20;
let trainWin  = 100;  // 0 = all
let topN      = 15;
let btRows    = 20;
let predCutoff = null; // ISO date string — only used when trainWin === 0

// ── DOM helpers ───────────────────────────────────────────────────────────
const $         = id  => document.getElementById(id);
const isDark    = ()  => document.documentElement.classList.contains(‘dark’);
const parseNums = s   => s ? s.split(’,’).map(x => x.trim()).filter(Boolean) : [];
const mirror    = n   => n.length === 2 ? n[1] + n[0] : n;
const pct1      = v   => (v * 100).toFixed(1) + ‘%’;
const pct2      = v   => (v * 100).toFixed(2) + ‘%’;
const esc       = s   => String(s).replace(/&/g,’&’).replace(/</g,’<’).replace(/>/g,’>’);

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
updateCutoffVisibility();
renderAll();
});
$(‘topNSel’).addEventListener(‘change’,    e => { topN   = +e.target.value; renderAll(); });
$(‘btRowsSel’).addEventListener(‘change’,  e => { btRows = +e.target.value; renderAll(); });

$(‘recSlider’).addEventListener(‘input’, e => {
recW = +e.target.value;
$(‘recLbl’).textContent  = recW;
$(‘recLbl2’).textContent = recW;
renderAll();
});

$(‘applyPredCutoff’).addEventListener(‘click’, () => {
const v = $(‘predCutoffDate’).value;
predCutoff = v || null;
renderAll();
});

$(‘clearPredCutoff’).addEventListener(‘click’, () => {
predCutoff = null;
$(‘predCutoffDate’).value = ‘’;
renderAll();
});

function updateCutoffVisibility() {
const wrap = $(‘cutoffWrapPred’);
const inp  = $(‘predCutoffDate’);
const applyBtn = $(‘applyPredCutoff’);
const clearBtn = $(‘clearPredCutoff’);
if (trainWin === 0) {
wrap.style.opacity = ‘1’;
wrap.style.pointerEvents = ‘’;
inp.disabled = false;
applyBtn.disabled = false;
clearBtn.disabled = false;
} else {
wrap.style.opacity = ‘.4’;
wrap.style.pointerEvents = ‘none’;
inp.disabled = true;
applyBtn.disabled = true;
clearBtn.disabled = true;
predCutoff = null;
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
const get = ev.target.result.transaction(STORE_NAME,‘readonly’)
.objectStore(STORE_NAME).get(CACHE_KEY);
get.onsuccess = () => resolve(get.result || null);
get.onerror   = () => resolve(null);
};
req.onerror = () => resolve(null);
});
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
setStatus(’’, ‘Loading data from cache…’);
updateCutoffVisibility();
const cached = await loadCache();

if (!cached || !cached.data || !Object.keys(cached.data).length) {
setStatus(‘empty’, ‘No data — open the Analyzer page first to cache lottery data.’);
return;
}

const map = new Map(Object.entries(cached.data));
allDraws = Array.from(map.entries())
.map(([dateStr, agg]) => {
const nums = parseNums((agg.results || {}).TWO || ‘’).filter(n => n.length === 2);
return { dateStr, twoNum: nums[0] || null };
})
.filter(d => d.twoNum)
.sort((a, b) => a.dateStr.localeCompare(b.dateStr));

const age = cached.fetchedAt ? Math.round((Date.now() - cached.fetchedAt) / 60000) : null;
setStatus(‘live’,
`${allDraws.length} TWO draws loaded` +
(age !== null ? ` · cached ${age < 60 ? age + ' min' : Math.round(age / 60) + 'h'} ago` : ‘’) +
` · ${allDraws[0]?.dateStr} → ${allDraws[allDraws.length - 1]?.dateStr}`
);

renderAll();
}

function setStatus(state, txt) {
$(‘statusText’).textContent = txt;
$(‘statusDot’).className = ‘status-dot’ + (state === ‘live’ ? ’ live’ : ‘’);
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE MODEL
// ═══════════════════════════════════════════════════════════════════════════

function computeModel(seq, W) {
const n = seq.length;
if (n < MIN_HIST) return null;

const safeW = Math.min(W, n - 1);

// Recency frequency (last W draws)
const recCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
seq.slice(-safeW).forEach(num => {
recCount[num[0]]++;
recCount[num[1]]++;
});

// All-time base rate
const baseCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
seq.forEach(num => { baseCount[num[0]]++; baseCount[num[1]]++; });
const baseTotal = n * 2;

// Gap / overdue
const lastSeen  = Object.fromEntries(DIGITS.map(d => [d, -1]));
const gapLists  = Object.fromEntries(DIGITS.map(d => [d, []]));
seq.forEach((num, i) => {
[num[0], num[1]].forEach(d => {
if (lastSeen[d] >= 0) gapLists[d].push(i - lastSeen[d]);
lastSeen[d] = i;
});
});

const rawScore = {};
const meta     = {};

DIGITS.forEach(d => {
const recFreq  = recCount[d]  / (2 * safeW);
const baseFreq = baseCount[d] / baseTotal;
const gaps     = gapLists[d];
const avgGap   = gaps.length >= 2
? gaps.reduce((a, b) => a + b, 0) / gaps.length
: 5.0;
const since   = lastSeen[d] >= 0 ? (n - 1 - lastSeen[d]) : n;
const ovRatio = avgGap > 0 ? Math.min(since / avgGap, OV_CAP) : 0;

```
rawScore[d] = W_REC * recFreq + W_OV * (ovRatio / OV_CAP) + W_BASE * baseFreq;
meta[d] = { recFreq, baseFreq, avgGap, since, ovRatio, gapCount: gaps.length, lastIdx: lastSeen[d] };
```

});

const total = DIGITS.reduce((s, d) => s + rawScore[d], 0);

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
meta[d].isLow        = p < CALIB_LO;
});

const numProbs = {};
DIGITS.forEach(a => DIGITS.forEach(b => { numProbs[a + b] = digitProb[a] * digitProb[b]; }));

return { digitProb, digitMeta: meta, numProbs, n };
}

function cumulP(pDraw, N) {
return 1 - Math.pow(1 - pDraw, N);
}

// Returns the training slice for the “current” prediction view
function getTrainSlice() {
if (trainWin === 0) {
// All draws mode — optionally capped at cutoff
if (predCutoff) return allDraws.filter(d => d.dateStr <= predCutoff);
return allDraws;
}
if (trainWin >= allDraws.length) return allDraws;
return allDraws.slice(-trainWin);
}

// Returns draws to test in backtest (only those after cutoff when cutoff is set)
function getBacktestRange() {
if (predCutoff && trainWin === 0) {
return { startIdx: allDraws.findIndex(d => d.dateStr > predCutoff), isCutoffMode: true };
}
return { startIdx: MIN_HIST, isCutoffMode: false };
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════

function renderAll() {
const slice = getTrainSlice();
const seq   = slice.map(d => d.twoNum);
const model = computeModel(seq, recW);

renderStatCards(slice, model);

const ids = [‘digitBars’,‘numPredTable’,‘pairTable’,‘lookaheadTable’,‘btSummary’,‘btGrid’];
if (!model) {
ids.forEach(id => {
if ($(id)) $(id).innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0;">Not enough data yet (minimum ${MIN_HIST} draws).</p>`;
});
return;
}

renderDigitBars(model);
renderNumPredTable(model);
renderPairTable(model);
renderLookahead(model);
renderBacktest();
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 1 — STAT CARDS
// ═══════════════════════════════════════════════════════════════════════════
function renderStatCards(slice, model) {
const total = allDraws.length;
const last  = slice[slice.length - 1];
let topDStr = ‘—’, topPStr = ‘—’, topOCStr = ‘’;

if (model) {
const topD = DIGITS.slice().sort((a, b) => model.digitProb[b] - model.digitProb[a])[0];
topDStr  = topD;
topPStr  = pct1(model.digitProb[topD]);
topOCStr = model.digitMeta[topD].isOC
? ’ ⚠ overconfident’
: model.digitMeta[topD].isCalib ? ’ ✓ calibrated’ : ‘’;
}

const cutoffNote = predCutoff && trainWin === 0
? `<div style="font-size:.65rem;color:hsl(38,78%,42%);margin-top:.25rem;">⏱ Cutoff mode — trained to ${predCutoff}</div>`
: ‘’;

$(‘statCards’).innerHTML = `<div class="stat-card"> <div class="stat-card-label">Total draws in DB</div> <div class="stat-card-value">${total}</div> <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${allDraws[allDraws.length - 1]?.dateStr}</div> </div> <div class="stat-card"> <div class="stat-card-label">Training window</div> <div class="stat-card-value">${slice.length}</div> <div class="stat-card-sub">${slice[0]?.dateStr} → ${last?.dateStr}${cutoffNote}</div> </div> <div class="stat-card"> <div class="stat-card-label">Last in training (TWO)</div> <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div> <div class="stat-card-sub">${last?.dateStr || ''}</div> </div> <div class="stat-card"> <div class="stat-card-label">Top digit now</div> <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;${model?.digitMeta[topDStr]?.isOC ? 'color:hsl(5,68%,48%)' : 'color:var(--primary)'}">${topDStr}</div> <div class="stat-card-sub">${topPStr} model score${topOCStr}</div> </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 2 — DIGIT BARS
// ═══════════════════════════════════════════════════════════════════════════
function renderDigitBars(model) {
const { digitMeta } = model;
const sorted = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob);
const maxP   = digitMeta[sorted[0]].prob;
const wrap   = $(‘digitBars’);
wrap.innerHTML = ‘’;

const hdr = document.createElement(‘div’);
hdr.className = ‘dbar-hdr’;
hdr.innerHTML = ` <div style="text-align:center">D</div> <div>Score bar <span style="opacity:.45;font-weight:400;font-size:.55rem;">(▏= 10% baseline)</span></div> <div style="text-align:right">Score</div> <div style="text-align:right">vs base</div> <div style="text-align:right">Since last</div> <div></div>`;
wrap.appendChild(hdr);

sorted.forEach(d => {
const m   = digitMeta[d];
const exc = (m.excessVsBase >= 0 ? ‘+’ : ‘’) + pct1(m.excessVsBase);
let barColor, pill;
if (m.isOC) {
barColor = ‘hsl(5,68%,52%)’;
pill = `<span class="cpill cpill-red">Overconfident ↓</span>`;
} else if (m.isElev) {
barColor = ‘hsl(38,78%,52%)’;
pill = `<span class="cpill cpill-amber">Elevated</span>`;
} else if (m.isCalib) {
barColor = ‘hsl(142,55%,44%)’;
pill = `<span class="cpill cpill-green">Calibrated ✓</span>`;
} else {
barColor = ‘var(–primary)’;
pill = `<span class="cpill cpill-muted">Low</span>`;
}

```
const fillPct     = (m.prob / maxP * 100).toFixed(1);
const baselinePct = Math.min(99, (0.10 / maxP * 100)).toFixed(1);

const row = document.createElement('div');
row.className = 'dbar-row';
row.title = `Digit ${d}: score ${pct2(m.prob)} · base ${pct2(m.baseFreq)} · avg gap ${m.avgGap.toFixed(1)} draws · ${m.since} draws since last seen`;
row.innerHTML = `
  <div class="dbar-lbl">${d}</div>
  <div class="dbar-track">
    <div class="dbar-fill" style="width:${fillPct}%;background:${barColor};"></div>
    <div class="dbar-baseline" style="left:${baselinePct}%;"></div>
  </div>
  <div class="dbar-score" style="color:${m.isOC ? 'hsl(5,68%,48%)' : m.isCalib ? 'hsl(142,55%,40%)' : 'var(--foreground)'};">${pct1(m.prob)}</div>
  <div class="dbar-excess" style="color:${m.excessVsBase >= 0 ? 'hsl(142,55%,40%)' : 'hsl(5,68%,48%)'};">${exc}</div>
  <div class="dbar-since" style="${m.ovRatio > 1.5 ? 'color:hsl(15,78%,50%);' : ''}">${m.since} drws${m.ovRatio > 1.0 ? ' ×' + m.ovRatio.toFixed(1) : ''}</div>
  <div>${pill}</div>`;
wrap.appendChild(row);
```

});
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3a — NUMBER PREDICTIONS
// ═══════════════════════════════════════════════════════════════════════════
function renderNumPredTable(model) {
const { numProbs, digitMeta } = model;
const sorted = Object.entries(numProbs).sort((a, b) => b[1] - a[1]).slice(0, topN);
const maxP   = sorted[0][1];

let html = `<table class="pt"><thead><tr>
<th>#</th><th>Number</th><th>Mirror</th><th colspan="2">Probability</th><th style="text-align:right">×base</th>

  </tr></thead><tbody>`;

sorted.forEach(([num, prob], i) => {
const mir   = mirror(num);
const isSelf = num === mir;
const anyOC  = digitMeta[num[0]].isOC || digitMeta[num[1]].isOC;
const basePr = digitMeta[num[0]].baseFreq * digitMeta[num[1]].baseFreq;
const ratio  = basePr > 0 ? prob / basePr : 1;
const fillW  = (prob / maxP * 100).toFixed(1);
const barClr = anyOC ? ‘hsl(5,68%,52%)’ : ‘var(–primary)’;

```
html += `
  <tr title="${num} · P=${pct2(prob)} · ×${ratio.toFixed(1)} vs uniform">
    <td style="color:var(--muted-foreground);font-size:.7rem;">${i + 1}</td>
    <td class="pt-num${anyOC ? ' oc-dim' : ''}">${num}${anyOC ? '<sup style="font-size:.55rem;color:hsl(5,68%,50%);">⚠</sup>' : ''}</td>
    <td class="pt-mir">${isSelf ? '—' : mir}</td>
    <td style="min-width:80px;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600;">${pct2(prob)}</div>
      <div class="pt-bar"><div class="pt-bar-fill" style="width:${fillW}%;background:${barClr};"></div></div>
    </td>
    <td style="width:0;padding:0;"></td>
    <td style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:.75rem;font-weight:${ratio >= 2 ? '700' : '400'};color:${ratio >= 2 ? 'hsl(142,55%,40%)' : 'var(--muted-foreground)'};">×${ratio.toFixed(1)}</td>
  </tr>`;
```

});

html += `</tbody></table> <p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55;"> ⚠ = contains a digit scored &gt;24 % (overconfident zone). Mirror: "59" covers "95" — always buy both. </p>`;
$(‘numPredTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3b — UNORDERED PAIRS
// ═══════════════════════════════════════════════════════════════════════════
function renderPairTable(model) {
const { digitMeta, numProbs } = model;
const pairMap = {};
DIGITS.forEach(a => DIGITS.forEach(b => {
if (b < a) return;
const key  = a + b;
const p    = a === b ? numProbs[a + b] : numProbs[a + b] + numProbs[b + a];
pairMap[key] = { a, b, prob: p, anyOC: digitMeta[a].isOC || digitMeta[b].isOC };
}));

const sorted = Object.values(pairMap).sort((x, y) => y.prob - x.prob).slice(0, topN);
const maxP   = sorted[0].prob;

let html = `<table class="pt"><thead><tr>
<th>#</th><th>Pair</th><th>Tickets</th><th colspan="2">Combined P</th><th></th>

  </tr></thead><tbody>`;

sorted.forEach(({ a, b, prob, anyOC }, i) => {
const isSame = a === b;
const t1 = a + b;
const t2 = isSame ? ‘—’ : b + a;
const fillW = (prob / maxP * 100).toFixed(1);
const barClr = anyOC ? ‘hsl(5,68%,52%)’ : ‘hsl(142,55%,44%)’;
html += ` <tr title="{${a},${b}} combined P=${pct2(prob)}"> <td style="color:var(--muted-foreground);font-size:.7rem;">${i + 1}</td> <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)${anyOC ? ';opacity:.6' : ''};">{${a},${b}}</td> <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground);">${t1}${isSame ? '' : ' + ' + t2}</td> <td style="min-width:80px;"> <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600;">${pct2(prob)}</div> <div class="pt-bar"><div class="pt-bar-fill" style="width:${fillW}%;background:${barClr};"></div></div> </td> <td style="width:0;padding:0;"></td> <td style="text-align:right;font-size:.65rem;">${anyOC ? '<span class="cpill cpill-red">⚠ OC</span>' : ''}</td> </tr>`;
});

html += `</tbody></table> <p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55;"> Symmetry confirmed. {5,9} covers "59" + "95". Combined P = 2×P(5)×P(9). OC = overconfident. </p>`;
$(‘pairTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 4 — N-DRAW LOOKAHEAD
// ═══════════════════════════════════════════════════════════════════════════
function renderLookahead(model) {
const { digitMeta } = model;
const Ns = [1, 2, 3, 4, 6];
const topDigits = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 7);

let html = `<table class="la-tbl"><thead><tr> <th>Digit</th><th>Score</th> ${Ns.map(n => `<th>Next ${n}</th>`).join(’’)}
<th>Confidence</th>

  </tr></thead><tbody>`;

topDigits.forEach(d => {
const m = digitMeta[d];
html += `<tr title="Digit ${d}: score ${pct2(m.prob)} · ${m.since} draws since last"> <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.0625rem;">${d}</td> <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:${m.isOC ? 'hsl(5,68%,48%)' : 'var(--foreground)'};">${pct1(m.prob)}</td>`;

```
Ns.forEach(N => {
  const rawP = cumulP(m.pDraw, N);
  const adjP = m.isOC ? rawP * OC_CORRECTION : rawP;
  let cls = 'la-lo';
  if ((m.isOC ? adjP : rawP) >= 0.75) cls = 'la-hi';
  else if ((m.isOC ? adjP : rawP) >= 0.45) cls = 'la-med';

  if (m.isOC) {
    html += `<td><div class="la-oc">${pct1(rawP)}</div><div style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:hsl(5,68%,48%);font-weight:600;">~${pct1(adjP)}</div></td>`;
  } else {
    html += `<td class="${cls}">${pct1(rawP)}</td>`;
  }
});

let pill;
if      (m.isOC)    pill = `<span class="cpill cpill-red">Overconfident ↓</span>`;
else if (m.isElev)  pill = `<span class="cpill cpill-amber">Elevated</span>`;
else if (m.isCalib) pill = `<span class="cpill cpill-green">Calibrated ✓</span>`;
else                pill = `<span class="cpill cpill-muted">Low</span>`;
html += `<td style="text-align:left;">${pill}</td></tr>`;
```

});

html += `</tbody></table> <p style="font-size:.7rem;color:var(--muted-foreground);margin-top:.625rem;line-height:1.55;"> OC digits: raw estimate struck through, adjusted value shown (×0.73 from backtest). Green ≥75 %, amber ≥45 %. Still estimates — not guarantees. </p>`;
$(‘lookaheadTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 5 — WALK-FORWARD BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

/**

- Run walk-forward backtest.
- For each draw i (from startIdx), train on all draws before i, predict draw i.
- In cutoff mode, startIdx points to first draw after the cutoff date.
  */
  function runBacktest() {
  const { startIdx, isCutoffMode } = getBacktestRange();
  const N = allDraws.length;
  if (startIdx < 0 || startIdx >= N) return [];

const results = [];

for (let i = Math.max(MIN_HIST, startIdx); i < N; i++) {
const seq   = allDraws.slice(0, i).map(d => d.twoNum);
const model = computeModel(seq, recW);
if (!model) continue;

```
const { numProbs, digitMeta } = model;

// Sorted numbers for prediction list
const sortedNums = Object.entries(numProbs).sort((a, b) => b[1] - a[1]);
const topList    = sortedNums.slice(0, topN);   // [{num, prob}]
const topNums    = topList.map(([n]) => n);

const actual  = allDraws[i].twoNum;
const dateStr = allDraws[i].dateStr;

// Probability of actual result in the model
const actualProb    = numProbs[actual]        || 0;
const mirrorProb    = numProbs[mirror(actual)] || 0;
const actualPairP   = actual === mirror(actual) ? actualProb : Math.max(actualProb, mirrorProb);

// Pair hit = actual or its mirror is in top list
const pairHit   = topNums.includes(actual) || topNums.includes(mirror(actual));
// Which prediction number matched (for display)
const matchedPredNum = topNums.includes(actual) ? actual
                     : topNums.includes(mirror(actual)) ? mirror(actual)
                     : null;

// Top 3 digits at prediction time (for display)
const topDigitsDisplay = DIGITS.slice()
  .sort((a, b) => digitMeta[b].prob - digitMeta[a].prob)
  .slice(0, 3)
  .map(d => ({ d, prob: digitMeta[d].prob, isOC: digitMeta[d].isOC }));

// OC flags for top prediction numbers
const topListWithMeta = topList.map(([num, prob]) => ({
  num, prob,
  isOC: digitMeta[num[0]].isOC || digitMeta[num[1]].isOC,
}));

// Horizon hits: first pair hit within window starting at draw i+k (k=0 is current draw)
// +2 = within draws i through i+1
// +4 = within draws i through i+3
function firstHitInWindow(fromOffset, windowSize) {
  for (let k = fromOffset; k < windowSize && (i + k) < N; k++) {
    const a = allDraws[i + k].twoNum;
    if (topNums.includes(a) || topNums.includes(mirror(a))) {
      const predNum = topNums.includes(a) ? a : mirror(a);
      return {
        drawn: a,
        predNum,
        dateStr: allDraws[i + k].dateStr,
        offset: k,    // 0 = same draw, 1 = next draw, etc.
        prob: numProbs[a] || 0,
      };
    }
  }
  return null;
}

// hit2: first hit in draws i through i+1 (window of 2)
// hit4: first hit in draws i through i+3 (window of 4)
const hit2info = firstHitInWindow(0, 2);
const hit4info = firstHitInWindow(0, 4);

results.push({
  i, dateStr, actual,
  actualProb, actualPairP, mirrorProb,
  topListWithMeta, topNums,
  pairHit, matchedPredNum,
  topDigitsDisplay,
  hit2info, hit4info,
});
```

}
return results;
}

function renderBacktest() {
const btAll = runBacktest();
const { isCutoffMode, startIdx } = getBacktestRange();

if (!btAll.length) {
$(‘btSummary’).innerHTML = ‘’;
$(‘btGrid’).innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0;">${ isCutoffMode && startIdx < 0 ? 'No draws found after the selected cutoff date.' : 'Not enough data.' }</p>`;
return;
}

const totalN    = btAll.length;
const pairRate  = btAll.filter(r => r.pairHit).length / totalN;
const hit2Rate  = btAll.filter(r => r.hit2info).length / totalN;
const hit4Rate  = btAll.filter(r => r.hit4info).length / totalN;
const avgActualP = btAll.reduce((s, r) => s + r.actualPairP, 0) / totalN;

const cutoffNote = isCutoffMode
? `<div class="bt-sum-item"> <div class="bt-sum-lbl">Mode</div> <div class="bt-sum-val" style="font-size:.75rem;color:hsl(38,78%,42%);">Cutoff → ${predCutoff}</div> </div>`
: ‘’;

$(‘btSummary’).innerHTML = ` ${cutoffNote} <div class="bt-sum-item"> <div class="bt-sum-lbl">Draws tested</div> <div class="bt-sum-val">${totalN}</div> </div> <div class="bt-sum-item"> <div class="bt-sum-lbl">Pair hit rate</div> <div class="bt-sum-val" style="color:${pairRate > 0.055 ? 'hsl(142,55%,40%)' : 'var(--foreground)'};">${(pairRate*100).toFixed(1)}%</div> </div> <div class="bt-sum-item"> <div class="bt-sum-lbl">Pair hit in 2 draws</div> <div class="bt-sum-val">${(hit2Rate*100).toFixed(1)}%</div> </div> <div class="bt-sum-item"> <div class="bt-sum-lbl">Pair hit in 4 draws</div> <div class="bt-sum-val">${(hit4Rate*100).toFixed(1)}%</div> </div> <div class="bt-sum-item"> <div class="bt-sum-lbl">Avg prob of actual</div> <div class="bt-sum-val" style="color:var(--muted-foreground);">${(avgActualP*100).toFixed(2)}%</div> </div> <div class="bt-sum-item"> <div class="bt-sum-lbl">Random baseline (top ${topN})</div> <div class="bt-sum-val" style="color:var(--muted-foreground);">${topN}%</div> </div>`;

// Table — most recent btRows entries
const recent = btAll.slice(-btRows);

// Header
let grid = `<div class="bt-hdr">
<div>Date</div>
<div>Drawn</div>
<div>Digits at prediction</div>
<div>Top predictions (prob · <span style="color:hsl(5,68%,55%);">⚠OC</span>)</div>
<div style="text-align:center">Pair</div>
<div style="text-align:center">+2 hit</div>
<div style="text-align:center">+4 hit</div>

  </div>`;

recent.forEach(r => {
// ── Digit pills ──
const digitPills = r.topDigitsDisplay.map(({ d, prob, isOC }) => {
const col = isOC ? ‘hsl(5,68%,48%)’ : prob >= CALIB_LO ? ‘hsl(142,55%,40%)’ : ‘var(–muted-foreground)’;
return `<span style="font-family:'JetBrains Mono',monospace;font-size:.7rem;font-weight:600;color:${col};white-space:nowrap;">${d}<span style="font-weight:400;font-size:.65rem;"> ${pct1(prob)}${isOC ? '⚠' : ''}</span></span>`;
}).join(’<span style="color:var(--border);margin:0 .2rem;">·</span>’);

```
// ── Prediction chips ──
// Show top 10, highlight pair hit in green, OC in red border
const chips = r.topListWithMeta.slice(0, 10).map(({ num, prob, isOC }) => {
  const isMatch = num === r.actual || num === mirror(r.actual);
  let cls = 'bt-chip';
  if (isMatch)     cls += ' pair-hit';
  else if (isOC)   cls += ' oc-chip';
  const probStr = (prob * 100).toFixed(1);
  return `<span class="${cls}" title="${num} · P=${pct2(prob)}${isOC ? ' · OVERCONFIDENT digit' : ''}">${num}<sup style="font-size:.5rem;opacity:.7;">${probStr}%${isOC ? '⚠' : ''}</sup></span>`;
}).join('');

// ── Pair result cell ──
let pairCell;
if (r.pairHit) {
  const matched = r.matchedPredNum;
  const wasExact = matched === r.actual;
  pairCell = `<div class="bt-cell bt-pair-col">
    <div style="font-weight:700;font-size:.75rem;">${r.actual}</div>
    ${!wasExact ? `<div style="font-size:.6rem;color:var(--muted-foreground);">via ${matched}</div>` : ''}
    <div style="font-size:.6rem;color:hsl(215,75%,50%);">${(r.actualProb * 100).toFixed(1)}%</div>
  </div>`;
} else {
  pairCell = `<div class="bt-cell bt-no">—</div>`;
}

// ── Horizon hit cells ──
function horizonCell(info, cssClass) {
  if (!info) return `<div class="bt-cell bt-no">—</div>`;
  const isSameDraw = info.offset === 0;
  return `<div class="bt-cell ${cssClass}">
    <div style="font-weight:700;font-size:.75rem;">${info.drawn}</div>
    <div style="font-size:.6rem;opacity:.75;">${isSameDraw ? 'draw 0' : '+' + info.offset}</div>
    <div style="font-size:.6rem;">${(info.prob * 100).toFixed(1)}%</div>
  </div>`;
}

const h2Cell = horizonCell(r.hit2info, 'bt-pair-col');
const h4Cell = horizonCell(r.hit4info, 'bt-pair-col');

// ── Actual number colour ──
const actualColor = r.pairHit ? 'hsl(142,55%,40%)' : 'var(--foreground)';

grid += `<div class="bt-row">
  <div class="bt-date">${r.dateStr}</div>
  <div>
    <div class="bt-actual" style="color:${actualColor};">${r.actual}</div>
    <div style="font-size:.6rem;color:var(--muted-foreground);font-family:'JetBrains Mono',monospace;">${(r.actualPairP*100).toFixed(2)}%</div>
  </div>
  <div style="display:flex;flex-direction:column;gap:.2rem;justify-content:center;">${digitPills}</div>
  <div class="bt-chips">${chips}</div>
  ${pairCell}${h2Cell}${h4Cell}
</div>`;
```

});

$(‘btGrid’).innerHTML = grid;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════
init().catch(err => {
setStatus(’’, ’Failed to load: ’ + err.message);
console.error(‘predictions.js:’, err);
});
