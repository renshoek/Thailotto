'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  Thai Lotto Scout — Composite Cross-Signal Ranking  (scout.js)
//
//  Combines four independent signals:
//    1. Probability model  (predictions.js model: recency + overdue + base rate)
//    2. Number-level overdue  (specific number's absence vs its own avg gap)
//    3. Hot / cold divergence  (recent rate vs expected rate for that number)
//    4. Calibration zone  (is the digit in the 17–20% honest zone?)
//
//  Composite score = 50% model P (OC-corrected) + 30% num-overdue (reliability-gated)
//                  + 5% calib bonus + 5% hot/cold tiebreaker
//  Tier A: ≥3 independent signals, no OC
//  Tier B: 2 signals
//  Tier C: 1 signal
//  OC:     any digit scored >24% (model historically WORSE than random here)
// ═══════════════════════════════════════════════════════════════════════════

const DIGITS     = '0123456789'.split('');
const W_REC      = 0.50, W_OV = 0.20, W_BASE = 0.30;
const OV_CAP     = 2.0;
const CALIB_LO   = 0.17, CALIB_HI = 0.22;

const MIN_HIST   = 30;
const DB_NAME    = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY  = 'perFileAggMap_v2';

let allDraws = [], recW = 15, topN = 15;

const $         = id => document.getElementById(id);
const pct1      = v  => (v * 100).toFixed(1) + '%';
const pct2      = v  => (v * 100).toFixed(2) + '%';
const mirror    = n  => n.length === 2 ? n[1] + n[0] : n;
const parseNums = s  => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];

// ── Theme ──────────────────────────────────────────────────────────────────
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

// ── Controls ───────────────────────────────────────────────────────────────
$('topNSel').addEventListener('change', e => { topN = +e.target.value; renderAll(); });
$('recSlider').addEventListener('input', e => {
  recW = +e.target.value;
  $('recLbl').textContent  = recW;
  $('recLbl2').textContent = recW;
  if (allDraws.length) renderAll();
});

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
    setStatus('', 'No data loaded.');
    const mc = $('mainContent');
    if (mc) mc.insertAdjacentHTML('beforeend', `
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
    `${allDraws.length} draws loaded · ${allDraws[0]?.dateStr} → ${allDraws.at(-1)?.dateStr}` +
    (age !== null ? ` · cached ${age < 60 ? age + 'min' : Math.round(age/60) + 'h'} ago` : ''));

  renderAll();
}

function setStatus(state, txt) {
  $('statusText').textContent = txt;
  $('statusDot').className = 'status-dot' + (state === 'live' ? ' live' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE MODEL  (identical to predictions.js — no imports across pages)
// ═══════════════════════════════════════════════════════════════════════════
function computeModel(seq, W) {
  const n = seq.length;
  if (n < MIN_HIST) return null;
  const safeW = Math.min(W, n - 1);

  const recCount  = Object.fromEntries(DIGITS.map(d => [d, 0]));
  const baseCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
  seq.slice(-safeW).forEach(num => {
    recCount[num[0]]  = (recCount[num[0]]  || 0) + 1;
    recCount[num[1]]  = (recCount[num[1]]  || 0) + 1;
  });
  seq.forEach(num => {
    baseCount[num[0]] = (baseCount[num[0]] || 0) + 1;
    baseCount[num[1]] = (baseCount[num[1]] || 0) + 1;
  });
  const baseTotal = n * 2;

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
    const ovRatio  = avgGap > 0 ? Math.min(since / avgGap, OV_CAP) : 0;
    rawScore[d]    = W_REC * recFreq + W_OV * (ovRatio / OV_CAP) + W_BASE * baseFreq;
    meta[d] = { recFreq, baseFreq, avgGap, since, ovRatio };
  });

  const total = DIGITS.reduce((s, d) => s + rawScore[d], 0);
  const digitProb = {};
  DIGITS.forEach(d => {
    const p = rawScore[d] / total;
    digitProb[d] = p;
    meta[d].prob         = p;
    
    meta[d].isCalib      = p >= CALIB_LO && p <= CALIB_HI;
    meta[d].isElev = p > CALIB_HI;  // any score >22% is 'elevated' (rare zone)
    meta[d].excessVsBase = p - meta[d].baseFreq;
    meta[d].pDraw        = 1 - Math.pow(1 - p, 2);
  });

  const numProbs = {};
  DIGITS.forEach(a => DIGITS.forEach(b => { numProbs[a + b] = digitProb[a] * digitProb[b]; }));

  return { digitProb, digitMeta: meta, numProbs };
}

// ═══════════════════════════════════════════════════════════════════════════
//  NUMBER-LEVEL STATS  (mirrors insights.js computeInsights for TWO)
// ═══════════════════════════════════════════════════════════════════════════
function computeNumStats(draws) {
  const N   = draws.length;
  const seq = draws.map(d => d.twoNum);

  // Build appearance index for all 00–99
  const appearances = {};
  for (let i = 0; i <= 99; i++) appearances[String(i).padStart(2, '0')] = [];
  seq.forEach((num, i) => { if (appearances[num]) appearances[num].push(i); });

  const recentCut = Math.max(0, N - Math.ceil(N * 0.25));
  const recentN   = N - recentCut;

  const stats = {};
  for (const num in appearances) {
    const idxList    = appearances[num];
    const totalFreq  = idxList.length;
    const recentFreq = idxList.filter(i => i >= recentCut).length;

    let avgGap = N, sinceLastSeen = N, overdueFrac = 0, gapCV = 0;

    if (totalFreq >= 1) sinceLastSeen = N - 1 - idxList[totalFreq - 1];
    if (totalFreq >= 2) {
      const gaps = [];
      for (let j = 1; j < idxList.length; j++) gaps.push(idxList[j] - idxList[j-1]);
      avgGap      = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      overdueFrac = Math.max(-2, Math.min(3, (sinceLastSeen - avgGap) / Math.max(1, avgGap)));
      if (gaps.length >= 2) {
        const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length);
        gapCV = sd / Math.max(1, avgGap);   // coefficient of variation: low = consistent gaps
      }
    }

    const overallRate    = totalFreq / N;
    const expectedRecent = overallRate * recentN;
    // Hot score: actual recent / expected recent.  Needs expected > 0.3 to be meaningful.
    const hotScore = expectedRecent > 0.3
      ? recentFreq / expectedRecent
      : (recentFreq > 0 ? 2 : 0);

    stats[num] = {
      num, totalFreq, recentFreq, avgGap, sinceLastSeen, overdueFrac,
      gapCV, hotScore, expectedRecent, overallRate,
      lastDate: totalFreq > 0 ? draws[idxList[totalFreq - 1]].dateStr : 'never',
    };
  }
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMPOSITE SCORING
// ═══════════════════════════════════════════════════════════════════════════
function computeComposite() {
  const seq   = allDraws.map(d => d.twoNum);
  const model = computeModel(seq, recW);
  if (!model) return null;

  const { digitProb, digitMeta, numProbs } = model;
  const numStats = computeNumStats(allDraws);
  const N        = allDraws.length;

  // ── Digit-level hot/cold ──────────────────────────────────────────────
  const recentCut = Math.max(0, N - Math.ceil(N * 0.25));
  const recentN   = N - recentCut;
  const dRecCount = Object.fromEntries(DIGITS.map(d => [d, 0]));
  allDraws.slice(recentCut).forEach(draw => {
    dRecCount[draw.twoNum[0]] = (dRecCount[draw.twoNum[0]] || 0) + 1;
    dRecCount[draw.twoNum[1]] = (dRecCount[draw.twoNum[1]] || 0) + 1;
  });
  const digitHot = {};
  DIGITS.forEach(d => {
    const expected = digitMeta[d].baseFreq * recentN * 2;
    const actual   = dRecCount[d];
    digitHot[d]    = expected > 0.3 ? actual / expected : (actual > 0 ? 2 : 0);
  });

  // ── Per-number composite ──────────────────────────────────────────────
  const allNums = [];
  for (let i = 0; i <= 99; i++) {
    const num   = String(i).padStart(2, '0');
    const a = num[0], b = num[1];
    const s     = numStats[num];
    const pM    = numProbs[num];      // exact P(ab)
    const aOC   = digitMeta[a].isElev;
    const bOC   = digitMeta[b].isElev;
    const anyOC = aOC || bOC;
    const aCalib = digitMeta[a].isCalib, bCalib = digitMeta[b].isCalib;

    // OC-corrected model probability
    const pAdj = pM;  // no OC correction: >22% zone has 0 backtest samples

    // Number-level overdue bonus
    // Only meaningful when number appeared ≥3 times.  Reliability saturates at 8 appearances.
    const freqReliability = Math.min(1, s.totalFreq / 8);
    const overdueBonus    = s.totalFreq >= 3 ? Math.max(0, s.overdueFrac) * freqReliability : 0;

    // Minor hot/cold tiebreaker (recency-only is worse than random — low weight)
    const hotAdj = Math.max(-1, Math.min(1, s.hotScore - 1));

    allNums.push({
      num, a, b, pM, pAdj, anyOC, aOC, bOC, aCalib, bCalib,
      aProb: digitProb[a], bProb: digitProb[b],
      aOvR:  digitMeta[a].ovRatio, bOvR: digitMeta[b].ovRatio,
      ...s,
      overdueBonus, hotAdj, freqReliability,
      digitHotA: digitHot[a], digitHotB: digitHot[b],
    });
  }

  // ── Normalise across all 100 numbers ─────────────────────────────────
  const maxPAdj    = Math.max(...allNums.map(s => s.pAdj),    0.0001);
  const maxOverdue = Math.max(...allNums.map(s => s.overdueBonus), 0.0001);

  allNums.forEach(s => {
    const normP  = s.pAdj         / maxPAdj;
    const normOD = s.overdueBonus / maxOverdue;
    // Calibration bonus: both digits not OC and at least one in 17–20% zone
    const calibBonus = (!s.anyOC && (s.aCalib || s.bCalib)) ? 0.05 : 0;

    s.rawScore  = normP * 0.50 + normOD * 0.30 + s.hotAdj * 0.05 + calibBonus;
    s.composite = Math.round(Math.max(0, Math.min(100, s.rawScore * 100)));

    // Independent signal count
    let sigs = 0;
    if (normP  > 0.5)                            sigs++;  // model ranks this number above median
    if (normOD > 0.4 && s.totalFreq >= 3)        sigs++;  // number overdue vs own average
    if (s.hotScore > 1.3 && s.totalFreq >= 3)    sigs++;  // recently running hot
    if (!s.anyOC && (s.aCalib || s.bCalib))      sigs++;  // in the model's calibrated zone
    s.signalCount = sigs;

    if      (s.anyOC)     s.tier = 'OC';
    else if (sigs >= 3)   s.tier = 'A';
    else if (sigs === 2)  s.tier = 'B';
    else                  s.tier = 'C';
  });

  const ranked = [...allNums].sort((a, b) => b.composite - a.composite);

  // ── Unordered pairs ───────────────────────────────────────────────────
  const pairArr = [];
  DIGITS.forEach(a => {
    DIGITS.forEach(b => {
      if (b < a) return;
      const ab   = allNums.find(n => n.num === a + b);
      const ba   = a === b ? null : allNums.find(n => n.num === b + a);
      const pPair = a === b ? numProbs[a + b] : numProbs[a + b] + numProbs[b + a];
      const combinedComp = ba
        ? Math.round((ab.composite + ba.composite) / 2)
        : ab.composite;
      const anyOC = digitMeta[a].isElev || digitMeta[b].isElev;
      pairArr.push({ a, b, pPair, combinedComp, anyOC, ab, ba });
    });
  });
  const rankedPairs = pairArr.sort((a, b) => b.combinedComp - a.combinedComp);

  // ── Digit enrichment: how many of the top-30 numbers contain this digit ─
  const top30 = ranked.slice(0, 30);
  const rankedDigits = DIGITS.map(d => {
    const m       = digitMeta[d];
    const inTop30 = top30.filter(n => n.a === d || n.b === d).length;
    return { d, ...m, hotScore: digitHot[d], inTop30 };
  }).sort((a, b) => b.prob - a.prob);

  return { ranked, rankedPairs, rankedDigits, digitMeta, digitProb, numProbs, N };
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function tierBadge(tier) {
  const map = {
    A:  'tier-a', B: 'tier-b',
    C:  'tier-c', OC: 'tier-oc',
  };
  return `<span class="tier-badge ${map[tier] || 'tier-c'}">${tier}</span>`;
}

function signalDots(s) {
  const dots = [];
  const maxP    = 0.0001; // placeholder — real threshold relative
  if (s.composite > 50)                             dots.push(`<span class="sdot sdot-model" title="Model P above median">P↑</span>`);
  if (s.overdueBonus > 0.4 && s.totalFreq >= 3)    dots.push(`<span class="sdot sdot-od"    title="Number overdue vs own avg">OD</span>`);
  if (s.hotScore > 1.3 && s.totalFreq >= 3)         dots.push(`<span class="sdot sdot-hot"   title="Running hot recently">🔥</span>`);
  if (!s.anyOC && (s.aCalib || s.bCalib))           dots.push(`<span class="sdot sdot-cal"   title="Calibrated zone 17–20%">✓</span>`);
  if (s.anyOC)                                      dots.push(`<span class="sdot sdot-oc"    title="Overconfident digit >24%">⚠</span>`);
  return dots.join('');
}

function compBar(composite, danger) {
  const color = danger
    ? 'hsl(5,68%,52%)'
    : composite >= 60 ? 'hsl(142,55%,44%)'
    : composite >= 35 ? 'hsl(38,78%,52%)'
    : 'var(--muted-foreground)';
  return `<div style="height:5px;background:var(--border);border-radius:3px;min-width:52px">
    <div style="height:100%;width:${composite}%;background:${color};border-radius:3px"></div>
  </div>
  <div style="font-family:'JetBrains Mono',monospace;font-size:.65rem;color:var(--muted-foreground)">${composite}/100</div>`;
}

function hotLabel(hotScore) {
  if (hotScore >= 1.5) return `<span style="color:hsl(15,80%,52%)">🔥 ×${hotScore.toFixed(1)}</span>`;
  if (hotScore <= 0.5) return `<span style="color:hsl(200,70%,52%)">❄️ ×${hotScore.toFixed(1)}</span>`;
  return `<span style="color:var(--muted-foreground)">×${hotScore.toFixed(1)}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 1 — STAT CARDS
// ═══════════════════════════════════════════════════════════════════════════
function renderStatCards(data) {
  const { N, ranked, rankedDigits } = data;
  const last   = allDraws.at(-1);
  const topNum = ranked[0];
  const topDig = rankedDigits[0];
  const tierACnt = ranked.filter(s => s.tier === 'A').length;
  const tierBCnt = ranked.filter(s => s.tier === 'B').length;

  $('statCards').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Total draws</div>
      <div class="stat-card-value">${N}</div>
      <div class="stat-card-sub">${allDraws[0]?.dateStr} → ${last?.dateStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Last result (TWO)</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:var(--primary)">${last?.twoNum || '—'}</div>
      <div class="stat-card-sub">${last?.dateStr || ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Top composite pick</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:${topNum?.anyOC ? 'hsl(5,68%,48%)' : 'var(--primary)'}">
        ${topNum?.num || '—'}${topNum && topNum.num !== mirror(topNum.num) ? ' / ' + mirror(topNum.num) : ''}
      </div>
      <div class="stat-card-sub">Score ${topNum?.composite || 0} · Tier ${topNum?.tier || '—'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Tier A / B numbers</div>
      <div class="stat-card-value">${tierACnt} / ${tierBCnt}</div>
      <div class="stat-card-sub">Numbers with ≥3 / 2 independent signals</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Top digit</div>
      <div class="stat-card-value" style="font-family:'JetBrains Mono',monospace;color:${topDig?.isElev ? 'hsl(5,68%,48%)' : 'var(--primary)'}">
        ${topDig?.d || '—'}
      </div>
      <div class="stat-card-sub">${topDig ? pct1(topDig.prob) + (topDig.isElev ? ' ⚠ OC' : topDig.isCalib ? ' ✓ calibrated' : '') : ''}</div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 2 — DIGIT RANKING
// ═══════════════════════════════════════════════════════════════════════════
function renderDigitSection(data) {
  const { rankedDigits } = data;

  let html = `<div class="sc-scroll"><table class="sc-tbl">
    <thead><tr>
      <th>Digit</th><th>Model score</th><th>Zone</th>
      <th>Overdue ratio</th><th>Since / avg gap</th>
      <th>Digit hot/cold</th><th>In top-30 picks</th>
    </tr></thead><tbody>`;

  rankedDigits.forEach(d => {
    let zoneBadge;
    if      (d.isElev)    zoneBadge = `<span class="cpill cpill-red">OC &gt;24%</span>`;
    else if (d.isCalib) zoneBadge = `<span class="cpill cpill-green">Calibrated ✓</span>`;
    else if (d.isElev)  zoneBadge = `<span class="cpill cpill-amber">Elevated</span>`;
    else                zoneBadge = `<span class="cpill cpill-muted">Low</span>`;

    const ovColor = d.ovRatio > 1.5 ? 'hsl(15,78%,50%)' : d.ovRatio > 1 ? 'hsl(38,78%,50%)' : 'var(--muted-foreground)';
    const scoreColor = d.isElev ? 'hsl(5,68%,48%)' : d.isCalib ? 'hsl(142,55%,40%)' : 'var(--foreground)';

    html += `<tr>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.125rem">${d.d}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:600;color:${scoreColor}">${pct1(d.prob)}</td>
      <td>${zoneBadge}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:${ovColor}">×${d.ovRatio.toFixed(2)}</td>
      <td style="font-size:.75rem;color:var(--muted-foreground)">${d.since} / avg ${d.avgGap.toFixed(0)} draws</td>
      <td>${hotLabel(d.hotScore)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;font-weight:${d.inTop30 >= 5 ? '700' : '400'};color:${d.inTop30 >= 5 ? 'hsl(142,55%,40%)' : 'var(--foreground)'}">${d.inTop30}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;
  $('digitSection').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3 — BEST NUMBERS
// ═══════════════════════════════════════════════════════════════════════════
function renderBestNumbers(data) {
  const { ranked } = data;
  const top = ranked.slice(0, topN);

  let html = `<div class="sc-scroll"><table class="sc-tbl">
    <thead><tr>
      <th>#</th><th>Number / mirror</th><th>Model P</th>
      <th>Num overdue</th><th>Hot/cold</th>
      <th>Freq</th><th>Composite</th><th>Signals</th><th>Tier</th>
    </tr></thead><tbody>`;

  top.forEach((s, i) => {
    const mir    = mirror(s.num);
    const isSelf = mir === s.num;

    // Model P: show strike-through raw + corrected if OC
    const pDisplay = s.anyOC
      ? `<span style="text-decoration:line-through;opacity:.4;font-size:.75rem">${pct2(s.pM)}</span><br>
         <span style="font-size:.75rem;color:hsl(5,68%,48%);font-weight:600">~${pct2(s.pM)}</span>`
      : `<span style="font-family:'JetBrains Mono',monospace;font-size:.8rem">${pct2(s.pM)}</span>`;

    // Number-level overdue
    const odStr = s.totalFreq < 3
      ? `<span style="color:var(--muted-foreground);font-size:.7rem">&lt;3 appearances</span>`
      : s.overdueFrac > 0.1
        ? `<span style="color:hsl(15,78%,50%);font-weight:600">+${(s.overdueFrac * 100).toFixed(0)}%</span>
           <span style="display:block;font-size:.65rem;color:var(--muted-foreground)">${s.sinceLastSeen} / avg ${s.avgGap.toFixed(0)}</span>`
        : `<span style="color:var(--muted-foreground);font-size:.75rem">${s.sinceLastSeen} / avg ${s.avgGap.toFixed(0)}</span>`;

    html += `<tr title="Digit ${s.a}: ${pct2(s.aProb)} · Digit ${s.b}: ${pct2(s.bProb)} · Gap CV: ${s.gapCV.toFixed(2)}">
      <td style="color:var(--muted-foreground);font-size:.7rem">${i+1}</td>
      <td>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:${s.anyOC ? 'hsl(5,68%,48%)' : 'var(--primary)'}">${s.num}</span>
        ${!isSelf ? `<span style="font-family:'JetBrains Mono',monospace;font-size:.75rem;color:var(--muted-foreground);margin-left:.35rem">/ ${mir}</span>` : ''}
      </td>
      <td>${pDisplay}</td>
      <td>${odStr}</td>
      <td>${hotLabel(s.hotScore)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground)">${s.totalFreq}×</td>
      <td>${compBar(s.composite, s.anyOC)}</td>
      <td style="white-space:nowrap">${signalDots(s)}</td>
      <td>${tierBadge(s.tier)}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;
  $('bestNumbers').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 4 — BEST PAIRS
// ═══════════════════════════════════════════════════════════════════════════
function renderBestPairs(data) {
  const { rankedPairs } = data;
  const top = rankedPairs.slice(0, topN);

  let html = `<div class="sc-scroll"><table class="sc-tbl">
    <thead><tr>
      <th>#</th><th>Pair</th><th>Both tickets</th>
      <th>Combined P</th><th>Avg overdue</th>
      <th>Avg hot/cold</th><th>Composite</th><th>Tier</th>
    </tr></thead><tbody>`;

  top.forEach(({ a, b, pPair, combinedComp, anyOC, ab, ba }, i) => {
    const isSame = a === b;
    const t1 = a + b, t2 = isSame ? null : b + a;

    const pDisplay = anyOC
      ? `<span style="text-decoration:line-through;opacity:.4;font-size:.75rem">${pct2(pPair)}</span>
         <span style="font-size:.75rem;color:hsl(5,68%,48%);font-weight:600"> ~${pct2(pPair)}</span>`
      : `<span style="font-family:'JetBrains Mono',monospace;font-size:.8rem">${pct2(pPair)}</span>`;

    const avgOD = ba
      ? (Math.max(0, ab.overdueFrac) + Math.max(0, ba.overdueFrac)) / 2
      : Math.max(0, ab.overdueFrac);
    const odStr = avgOD > 0.1
      ? `<span style="color:hsl(15,78%,50%);font-weight:600">+${(avgOD * 100).toFixed(0)}%</span>`
      : `<span style="color:var(--muted-foreground)">—</span>`;

    const avgHot = ba ? (ab.hotScore + ba.hotScore) / 2 : ab.hotScore;

    // Tier: worst of the two individual numbers
    const pairTier = anyOC ? 'OC'
      : (ab.tier === 'A' && (!ba || ba.tier === 'A')) ? 'A'
      : (ab.tier !== 'C' || (ba && ba.tier !== 'C')) ? 'B'
      : 'C';

    html += `<tr>
      <td style="color:var(--muted-foreground);font-size:.7rem">${i+1}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)${anyOC?';opacity:.6':''}">{${a},${b}}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground)">${t1}${t2 ? ' + ' + t2 : ''}</td>
      <td>${pDisplay}</td>
      <td>${odStr}</td>
      <td>${hotLabel(avgHot)}</td>
      <td>${compBar(combinedComp, anyOC)}</td>
      <td>${tierBadge(pairTier)}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;
  $('bestPairs').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 5 — AVOID LIST
// ═══════════════════════════════════════════════════════════════════════════
function renderAvoidList(data) {
  const { ranked } = data;
  // Bottom topN with ≥2 appearances (exclude never/rarely drawn — no data to judge)
  const bottom = [...ranked].filter(s => s.totalFreq >= 2).slice(-topN).reverse();

  let html = `<div class="sc-scroll"><table class="sc-tbl">
    <thead><tr>
      <th>#</th><th>Number / mirror</th><th>Model P</th>
      <th>Last drawn</th><th>Hot/cold</th>
      <th>Freq</th><th>Composite</th><th>Why skip</th>
    </tr></thead><tbody>`;

  bottom.forEach((s, i) => {
    const mir    = mirror(s.num);
    const isSelf = mir === s.num;
    const recentlyDrawn = s.totalFreq >= 2 && s.sinceLastSeen < s.avgGap * 0.5;

    const reasons = [];
    if (s.anyOC)        reasons.push(`<span class="avoid-tag avoid-oc">⚠ OC digit</span>`);
    if (recentlyDrawn)  reasons.push(`<span class="avoid-tag avoid-recent">Just drawn</span>`);
    if (s.hotScore > 1.8 && s.totalFreq >= 3) reasons.push(`<span class="avoid-tag avoid-hot">Running hot</span>`);
    if (s.overdueFrac < -0.5) reasons.push(`<span class="avoid-tag avoid-fresh">Not overdue</span>`);
    if (!reasons.length) reasons.push(`<span class="avoid-tag avoid-low">All signals low</span>`);

    html += `<tr>
      <td style="color:var(--muted-foreground);font-size:.7rem">${i+1}</td>
      <td>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.9375rem;color:hsl(5,68%,48%)">${s.num}</span>
        ${!isSelf ? `<span style="font-family:'JetBrains Mono',monospace;font-size:.75rem;color:var(--muted-foreground);margin-left:.35rem">/ ${mir}</span>` : ''}
      </td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground)">${pct2(s.pM)}</td>
      <td style="font-size:.75rem;color:var(--muted-foreground)">${s.sinceLastSeen} draws ago<br><span style="font-size:.65rem">${s.lastDate}</span></td>
      <td>${hotLabel(s.hotScore)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted-foreground)">${s.totalFreq}×</td>
      <td>${compBar(s.composite, true)}</td>
      <td style="font-size:.75rem">${reasons.join(' ')}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;
  $('avoidList').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 6 — SIGNAL MATRIX 10×10
// ═══════════════════════════════════════════════════════════════════════════
function renderMatrix(data) {
  const { ranked } = data;
  const compMap = {};
  ranked.forEach((s, idx) => { compMap[s.num] = { ...s, rank: idx + 1 }; });

  const isDarkMode = document.documentElement.classList.contains('dark');
  const maxC = Math.max(...ranked.map(s => s.composite));
  const minC = Math.min(...ranked.map(s => s.composite));

  function cellBg(comp, anyOC) {
    const norm = (comp - minC) / Math.max(1, maxC - minC);
    if (anyOC) {
      return isDarkMode
        ? `hsl(5,${Math.round(25 + norm*45)}%,${Math.round(13 + norm*24)}%)`
        : `hsl(5,${Math.round(55 + norm*25)}%,${Math.round(97 - norm*22)}%)`;
    }
    return isDarkMode
      ? `hsl(142,${Math.round(6 + norm*58)}%,${Math.round(11 + norm*40)}%)`
      : `hsl(142,${Math.round(8 + norm*68)}%,${Math.round(97 - norm*44)}%)`;
  }
  function cellFg(comp) {
    const norm = (comp - minC) / Math.max(1, maxC - minC);
    return norm > 0.6
      ? (isDarkMode ? '#e2e8f0' : '#1e293b')
      : 'var(--muted-foreground)';
  }

  let html = `<div style="overflow-x:auto"><table class="sc-matrix">
    <thead><tr>
      <th style="background:transparent;border:none;color:var(--muted-foreground);font-size:.6rem;padding:.2rem .4rem">↓tens / units→</th>`;
  for (let col = 0; col <= 9; col++) {
    html += `<th style="background:transparent;border:none;color:var(--muted-foreground);font-size:.65rem;font-family:'JetBrains Mono',monospace;text-align:center;padding:.15rem .25rem">·${col}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (let row = 0; row <= 9; row++) {
    html += `<tr><td style="font-family:'JetBrains Mono',monospace;font-size:.65rem;color:var(--muted-foreground);font-weight:600;padding:.15rem .4rem .15rem 0;border:none;white-space:nowrap">${row}·</td>`;
    for (let col = 0; col <= 9; col++) {
      const num = `${row}${col}`;
      const s   = compMap[num];
      html += `<td style="
        background:${cellBg(s.composite, s.anyOC)};
        color:${cellFg(s.composite)};
        font-family:'JetBrains Mono',monospace;
        font-size:.58rem; font-weight:600;
        text-align:center; vertical-align:middle;
        padding:.2rem .1rem; border-radius:4px;
        border: none; cursor:default;
        min-width:2.8rem; height:2.1rem;
        line-height:1.3;
      " title="${num} / ${mirror(num)} · Rank ${s.rank} of 100 · Score ${s.composite} · Tier ${s.tier}${s.anyOC ? ' · ⚠ OC' : ''}">
        ${num}<br><span style="opacity:.75">${s.composite}</span>
      </td>`;
    }
    html += `</tr>`;
  }

  html += `</tbody></table></div>
    <div style="display:flex;align-items:center;gap:1rem;margin-top:.75rem;font-size:.7rem;color:var(--muted-foreground);flex-wrap:wrap;">
      <span>Key:</span>
      <span style="display:inline-flex;align-items:center;gap:.3rem">
        <span style="width:12px;height:12px;border-radius:3px;background:${isDarkMode?'hsl(142,64%,51%)':'hsl(142,76%,55%)'};display:inline-block;"></span>High composite ✓
      </span>
      <span style="display:inline-flex;align-items:center;gap:.3rem">
        <span style="width:12px;height:12px;border-radius:3px;background:${isDarkMode?'hsl(142,6%,22%)':'hsl(142,8%,96%)'};border:1px solid var(--border);display:inline-block;"></span>Low composite
      </span>
      <span style="display:inline-flex;align-items:center;gap:.3rem">
        <span style="width:12px;height:12px;border-radius:3px;background:${isDarkMode?'hsl(5,70%,37%)':'hsl(5,80%,88%)'};display:inline-block;"></span>OC digit (red)
      </span>
      <span>Top-left = number · Bottom = composite score</span>
    </div>`;

  $('signalMatrix').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER ALL
// ═══════════════════════════════════════════════════════════════════════════
function renderAll() {
  const data = computeComposite();
  if (!data) {
    ['statCards','digitSection','bestNumbers','bestPairs','avoidList','signalMatrix'].forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = `<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Not enough data yet (min ${MIN_HIST} draws).</p>`;
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

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════
init().catch(err => {
  setStatus('', 'Error loading data: ' + err.message);
  console.error('scout.js:', err);
});
