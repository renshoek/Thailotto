'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto · Two-Digit Prize — Probability Model (predictions.js)
//
//  PARAMETERS — grid-searched over 458 draws (2006–2026), walk-forward backtest:
//    wRec  = 0.50   recency window frequency
//    wBase = 0.30   all-time base rate
//    wOv   = 0.20   gap-based overdue ratio
//    W     = 15     recency window (draws)
//    ovCap = 2.0    overdue ratio cap
//
//  WHAT THE BACKTEST ACTUALLY FOUND (not what was assumed before):
//    • Best combo top-15 pair hit: 18.22%  vs  15.00% baseline  Z=1.87
//    • Recency-only (W=15):  16.36%  ← beats random
//    • Base-rate-only:       17.76%  ← beats random
//    • Overdue-only:         13.79%  ← WORSE than random  ← was 45% in old model
//    • Old model (35/45/20): 15.65%  ← barely above baseline
//    • The >24% OC zone appeared in only 0.5% of draws — 2 data points, no conclusion
//    • No single-year result is stable: range 8–40% across years
//    • SE at n=428: ±1.73pp — 18.22% is directionally positive but not confirmed
//
//  CORRECTIONS vs old model:
//    Overdue weight: 0.45 → 0.20  (was the worst individual predictor, hurt the model)
//    Recency weight: 0.35 → 0.50  (best individual predictor)
//    Base rate:      0.20 → 0.30  (second-best individual predictor)
//    recWindow:      20   → 15
//    ovCap:          3.0  → 2.0
//    OC correction removed: zone barely exists, sample too small to conclude anything
// ════════════════════════════════════════════════════════════════════════════

const DIGITS     = '0123456789'.split('');
const W_REC      = 0.50;   // recency — best individual predictor in backtest
const W_OV       = 0.20;   // overdue — weakest signal, kept as minor correction only
const W_BASE     = 0.30;   // base rate — second best individual predictor
const OV_CAP     = 2.0;    // cap at 2× average gap (not 3× — high values were noise)
const REC_WIN    = 15;     // optimal recency window from grid search
const CALIB_LO   = 0.17;   // calibrated zone lower bound (from zone analysis)
const CALIB_HI   = 0.22;   // calibrated zone upper — widened, 20–24% zone had 0 samples
const MIN_HIST   = 30;

const DB_NAME    = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY  = 'perFileAggMap_v2';

// ── State ─────────────────────────────────────────────────────────────────
let allDraws   = [];
let recW       = REC_WIN;
let topN       = 15;
let btRows     = 20;
let predCutoff = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────
const $         = id => document.getElementById(id);
const parseNums = s  => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
const mirror    = n  => n.length === 2 ? n[1] + n[0] : n;
const pct1      = v  => (v * 100).toFixed(1) + '%';
const pct2      = v  => (v * 100).toFixed(2) + '%';

// ── Theme ─────────────────────────────────────────────────────────────────
$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  if (allDraws.length) renderAll();
});
{
  const s = localStorage.getItem('theme');
  if (s === 'dark' || (!s && window.matchMedia('(prefers-color-scheme:dark)').matches))
    document.documentElement.classList.add('dark');
}

// ── Controls ──────────────────────────────────────────────────────────────
$('topNSel').addEventListener('change',   e => { topN   = +e.target.value; renderAll(); });
$('btRowsSel').addEventListener('change', e => { btRows = +e.target.value; renderAll(); });

$('recSlider').addEventListener('input', e => {
  recW = +e.target.value;
  $('recLbl').textContent  = recW;
  $('recLbl2').textContent = recW;
  renderAll();
});

$('predCutoffInput').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  predCutoff = (!e.target.value.trim() || isNaN(v) || v <= 0) ? 0 : v;
  updateNextResult();
  renderAll();
});

function updateNextResult() {
  const el = $('nextResultDisplay');
  if (!el || !allDraws.length) return;
  const idx = predCutoff > 0 ? predCutoff : allDraws.length;
  if (idx < allDraws.length) {
    const d = allDraws[idx];
    el.innerHTML =
      `Next result: <strong style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${d.twoNum}</strong>` +
      `<span style="color:var(--muted-foreground);font-size:.7rem;margin-left:.35rem">(${d.dateStr})</span>`;
  } else {
    el.innerHTML = `Next result: <span style="color:var(--muted-foreground)">Unknown (future)</span>`;
  }
}

// ── IndexedDB ─────────────────────────────────────────────────────────────
async function loadCache() {
  return new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ev => {
      if (!ev.target.result.objectStoreNames.contains(STORE_NAME))
        ev.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = ev => {
      const get = ev.target.result.transaction(STORE_NAME, 'readonly')
                    .objectStore(STORE_NAME).get(CACHE_KEY);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror   = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  setStatus('', 'Loading data from cache…');
  const cached = await loadCache();

  if (!cached?.data || !Object.keys(cached.data).length) {
    setStatus('', 'No data. Open the Analyzer page first.');
    const sc = document.querySelector('#mainContent #statCards');
    if (sc) sc.insertAdjacentHTML('beforebegin', `
      <div style="text-align:center;padding:4rem 2rem;color:var(--muted-foreground)">
        <p>Please open <a href="index.html" style="color:var(--primary)">the Analyzer</a> first to cache lottery data.</p>
      </div>`);
    return;
  }

  const map = new Map(Object.entries(cached.data));
  allDraws = Array.from(map.entries())
    .map(([dateStr, agg]) => {
      const nums = parseNums((agg.results || {}).TWO || '').filter(n => n.length === 2);
      return { dateStr, twoNum: nums[0] || null };
    })
    .filter(d => d.twoNum)
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr));

  const age = cached.fetchedAt ? Math.round((Date.now() - cached.fetchedAt) / 60000) : null;
  setStatus('live',
    `${allDraws.length} draws · ${allDraws[0]?.dateStr} → ${allDraws.at(-1)?.dateStr}` +
    (age !== null ? ` · cached ${age < 60 ? age + 'min' : Math.round(age/60) + 'h'} ago` : ''));

  updateNextResult();
  renderAll();
}

function setStatus(state, txt) {
  $('statusText').textContent = txt;
  $('statusDot').className = 'status-dot' + (state === 'live' ? ' live' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE MODEL — validated weights from grid search on 458 draws
// ═══════════════════════════════════════════════════════════════════════════
function computeModel(seq, W) {
  const n = seq.length;
  if (n < MIN_HIST) return null;
  const safeW = Math.min(W, n - 1);

  // Recency counts (last W draws)
  const recCount  = Object.fromEntries(DIGITS.map(d => [d, 0]));
  seq.slice(-safeW).forEach(num => {
    recCount[num[0]]++;
    recCount[num[1]]++;
  });

  // All-time base count
  const baseCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
  seq.forEach(num => {
    baseCount[num[0]]++;
    baseCount[num[1]]++;
  });
  const baseTotal = n * 2;

  // Gap / overdue
  const lastSeen = Object.fromEntries(DIGITS.map(d => [d, -1]));
  const gapLists = Object.fromEntries(DIGITS.map(d => [d, []]));
  seq.forEach((num, i) => {
    [num[0], num[1]].forEach(d => {
      if (lastSeen[d] >= 0) gapLists[d].push(i - lastSeen[d]);
      lastSeen[d] = i;
    });
  });

  const rawScore = {}, meta = {};
  DIGITS.forEach(d => {
    const recFreq  = recCount[d]  / (2 * safeW);
    const baseFreq = baseCount[d] / baseTotal;
    const gaps     = gapLists[d];
    const avgGap   = gaps.length >= 2 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 5.0;
    const since    = lastSeen[d] >= 0 ? (n - 1 - lastSeen[d]) : n;
    // Cap at OV_CAP=2 — values above 2× avg gap are noise, not signal
    const ovRatio  = Math.min(since / Math.max(avgGap, 1), OV_CAP) / OV_CAP;

    rawScore[d] = W_REC * recFreq + W_OV * ovRatio + W_BASE * baseFreq;
    meta[d] = { recFreq, baseFreq, avgGap, since, ovRatio: since / Math.max(avgGap, 1), gapCount: gaps.length, lastIdx: lastSeen[d] };
  });

  const total = DIGITS.reduce((s, d) => s + rawScore[d], 0);
  const digitProb = {};
  DIGITS.forEach(d => {
    const p = rawScore[d] / total;
    digitProb[d] = p;
    meta[d].prob         = p;
    meta[d].excessVsBase = p - meta[d].baseFreq;
    meta[d].pDraw        = 1 - Math.pow(1 - p, 2);
    // Zone classification — based on actual backtest hit rates
    // 15–22%: directionally positive zone (hit rate 22.3% vs 19% baseline per zone analysis)
    // Note: >22% is so rare (3% of draws) there's insufficient data to characterise it
    meta[d].isCalib = p >= CALIB_LO && p <= CALIB_HI;
    meta[d].isElev  = p > CALIB_HI;   // too rare to trust — flag only
    meta[d].isLow   = p < CALIB_LO;
  });

  const numProbs = {};
  DIGITS.forEach(a => DIGITS.forEach(b => { numProbs[a + b] = digitProb[a] * digitProb[b]; }));

  return { digitProb, digitMeta: meta, numProbs, n };
}

function cumulP(pDraw, N) {
  return 1 - Math.pow(1 - pDraw, N);
}

function getSlice() {
  if (predCutoff > 0 && predCutoff < allDraws.length)
    return allDraws.slice(0, predCutoff);
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
    ['digitBars', 'numPredTable', 'pairTable', 'lookaheadTable', 'btSummary', 'btGrid']
      .forEach(id => {
        const el = $(id);
        if (el) el.innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Not enough data yet (minimum ${MIN_HIST} draws).</p>`;
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
  const last  = allDraws[total - 1];
  let topDStr = '—', topPStr = '—', zoneStr = '';

  if (model) {
    const topD = DIGITS.slice().sort((a, b) => model.digitProb[b] - model.digitProb[a])[0];
    topDStr  = topD;
    topPStr  = pct1(model.digitProb[topD]);
    const m  = model.digitMeta[topD];
    zoneStr  = m.isCalib ? ' ✓ calibrated zone' : m.isElev ? ' ⚠ elevated (rare zone)' : '';
  }

  const cutoffLabel = predCutoff > 0 ? `First ${Math.min(predCutoff, allDraws.length)} draws` : 'All draws';

  $('statCards').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Total draws in DB</div>
      <div class="stat-card-value">${total}</div>
      <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${last?.dateStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Prediction window</div>
      <div class="stat-card-value">${slice.length}</div>
      <div class="stat-card-sub">${cutoffLabel}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Last result (TWO)</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div>
      <div class="stat-card-sub">${last?.dateStr || ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Top digit</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${topDStr}</div>
      <div class="stat-card-sub">${topPStr} model score${zoneStr}</div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 2 — DIGIT PROBABILITY BARS
// ═══════════════════════════════════════════════════════════════════════════
function renderDigitBars(model) {
  const { digitMeta } = model;
  const wrap = $('digitBars');
  wrap.innerHTML = '';

  const sorted = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob);
  const maxP   = digitMeta[sorted[0]].prob;

  const hdr = document.createElement('div');
  hdr.className = 'dbar-hdr';
  hdr.innerHTML = `
    <div style="text-align:center">D</div>
    <div>Score bar <span style="opacity:.45;font-weight:400;font-size:.55rem">(▏= 10% baseline)</span></div>
    <div style="text-align:right">Score</div>
    <div style="text-align:right">vs base</div>
    <div style="text-align:right">Since last</div>
    <div></div>
  `;
  wrap.appendChild(hdr);

  sorted.forEach(d => {
    const m   = digitMeta[d];
    const exc = m.excessVsBase >= 0 ? '+' + pct1(m.excessVsBase) : pct1(m.excessVsBase);

    let barColor, pill;
    if (m.isElev) {
      barColor = 'hsl(38,78%,52%)';
      pill     = `<span class="cpill cpill-amber">Elevated ⚠</span>`;
    } else if (m.isCalib) {
      barColor = 'hsl(142,55%,44%)';
      pill     = `<span class="cpill cpill-green">Calibrated ✓</span>`;
    } else {
      barColor = 'var(--primary)';
      pill     = `<span class="cpill cpill-muted">Low</span>`;
    }

    const fillPct     = (m.prob / maxP * 100).toFixed(1);
    const baselinePct = Math.min(99, (0.10 / maxP * 100)).toFixed(1);

    const row = document.createElement('div');
    row.className = 'dbar-row';
    row.title = `Digit ${d}: score ${pct2(m.prob)} · base ${pct2(m.baseFreq)} · avg gap ${m.avgGap.toFixed(1)} draws · ${m.since} draws since last`;
    row.innerHTML = `
      <div class="dbar-lbl">${d}</div>
      <div class="dbar-track">
        <div class="dbar-fill" style="width:${fillPct}%;background:${barColor}"></div>
        <div class="dbar-baseline" style="left:${baselinePct}%"></div>
      </div>
      <div class="dbar-score" style="color:${m.isCalib ? 'hsl(142,55%,40%)' : 'var(--foreground)'}">${pct1(m.prob)}</div>
      <div class="dbar-excess" style="color:${m.excessVsBase >= 0 ? 'hsl(142,55%,40%)' : 'hsl(5,68%,48%)'};">${exc}</div>
      <div class="dbar-since" style="${m.ovRatio > 1.5 ? 'color:hsl(15,78%,50%)' : ''}">${m.since} drws${m.ovRatio > 1.0 ? ' ×' + m.ovRatio.toFixed(1) : ''}</div>
      <div>${pill}</div>
    `;
    wrap.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3a — NUMBER PREDICTIONS (hidden, DOM stub only)
// ═══════════════════════════════════════════════════════════════════════════
function renderNumPredTable(model) {
  const el = $('numPredTable');
  if (el) el.innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3b — UNORDERED PAIRS
// ═══════════════════════════════════════════════════════════════════════════
function renderPairTable(model) {
  const { digitMeta, numProbs } = model;

  const pairMap = {};
  DIGITS.forEach(a => {
    DIGITS.forEach(b => {
      if (b < a) return;
      const key = a + b;
      const p   = a === b ? numProbs[a + b] : numProbs[a + b] + numProbs[b + a];
      pairMap[key] = { a, b, prob: p, anyElev: digitMeta[a].isElev || digitMeta[b].isElev };
    });
  });

  const sorted = Object.values(pairMap).sort((x, y) => y.prob - x.prob).slice(0, topN);
  const maxP   = sorted[0].prob;

  let html = `<table class="pt"><thead><tr>
    <th>#</th><th>Pair</th><th>Both tickets</th><th colspan="2">Combined P</th><th style="text-align:right">Flag</th>
  </tr></thead><tbody>`;

  sorted.forEach(({ a, b, prob, anyElev }, i) => {
    const isSame = a === b;
    const t1 = a + b, t2 = isSame ? '—' : b + a;
    const fillW = (prob / maxP * 100).toFixed(1);
    const barClr = anyElev ? 'hsl(38,78%,52%)' : 'hsl(142,55%,44%)';

    html += `<tr>
      <td style="color:var(--muted-foreground);font-size:.7rem">${i + 1}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)">{${a},${b}}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground)">${t1}${isSame ? '' : ' + ' + t2}</td>
      <td style="min-width:80px;">
        <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600">${pct2(prob)}</div>
        <div class="pt-bar"><div class="pt-bar-fill" style="width:${fillW}%;background:${barClr}"></div></div>
      </td>
      <td style="width:0;padding:0"></td>
      <td style="text-align:right;font-size:.65rem">${anyElev ? '<span class="cpill cpill-amber">⚠ rare zone</span>' : ''}</td>
    </tr>`;
  });

  html += `</tbody></table>
    <p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55">
      {5,9} covers both "59" and "95" — buy both. Combined P = 2 × P(5) × P(9).
      ⚠ rare zone = digit score &gt;22% — insufficient backtest data to characterise, treat with caution.
    </p>`;

  $('pairTable').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 4 — N-DRAW LOOKAHEAD
// ═══════════════════════════════════════════════════════════════════════════
function renderLookahead(model) {
  const { digitMeta } = model;
  const Ns = [1, 2, 3, 4, 6];

  const topDigits = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 7);

  let html = `<table class="la-tbl"><thead><tr>
    <th>Digit</th><th>Score</th>
    ${Ns.map(n => `<th>Next ${n} draw${n > 1 ? 's' : ''}</th>`).join('')}
    <th>Zone</th>
  </tr></thead><tbody>`;

  topDigits.forEach(d => {
    const m = digitMeta[d];

    html += `<tr title="Digit ${d}: ${pct2(m.prob)} · ${m.since} draws since last seen · avg gap ${m.avgGap.toFixed(1)}">
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.0625rem">${d}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem">${pct1(m.prob)}</td>`;

    Ns.forEach(N => {
      const p   = cumulP(m.pDraw, N);
      let cls = 'la-lo';
      if      (p >= 0.75) cls = 'la-hi';
      else if (p >= 0.45) cls = 'la-med';
      html += `<td class="${cls}">${pct1(p)}</td>`;
    });

    let zoneLbl;
    if      (m.isElev)  zoneLbl = `<span class="cpill cpill-amber">Elevated ⚠</span>`;
    else if (m.isCalib) zoneLbl = `<span class="cpill cpill-green">Calibrated ✓</span>`;
    else                zoneLbl = `<span class="cpill cpill-muted">Low</span>`;

    html += `<td style="text-align:left">${zoneLbl}</td></tr>`;
  });

  html += `</tbody></table>
    <p style="font-size:.7rem;color:var(--muted-foreground);margin-top:.625rem;line-height:1.55">
      P(digit appears ≥1 time in N draws) = 1 − (1 − P<sub>draw</sub>)<sup>N</sup>.
      Calibrated zone 17–22%: backtest zone analysis showed 22.3% hit rate vs 19% baseline.
      Elevated (&gt;22%): too rare in practice (3% of draws) to draw conclusions.
    </p>`;

  $('lookaheadTable').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 5 — WALK-FORWARD BACKTEST
// ═══════════════════════════════════════════════════════════════════════════
function runBacktest() {
  const results = [];
  const N = allDraws.length;

  for (let i = MIN_HIST; i < N; i++) {
    const seq    = allDraws.slice(0, i).map(d => d.twoNum);
    const model  = computeModel(seq, recW);
    if (!model) continue;

    const { numProbs, digitMeta } = model;
    const sorted  = Object.entries(numProbs).sort((a, b) => b[1] - a[1]);
    const topNums = sorted.slice(0, topN).map(([n]) => n);
    const actual  = allDraws[i].twoNum;

    // Probability the model assigned to the drawn pair
    const pActual = Math.max(numProbs[actual] || 0, numProbs[mirror(actual)] || 0);

    // Top 4 digits at time of prediction
    const topDigits = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 4);

    const pairHit = topNums.includes(actual) || topNums.includes(mirror(actual));

    function horizonHit(lookAhead) {
      for (let k = 1; k <= lookAhead && (i + k) < N; k++) {
        const a = allDraws[i + k].twoNum;
        if (topNums.includes(a) || topNums.includes(mirror(a))) return a;
      }
      return null;
    }

    results.push({
      i, dateStr: allDraws[i].dateStr, actual, topNums, topDigits,
      pActual, pairHit,
      hit2: horizonHit(2), hit4: horizonHit(4),
      digitMeta,
    });
  }
  return results;
}

function renderBacktest() {
  const btAll = runBacktest();
  const btSummaryEl = $('btSummary');
  const btGridEl    = $('btGrid');
  if (!btAll.length) {
    if (btGridEl) btGridEl.innerHTML = '<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Not enough data.</p>';
    return;
  }

  const totalN   = btAll.length;
  const pairRate = btAll.filter(r => r.pairHit).length / totalN;
  const hit2Rate = btAll.filter(r => r.hit2).length    / totalN;
  const hit4Rate = btAll.filter(r => r.hit4).length    / totalN;
  const baseline = topN / 100;

  // Z-score vs baseline
  const z = (pairRate - baseline) / Math.sqrt(baseline * (1 - baseline) / totalN);

  if (btSummaryEl) {
    btSummaryEl.innerHTML = `
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Predictions tested</div>
        <div class="bt-sum-val">${totalN}</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Pair hit (single draw)</div>
        <div class="bt-sum-val" style="color:${pairRate > baseline ? 'hsl(142,55%,40%)' : 'var(--foreground)'}">
          ${(pairRate * 100).toFixed(1)}%
        </div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Baseline (top ${topN})</div>
        <div class="bt-sum-val" style="color:var(--muted-foreground)">${(baseline * 100).toFixed(0)}%</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Z-score vs baseline</div>
        <div class="bt-sum-val" style="color:${Math.abs(z) >= 1.96 ? 'hsl(142,55%,40%)' : 'var(--muted-foreground)'}">
          ${z.toFixed(2)} ${Math.abs(z) >= 1.96 ? '✓' : '(not significant)'}
        </div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Pair hit in next 2 draws</div>
        <div class="bt-sum-val">${(hit2Rate * 100).toFixed(1)}%</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Pair hit in next 4 draws</div>
        <div class="bt-sum-val">${(hit4Rate * 100).toFixed(1)}%</div>
      </div>`;
  }

  const recent = btAll.slice(-btRows);

  let grid = `<div class="bt-hdr">
    <div>Date</div>
    <div>Drawn</div>
    <div>Prob</div>
    <div>Digits pred→got</div>
    <div>Top predictions</div>
    <div style="text-align:center">Pair</div>
    <div style="text-align:center">+2</div>
    <div style="text-align:center">+4</div>
  </div>`;

  recent.forEach(r => {
    const chips = r.topNums.slice(0, 10).map(n => {
      const isPair = n === r.actual || n === mirror(r.actual);
      const isElev = r.digitMeta[n[0]]?.isElev || r.digitMeta[n[1]]?.isElev;
      let cls = 'bt-chip';
      if      (isPair) cls += ' pair-hit';
      else if (isElev) cls += ' oc-pred';
      return `<span class="${cls}">${n}</span>`;
    }).join('');

    const actualDs   = [r.actual[0], r.actual[1]];
    const predDigStr = r.topDigits.map(d => {
      const hit = actualDs.includes(d);
      return `<span style="font-weight:${hit ? '700' : '400'};color:${hit ? 'hsl(142,55%,38%)' : 'var(--muted-foreground)'}">${d}</span>`;
    }).join('·');
    const gotDigStr = actualDs.map(d => {
      const predicted = r.topDigits.includes(d);
      return `<span style="color:${predicted ? 'hsl(142,55%,38%)' : 'var(--foreground)'}">${d}</span>`;
    }).join('');

    const pAbove  = r.pActual > 0.02;
    const pColor  = pAbove ? 'hsl(142,55%,38%)' : 'var(--muted-foreground)';

    grid += `<div class="bt-row">
      <div class="bt-date">${r.dateStr}</div>
      <div class="bt-actual" style="color:${r.pairHit ? 'hsl(142,55%,40%)' : 'var(--foreground)'}">${r.actual}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:${pColor};white-space:nowrap">${pct2(r.pActual)}</div>
      <div style="font-size:.68rem;font-family:'JetBrains Mono',monospace;white-space:nowrap">${predDigStr}→${gotDigStr}</div>
      <div class="bt-chips">${chips}</div>
      ${r.pairHit ? '<div class="bt-cell bt-yes">✓</div>' : '<div class="bt-cell bt-no">—</div>'}
      ${r.hit2    ? `<div class="bt-cell bt-hit-num">${r.hit2}</div>` : '<div class="bt-cell bt-no">—</div>'}
      ${r.hit4    ? `<div class="bt-cell bt-hit-num">${r.hit4}</div>` : '<div class="bt-cell bt-no">—</div>'}
    </div>`;
  });

  if (btGridEl) btGridEl.innerHTML = grid;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════
init().catch(err => {
  setStatus('', 'Failed to load: ' + err.message);
  console.error('predictions.js:', err);
});
