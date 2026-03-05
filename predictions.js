‘use strict’;
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto · Two-Digit Prize — Probability Model (predictions.js)
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
let allDraws = [];
let recW     = 20;
// trainWin is always 0 (all draws) — no longer user-configurable
let topN     = 15;
let btRows   = 20;
let cutoffN  = 0;   // 0 = use all draws; >0 = train on draws 0..cutoffN-1

// ── DOM helpers ───────────────────────────────────────────────────────────
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
$(‘topNSel’).addEventListener(‘change’,   e => { topN   = +e.target.value; renderAll(); });
$(‘btRowsSel’).addEventListener(‘change’, e => { btRows = +e.target.value; renderAll(); });

$(‘recSlider’).addEventListener(‘input’, e => {
recW = +e.target.value;
$(‘recLbl’).textContent  = recW;
$(‘recLbl2’).textContent = recW;
renderAll();
});

$(‘cutoffInput’).addEventListener(‘input’, e => {
const v = parseInt(e.target.value, 10);
cutoffN = isNaN(v) || v < 0 ? 0 : v;
updateCutoffInfo();
renderAll();
});

function updateCutoffInfo() {
const el = $(‘cutoffInfo’);
if (!el) return;
if (!allDraws.length) { el.innerHTML = ‘’; return; }

if (cutoffN <= 0) {
el.innerHTML = `Using all <strong>${allDraws.length}</strong> draws for training.`;
el.style.color = ‘’;
return;
}

const effectiveN = Math.min(cutoffN, allDraws.length);
const trainEnd   = allDraws[effectiveN - 1];

if (effectiveN >= allDraws.length) {
el.innerHTML = `Train: all ${allDraws.length} draws (to ${trainEnd.dateStr}) · Next: <strong style="color:var(--muted-foreground)">unknown (future)</strong>`;
} else {
const next = allDraws[effectiveN];
el.innerHTML = `Train: draws 1–${effectiveN} (to <em>${trainEnd.dateStr}</em>) · `
+ `Next result: <strong style="color:hsl(142,55%,40%)">${next.twoNum}</strong> on ${next.dateStr}`;
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
const tx  = ev.target.result.transaction(STORE_NAME, ‘readonly’);
const get = tx.objectStore(STORE_NAME).get(CACHE_KEY);
get.onsuccess = () => resolve(get.result || null);
get.onerror   = () => resolve(null);
};
req.onerror = () => resolve(null);
});
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
setStatus(’’, ‘Loading data from cache…’);
const cached = await loadCache();

if (!cached || !cached.data || !Object.keys(cached.data).length) {
setStatus(‘empty’, ‘No data. Open the Analyzer page first to load data, then return here.’);
return;
}

allDraws = Array.from(new Map(Object.entries(cached.data)).entries())
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

updateCutoffInfo();
renderAll();
}

function setStatus(state, txt) {
$(‘statusText’).textContent = txt;
const dot = $(‘statusDot’);
dot.className = ‘status-dot’ + (state === ‘live’ ? ’ live’ : ‘’);
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
seq.slice(-safeW).forEach(num => { recCount[num[0]]++; recCount[num[1]]++; });
seq.forEach(num =>              { baseCount[num[0]]++; baseCount[num[1]]++; });
const baseTotal = n * 2;

const lastSeen = Object.fromEntries(DIGITS.map(d => [d, -1]));
const gapLists = Object.fromEntries(DIGITS.map(d => [d, []]));
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
const avgGap   = gaps.length >= 2 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 5.0;
const since    = lastSeen[d] >= 0 ? (n - 1 - lastSeen[d]) : n;
const ovRatio  = avgGap > 0 ? Math.min(since / avgGap, OV_CAP) : 0;
rawScore[d] = W_REC * recFreq + W_OV * (ovRatio / OV_CAP) + W_BASE * baseFreq;
meta[d] = { recFreq, baseFreq, avgGap, since, ovRatio, gapCount: gaps.length, lastIdx: lastSeen[d] };
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

// ── Per-number overdue stats ──
const _numLS    = {};
const numGapMap = {};
seq.forEach((num, i) => {
if (_numLS[num] !== undefined) {
numGapMap[num] = numGapMap[num] || [];
numGapMap[num].push(i - _numLS[num]);
}
_numLS[num] = i;
});
const numSince = {};
DIGITS.forEach(a => DIGITS.forEach(b => {
const num = a + b;
numSince[num] = _numLS[num] !== undefined ? (n - 1 - _numLS[num]) : null;
}));

return { digitProb, digitMeta: meta, numProbs, numSince, numGapMap, n };
}

function cumulP(pDraw, N) { return 1 - Math.pow(1 - pDraw, N); }

function getSlice() {
if (cutoffN > 0 && cutoffN < allDraws.length) return allDraws.slice(0, cutoffN);
return allDraws;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════
function renderAll() {
const slice = getSlice();
const seq   = slice.map(d => d.twoNum);
const model = computeModel(seq, recW);

renderStatCards(slice, model);
if (!model) {
[‘digitBars’,‘numPredTable’,‘pairTable’,‘lookaheadTable’,‘btSummary’,‘btGrid’]
.forEach(id => { if ($(id)) $(id).innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Not enough data (minimum ${MIN_HIST} draws).</p>`; });
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
const total = allDraws.length;
const last  = allDraws[total - 1];
let topDStr = ‘—’, topPStr = ‘—’, topOCStr = ‘’;

if (model) {
const topD = DIGITS.slice().sort((a, b) => model.digitProb[b] - model.digitProb[a])[0];
topDStr  = topD;
topPStr  = pct1(model.digitProb[topD]);
topOCStr = model.digitMeta[topD].isOC ? ’ ⚠ overconfident’ : model.digitMeta[topD].isCalib ? ’ ✓ calibrated’ : ‘’;
}

$(‘statCards’).innerHTML = ` <div class="stat-card"> <div class="stat-card-label">Total draws in DB</div> <div class="stat-card-value">${total}</div> <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${last?.dateStr}</div> </div> <div class="stat-card"> <div class="stat-card-label">Training window</div> <div class="stat-card-value">${slice.length}</div> <div class="stat-card-sub">${slice[0]?.dateStr} → ${slice[slice.length - 1]?.dateStr}</div> </div> <div class="stat-card"> <div class="stat-card-label">Last result (TWO)</div> <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div> <div class="stat-card-sub">${last?.dateStr || ''}</div> </div> <div class="stat-card"> <div class="stat-card-label">Top digit now</div> <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;${model?.digitMeta[topDStr]?.isOC ? 'color:hsl(5,68%,48%)' : 'color:var(--primary)'}">${topDStr}</div> <div class="stat-card-sub">${topPStr} model score${topOCStr}</div> </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DIGIT BARS  (enhanced overdue: since/avgGap/ratio)
// ═══════════════════════════════════════════════════════════════════════════
function renderDigitBars(model) {
const { digitMeta } = model;
const wrap   = $(‘digitBars’);
wrap.innerHTML = ‘’;
const sorted = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob);
const maxP   = digitMeta[sorted[0]].prob;

const hdr = document.createElement(‘div’);
hdr.className = ‘dbar-hdr’;
hdr.innerHTML = ` <div style="text-align:center">D</div> <div>Score bar <span style="opacity:.45;font-weight:400;font-size:.55rem;">(▏= 10% baseline)</span></div> <div style="text-align:right">Score</div> <div style="text-align:right">vs base</div> <div style="text-align:right">Overdue (since/avg)</div> <div></div>`;
wrap.appendChild(hdr);

sorted.forEach(d => {
const m   = digitMeta[d];
const exc = m.excessVsBase >= 0 ? ‘+’ + pct1(m.excessVsBase) : pct1(m.excessVsBase);

```
let barColor, pill;
if      (m.isOC)    { barColor = 'hsl(5,68%,52%)';   pill = `<span class="cpill cpill-red">OC ↓</span>`; }
else if (m.isElev)  { barColor = 'hsl(38,78%,52%)';  pill = `<span class="cpill cpill-amber">Elevated</span>`; }
else if (m.isCalib) { barColor = 'hsl(142,55%,44%)'; pill = `<span class="cpill cpill-green">Calibrated ✓</span>`; }
else                { barColor = 'var(--primary)';   pill = `<span class="cpill cpill-muted">Low</span>`; }

const fillPct     = (m.prob / maxP * 100).toFixed(1);
const baselinePct = Math.min(99, (0.10 / maxP * 100)).toFixed(1);
const overdueColor = m.ovRatio >= 2.0 ? 'hsl(5,68%,48%)' : m.ovRatio >= 1.0 ? 'hsl(38,78%,42%)' : 'var(--muted-foreground)';
const overdueStr   = `${m.since} / ${m.avgGap.toFixed(1)}${m.ovRatio > 1.0 ? ` ×${m.ovRatio.toFixed(1)}` : ''}`;

const row = document.createElement('div');
row.className = 'dbar-row';
row.title = `Digit ${d}: score ${pct2(m.prob)} · base ${pct2(m.baseFreq)} · avg gap ${m.avgGap.toFixed(1)} · ${m.since} since last · overdue ×${m.ovRatio.toFixed(2)}`;
row.innerHTML = `
  <div class="dbar-lbl">${d}</div>
  <div class="dbar-track">
    <div class="dbar-fill" style="width:${fillPct}%;background:${barColor};"></div>
    <div class="dbar-baseline" style="left:${baselinePct}%;"></div>
  </div>
  <div class="dbar-score" style="color:${m.isOC ? 'hsl(5,68%,48%)' : m.isCalib ? 'hsl(142,55%,40%)' : 'var(--foreground)'};">${pct1(m.prob)}</div>
  <div class="dbar-excess" style="color:${m.excessVsBase >= 0 ? 'hsl(142,55%,40%)' : 'hsl(5,68%,48%)'};">${exc}</div>
  <div class="dbar-since" style="color:${overdueColor};${m.ovRatio >= 2 ? 'font-weight:600;' : ''}">${overdueStr}</div>
  <div>${pill}</div>`;
wrap.appendChild(row);
```

});
}

// ═══════════════════════════════════════════════════════════════════════════
//  NUMBER PREDICTION TABLE  (+ per-number overdue stats)
// ═══════════════════════════════════════════════════════════════════════════
function renderNumPredTable(model) {
const { numProbs, digitMeta, numSince, numGapMap } = model;
const sorted = Object.entries(numProbs).sort((a, b) => b[1] - a[1]).slice(0, topN);
const maxP   = sorted[0][1];

let html = `<table class="pt"><thead><tr>
<th>#</th><th>Number</th><th>Mirror</th><th colspan="2">Probability</th>
<th style="text-align:right">×base</th>
<th style="text-align:right">Since drawn</th>

  </tr></thead><tbody>`;

sorted.forEach(([num, prob], i) => {
const mir    = mirror(num);
const isSelf = num === mir;
const aOC    = digitMeta[num[0]].isOC;
const bOC    = digitMeta[num[1]].isOC;
const anyOC  = aOC || bOC;
const basePr = digitMeta[num[0]].baseFreq * digitMeta[num[1]].baseFreq;
const ratio  = basePr > 0 ? prob / basePr : 1;
const fillW  = (prob / maxP * 100).toFixed(1);
const barClr = anyOC ? ‘hsl(5,68%,52%)’ : ‘var(–primary)’;

```
const since     = numSince[num];
const gaps      = numGapMap[num] || [];
const avgG      = gaps.length >= 2 ? Math.round(gaps.reduce((a,b) => a+b, 0) / gaps.length) : null;
const sinceStr  = since === null ? 'never' : since === 0 ? '0 (last)' : `${since}`;
const avgStr    = avgG !== null ? ` (avg ${avgG})` : '';
const sinceCls  = since === null ? 'hsl(5,68%,48%)' : since > 40 ? 'hsl(38,78%,42%)' : 'var(--muted-foreground)';

html += `
  <tr title="${num}${isSelf?'':' + '+mir} · P=${pct2(prob)} · ×${ratio.toFixed(1)} vs base · last drawn ${sinceStr} draws ago${avgStr}">
    <td style="color:var(--muted-foreground);font-size:.7rem;padding-right:.25rem;">${i+1}</td>
    <td class="pt-num${anyOC ? ' oc-dim' : ''}">${num}${anyOC ? '<sup style="font-size:.55rem;color:hsl(5,68%,50%);">⚠</sup>' : ''}</td>
    <td class="pt-mir">${isSelf ? '—' : mir}</td>
    <td style="min-width:80px;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600;">${pct2(prob)}</div>
      <div class="pt-bar"><div class="pt-bar-fill" style="width:${fillW}%;background:${barClr};"></div></div>
    </td>
    <td style="width:0;padding:0;"></td>
    <td style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:.75rem;font-weight:${ratio >= 2 ? '700' : '400'};color:${ratio >= 2 ? 'hsl(142,55%,40%)' : 'var(--muted-foreground)'};">×${ratio.toFixed(1)}</td>
    <td style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:.68rem;color:${sinceCls};">${sinceStr}${avgStr}</td>
  </tr>`;
```

});

html += `</tbody></table> <p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55;"> ⚠ = digit scored &gt;24% (overconfident) — backtest hit only 13.8%. "Since drawn" = draws since this exact number last appeared in training data. Mirror "59" covers "95". </p>`;
$(‘numPredTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  UNORDERED PAIRS TABLE
// ═══════════════════════════════════════════════════════════════════════════
function renderPairTable(model) {
const { digitMeta, numProbs } = model;
const pairMap = {};
DIGITS.forEach(a => {
DIGITS.forEach(b => {
if (b < a) return;
const key = a + b;
const p   = a === b ? numProbs[a + b] : numProbs[a + b] + numProbs[b + a];
pairMap[key] = { a, b, prob: p, anyOC: digitMeta[a].isOC || digitMeta[b].isOC };
});
});

const sorted = Object.values(pairMap).sort((x, y) => y.prob - x.prob).slice(0, topN);
const maxP   = sorted[0].prob;

let html = `<table class="pt"><thead><tr>
<th>#</th><th>Pair</th><th>Both tickets</th><th colspan="2">Combined P</th><th style="text-align:right">Caution</th>

  </tr></thead><tbody>`;

sorted.forEach(({ a, b, prob, anyOC }, i) => {
const isSame = a === b;
const fillW  = (prob / maxP * 100).toFixed(1);
const barClr = anyOC ? ‘hsl(5,68%,52%)’ : ‘hsl(142,55%,44%)’;
html += ` <tr> <td style="color:var(--muted-foreground);font-size:.7rem;">${i+1}</td> <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)${anyOC?';opacity:.6':''}">{${a},${b}}</td> <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground);">${a+b}${isSame?'':' + '+b+a}</td> <td style="min-width:80px;"> <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600;">${pct2(prob)}</div> <div class="pt-bar"><div class="pt-bar-fill" style="width:${fillW}%;background:${barClr};"></div></div> </td> <td style="width:0;padding:0;"></td> <td style="text-align:right;font-size:.65rem;">${anyOC ? '<span class="cpill cpill-red">⚠ OC</span>' : ''}</td> </tr>`;
});

html += `</tbody></table> <p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55;"> Symmetry confirmed: {5,9} covers "59" and "95". Combined P = 2×P(5)×P(9). Always buy both orientations. </p>`;
$(‘pairTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  N-DRAW LOOKAHEAD  (+ overdue column)
// ═══════════════════════════════════════════════════════════════════════════
function renderLookahead(model) {
const { digitMeta } = model;
const Ns = [1, 2, 3, 4, 6];
const topDigits = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 7);

let html = `<table class="la-tbl"><thead><tr> <th>Digit</th><th>Score</th> ${Ns.map(n => `<th>Next ${n} draw${n > 1 ? ‘s’ : ‘’}</th>`).join(’’)}
<th>Overdue</th>
<th>Confidence</th>

  </tr></thead><tbody>`;

topDigits.forEach(d => {
const m    = digitMeta[d];
const isOC = m.isOC;
const overdueColor = m.ovRatio >= 2 ? ‘hsl(5,68%,48%)’ : m.ovRatio >= 1 ? ‘hsl(38,78%,42%)’ : ‘var(–muted-foreground)’;
const overdueStr   = `${m.since} / ${m.avgGap.toFixed(1)}${m.ovRatio > 1 ? ` ×${m.ovRatio.toFixed(1)}` : ''}`;

```
html += `<tr title="Digit ${d}: score ${pct2(m.prob)} · ${m.since} draws since last · avg gap ${m.avgGap.toFixed(1)}">
  <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.0625rem;">${d}</td>
  <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:${isOC ? 'hsl(5,68%,48%)' : 'var(--foreground)'};">${pct1(m.prob)}</td>`;

Ns.forEach(N => {
  const rawP = cumulP(m.pDraw, N);
  const adjP = isOC ? rawP * OC_CORRECTION : rawP;
  const disp = isOC ? adjP : rawP;
  let cls = 'la-lo';
  if      (disp >= 0.75) cls = 'la-hi';
  else if (disp >= 0.45) cls = 'la-med';
  if (isOC) {
    html += `<td><div class="la-oc">${pct1(rawP)}</div><div style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:hsl(5,68%,48%);font-weight:600;">~${pct1(adjP)}</div></td>`;
  } else {
    html += `<td class="${cls}">${pct1(rawP)}</td>`;
  }
});

let pill;
if      (isOC)      pill = `<span class="cpill cpill-red">Overconfident ↓</span>`;
else if (m.isElev)  pill = `<span class="cpill cpill-amber">Elevated</span>`;
else if (m.isCalib) pill = `<span class="cpill cpill-green">Calibrated ✓</span>`;
else                pill = `<span class="cpill cpill-muted">Low</span>`;

html += `
  <td style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:${overdueColor};font-weight:${m.ovRatio >= 2 ? '600' : '400'};">${overdueStr}</td>
  <td style="text-align:left;">${pill}</td></tr>`;
```

});

html += `</tbody></table> <p style="font-size:.7rem;color:var(--muted-foreground);margin-top:.625rem;line-height:1.55;"> Overdue = draws since last seen / avg gap. ×1.0 = due on schedule, ×2.0+ = very late. OC digits struck through; ×0.73 adjusted value shown. </p>`;
$(‘lookaheadTable’).innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WALK-FORWARD BACKTEST
// ═══════════════════════════════════════════════════════════════════════════
function runBacktest() {
const startIdx = cutoffN > 0 ? Math.max(MIN_HIST, cutoffN) : MIN_HIST;
const N        = allDraws.length;
const results  = [];

for (let i = startIdx; i < N; i++) {
const seq   = allDraws.slice(0, i).map(d => d.twoNum);
const model = computeModel(seq, recW);
if (!model) continue;

```
const { numProbs, digitMeta } = model;
const sortedNums  = Object.entries(numProbs).sort((a, b) => b[1] - a[1]);
const topNums     = sortedNums.slice(0, topN).map(([n]) => n);
const topListMeta = sortedNums.slice(0, topN).map(([num, prob]) => ({
  num, prob, isOC: digitMeta[num[0]].isOC || digitMeta[num[1]].isOC
}));

const actual  = allDraws[i].twoNum;
const dateStr = allDraws[i].dateStr;

const pairHit    = topNums.includes(actual) || topNums.includes(mirror(actual));
const matchedNum = topNums.includes(actual) ? actual : topNums.includes(mirror(actual)) ? mirror(actual) : null;
const actualProb = numProbs[actual] || 0;

// Top 3 predicted digits at this step
const top3digits = DIGITS.slice()
  .sort((a, b) => digitMeta[b].prob - digitMeta[a].prob)
  .slice(0, 3)
  .map(d => ({ d, prob: digitMeta[d].prob, isOC: digitMeta[d].isOC }));

// First pair hit within window — returns drawn number, matched predicted number, offset, and model P
function firstHit(windowSize) {
  for (let k = 0; k < windowSize && (i + k) < N; k++) {
    const drawn = allDraws[i + k].twoNum;
    if (topNums.includes(drawn)) {
      return { drawn, predNum: drawn, offset: k, prob: numProbs[drawn] || 0 };
    }
    const mir = mirror(drawn);
    if (topNums.includes(mir)) {
      return { drawn, predNum: mir, offset: k, prob: numProbs[mir] || 0 };
    }
  }
  return null;
}

results.push({
  i, dateStr, actual, actualProb, pairHit, matchedNum,
  topListMeta, topNums, top3digits,
  hit2: firstHit(2),
  hit4: firstHit(4),
});
```

}
return results;
}

function renderBacktest() {
const btAll = runBacktest();

if (!btAll.length) {
$(‘btSummary’).innerHTML = ‘’;
$(‘btGrid’).innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Not enough data${cutoffN > 0 ? ` — cutoff (${cutoffN}) leaves no test draws` : ''}.</p>`;
return;
}

const totalN   = btAll.length;
const pairRate = btAll.filter(r => r.pairHit).length / totalN;
const hit2Rate = btAll.filter(r => r.hit2).length    / totalN;
const hit4Rate = btAll.filter(r => r.hit4).length    / totalN;
const avgActP  = btAll.reduce((s, r) => s + r.actualProb, 0) / totalN;

$(‘btSummary’).innerHTML = ` <div class="bt-sum-item"><div class="bt-sum-lbl">Draws tested</div><div class="bt-sum-val">${totalN}</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Pair hit rate</div><div class="bt-sum-val" style="color:${pairRate > 0.055 ? 'hsl(142,55%,40%)' : 'var(--foreground)'};">${(pairRate * 100).toFixed(1)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Hit in 2 draws</div><div class="bt-sum-val">${(hit2Rate * 100).toFixed(1)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Hit in 4 draws</div><div class="bt-sum-val">${(hit4Rate * 100).toFixed(1)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Avg P(actual)</div><div class="bt-sum-val" style="color:var(--muted-foreground);">${(avgActP * 100).toFixed(2)}%</div></div> <div class="bt-sum-item"><div class="bt-sum-lbl">Random baseline</div><div class="bt-sum-val" style="color:var(--muted-foreground);">${topN}%</div></div>`;

const recent = btAll.slice(-btRows);

let grid = `<div class="bt-hdr">
<div>Date</div>
<div>Drawn</div>
<div>Top 3 digits</div>
<div>Predicted numbers  <span style="font-weight:400;opacity:.6">(P%)</span></div>
<div style="text-align:center">Pair</div>
<div style="text-align:center">+2 draws</div>
<div style="text-align:center">+4 draws</div>

  </div>`;

recent.forEach(r => {
const actualDigits = new Set([r.actual[0], r.actual[1]]);

```
// ── Top 3 digit column: underline digits that appeared in actual result ──
const digitCol = r.top3digits.map(({ d, prob, isOC }) => {
  const hit = actualDigits.has(d);
  return `<div style="display:flex;gap:.2rem;align-items:baseline;">
    <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.8rem;
      color:${hit ? 'hsl(142,55%,38%)' : isOC ? 'hsl(5,68%,48%)' : 'var(--foreground)'};
      ${hit ? 'text-decoration:underline dotted;' : ''}">${d}${isOC ? '<sup style="font-size:.5rem">⚠</sup>' : ''}</span>
    <span style="font-size:.6rem;color:${isOC ? 'hsl(5,68%,50%)' : 'var(--muted-foreground)'};">${pct1(prob)}</span>
  </div>`;
}).join('');

// ── Number chips: green = pair hit, red border = OC, each shows P% ──
const chips = r.topListMeta.slice(0, 10).map(({ num, prob, isOC }) => {
  const isHit = num === r.actual || num === mirror(r.actual);
  let cls = 'bt-chip';
  if      (isHit) cls += ' bt-chip-hit';
  else if (isOC)  cls += ' bt-chip-oc';
  return `<span class="${cls}" title="${num} · P=${pct2(prob)}${isOC ? ' ⚠ OC' : ''}">${num}<span class="bt-chip-p">${(prob * 100).toFixed(1)}</span></span>`;
}).join('');

// ── Pair hit cell ──
let pairCell;
if (r.pairHit) {
  const wasMirror = r.matchedNum !== r.actual;
  pairCell = `<div class="bt-result-cell">
    <span class="bt-result-num">${r.actual}</span>
    ${wasMirror ? `<span class="bt-result-sub">via&nbsp;${r.matchedNum}</span>` : ''}
    <span class="bt-result-prob">${(r.actualProb * 100).toFixed(2)}%</span>
  </div>`;
} else {
  pairCell = `<div class="bt-miss">—</div>`;
}

// ── +2 / +4 cells: show drawn number, offset, and model P at prediction time ──
const hitCell = info => {
  if (!info) return `<div class="bt-miss">—</div>`;
  return `<div class="bt-result-cell">
    <span class="bt-result-num">${info.drawn}</span>
    <span class="bt-result-sub">${info.offset === 0 ? 'same' : '+' + info.offset + ' draw' + (info.offset > 1 ? 's' : '')}</span>
    <span class="bt-result-prob">${(info.prob * 100).toFixed(2)}%</span>
  </div>`;
};

grid += `<div class="bt-row">
  <div class="bt-date">${r.dateStr}</div>
  <div>
    <div class="bt-actual" style="color:${r.pairHit ? 'hsl(142,55%,40%)' : 'var(--foreground)'};">${r.actual}</div>
    <div class="bt-actual-p">${(r.actualProb * 100).toFixed(2)}%</div>
  </div>
  <div class="bt-digit-col">${digitCol}</div>
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
setStatus(’’, ’Failed to load: ’ + err.message);
console.error(‘predictions.js:’, err);
});
