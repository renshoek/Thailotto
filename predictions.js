'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto · Two-Digit Prize — Probability Model (predictions.js)
//
//  Model (from backtest of 458 draws, 2006-2026):
//    score(d) = 0.35 × recency_freq(d, W)
//             + 0.45 × min(overdue_ratio(d), 3) / 3
//             + 0.20 × historical_base_rate(d)
//    prob(d)  = score(d) / Σ score
//
//  Key confirmed facts:
//    • P("06") = P("60")  — symmetry statistically confirmed (Z=−1.52)
//    • Overconfident zone (score > 24%): actual backtest hit 13.8% < baseline 19%
//    • Calibrated zone (17–20%): actual hit 20.9% — best honest estimate
//    • Top-5 number selection: 5.3% hit vs 5.0% baseline (not significant, Z=0.27)
//    • Recency-only strategies: worse than random at all window sizes
//    • Overconfidence correction factor: 0.73× (actual 13.8% / expected ~19%)
// ════════════════════════════════════════════════════════════════════════════

const DIGITS        = '0123456789'.split('');
const W_REC         = 0.35;    // recency weight
const W_OV          = 0.45;    // overdue weight
const W_BASE        = 0.20;    // base rate weight
const OV_CAP        = 3.0;     // max overdue ratio before capping
const OVERCONF      = 0.24;    // above this: model overconfident (hit drops to 13.8%)
const CALIB_LO      = 0.17;    // calibrated zone lower bound
const CALIB_HI      = 0.20;    // calibrated zone upper bound
const OC_CORRECTION = 0.73;    // backtest-derived correction for overconfident zone
const MIN_HIST      = 30;      // minimum draws before model is meaningful

const DB_NAME    = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY  = 'perFileAggMap_v2';

// ── State ─────────────────────────────────────────────────────────────────
let allDraws   = [];   // [{dateStr, twoNum}] sorted oldest→newest
let recW       = 20;   // recency window
let trainWin   = 0;    // always all draws – not user-controllable
let topN       = 15;
let btRows     = 20;
let predCutoff = 0;    // 0 = use all draws for predictions; >0 = first X draws

// ── DOM refs ──────────────────────────────────────────────────────────────
const $         = id => document.getElementById(id);
const isDark    = ()  => document.documentElement.classList.contains('dark');
const parseNums = s   => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
const mirror    = n   => n.length === 2 ? n[1] + n[0] : n;
const pct1      = v   => (v * 100).toFixed(1) + '%';
const pct2      = v   => (v * 100).toFixed(2) + '%';

// ── Theme ─────────────────────────────────────────────────────────────────
$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  if (allDraws.length) renderAll();
});
{
  const s = localStorage.getItem('theme');
  if (s === 'dark' || (!s && window.matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.classList.add('dark');
}

// ── Controls ──────────────────────────────────────────────────────────────
// trainWin is fixed at 0 (all draws) — no listener needed

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
  if (!el) return;
  if (!allDraws.length) { el.textContent = ''; return; }
  const idx = predCutoff > 0 ? predCutoff : allDraws.length;
  if (idx < allDraws.length) {
    const d = allDraws[idx];
    el.innerHTML =
      `Next result: <strong style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${d.twoNum}</strong>` +
      `<span style="color:var(--muted-foreground);font-size:.7rem;margin-left:.35rem;">(${d.dateStr})</span>`;
  } else {
    el.innerHTML =
      `Next result: <span style="color:var(--muted-foreground);">Unknown (future)</span>`;
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
      const tx  = ev.target.result.transaction(STORE_NAME, 'readonly');
      const get = tx.objectStore(STORE_NAME).get(CACHE_KEY);
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

  if (!cached || !cached.data || !Object.keys(cached.data).length) {
    setStatus('empty', 'No data. Open the Analyzer page first to load data, then return here.');
    const mc = $('mainContent');
    if (mc) {
      const sc = mc.querySelector('#statCards');
      if (sc) sc.insertAdjacentHTML('beforebegin', `
        <div style="text-align:center;padding:4rem 2rem;color:var(--muted-foreground)">
          <h2 style="color:var(--foreground);font-size:1.25rem;margin-bottom:.75rem">No data loaded</h2>
          <p>Please open <a href="index.html" style="color:var(--primary)">the Analyzer</a> first to cache lottery data.</p>
        </div>`);
    }
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
    `${allDraws.length} TWO draws loaded` +
    (age !== null ? ` · cached ${age < 60 ? age + ' min' : Math.round(age / 60) + 'h'} ago` : '') +
    ` · ${allDraws[0]?.dateStr} → ${allDraws[allDraws.length - 1]?.dateStr}`
  );

  updateNextResult();
  renderAll();
}

function setStatus(state, txt) {
  $('statusText').textContent = txt;
  const dot = $('statusDot');
  dot.className = 'status-dot' + (state === 'live' ? ' live' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE MODEL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute digit probability scores from a sequence of 2-digit results.
 * @param {string[]} seq    - chronological TWO results
 * @param {number}   W      - recency window
 * @returns {object|null}
 */
function computeModel(seq, W) {
  const n = seq.length;
  if (n < MIN_HIST) return null;

  const safeW = Math.min(W, n - 1);

  // ── Recency frequency ──
  const recBlock = seq.slice(-safeW);
  const recCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
  recBlock.forEach(num => {
    recCount[num[0]] = (recCount[num[0]] || 0) + 1;
    recCount[num[1]] = (recCount[num[1]] || 0) + 1;
  });

  // ── All-time base rate ──
  const baseCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
  seq.forEach(num => {
    baseCount[num[0]] = (baseCount[num[0]] || 0) + 1;
    baseCount[num[1]] = (baseCount[num[1]] || 0) + 1;
  });
  const baseTotal = n * 2;  // 2 digits per draw

  // ── Gap / overdue ──
  const lastSeen  = Object.fromEntries(DIGITS.map(d => [d, -1]));
  const gapLists  = Object.fromEntries(DIGITS.map(d => [d, []]));
  seq.forEach((num, i) => {
    [num[0], num[1]].forEach(d => {
      if (lastSeen[d] >= 0) gapLists[d].push(i - lastSeen[d]);
      lastSeen[d] = i;
    });
  });

  // ── Score each digit ──
  const rawScore = {};
  const meta     = {};

  DIGITS.forEach(d => {
    const recFreq  = recCount[d]  / (2 * safeW);
    const baseFreq = baseCount[d] / baseTotal;
    const gaps     = gapLists[d];
    const avgGap   = gaps.length >= 2
      ? gaps.reduce((a, b) => a + b, 0) / gaps.length
      : 5.0;   // prior: ~10% per slot × 2 slots ≈ 1 appearance per 5 draws
    const since   = lastSeen[d] >= 0 ? (n - 1 - lastSeen[d]) : n;
    const ovRatio = avgGap > 0 ? Math.min(since / avgGap, OV_CAP) : 0;
    const ovScore = ovRatio / OV_CAP;

    rawScore[d] = W_REC * recFreq + W_OV * ovScore + W_BASE * baseFreq;
    meta[d] = { recFreq, baseFreq, avgGap, since, ovRatio, gapCount: gaps.length, lastIdx: lastSeen[d] };
  });

  const total = DIGITS.reduce((s, d) => s + rawScore[d], 0);

  const digitProb = {};
  DIGITS.forEach(d => {
    const p = rawScore[d] / total;
    digitProb[d] = p;
    meta[d].prob         = p;
    meta[d].excessVsBase = p - meta[d].baseFreq;
    meta[d].pDraw        = 1 - Math.pow(1 - p, 2);  // P(digit appears in a 2-slot draw)
    meta[d].isOC         = p > OVERCONF;
    meta[d].isCalib      = p >= CALIB_LO && p <= CALIB_HI;
    meta[d].isElev       = p > CALIB_HI  && p <= OVERCONF;
    meta[d].isLow        = p < CALIB_LO;
  });

  // ── Number probabilities ──  P(AB) = P(A)×P(B); P(AB)=P(BA) confirmed
  const numProbs = {};
  DIGITS.forEach(a => DIGITS.forEach(b => { numProbs[a + b] = digitProb[a] * digitProb[b]; }));

  return { digitProb, digitMeta: meta, numProbs, n };
}

/** P(digit appears ≥1 time in N draws) */
function cumulP(pDraw, N) {
  return 1 - Math.pow(1 - pDraw, N);
}

/** Get prediction slice — uses predCutoff (from start), not trainWin */
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
    ['digitBars','numPredTable','pairTable','lookaheadTable','btSummary','btGrid']
      .forEach(id => {
        const el = $(id);
        if (el) el.innerHTML = '<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Not enough data yet (minimum ' + MIN_HIST + ' draws).</p>';
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
  let topDStr = '—', topPStr = '—', topOCStr = '';

  if (model) {
    const topD = DIGITS.slice().sort((a, b) => model.digitProb[b] - model.digitProb[a])[0];
    topDStr  = topD;
    topPStr  = pct1(model.digitProb[topD]);
    topOCStr = model.digitMeta[topD].isOC ? ' ⚠ overconfident' : model.digitMeta[topD].isCalib ? ' ✓ calibrated' : '';
  }

  const cutoffLabel = predCutoff > 0
    ? `First ${Math.min(predCutoff, allDraws.length)} draws`
    : 'All draws';

  $('statCards').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Total draws in DB</div>
      <div class="stat-card-value">${total}</div>
      <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${last?.dateStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Prediction window</div>
      <div class="stat-card-value">${slice.length}</div>
      <div class="stat-card-sub">${cutoffLabel} · ${slice[0]?.dateStr} → ${slice[slice.length - 1]?.dateStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Last result (TWO)</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div>
      <div class="stat-card-sub">${last?.dateStr || ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Top digit now</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;${model?.digitMeta[topDStr]?.isOC ? 'color:hsl(5,68%,48%)' : 'color:var(--primary)'}">${topDStr}</div>
      <div class="stat-card-sub">${topPStr} model score${topOCStr}</div>
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

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'dbar-hdr';
  hdr.innerHTML = `
    <div style="text-align:center">D</div>
    <div>Score bar <span style="opacity:.45;font-weight:400;font-size:.55rem;">(▏= 10% baseline)</span></div>
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
    if (m.isOC) {
      barColor = 'hsl(5,68%,52%)';
      pill     = `<span class="cpill cpill-red">Overconfident ↓</span>`;
    } else if (m.isElev) {
      barColor = 'hsl(38,78%,52%)';
      pill     = `<span class="cpill cpill-amber">Elevated</span>`;
    } else if (m.isCalib) {
      barColor = 'hsl(142,55%,44%)';
      pill     = `<span class="cpill cpill-green">Calibrated ✓</span>`;
    } else {
      barColor = 'var(--primary)';
      pill     = `<span class="cpill cpill-muted">Low</span>`;
    }

    const fillPct     = (m.prob / maxP * 100).toFixed(1);
    const baselinePct = Math.min(99, (0.10   / maxP * 100)).toFixed(1);

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
      <div>${pill}</div>
    `;
    wrap.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3a — NUMBER PREDICTION TABLE  (removed; only pairs shown)
// ═══════════════════════════════════════════════════════════════════════════
function renderNumPredTable(model) {
  // Kept for DOM compatibility but section hidden in HTML
  const el = $('numPredTable');
  if (!el) return;
  el.innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3b — UNORDERED PAIRS TABLE
// ═══════════════════════════════════════════════════════════════════════════
function renderPairTable(model) {
  const { digitProb, digitMeta, numProbs } = model;

  // Build unordered pairs {a,b} with a≤b, combined prob = P(ab)+P(ba)
  const pairMap = {};
  DIGITS.forEach(a => {
    DIGITS.forEach(b => {
      if (b < a) return;  // only process a≤b
      const key  = a + b;
      const p    = a === b ? numProbs[a + b] : numProbs[a + b] + numProbs[b + a];
      const anyOC = digitMeta[a].isOC || digitMeta[b].isOC;
      pairMap[key] = { a, b, prob: p, anyOC };
    });
  });

  const sorted = Object.values(pairMap).sort((x, y) => y.prob - x.prob).slice(0, topN);
  const maxP   = sorted[0].prob;

  let html = `<table class="pt"><thead><tr>
    <th>#</th><th>Pair</th><th>Both tickets</th><th colspan="2">Combined P</th><th style="text-align:right">Caution</th>
  </tr></thead><tbody>`;

  sorted.forEach(({ a, b, prob, anyOC }, i) => {
    const isSame = a === b;
    const t1 = a + b;
    const t2 = isSame ? '—' : b + a;
    const fillW = (prob / maxP * 100).toFixed(1);
    const barClr = anyOC ? 'hsl(5,68%,52%)' : 'hsl(142,55%,44%)';

    html += `
      <tr title="${isSame ? t1 : t1 + ' + ' + t2} · combined P=${pct2(prob)}">
        <td style="color:var(--muted-foreground);font-size:.7rem;">${i + 1}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)${anyOC ? ';opacity:.6' : ''};">{${a},${b}}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground);">${t1}${isSame ? '' : ' + ' + t2}</td>
        <td style="min-width:80px;">
          <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600;">${pct2(prob)}</div>
          <div class="pt-bar"><div class="pt-bar-fill" style="width:${fillW}%;background:${barClr};"></div></div>
        </td>
        <td style="width:0;padding:0;"></td>
        <td style="text-align:right;font-size:.65rem;">${anyOC ? '<span class="cpill cpill-red">⚠ OC</span>' : ''}</td>
      </tr>`;
  });

  html += `</tbody></table>
    <p style="font-size:.7rem;color:var(--muted-foreground);font-style:italic;margin-top:.5rem;line-height:1.55;">
      Symmetry confirmed: {5,9} covers both "59" and "95". Combined P = 2 × P(5) × P(9).
      Always buy both orientations. OC = overconfident pair.
    </p>`;

  $('pairTable').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 4 — N-DRAW LOOKAHEAD TABLE
// ═══════════════════════════════════════════════════════════════════════════
function renderLookahead(model) {
  const { digitMeta } = model;
  const Ns = [1, 2, 3, 4, 6];

  // Top 7 digits by score
  const topDigits = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 7);

  let html = `<table class="la-tbl"><thead><tr>
    <th>Digit</th><th>Score</th>
    ${Ns.map(n => `<th>Next ${n} draw${n > 1 ? 's' : ''}</th>`).join('')}
    <th>Confidence</th>
  </tr></thead><tbody>`;

  topDigits.forEach(d => {
    const m    = digitMeta[d];
    const isOC = m.isOC;

    html += `<tr title="Digit ${d}: score ${pct2(m.prob)} · ${m.since} draws since last seen">
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.0625rem;">${d}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:${isOC ? 'hsl(5,68%,48%)' : 'var(--foreground)'};">${pct1(m.prob)}</td>`;

    Ns.forEach(N => {
      const rawP     = cumulP(m.pDraw, N);
      const adjP     = isOC ? rawP * OC_CORRECTION : rawP;
      const displayP = isOC ? adjP : rawP;
      let cls = 'la-lo';
      if      (displayP >= 0.75) cls = 'la-hi';
      else if (displayP >= 0.45) cls = 'la-med';

      if (isOC) {
        html += `<td>
          <div class="la-oc">${pct1(rawP)}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:hsl(5,68%,48%);font-weight:600;">~${pct1(adjP)}</div>
        </td>`;
      } else {
        html += `<td class="${cls}">${pct1(rawP)}</td>`;
      }
    });

    let confLabel;
    if      (isOC)        confLabel = `<span class="cpill cpill-red">Overconfident ↓</span>`;
    else if (m.isElev)    confLabel = `<span class="cpill cpill-amber">Elevated</span>`;
    else if (m.isCalib)   confLabel = `<span class="cpill cpill-green">Calibrated ✓</span>`;
    else                  confLabel = `<span class="cpill cpill-muted">Low</span>`;

    html += `<td style="text-align:left;">${confLabel}</td></tr>`;
  });

  html += `</tbody></table>
    <p style="font-size:.7rem;color:var(--muted-foreground);margin-top:.625rem;line-height:1.55;">
      Overconfident digits (score &gt;24 %): raw estimate struck through, adjusted value shown in orange (×0.73 correction from backtest).
      Green cells ≥75 %, amber ≥45 %. These are model estimates — the overdue signal is imperfectly calibrated at high confidence.
    </p>`;

  $('lookaheadTable').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 5 — WALK-FORWARD BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the walk-forward backtest.
 * For each draw index i (starting at MIN_HIST), train on draws 0…i-1 and predict draw i.
 * Returns array of prediction records.
 * NOTE: always uses ALL draws regardless of predCutoff — backtest is a historical record.
 */
function runBacktest() {
  const results = [];
  const N = allDraws.length;

  for (let i = MIN_HIST; i < N; i++) {
    const seq   = allDraws.slice(0, i).map(d => d.twoNum);
    const model = computeModel(seq, recW);
    if (!model) continue;

    const { numProbs, digitMeta } = model;
    const sorted   = Object.entries(numProbs).sort((a, b) => b[1] - a[1]);
    const topNums  = sorted.slice(0, topN).map(([n]) => n);
    const actual   = allDraws[i].twoNum;
    const dateStr  = allDraws[i].dateStr;

    // Probability assigned to drawn pair at the time of prediction (max of AB / BA)
    const pActual = Math.max(numProbs[actual] || 0, numProbs[mirror(actual)] || 0);

    // Top 4 digits by score at time of prediction
    const topDigits = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 4);

    const pairHit = topNums.includes(actual) || topNums.includes(mirror(actual));

    // Returns the drawn number that matched (or null) within lookAhead draws
    function horizonHit(lookAhead) {
      for (let k = 1; k <= lookAhead && (i + k) < N; k++) {
        const a = allDraws[i + k].twoNum;
        if (topNums.includes(a) || topNums.includes(mirror(a))) return a;
      }
      return null;
    }

    results.push({
      i, dateStr, actual, topNums, topDigits,
      pActual, pairHit,
      hit2: horizonHit(2),
      hit4: horizonHit(4),
      topProb: sorted[0][1],
      digitMeta,   // retained for OC chip detection
    });
  }
  return results;
}

function renderBacktest() {
  const btAll = runBacktest();
  if (!btAll.length) {
    if ($('btGrid')) $('btGrid').innerHTML = '<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Not enough data.</p>';
    return;
  }

  // ── Summary stats ──────────────────────────────────────────────────────
  const totalN   = btAll.length;
  const pairRate = btAll.filter(r => r.pairHit).length / totalN;
  const hit2Rate = btAll.filter(r => r.hit2).length    / totalN;
  const hit4Rate = btAll.filter(r => r.hit4).length    / totalN;

  // Count draws where top prediction had ≥1 OC digit
  const ocCount  = btAll.filter(r => {
    const n = r.topNums[0] || '';
    return n && (r.digitMeta[n[0]]?.isOC || r.digitMeta[n[1]]?.isOC);
  }).length;

  const btSummaryEl = $('btSummary');
  if (btSummaryEl) {
    btSummaryEl.innerHTML = `
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Predictions tested</div>
        <div class="bt-sum-val">${totalN}</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Pair hit (single draw)</div>
        <div class="bt-sum-val" style="color:${pairRate > 0.055 ? 'hsl(142,55%,40%)' : 'var(--foreground)'};">${(pairRate * 100).toFixed(1)}%</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Pair hit in next 2 draws</div>
        <div class="bt-sum-val">${(hit2Rate * 100).toFixed(1)}%</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Pair hit in next 4 draws</div>
        <div class="bt-sum-val">${(hit4Rate * 100).toFixed(1)}%</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Random baseline (top ${topN})</div>
        <div class="bt-sum-val" style="color:var(--muted-foreground);">${topN}%</div>
      </div>
      <div class="bt-sum-item">
        <div class="bt-sum-lbl">Draws w/ OC top pick</div>
        <div class="bt-sum-val" style="color:hsl(5,68%,48%);">${ocCount}</div>
      </div>`;
  }

  // ── Table ──────────────────────────────────────────────────────────────
  const recent = btAll.slice(-btRows);

  let grid = `<div class="bt-hdr">
    <div>Date</div>
    <div>Drawn</div>
    <div>Prob</div>
    <div>Digits pred→got</div>
    <div>Top predictions <span style="font-weight:400;opacity:.65">(orange border = OC)</span></div>
    <div style="text-align:center">Pair</div>
    <div style="text-align:center">+2 draw</div>
    <div style="text-align:center">+4 draw</div>
  </div>`;

  recent.forEach(r => {
    // ── Prediction chips ───────────────────────────────────────────────
    const chips = r.topNums.slice(0, 10).map(n => {
      const isPair = n === r.actual || n === mirror(r.actual);
      const isOC   = r.digitMeta[n[0]]?.isOC || r.digitMeta[n[1]]?.isOC;
      let cls = 'bt-chip';
      if      (isPair) cls += ' pair-hit';
      else if (isOC)   cls += ' oc-pred';
      return `<span class="${cls}" title="P=${pct2(r.digitMeta[n[0]]?.prob * r.digitMeta[n[1]]?.prob || 0)}">${n}</span>`;
    }).join('');

    // ── Digit column ───────────────────────────────────────────────────
    const actualDs  = [r.actual[0], r.actual[1]];
    const predDigStr = r.topDigits.map(d => {
      const hit = actualDs.includes(d);
      return `<span style="font-weight:${hit ? '700' : '400'};color:${hit ? 'hsl(142,55%,38%)' : 'var(--muted-foreground)'}">${d}</span>`;
    }).join('·');
    const gotDigStr = actualDs.map(d => {
      const predicted = r.topDigits.includes(d);
      return `<span style="color:${predicted ? 'hsl(142,55%,38%)' : 'var(--foreground)'};">${d}</span>`;
    }).join('');

    // ── Cells ──────────────────────────────────────────────────────────
    const pairCell = r.pairHit
      ? `<div class="bt-cell bt-yes">✓</div>`
      : `<div class="bt-cell bt-no">—</div>`;

    const h2Cell = r.hit2
      ? `<div class="bt-cell bt-hit-num">${r.hit2}</div>`
      : `<div class="bt-cell bt-no">—</div>`;

    const h4Cell = r.hit4
      ? `<div class="bt-cell bt-hit-num">${r.hit4}</div>`
      : `<div class="bt-cell bt-no">—</div>`;

    // Colour model probability — green if above 2% (rough pair baseline)
    const pAbove  = r.pActual > 0.02;
    const pColor  = pAbove ? 'hsl(142,55%,38%)' : 'var(--muted-foreground)';

    // Flag row as overconfident if top prediction had OC digit
    const topN0 = r.topNums[0] || '';
    const rowOC = topN0 && (r.digitMeta[topN0[0]]?.isOC || r.digitMeta[topN0[1]]?.isOC);

    grid += `<div class="bt-row${rowOC ? ' bt-row-oc' : ''}">
      <div class="bt-date">${r.dateStr}</div>
      <div class="bt-actual" style="color:${r.pairHit ? 'hsl(142,55%,40%)' : 'var(--foreground)'}">${r.actual}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:${pColor};white-space:nowrap;">${pct2(r.pActual)}</div>
      <div style="font-size:.68rem;font-family:'JetBrains Mono',monospace;white-space:nowrap;">${predDigStr}→${gotDigStr}</div>
      <div class="bt-chips">${chips}</div>
      ${pairCell}${h2Cell}${h4Cell}
    </div>`;
  });

  const btGridEl = $('btGrid');
  if (btGridEl) btGridEl.innerHTML = grid;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════
init().catch(err => {
  setStatus('', 'Failed to load: ' + err.message);
  console.error('predictions.js:', err);
});
