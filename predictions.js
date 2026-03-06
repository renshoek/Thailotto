'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto · Two-Digit Prize — Probability Model  (predictions.js)
//
//  PARAMETERS: grid-searched on 458 actual draws, walk-forward backtest.
//    wRec=0.50  wOv=0.20  wBase=0.30  W=15  ovCap=2.0
//    Best top-15 pair hit: 18.22% vs 15.00% baseline  (Z=1.87, not yet p<0.05)
//
//  What the backtest found:
//    Recency-only (W=15): 16.4% — best individual signal
//    Base-rate-only:      17.8% — second best
//    Overdue-only:        13.8% — WORSE than random (was 45% in old model — wrong)
//    No OC correction: digits >22% appear in <3% of draws, zero samples above 24%
//    Draw is statistically fair: Chi²=15.09 < 16.9 (p=0.05 critical)
// ════════════════════════════════════════════════════════════════════════════

const DIGITS   = '0123456789'.split('');
const W_REC    = 0.50;
const W_OV     = 0.20;
const W_BASE   = 0.30;
const OV_CAP   = 2.0;
const REC_WIN  = 15;
const MIN_HIST = 30;
// Calibrated zone 17-22%: zone analysis found 22.3% actual hit vs 19% baseline
// Elevated >22%: fewer than 3% of draws, insufficient data to characterise
const CALIB_LO = 0.17;
const CALIB_HI = 0.22;

const DB_NAME    = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY  = 'perFileAggMap_v2';

let allDraws   = [];
let recW       = REC_WIN;
let topN       = 15;
let btRows     = 20;
let predCutoff = 0;

const $         = id => document.getElementById(id);
const parseNums = s  => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
const mirror    = n  => n[1] + n[0];
const fmt1      = v  => (v * 100).toFixed(1) + '%';
const fmt2      = v  => (v * 100).toFixed(2) + '%';

// ── Theme ─────────────────────────────────────────────────────────────────
$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  if (allDraws.length) renderAll();
});
(function () {
  const s = localStorage.getItem('theme');
  if (s === 'dark' || (!s && window.matchMedia('(prefers-color-scheme:dark)').matches))
    document.documentElement.classList.add('dark');
})();

// ── Controls ──────────────────────────────────────────────────────────────
$('topNSel').addEventListener('change',   e => { topN   = +e.target.value; if (allDraws.length) renderAll(); });
$('btRowsSel').addEventListener('change', e => { btRows = +e.target.value; if (allDraws.length) renderBacktest(); });
$('recSlider').addEventListener('input',  e => {
  recW = +e.target.value;
  $('recLbl').textContent = $('recLbl2').textContent = recW;
  if (allDraws.length) renderAll();
});
$('predCutoffInput').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  predCutoff = (!e.target.value.trim() || isNaN(v) || v <= 0) ? 0 : v;
  updateCutoffLabel();
  if (allDraws.length) renderAll();
});

function updateCutoffLabel () {
  const el = $('nextResultDisplay');
  if (!el || !allDraws.length) return;
  const idx = predCutoff > 0 ? predCutoff : allDraws.length;
  if (idx < allDraws.length) {
    const d = allDraws[idx];
    el.innerHTML =
      `Next known result: <strong class="mono" style="color:var(--primary)">${d.twoNum}</strong>` +
      ` <span style="color:var(--muted-foreground);font-size:.7rem">(${d.dateStr})</span>`;
  } else {
    el.innerHTML = `Next result: <span style="color:var(--muted-foreground)">future — unknown</span>`;
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────
async function loadCache () {
  return new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ev => {
      if (!ev.target.result.objectStoreNames.contains(STORE_NAME))
        ev.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = ev => {
      const tx = ev.target.result.transaction(STORE_NAME, 'readonly');
      const get = tx.objectStore(STORE_NAME).get(CACHE_KEY);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror   = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init () {
  setStatus('', 'Loading from cache…');
  const cached = await loadCache();

  if (!cached?.data || !Object.keys(cached.data).length) {
    setStatus('', 'No cached data.');
    $('mainContent').insertAdjacentHTML('beforeend', `
      <div style="text-align:center;padding:4rem 2rem;color:var(--muted-foreground)">
        Open <a href="index.html" style="color:var(--primary)">the Analyzer</a> first to cache data.
      </div>`);
    return;
  }

  allDraws = Array.from(new Map(Object.entries(cached.data)).entries())
    .map(([dateStr, agg]) => {
      const nums = parseNums((agg.results || {}).TWO || '').filter(n => n.length === 2);
      return { dateStr, twoNum: nums[0] || null };
    })
    .filter(d => d.twoNum)
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr));

  const age = cached.fetchedAt
    ? Math.round((Date.now() - cached.fetchedAt) / 60000) : null;
  setStatus('live',
    `${allDraws.length} draws · ${allDraws[0]?.dateStr} → ${allDraws.at(-1)?.dateStr}` +
    (age !== null ? ` · cache ${age < 60 ? age + 'min' : Math.round(age/60) + 'h'} old` : ''));

  updateCutoffLabel();
  renderAll();
}

function setStatus (state, txt) {
  $('statusText').textContent = txt;
  $('statusDot').className = 'status-dot' + (state === 'live' ? ' live' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE MODEL
// ═══════════════════════════════════════════════════════════════════════════
function computeModel (seq, W) {
  const n = seq.length;
  if (n < MIN_HIST) return null;
  const safeW = Math.min(W, n - 1);

  const recCnt  = Object.fromEntries(DIGITS.map(d => [d, 0]));
  const baseCnt = Object.fromEntries(DIGITS.map(d => [d, 0]));
  seq.slice(-safeW).forEach(num => { recCnt[num[0]]++; recCnt[num[1]]++; });
  seq.forEach(num =>               { baseCnt[num[0]]++; baseCnt[num[1]]++; });

  const lastSeen = Object.fromEntries(DIGITS.map(d => [d, -1]));
  const gapLists = Object.fromEntries(DIGITS.map(d => [d, []]));
  seq.forEach((num, i) => {
    [num[0], num[1]].forEach(d => {
      if (lastSeen[d] >= 0) gapLists[d].push(i - lastSeen[d]);
      lastSeen[d] = i;
    });
  });

  const raw = {}, meta = {};
  DIGITS.forEach(d => {
    const recFreq  = recCnt[d]  / (2 * safeW);
    const baseFreq = baseCnt[d] / (n * 2);
    const gaps     = gapLists[d];
    const avgGap   = gaps.length >= 2 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 5.0;
    const since    = lastSeen[d] >= 0 ? (n - 1 - lastSeen[d]) : n;
    const ovRatio  = Math.min(since / Math.max(avgGap, 1), OV_CAP) / OV_CAP;

    raw[d]   = W_REC * recFreq + W_OV * ovRatio + W_BASE * baseFreq;
    meta[d]  = { recFreq, baseFreq, avgGap, since, ovRatioRaw: since / Math.max(avgGap, 1) };
  });

  const total = DIGITS.reduce((s, d) => s + raw[d], 0);
  const digitProb = {};
  DIGITS.forEach(d => {
    const p          = raw[d] / total;
    digitProb[d]     = p;
    meta[d].prob     = p;
    meta[d].vsBase   = p - meta[d].baseFreq;
    meta[d].pDraw    = 1 - Math.pow(1 - p, 2);
    meta[d].isCalib  = p >= CALIB_LO && p <= CALIB_HI;
    meta[d].isElev   = p > CALIB_HI;
  });

  const numProbs = {};
  DIGITS.forEach(a => DIGITS.forEach(b => { numProbs[a + b] = digitProb[a] * digitProb[b]; }));
  return { digitProb, digitMeta: meta, numProbs, n };
}

function cumP (pDraw, N) { return 1 - Math.pow(1 - pDraw, N); }

function getSeq () {
  const slice = (predCutoff > 0 && predCutoff < allDraws.length)
    ? allDraws.slice(0, predCutoff) : allDraws;
  return { slice, seq: slice.map(d => d.twoNum) };
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════════════════════
function renderAll () {
  const { slice, seq } = getSeq();
  const model          = computeModel(seq, recW);
  renderStatCards(slice, model);
  if (!model) {
    ['digitBars','pairTable','lookaheadTable','btSummary','btGrid'].forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.5rem 0">Need at least ${MIN_HIST} draws.</p>`;
    });
    return;
  }
  renderDigitBars(model);
  renderPairTable(model);
  renderLookahead(model);
  renderBacktest();
}

// ── Stat cards ────────────────────────────────────────────────────────────
function renderStatCards (slice, model) {
  const last   = allDraws.at(-1);
  const cutLbl = (predCutoff > 0 && predCutoff < allDraws.length)
    ? `First ${predCutoff} draws` : 'All draws';
  let topD = '—', score = '—', note = '';

  if (model) {
    topD  = DIGITS.slice().sort((a, b) => model.digitProb[b] - model.digitProb[a])[0];
    score = fmt1(model.digitProb[topD]);
    const m = model.digitMeta[topD];
    note  = m.isElev ? ' · elevated ⚠' : m.isCalib ? ' · calibrated ✓' : '';
  }

  $('statCards').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Draws in DB</div>
      <div class="stat-card-value">${allDraws.length}</div>
      <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${last?.dateStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Prediction window</div>
      <div class="stat-card-value">${slice.length}</div>
      <div class="stat-card-sub">${cutLbl}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Last TWO result</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div>
      <div class="stat-card-sub">${last?.dateStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Top digit</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${topD}</div>
      <div class="stat-card-sub">${score}${note}</div>
    </div>`;
}

// ── Digit bars ────────────────────────────────────────────────────────────
function renderDigitBars (model) {
  const { digitMeta } = model;
  const sorted = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob);
  const maxP   = digitMeta[sorted[0]].prob;
  const wrap   = $('digitBars');
  wrap.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'dbar-hdr';
  hdr.innerHTML = `
    <div></div>
    <div>Score bar <small style="opacity:.45;font-weight:400">(▏= 10% fair baseline)</small></div>
    <div>Score</div><div>vs base</div><div>Since</div><div>Zone</div>`;
  wrap.appendChild(hdr);

  sorted.forEach(d => {
    const m    = digitMeta[d];
    const sign = m.vsBase >= 0 ? '+' : '';
    let barColor, pill;
    if      (m.isElev)  { barColor = 'hsl(38,78%,52%)';  pill = `<span class="cpill cpill-amber">Elevated ⚠</span>`; }
    else if (m.isCalib) { barColor = 'hsl(142,55%,44%)'; pill = `<span class="cpill cpill-green">Calibrated ✓</span>`; }
    else                { barColor = 'var(--primary)';   pill = `<span class="cpill cpill-muted">Normal</span>`; }

    const row = document.createElement('div');
    row.className = 'dbar-row';
    row.title = `Digit ${d} · score ${fmt2(m.prob)} · base ${fmt2(m.baseFreq)} · avg gap ${m.avgGap.toFixed(1)} · ${m.since} since last`;
    row.innerHTML = `
      <div class="dbar-lbl">${d}</div>
      <div class="dbar-track">
        <div class="dbar-fill" style="width:${(m.prob/maxP*100).toFixed(1)}%;background:${barColor}"></div>
        <div class="dbar-baseline" style="left:${Math.min(98,(0.10/maxP*100)).toFixed(1)}%"></div>
      </div>
      <div class="dbar-score" style="color:${m.isCalib?'hsl(142,55%,40%)':'var(--foreground)'}">${fmt1(m.prob)}</div>
      <div class="dbar-excess" style="color:${m.vsBase>=0?'hsl(142,55%,40%)':'hsl(5,68%,48%)'}">${sign}${fmt1(m.vsBase)}</div>
      <div class="dbar-since" style="${m.ovRatioRaw>1.5?'color:hsl(15,78%,50%);font-weight:600':''}">${m.since}d${m.ovRatioRaw>1?' ×'+m.ovRatioRaw.toFixed(1):''}</div>
      <div>${pill}</div>`;
    wrap.appendChild(row);
  });
}

// ── Pair table ────────────────────────────────────────────────────────────
function renderPairTable (model) {
  const { digitMeta, numProbs, digitProb } = model;
  const pairs = [];
  DIGITS.forEach(a => {
    DIGITS.forEach(b => {
      if (b < a) return;
      const p = a === b ? numProbs[a+b] : numProbs[a+b] + numProbs[b+a];
      pairs.push({ a, b, prob: p, aCalib: digitMeta[a].isCalib, bCalib: digitMeta[b].isCalib,
                   aElev: digitMeta[a].isElev, bElev: digitMeta[b].isElev });
    });
  });
  pairs.sort((x, y) => y.prob - x.prob);
  const top  = pairs.slice(0, topN);
  const maxP = top[0].prob;

  let html = `<table class="pt"><thead><tr>
    <th>#</th><th>Pair</th><th>Tickets</th><th colspan="2">Combined P</th><th>Digit scores</th>
  </tr></thead><tbody>`;

  top.forEach(({ a, b, prob, aCalib, bCalib, aElev, bElev }, i) => {
    const isSame = a === b;
    const fa = aElev ? `<span class="cpill cpill-amber" style="font-size:.5rem">⚠</span>` : aCalib ? `<span class="cpill cpill-green" style="font-size:.5rem">✓</span>` : '';
    const fb = bElev ? `<span class="cpill cpill-amber" style="font-size:.5rem">⚠</span>` : bCalib ? `<span class="cpill cpill-green" style="font-size:.5rem">✓</span>` : '';
    const barColor = (aCalib||bCalib) ? 'hsl(142,55%,44%)' : (aElev||bElev) ? 'hsl(38,78%,52%)' : 'var(--primary)';

    html += `<tr>
      <td style="color:var(--muted-foreground);font-size:.7rem">${i+1}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)">{${a},${b}}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground)">${a+b}${isSame?'':' + '+b+a}</td>
      <td>
        <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:600">${fmt2(prob)}</div>
        <div class="pt-bar"><div class="pt-bar-fill" style="width:${(prob/maxP*100).toFixed(1)}%;background:${barColor}"></div></div>
      </td>
      <td style="width:0;padding:0"></td>
      <td style="font-size:.72rem;white-space:nowrap">${a}${fa} ${fmt1(digitProb[a])} &nbsp;${b}${fb} ${fmt1(digitProb[b])}</td>
    </tr>`;
  });

  html += `</tbody></table>
    <p class="pair-note">
      {5,9} = both "59" and "95" — always buy both. Symmetry confirmed (no positional bias, Z=−1.52).
      Combined P = 2 × P(A) × P(B).
      ✓ calibrated zone 17–22% (backtest: 22.3% hit vs 19% baseline).
      ⚠ elevated &gt;22% — fewer than 3% of draws reach this, too little data to trust.
    </p>`;
  $('pairTable').innerHTML = html;
}

// ── Lookahead ─────────────────────────────────────────────────────────────
function renderLookahead (model) {
  const { digitMeta } = model;
  const Ns     = [1, 2, 3, 4, 6];
  const sorted = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 8);

  let html = `<table class="la-tbl"><thead><tr>
    <th>Digit</th><th>Score</th><th>vs base</th>
    ${Ns.map(n => `<th>+${n} draw${n>1?'s':''}</th>`).join('')}
    <th>Zone</th>
  </tr></thead><tbody>`;

  sorted.forEach(d => {
    const m    = digitMeta[d];
    const sign = m.vsBase >= 0 ? '+' : '';
    const ovNote = m.ovRatioRaw > 1.5
      ? ` <span style="font-size:.6rem;color:hsl(15,78%,50%)">(×${m.ovRatioRaw.toFixed(1)} gap)</span>` : '';

    html += `<tr>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.0625rem">${d}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.82rem">${fmt1(m.prob)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.75rem;color:${m.vsBase>=0?'hsl(142,55%,40%)':'hsl(5,68%,48%)'}">${sign}${fmt1(m.vsBase)}</td>`;

    Ns.forEach(N => {
      const p = cumP(m.pDraw, N);
      html += `<td class="${p>=0.75?'la-hi':p>=0.45?'la-med':'la-lo'}">${fmt1(p)}</td>`;
    });

    html += `<td>${
      m.isElev  ? `<span class="cpill cpill-amber">Elevated ⚠</span>` :
      m.isCalib ? `<span class="cpill cpill-green">Calibrated ✓</span>` :
                  `<span class="cpill cpill-muted">Normal</span>`
    }${ovNote}</td></tr>`;
  });

  html += `</tbody></table>
    <p style="font-size:.7rem;color:var(--muted-foreground);margin-top:.625rem;line-height:1.6">
      P(digit appears ≥1× in N draws) = 1−(1−P<sub>draw</sub>)<sup>N</sup>,
      P<sub>draw</sub> = 1−(1−score)².
      Calibrated 17–22%: zone analysis found 22.3% actual hit rate vs 19% baseline.
      Elevated &gt;22%: almost never occurs — do not over-interpret those readings.
    </p>`;
  $('lookaheadTable').innerHTML = html;
}

// ── Backtest ──────────────────────────────────────────────────────────────
function runBacktest () {
  const N = allDraws.length, out = [];
  for (let i = MIN_HIST; i < N; i++) {
    const seq   = allDraws.slice(0, i).map(d => d.twoNum);
    const model = computeModel(seq, recW);
    if (!model) continue;
    const { numProbs, digitMeta } = model;
    const topNums = Object.entries(numProbs).sort((a, b) => b[1]-a[1]).slice(0, topN).map(([n]) => n);
    const actual  = allDraws[i].twoNum;
    const pActual = Math.max(numProbs[actual]||0, numProbs[mirror(actual)]||0);
    const pairHit = topNums.includes(actual) || topNums.includes(mirror(actual));
    const topDigs = DIGITS.slice().sort((a, b) => digitMeta[b].prob - digitMeta[a].prob).slice(0, 4);
    function hor (k) {
      for (let j = 1; j <= k && (i+j) < N; j++) {
        const a = allDraws[i+j].twoNum;
        if (topNums.includes(a) || topNums.includes(mirror(a))) return a;
      }
      return null;
    }
    out.push({ i, dateStr: allDraws[i].dateStr, actual, topNums, topDigs, pActual, pairHit, hit2: hor(2), hit4: hor(4), digitMeta });
  }
  return out;
}

function renderBacktest () {
  const bt  = runBacktest();
  if (!bt.length) return;
  const n   = bt.length;
  const pr  = bt.filter(r => r.pairHit).length / n;
  const h2r = bt.filter(r => r.hit2).length    / n;
  const h4r = bt.filter(r => r.hit4).length    / n;
  const bl  = topN / 100;
  const z   = (pr - bl) / Math.sqrt(bl * (1 - bl) / n);
  const se  = Math.sqrt(bl * (1 - bl) / n) * 100;

  $('btSummary').innerHTML = `
    <div class="bt-sum-item"><div class="bt-sum-lbl">Tested</div><div class="bt-sum-val">${n}</div></div>
    <div class="bt-sum-item">
      <div class="bt-sum-lbl">Pair hit (top ${topN})</div>
      <div class="bt-sum-val" style="color:${pr>bl?'hsl(142,55%,40%)':'hsl(5,68%,48%)'}">${(pr*100).toFixed(1)}%</div>
    </div>
    <div class="bt-sum-item">
      <div class="bt-sum-lbl">Random baseline</div>
      <div class="bt-sum-val" style="color:var(--muted-foreground)">${(bl*100).toFixed(0)}%</div>
    </div>
    <div class="bt-sum-item">
      <div class="bt-sum-lbl">Z-score</div>
      <div class="bt-sum-val" style="color:${Math.abs(z)>=1.96?'hsl(142,55%,40%)':'var(--muted-foreground)'}">
        ${z.toFixed(2)}${Math.abs(z)>=1.96?' ✓':' (not sig.)'}
      </div>
    </div>
    <div class="bt-sum-item"><div class="bt-sum-lbl">Margin of error</div><div class="bt-sum-val" style="color:var(--muted-foreground)">±${se.toFixed(1)}pp</div></div>
    <div class="bt-sum-item"><div class="bt-sum-lbl">Hit in +2 draws</div><div class="bt-sum-val">${(h2r*100).toFixed(1)}%</div></div>
    <div class="bt-sum-item"><div class="bt-sum-lbl">Hit in +4 draws</div><div class="bt-sum-val">${(h4r*100).toFixed(1)}%</div></div>`;

  const rows = bt.slice(-btRows);
  let grid = `<div class="bt-hdr">
    <div>Date</div><div>Drawn</div><div>Prob</div>
    <div>Pred digits → got</div><div>Top picks (first 10)</div>
    <div style="text-align:center">Pair</div><div style="text-align:center">+2</div><div style="text-align:center">+4</div>
  </div>`;

  rows.forEach(r => {
    const actualDs = [r.actual[0], r.actual[1]];
    const chips = r.topNums.slice(0, 10).map(n => {
      const hit  = n === r.actual || n === mirror(r.actual);
      const elev = r.digitMeta[n[0]]?.isElev || r.digitMeta[n[1]]?.isElev;
      return `<span class="bt-chip${hit?' pair-hit':elev?' elev-pred':''}">${n}</span>`;
    }).join('');
    const predStr = r.topDigs.map(d => {
      const h = actualDs.includes(d);
      return `<span style="font-weight:${h?700:400};color:${h?'hsl(142,55%,38%)':'var(--muted-foreground)'}">${d}</span>`;
    }).join('·');
    const gotStr = actualDs.map(d => {
      return `<span style="color:${r.topDigs.includes(d)?'hsl(142,55%,38%)':'var(--foreground)'}">${d}</span>`;
    }).join('');

    grid += `<div class="bt-row">
      <div class="bt-date">${r.dateStr}</div>
      <div class="bt-actual" style="color:${r.pairHit?'hsl(142,55%,40%)':'var(--foreground)'}">${r.actual}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:.7rem;color:${r.pActual>0.02?'hsl(142,55%,38%)':'var(--muted-foreground)'}">${fmt2(r.pActual)}</div>
      <div style="font-size:.68rem;font-family:'JetBrains Mono',monospace;white-space:nowrap">${predStr}→${gotStr}</div>
      <div class="bt-chips">${chips}</div>
      ${r.pairHit?'<div class="bt-cell bt-yes">✓</div>':'<div class="bt-cell bt-no">—</div>'}
      ${r.hit2?`<div class="bt-cell bt-hit2">${r.hit2}</div>`:'<div class="bt-cell bt-no">—</div>'}
      ${r.hit4?`<div class="bt-cell bt-hit4">${r.hit4}</div>`:'<div class="bt-cell bt-no">—</div>'}
    </div>`;
  });
  $('btGrid').innerHTML = grid;
}

init().catch(err => { setStatus('', 'Error: ' + err.message); console.error(err); });
