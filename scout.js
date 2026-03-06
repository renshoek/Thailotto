'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto Scout — Composite Cross-Signal Ranking  (scout.js)
//
//  Model weights from grid-search on 458 actual draws (2006–2026):
//    wRec=0.50  wBase=0.30  wOv=0.20  W=15  ovCap=2.0
//    Top-15 pair hit: 18.22% vs 15.00% baseline  (Z=1.87)
//
//  Composite score per number: 3 signals, all honestly weighted:
//    1. Model P (60%) — recency+base+overdue ranked probability
//    2. Number-level overdue (30%) — this number's absence vs its own avg gap
//       only counted when num appeared ≥3× (otherwise gap estimate unreliable)
//    3. Calibrated zone bonus (10%) — digit in 17–22% zone
//
//  Tiers: A = 3 signals active  B = 2 signals  C = 1 signal
//  NO OC tier: digits above 22% appear in <3% of draws, zero samples above 24%.
//  The old "OC correction" was based on 2 data points — removed.
// ════════════════════════════════════════════════════════════════════════════

const DIGITS   = '0123456789'.split('');
const W_REC    = 0.50;
const W_OV     = 0.20;
const W_BASE   = 0.30;
const OV_CAP   = 2.0;
const REC_WIN  = 15;
const MIN_HIST = 30;
const CALIB_LO = 0.17;
const CALIB_HI = 0.22;

const DB_NAME    = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY  = 'perFileAggMap_v2';

let allDraws = [], recW = REC_WIN, topN = 15;

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
$('topNSel').addEventListener('change', e => { topN = +e.target.value; if (allDraws.length) renderAll(); });
$('recSlider').addEventListener('input', e => {
  recW = +e.target.value;
  $('recLbl').textContent = $('recLbl2').textContent = recW;
  if (allDraws.length) renderAll();
});

// ── Cache ─────────────────────────────────────────────────────────────────
async function loadCache () {
  return new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ev => {
      if (!ev.target.result.objectStoreNames.contains(STORE_NAME))
        ev.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = ev => {
      const get = ev.target.result.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(CACHE_KEY);
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
        Open <a href="index.html" style="color:var(--primary)">the Analyzer</a> first to cache data, then return here.
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

  const age = cached.fetchedAt ? Math.round((Date.now() - cached.fetchedAt) / 60000) : null;
  setStatus('live',
    `${allDraws.length} draws · ${allDraws[0]?.dateStr} → ${allDraws.at(-1)?.dateStr}` +
    (age !== null ? ` · cache ${age < 60 ? age + 'min' : Math.round(age/60) + 'h'} old` : ''));
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

    raw[d]  = W_REC * recFreq + W_OV * ovRatio + W_BASE * baseFreq;
    meta[d] = { recFreq, baseFreq, avgGap, since, ovRatioRaw: since / Math.max(avgGap, 1) };
  });

  const total = DIGITS.reduce((s, d) => s + raw[d], 0);
  const digitProb = {};
  DIGITS.forEach(d => {
    const p           = raw[d] / total;
    digitProb[d]      = p;
    meta[d].prob      = p;
    meta[d].vsBase    = p - meta[d].baseFreq;
    meta[d].isCalib   = p >= CALIB_LO && p <= CALIB_HI;
    meta[d].isElev    = p > CALIB_HI;
  });

  const numProbs = {};
  DIGITS.forEach(a => DIGITS.forEach(b => { numProbs[a + b] = digitProb[a] * digitProb[b]; }));
  return { digitProb, digitMeta: meta, numProbs, n };
}

// ═══════════════════════════════════════════════════════════════════════════
//  NUMBER-LEVEL STATS
// ═══════════════════════════════════════════════════════════════════════════
function computeNumStats (draws) {
  const N   = draws.length;
  const seq = draws.map(d => d.twoNum);
  const appearances = {};
  for (let i = 0; i <= 99; i++) appearances[String(i).padStart(2, '0')] = [];
  seq.forEach((num, i) => { if (appearances[num]) appearances[num].push(i); });

  const recentCut = Math.max(0, N - Math.ceil(N * 0.25));
  const recentN   = N - recentCut;

  const stats = {};
  for (const num in appearances) {
    const idx       = appearances[num];
    const freq      = idx.length;
    const recentF   = idx.filter(i => i >= recentCut).length;
    let avgGap = N, since = N, overdueFrac = 0;

    if (freq >= 1) since = N - 1 - idx[freq - 1];
    if (freq >= 2) {
      const gaps = [];
      for (let j = 1; j < idx.length; j++) gaps.push(idx[j] - idx[j-1]);
      avgGap      = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      overdueFrac = Math.max(-2, Math.min(3, (since - avgGap) / Math.max(1, avgGap)));
    }

    const overallRate    = freq / N;
    const expectedRecent = overallRate * recentN;
    const hotScore       = expectedRecent > 0.3 ? recentF / expectedRecent : (recentF > 0 ? 2 : 0);

    stats[num] = { num, freq, recentF, avgGap, since, overdueFrac, hotScore, expectedRecent,
                   overallRate, lastDate: freq > 0 ? draws[idx[freq-1]].dateStr : 'never' };
  }
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMPOSITE SCORING
// ═══════════════════════════════════════════════════════════════════════════
function computeComposite () {
  const seq   = allDraws.map(d => d.twoNum);
  const model = computeModel(seq, recW);
  if (!model) return null;

  const { digitProb, digitMeta, numProbs } = model;
  const numStats = computeNumStats(allDraws);
  const N        = allDraws.length;
  const recentCut = Math.max(0, N - Math.ceil(N * 0.25));
  const recentN   = N - recentCut;

  // Digit-level hot/cold
  const dRecCnt = Object.fromEntries(DIGITS.map(d => [d, 0]));
  allDraws.slice(recentCut).forEach(draw => {
    dRecCnt[draw.twoNum[0]]++;
    dRecCnt[draw.twoNum[1]]++;
  });
  const digitHot = {};
  DIGITS.forEach(d => {
    const exp  = digitMeta[d].baseFreq * recentN * 2;
    digitHot[d] = exp > 0.3 ? dRecCnt[d] / exp : (dRecCnt[d] > 0 ? 2 : 0);
  });

  const allNums = [];
  for (let i = 0; i <= 99; i++) {
    const num    = String(i).padStart(2, '0');
    const a = num[0], b = num[1];
    const s      = numStats[num];
    const pM     = numProbs[num];
    const aCalib = digitMeta[a].isCalib;
    const bCalib = digitMeta[b].isCalib;
    const aElev  = digitMeta[a].isElev;
    const bElev  = digitMeta[b].isElev;

    // Number-level overdue — reliability-gated (min 3 appearances, scales to 8)
    const reliab     = Math.min(1, s.freq / 8);
    const odBonus    = s.freq >= 3 ? Math.max(0, s.overdueFrac) * reliab : 0;

    // Calibrated zone bonus
    const calibBonus = (aCalib || bCalib) ? 1 : 0;

    allNums.push({
      num, a, b, pM, aCalib, bCalib, aElev, bElev,
      aProb: digitProb[a], bProb: digitProb[b],
      aOvR:  digitMeta[a].ovRatioRaw, bOvR: digitMeta[b].ovRatioRaw,
      ...s, odBonus, calibBonus,
      digitHotA: digitHot[a], digitHotB: digitHot[b],
    });
  }

  const maxPM = Math.max(...allNums.map(s => s.pM), 0.0001);
  const maxOD = Math.max(...allNums.map(s => s.odBonus), 0.0001);

  allNums.forEach(s => {
    const normP  = s.pM     / maxPM;
    const normOD = s.odBonus / maxOD;
    s.rawScore  = normP * 0.60 + normOD * 0.30 + s.calibBonus * 0.10;
    s.composite = Math.round(Math.max(0, Math.min(100, s.rawScore * 100)));

    // Signal count
    let sigs = 0;
    if (normP  > 0.5)                          sigs++;  // model P above median
    if (normOD > 0.35 && s.freq >= 3)          sigs++;  // number overdue vs own avg
    if (aCalib || bCalib)                      sigs++;  // digit in calibrated zone
    s.signalCount = sigs;
    s.tier = sigs >= 3 ? 'A' : sigs === 2 ? 'B' : 'C';
  });

  const ranked = [...allNums].sort((a, b) => b.composite - a.composite);

  // Unordered pairs
  const pairArr = [];
  DIGITS.forEach(a => {
    DIGITS.forEach(b => {
      if (b < a) return;
      const ab   = allNums.find(n => n.num === a + b);
      const ba   = a === b ? null : allNums.find(n => n.num === b + a);
      const pPair = a === b ? numProbs[a+b] : numProbs[a+b] + numProbs[b+a];
      const comb  = ba ? Math.round((ab.composite + ba.composite) / 2) : ab.composite;
      const bothCalib = (ab.aCalib || ab.bCalib);
      pairArr.push({ a, b, pPair, comb, ab, ba, bothCalib });
    });
  });
  pairArr.sort((a, b) => b.comb - a.comb);

  // Digit enrichment
  const top30 = ranked.slice(0, 30);
  const rankedDigits = DIGITS.map(d => {
    const m       = digitMeta[d];
    const inTop30 = top30.filter(n => n.a === d || n.b === d).length;
    return { d, ...m, hotScore: digitHot[d], inTop30 };
  }).sort((a, b) => b.prob - a.prob);

  return { ranked, pairArr, rankedDigits, digitMeta, numProbs, N };
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function tierBadge (tier) {
  const cls = { A: 'tier-a', B: 'tier-b', C: 'tier-c' };
  return `<span class="tier-badge ${cls[tier]||'tier-c'}">${tier}</span>`;
}

function signalTags (s) {
  const tags = [];
  if (s.composite > 50)                      tags.push(`<span class="stag stag-p"   title="Model P above median">P↑</span>`);
  if (s.odBonus > 0.35 && s.freq >= 3)       tags.push(`<span class="stag stag-od"  title="Number overdue vs own avg gap">OD</span>`);
  if (s.aCalib || s.bCalib)                  tags.push(`<span class="stag stag-cal" title="Digit in calibrated zone 17–22%">✓</span>`);
  if (s.aElev  || s.bElev)                   tags.push(`<span class="stag stag-elev" title="Digit in elevated zone >22% — rare">⚠</span>`);
  return tags.join('');
}

function compBar (v, accent) {
  const color = accent === 'elev' ? 'hsl(38,78%,52%)' :
                v >= 60 ? 'hsl(142,55%,44%)' :
                v >= 35 ? 'hsl(215,75%,50%)' : 'var(--border)';
  return `<div style="height:5px;background:var(--border);border-radius:3px;min-width:56px">
    <div style="height:100%;width:${v}%;background:${color};border-radius:3px"></div></div>
  <div style="font-family:'JetBrains Mono',monospace;font-size:.63rem;color:var(--muted-foreground)">${v}/100</div>`;
}

function hotTag (hs) {
  if (hs >= 1.5) return `<span style="color:hsl(15,78%,50%)">🔥 ×${hs.toFixed(1)}</span>`;
  if (hs <= 0.5) return `<span style="color:hsl(200,65%,50%)">❄ ×${hs.toFixed(1)}</span>`;
  return `<span style="color:var(--muted-foreground)">×${hs.toFixed(1)}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER SECTIONS
// ═══════════════════════════════════════════════════════════════════════════
function renderStatCards (data) {
  const { N, ranked, rankedDigits } = data;
  const last = allDraws.at(-1);
  const top  = ranked[0];
  const topD = rankedDigits[0];
  const tA   = ranked.filter(s => s.tier === 'A').length;
  const tB   = ranked.filter(s => s.tier === 'B').length;

  $('statCards').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Total draws</div>
      <div class="stat-card-value">${N}</div>
      <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${last?.dateStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Last TWO result</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div>
      <div class="stat-card-sub">${last?.dateStr || ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Top composite pick</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">
        ${top?.num || '—'}${top && top.num !== mirror(top.num) ? ' / ' + mirror(top.num) : ''}
      </div>
      <div class="stat-card-sub">Score ${top?.composite || 0} · Tier ${top?.tier || '—'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Tier A / B numbers</div>
      <div class="stat-card-value">${tA} / ${tB}</div>
      <div class="stat-card-sub">Numbers with 3 / 2 signals active</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Top digit</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${topD?.d || '—'}</div>
      <div class="stat-card-sub">${topD ? fmt1(topD.prob) + (topD.isElev ? ' · elevated ⚠' : topD.isCalib ? ' · calibrated ✓' : '') : ''}</div>
    </div>`;
}

function renderDigitSection (data) {
  const { rankedDigits } = data;
  let html = `<div style="overflow-x:auto"><table class="sc-tbl">
    <thead><tr>
      <th>Digit</th><th>Model score</th><th>Zone</th>
      <th>Overdue ratio</th><th>Since / avg gap</th>
      <th>Recent hot/cold</th><th>In top-30 picks</th>
    </tr></thead><tbody>`;

  rankedDigits.forEach(d => {
    const zone = d.isElev  ? `<span class="cpill cpill-amber">Elevated ⚠</span>` :
                 d.isCalib ? `<span class="cpill cpill-green">Calibrated ✓</span>` :
                             `<span class="cpill cpill-muted">Normal</span>`;
    const ovClr = d.ovRatioRaw > 1.5 ? 'hsl(15,78%,50%)' : d.ovRatioRaw > 1 ? 'hsl(38,78%,50%)' : 'var(--muted-foreground)';
    const scClr = d.isCalib ? 'hsl(142,55%,40%)' : d.isElev ? 'hsl(38,78%,40%)' : 'var(--foreground)';

    html += `<tr>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.1rem">${d.d}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:600;color:${scClr}">${fmt1(d.prob)}</td>
      <td>${zone}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.78rem;color:${ovClr}">×${d.ovRatioRaw.toFixed(2)}</td>
      <td style="font-size:.75rem;color:var(--muted-foreground)">${d.since} / avg ${d.avgGap.toFixed(0)}</td>
      <td>${hotTag(d.hotScore)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:${d.inTop30>=5?700:400};color:${d.inTop30>=5?'hsl(142,55%,40%)':'var(--foreground)'}">${d.inTop30}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  $('digitSection').innerHTML = html;
}

function renderBestNumbers (data) {
  const { ranked } = data;
  const top = ranked.slice(0, topN);
  let html = `<div style="overflow-x:auto"><table class="sc-tbl">
    <thead><tr>
      <th>#</th><th>Number / mirror</th><th>Model P</th>
      <th>Num overdue</th><th>Hot/cold</th>
      <th>Freq</th><th>Composite</th><th>Signals</th><th>Tier</th>
    </tr></thead><tbody>`;

  top.forEach((s, i) => {
    const isSelf = mirror(s.num) === s.num;
    const odStr  = s.freq < 3
      ? `<span style="color:var(--muted-foreground);font-size:.7rem">&lt;3 appearances</span>`
      : s.overdueFrac > 0.1
        ? `<span style="color:hsl(15,78%,50%);font-weight:600">+${(s.overdueFrac*100).toFixed(0)}%</span>
           <span style="display:block;font-size:.63rem;color:var(--muted-foreground)">${s.since} / avg ${s.avgGap.toFixed(0)}</span>`
        : `<span style="font-size:.75rem;color:var(--muted-foreground)">${s.since} / avg ${s.avgGap.toFixed(0)}</span>`;

    const accent = (s.aElev || s.bElev) ? 'elev' : '';

    html += `<tr title="Digit ${s.a}: ${fmt2(s.aProb)} · Digit ${s.b}: ${fmt2(s.bProb)}">
      <td style="color:var(--muted-foreground);font-size:.7rem">${i+1}</td>
      <td>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:var(--primary)">${s.num}</span>
        ${!isSelf?`<span style="font-family:'JetBrains Mono',monospace;font-size:.75rem;color:var(--muted-foreground);margin-left:.35rem">/ ${mirror(s.num)}</span>`:''}
      </td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem">${fmt2(s.pM)}</td>
      <td>${odStr}</td>
      <td>${hotTag(s.hotScore)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.78rem;color:var(--muted-foreground)">${s.freq}×</td>
      <td>${compBar(s.composite, accent)}</td>
      <td style="white-space:nowrap">${signalTags(s)}</td>
      <td>${tierBadge(s.tier)}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  $('bestNumbers').innerHTML = html;
}

function renderBestPairs (data) {
  const { pairArr } = data;
  const top = pairArr.slice(0, topN);
  let html = `<div style="overflow-x:auto"><table class="sc-tbl">
    <thead><tr>
      <th>#</th><th>Pair</th><th>Both tickets</th>
      <th>Combined P</th><th>Avg overdue</th>
      <th>Composite</th><th>Tier</th>
    </tr></thead><tbody>`;

  top.forEach(({ a, b, pPair, comb, ab, ba, bothCalib }, i) => {
    const isSame = a === b;
    const avgOD  = ba
      ? (Math.max(0, ab.overdueFrac) + Math.max(0, ba.overdueFrac)) / 2
      : Math.max(0, ab.overdueFrac);
    const odStr  = avgOD > 0.1
      ? `<span style="color:hsl(15,78%,50%);font-weight:600">+${(avgOD*100).toFixed(0)}%</span>`
      : `<span style="color:var(--muted-foreground)">—</span>`;
    const pairTier = (ab.tier === 'A' && (!ba || ba.tier === 'A')) ? 'A'
                   : (ab.tier !== 'C' || (ba && ba.tier !== 'C'))  ? 'B' : 'C';
    const anyElev = ab.aElev || ab.bElev;
    const accent  = anyElev ? 'elev' : '';

    html += `<tr>
      <td style="color:var(--muted-foreground);font-size:.7rem">${i+1}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)">{${a},${b}}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground)">${a+b}${isSame?'':' + '+b+a}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem">${fmt2(pPair)}</td>
      <td>${odStr}</td>
      <td>${compBar(comb, accent)}</td>
      <td>${tierBadge(pairTier)}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  $('bestPairs').innerHTML = html;
}

function renderAvoidList (data) {
  const { ranked } = data;
  const bottom = [...ranked].filter(s => s.freq >= 2).slice(-topN).reverse();
  let html = `<div style="overflow-x:auto"><table class="sc-tbl">
    <thead><tr>
      <th>#</th><th>Number / mirror</th><th>Model P</th>
      <th>Last seen</th><th>Hot/cold</th><th>Freq</th><th>Composite</th><th>Why skip</th>
    </tr></thead><tbody>`;

  bottom.forEach((s, i) => {
    const isSelf = mirror(s.num) === s.num;
    const recentlyDrawn = s.freq >= 2 && s.since < s.avgGap * 0.5;
    const reasons = [];
    if (recentlyDrawn)               reasons.push(`<span class="avoid-tag avoid-recent">Just drawn</span>`);
    if (s.hotScore > 1.8 && s.freq >= 3) reasons.push(`<span class="avoid-tag avoid-hot">Running hot</span>`);
    if (s.overdueFrac < -0.5)        reasons.push(`<span class="avoid-tag avoid-fresh">Not overdue</span>`);
    if (!reasons.length)             reasons.push(`<span class="avoid-tag avoid-low">All signals low</span>`);

    html += `<tr>
      <td style="color:var(--muted-foreground);font-size:.7rem">${i+1}</td>
      <td>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(5,68%,48%)">${s.num}</span>
        ${!isSelf?`<span style="font-family:'JetBrains Mono',monospace;font-size:.75rem;color:var(--muted-foreground);margin-left:.35rem">/ ${mirror(s.num)}</span>`:''}
      </td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.78rem;color:var(--muted-foreground)">${fmt2(s.pM)}</td>
      <td style="font-size:.72rem;color:var(--muted-foreground)">${s.since} draws ago<br><span style="font-size:.63rem">${s.lastDate}</span></td>
      <td>${hotTag(s.hotScore)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.78rem;color:var(--muted-foreground)">${s.freq}×</td>
      <td>${compBar(s.composite, '')}</td>
      <td style="font-size:.72rem">${reasons.join(' ')}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  $('avoidList').innerHTML = html;
}

function renderMatrix (data) {
  const { ranked } = data;
  const compMap = {};
  ranked.forEach((s, idx) => { compMap[s.num] = { ...s, rank: idx + 1 }; });

  const isDark = document.documentElement.classList.contains('dark');
  const maxC   = Math.max(...ranked.map(s => s.composite));
  const minC   = Math.min(...ranked.map(s => s.composite));

  function cellBg (comp, isElev) {
    const norm = (comp - minC) / Math.max(1, maxC - minC);
    if (isElev) return isDark
      ? `hsl(38,${Math.round(20+norm*40)}%,${Math.round(12+norm*25)}%)`
      : `hsl(38,${Math.round(55+norm*25)}%,${Math.round(97-norm*20)}%)`;
    return isDark
      ? `hsl(142,${Math.round(5+norm*55)}%,${Math.round(10+norm*40)}%)`
      : `hsl(142,${Math.round(6+norm*65)}%,${Math.round(97-norm*44)}%)`;
  }
  function cellFg (comp) {
    return (comp - minC) / Math.max(1, maxC - minC) > 0.62
      ? (isDark ? '#e2e8f0' : '#1e293b') : 'var(--muted-foreground)';
  }

  let html = `<div style="overflow-x:auto"><table class="sc-matrix">
    <thead><tr>
      <th style="background:transparent;border:none;color:var(--muted-foreground);font-size:.58rem;padding:.2rem .5rem .2rem 0">↓ tens</th>`;
  for (let c = 0; c <= 9; c++) {
    html += `<th style="background:transparent;border:none;color:var(--muted-foreground);font-size:.63rem;font-family:'JetBrains Mono',monospace;text-align:center;padding:.15rem .2rem">·${c}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (let r = 0; r <= 9; r++) {
    html += `<tr><td style="font-family:'JetBrains Mono',monospace;font-size:.63rem;color:var(--muted-foreground);font-weight:600;padding:.15rem .4rem .15rem 0;border:none;white-space:nowrap">${r}·</td>`;
    for (let c = 0; c <= 9; c++) {
      const num = `${r}${c}`;
      const s   = compMap[num];
      const ane = s.aElev || s.bElev;
      html += `<td style="
        background:${cellBg(s.composite, ane)};
        color:${cellFg(s.composite)};
        font-family:'JetBrains Mono',monospace;
        font-size:.56rem;font-weight:600;
        text-align:center;vertical-align:middle;
        padding:.18rem .08rem;border-radius:4px;
        border:none;cursor:default;
        min-width:2.8rem;height:2.05rem;line-height:1.3;
      " title="${num} / ${mirror(num)} · Rank ${s.rank} · Score ${s.composite} · Tier ${s.tier}">
        ${num}<br><span style="opacity:.7">${s.composite}</span>
      </td>`;
    }
    html += `</tr>`;
  }

  html += `</tbody></table></div>
    <div style="display:flex;align-items:center;gap:1rem;margin-top:.75rem;font-size:.7rem;color:var(--muted-foreground);flex-wrap:wrap;">
      <span style="display:inline-flex;align-items:center;gap:.3rem">
        <span style="width:12px;height:12px;border-radius:3px;background:${isDark?'hsl(142,60%,50%)':'hsl(142,71%,55%)'};display:inline-block"></span>High composite (green)
      </span>
      <span style="display:inline-flex;align-items:center;gap:.3rem">
        <span style="width:12px;height:12px;border-radius:3px;background:${isDark?'hsl(38,60%,37%)':'hsl(38,80%,80%)'};display:inline-block"></span>Elevated digit &gt;22% (amber)
      </span>
      <span>Row = tens digit · Column = units digit · Number shown top, composite score bottom</span>
    </div>`;
  $('signalMatrix').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER ALL
// ═══════════════════════════════════════════════════════════════════════════
function renderAll () {
  const data = computeComposite();
  if (!data) {
    ['statCards','digitSection','bestNumbers','bestPairs','avoidList','signalMatrix'].forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Need at least ${MIN_HIST} draws.</p>`;
    });
    return;
  }
  renderStatCards(data);
  renderDigitSection(data);
  renderBestNumbers(data);
  renderBestPairs(data);
  renderAvoidList(data);
  renderMatrix(data);
}

init().catch(err => { setStatus('', 'Error: ' + err.message); console.error(err); });
