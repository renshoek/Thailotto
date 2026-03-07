'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  Thai Lotto Scout — Composite Cross-Signal Ranking  (scout.js)
//  Weights: wRec=0.50  wBase=0.30  wOv=0.20  W=15  ovCap=2.0
//  Top-15 pair hit: 18.22% vs 15.00% baseline  (Z=1.87, n=428)
// ════════════════════════════════════════════════════════════════════════════

var DIGITS    = ['0','1','2','3','4','5','6','7','8','9'];
var W_REC     = 0.50;
var W_OV      = 0.20;
var W_BASE    = 0.30;
var OV_CAP    = 2.0;
var REC_WIN   = 15;
var MIN_HIST  = 30;
var CALIB_LO  = 0.17;
var CALIB_HI  = 0.22;

var DB_NAME    = 'thai-lotto-agg-db';
var STORE_NAME = 'agg-store';
var CACHE_KEY  = 'perFileAggMap_v2';

var allDraws   = [];
var recW       = REC_WIN;
var topN       = 15;
var predCutoff = 0;
var btRowsN    = 20;

function $el(id) { return document.getElementById(id); }
function parseNums(s) { return s ? s.split(',').map(function(x){return x.trim();}).filter(Boolean) : []; }
function mirrorNum(n) { return n[1] + n[0]; }
function fmt1(v) { return (v * 100).toFixed(1) + '%'; }
function fmt2(v) { return (v * 100).toFixed(2) + '%'; }

// ── Theme ─────────────────────────────────────────────────────────────────
$el('themeToggle').addEventListener('click', function() {
  var dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  if (allDraws.length) renderAll();
});
(function() {
  var s = localStorage.getItem('theme');
  if (s === 'dark' || (!s && window.matchMedia('(prefers-color-scheme:dark)').matches))
    document.documentElement.classList.add('dark');
})();

// ── Controls ──────────────────────────────────────────────────────────────
$el('topNSel').addEventListener('change', function(e) {
  topN = +e.target.value;
  if (allDraws.length) renderAll();
});
$el('recSlider').addEventListener('input', function(e) {
  recW = +e.target.value;
  $el('recLbl').textContent  = recW;
  $el('recLbl2').textContent = recW;
  if (allDraws.length) renderAll();
});
if ($el('predCutoffInput')) {
  $el('predCutoffInput').addEventListener('input', function(e) {
    var v = parseInt(e.target.value, 10);
    predCutoff = (!e.target.value.trim() || isNaN(v) || v <= 0) ? 0 : v;
    updateCutoffLabel();
    if (allDraws.length) renderAll();
  });
}
if ($el('btRowsSel')) {
  $el('btRowsSel').addEventListener('change', function(e) {
    btRowsN = +e.target.value;
    if (allDraws.length) renderScoutBacktest();
  });
}

function updateCutoffLabel() {
  var el = $el('nextResultDisplay');
  if (!el || !allDraws.length) return;
  var idx = predCutoff > 0 ? predCutoff : allDraws.length;
  if (idx < allDraws.length) {
    var d = allDraws[idx];
    el.innerHTML =
      'Next known result: <strong style="font-family:\'JetBrains Mono\',monospace;color:var(--primary)">' + d.twoNum + '</strong>' +
      ' <span style="color:var(--muted-foreground);font-size:.7rem">(' + d.dateStr + ')</span>';
  } else {
    el.innerHTML = 'Next result: <span style="color:var(--muted-foreground)">future — unknown</span>';
  }
}

// ── IndexedDB Cache ───────────────────────────────────────────────────────
function loadCache() {
  return new Promise(function(resolve) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function(ev) {
      if (!ev.target.result.objectStoreNames.contains(STORE_NAME))
        ev.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = function(ev) {
      var get = ev.target.result.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(CACHE_KEY);
      get.onsuccess = function() { resolve(get.result || null); };
      get.onerror   = function() { resolve(null); };
    };
    req.onerror = function() { resolve(null); };
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  setStatus('', 'Loading from cache\u2026');
  var cached = await loadCache();
  if (!cached || !cached.data || !Object.keys(cached.data).length) {
    setStatus('', 'No cached data.');
    $el('mainContent').insertAdjacentHTML('beforeend',
      '<div style="text-align:center;padding:4rem 2rem;color:var(--muted-foreground)">' +
      'Open <a href="index.html" style="color:var(--primary)">the Analyzer</a> first to cache data.' +
      '</div>');
    return;
  }

  var entries = Object.entries(cached.data);
  var tmp = [];
  for (var ei = 0; ei < entries.length; ei++) {
    var dateStr = entries[ei][0];
    var agg     = entries[ei][1];
    var nums    = parseNums((agg.results || {}).TWO || '').filter(function(n) { return n.length === 2; });
    if (nums[0]) tmp.push({ dateStr: dateStr, twoNum: nums[0] });
  }
  tmp.sort(function(a, b) { return a.dateStr < b.dateStr ? -1 : 1; });
  allDraws = tmp;

  var age = cached.fetchedAt ? Math.round((Date.now() - cached.fetchedAt) / 60000) : null;
  setStatus('live',
    allDraws.length + ' draws \xb7 ' + (allDraws[0] ? allDraws[0].dateStr : '') +
    ' \u2192 ' + (allDraws[allDraws.length - 1] ? allDraws[allDraws.length - 1].dateStr : '') +
    (age !== null ? ' \xb7 cache ' + (age < 60 ? age + 'min' : Math.round(age / 60) + 'h') + ' old' : ''));
  updateCutoffLabel();
  renderAll();
}

function setStatus(state, txt) {
  $el('statusText').textContent = txt;
  $el('statusDot').className = 'status-dot' + (state === 'live' ? ' live' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE DIGIT MODEL
// ═══════════════════════════════════════════════════════════════════════════
function computeModel(seq, W) {
  var n = seq.length;
  if (n < MIN_HIST) return null;
  var safeW = Math.min(W, n - 1);

  var recCnt = {}, baseCnt = {}, lastSeen = {}, gapLists = {};
  for (var di = 0; di < DIGITS.length; di++) {
    var d = DIGITS[di];
    recCnt[d] = 0; baseCnt[d] = 0; lastSeen[d] = -1; gapLists[d] = [];
  }
  var recStart = n - safeW;
  for (var i = 0; i < n; i++) {
    var num = seq[i], d0 = num[0], d1 = num[1];
    baseCnt[d0]++; baseCnt[d1]++;
    if (i >= recStart) { recCnt[d0]++; recCnt[d1]++; }
    if (lastSeen[d0] >= 0) gapLists[d0].push(i - lastSeen[d0]);
    lastSeen[d0] = i;
    if (d1 !== d0) {
      if (lastSeen[d1] >= 0) gapLists[d1].push(i - lastSeen[d1]);
      lastSeen[d1] = i;
    }
  }

  var raw = {}, meta = {};
  for (var di2 = 0; di2 < DIGITS.length; di2++) {
    var dig     = DIGITS[di2];
    var recFreq  = recCnt[dig]  / (2 * safeW);
    var baseFreq = baseCnt[dig] / (n * 2);
    var gaps     = gapLists[dig];
    var avgGap   = gaps.length >= 2 ? gaps.reduce(function(a, b) { return a + b; }, 0) / gaps.length : 5.0;
    var since    = lastSeen[dig] >= 0 ? (n - 1 - lastSeen[dig]) : n;
    var ovRaw    = since / Math.max(avgGap, 1);
    var ovRatio  = Math.min(ovRaw, OV_CAP) / OV_CAP;
    raw[dig]  = W_REC * recFreq + W_OV * ovRatio + W_BASE * baseFreq;
    meta[dig] = { recFreq: recFreq, baseFreq: baseFreq, avgGap: avgGap, since: since, ovRatioRaw: ovRaw };
  }

  var total = 0;
  for (var di3 = 0; di3 < DIGITS.length; di3++) total += raw[DIGITS[di3]];

  var digitProb = {};
  for (var di4 = 0; di4 < DIGITS.length; di4++) {
    var dg = DIGITS[di4];
    var p  = raw[dg] / total;
    digitProb[dg]    = p;
    meta[dg].prob    = p;
    meta[dg].vsBase  = p - meta[dg].baseFreq;
    meta[dg].isCalib = (p >= CALIB_LO && p <= CALIB_HI);
    meta[dg].isElev  = (p > CALIB_HI);
  }

  var numProbs = {};
  for (var ai = 0; ai < DIGITS.length; ai++) {
    for (var bi = 0; bi < DIGITS.length; bi++) {
      numProbs[DIGITS[ai] + DIGITS[bi]] = digitProb[DIGITS[ai]] * digitProb[DIGITS[bi]];
    }
  }
  return { digitProb: digitProb, digitMeta: meta, numProbs: numProbs };
}

// ═══════════════════════════════════════════════════════════════════════════
//  NUMBER-LEVEL STATS  (draws passed as parameter)
// ═══════════════════════════════════════════════════════════════════════════
function computeNumStats(draws) {
  var N         = draws.length;
  var recentCut = Math.max(0, N - Math.ceil(N * 0.25));
  var recentN   = N - recentCut;

  var appearances = {};
  for (var ni = 0; ni <= 99; ni++) appearances[String(ni).padStart(2, '0')] = [];
  for (var di = 0; di < N; di++) {
    var num = draws[di].twoNum;
    if (appearances[num]) appearances[num].push(di);
  }

  var stats = {}, keys = Object.keys(appearances);
  for (var ki = 0; ki < keys.length; ki++) {
    var numStr = keys[ki], idx = appearances[numStr];
    var freq = idx.length, recentF = 0;
    for (var ri = 0; ri < idx.length; ri++) { if (idx[ri] >= recentCut) recentF++; }
    var avgGap = N, since = N, overdueFrac = 0;
    if (freq >= 1) since = N - 1 - idx[freq - 1];
    if (freq >= 2) {
      var gs = 0;
      for (var gi = 1; gi < idx.length; gi++) gs += idx[gi] - idx[gi - 1];
      avgGap      = gs / (idx.length - 1);
      overdueFrac = Math.max(-2, Math.min(3, (since - avgGap) / Math.max(1, avgGap)));
    }
    var overallRate = freq / N;
    var expRecent   = overallRate * recentN;
    var hotScore    = expRecent > 0.3 ? recentF / expRecent : (recentF > 0 ? 2 : 0);
    stats[numStr] = {
      freq: freq, recentF: recentF, avgGap: avgGap, since: since,
      overdueFrac: overdueFrac, hotScore: hotScore, overallRate: overallRate,
      lastDate: freq > 0 ? draws[idx[freq - 1]].dateStr : 'never'
    };
  }
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMPOSITE SCORING  (respects predCutoff)
// ═══════════════════════════════════════════════════════════════════════════
function computeComposite() {
  var draws = (predCutoff > 0 && predCutoff < allDraws.length)
    ? allDraws.slice(0, predCutoff) : allDraws;

  var drawSeq = [];
  for (var qi = 0; qi < draws.length; qi++) drawSeq.push(draws[qi].twoNum);

  var mdl = computeModel(drawSeq, recW);
  if (!mdl) return null;

  var digitProb = mdl.digitProb, digitMeta = mdl.digitMeta, numProbs = mdl.numProbs;
  var numStats  = computeNumStats(draws);
  var totalN    = draws.length;
  var recentCut = Math.max(0, totalN - Math.ceil(totalN * 0.25));
  var recentN   = totalN - recentCut;

  var dRecCnt = {};
  for (var di2 = 0; di2 < DIGITS.length; di2++) dRecCnt[DIGITS[di2]] = 0;
  for (var ri = recentCut; ri < draws.length; ri++) {
    dRecCnt[draws[ri].twoNum[0]]++;
    dRecCnt[draws[ri].twoNum[1]]++;
  }
  var digitHot = {};
  for (var di3 = 0; di3 < DIGITS.length; di3++) {
    var dg  = DIGITS[di3];
    var exp = digitMeta[dg].baseFreq * recentN * 2;
    digitHot[dg] = exp > 0.3 ? dRecCnt[dg] / exp : (dRecCnt[dg] > 0 ? 2 : 0);
  }

  var allNums = [];
  for (var ni = 0; ni <= 99; ni++) {
    var numStr  = String(ni).padStart(2, '0');
    var dA = numStr[0], dB = numStr[1];
    var ns = numStats[numStr];
    var pM = numProbs[numStr];
    var acalib   = digitMeta[dA].isCalib, bcalib = digitMeta[dB].isCalib;
    var aelev    = digitMeta[dA].isElev,  belev  = digitMeta[dB].isElev;
    var reliab   = Math.min(1, ns.freq / 8);
    var odBonus  = ns.freq >= 3 ? Math.max(0, ns.overdueFrac) * reliab : 0;
    var calibBon = (acalib || bcalib) ? 1 : 0;
    allNums.push({
      num: numStr, a: dA, b: dB, pM: pM,
      aCalib: acalib, bCalib: bcalib, aElev: aelev, bElev: belev,
      aProb: digitProb[dA], bProb: digitProb[dB],
      aOvR: digitMeta[dA].ovRatioRaw, bOvR: digitMeta[dB].ovRatioRaw,
      odBonus: odBonus, calibBonus: calibBon,
      digitHotA: digitHot[dA], digitHotB: digitHot[dB],
      freq: ns.freq, recentF: ns.recentF, avgGap: ns.avgGap, since: ns.since,
      overdueFrac: ns.overdueFrac, hotScore: ns.hotScore,
      overallRate: ns.overallRate, lastDate: ns.lastDate,
      rawScore: 0, composite: 0, signalCount: 0, tier: 'C'
    });
  }

  var maxPM = 0.0001, maxOD = 0.0001;
  for (var mi = 0; mi < allNums.length; mi++) {
    if (allNums[mi].pM      > maxPM) maxPM = allNums[mi].pM;
    if (allNums[mi].odBonus > maxOD) maxOD = allNums[mi].odBonus;
  }

  for (var si = 0; si < allNums.length; si++) {
    var e = allNums[si];
    var normP = e.pM / maxPM, normOD = e.odBonus / maxOD;
    e.rawScore  = normP * 0.60 + normOD * 0.30 + e.calibBonus * 0.10;
    e.composite = Math.round(Math.max(0, Math.min(100, e.rawScore * 100)));
    var sigs = 0;
    if (normP  > 0.5)                  sigs++;
    if (normOD > 0.35 && e.freq >= 3) sigs++;
    if (e.aCalib || e.bCalib)         sigs++;
    e.signalCount = sigs;
    e.tier = sigs >= 3 ? 'A' : sigs === 2 ? 'B' : 'C';
  }

  var ranked = allNums.slice().sort(function(x, y) { return y.composite - x.composite; });
  var numMap = {};
  for (var mpi = 0; mpi < ranked.length; mpi++) {
    numMap[ranked[mpi].num] = ranked[mpi];
    numMap[ranked[mpi].num].rank = mpi + 1;
  }

  var pairArr = [];
  for (var pi = 0; pi < DIGITS.length; pi++) {
    for (var pj = pi; pj < DIGITS.length; pj++) {
      var da = DIGITS[pi], db = DIGITS[pj];
      var abKey = da + db, baKey = db + da;
      var entAB = numMap[abKey], entBA = da !== db ? numMap[baKey] : null;
      if (!entAB) continue;
      var pPair = da === db ? numProbs[abKey] : (numProbs[abKey] + numProbs[baKey]);
      var comb  = entBA ? Math.round((entAB.composite + entBA.composite) / 2) : entAB.composite;
      pairArr.push({ da: da, db: db, pPair: pPair, comb: comb, entAB: entAB, entBA: entBA,
                     anyCalib: (entAB.aCalib || entAB.bCalib) });
    }
  }
  pairArr.sort(function(x, y) { return y.comb - x.comb; });

  var top30 = ranked.slice(0, 30);
  var rankedDigits = [];
  for (var rdi = 0; rdi < DIGITS.length; rdi++) {
    var dg2 = DIGITS[rdi], m = digitMeta[dg2];
    var cnt30 = 0;
    for (var ti = 0; ti < top30.length; ti++) {
      if (top30[ti].a === dg2 || top30[ti].b === dg2) cnt30++;
    }
    rankedDigits.push({
      d: dg2, prob: m.prob, vsBase: m.vsBase, baseFreq: m.baseFreq,
      avgGap: m.avgGap, since: m.since, ovRatioRaw: m.ovRatioRaw,
      isCalib: m.isCalib, isElev: m.isElev, hotScore: digitHot[dg2], inTop30: cnt30
    });
  }
  rankedDigits.sort(function(x, y) { return y.prob - x.prob; });

  return { ranked: ranked, pairArr: pairArr, rankedDigits: rankedDigits,
           numMap: numMap, digitMeta: digitMeta, N: totalN };
}

// ═══════════════════════════════════════════════════════════════════════════
//  BACKTEST — lean composite per step (for walk-forward)
// ═══════════════════════════════════════════════════════════════════════════
function computeRankedBT(drawSlice, W) {
  var seq = [];
  for (var qi = 0; qi < drawSlice.length; qi++) seq.push(drawSlice[qi].twoNum);
  var mdl = computeModel(seq, W);
  if (!mdl) return null;

  var digitMeta = mdl.digitMeta, numProbs = mdl.numProbs, N = drawSlice.length;

  var appearances = {};
  for (var ni = 0; ni <= 99; ni++) appearances[String(ni).padStart(2, '0')] = [];
  for (var di = 0; di < N; di++) {
    var num = drawSlice[di].twoNum;
    if (appearances[num]) appearances[num].push(di);
  }

  var allNums = [];
  for (var ni2 = 0; ni2 <= 99; ni2++) {
    var numStr = String(ni2).padStart(2, '0');
    var dA = numStr[0], dB = numStr[1];
    var idx = appearances[numStr], freq = idx.length;
    var avgGap = N, since = N, overdueFrac = 0;
    if (freq >= 1) since = N - 1 - idx[freq - 1];
    if (freq >= 2) {
      var gs = 0;
      for (var gi = 1; gi < idx.length; gi++) gs += idx[gi] - idx[gi - 1];
      avgGap      = gs / (idx.length - 1);
      overdueFrac = Math.max(-2, Math.min(3, (since - avgGap) / Math.max(1, avgGap)));
    }
    var reliab   = Math.min(1, freq / 8);
    var odBonus  = freq >= 3 ? Math.max(0, overdueFrac) * reliab : 0;
    var acalib   = digitMeta[dA].isCalib, bcalib = digitMeta[dB].isCalib;
    allNums.push({
      num: numStr, pM: numProbs[numStr],
      aCalib: acalib, bCalib: bcalib,
      aElev: digitMeta[dA].isElev, bElev: digitMeta[dB].isElev,
      odBonus: odBonus, calibBonus: (acalib || bcalib) ? 1 : 0, freq: freq
    });
  }

  var maxPM = 0.0001, maxOD = 0.0001;
  for (var mi = 0; mi < allNums.length; mi++) {
    if (allNums[mi].pM      > maxPM) maxPM = allNums[mi].pM;
    if (allNums[mi].odBonus > maxOD) maxOD = allNums[mi].odBonus;
  }
  for (var si = 0; si < allNums.length; si++) {
    var e = allNums[si];
    var normP = e.pM / maxPM, normOD = e.odBonus / maxOD;
    e.composite = Math.round(Math.max(0, Math.min(100,
      (normP * 0.60 + normOD * 0.30 + e.calibBonus * 0.10) * 100)));
    var sigs = 0;
    if (normP  > 0.5)                  sigs++;
    if (normOD > 0.35 && e.freq >= 3) sigs++;
    if (e.aCalib || e.bCalib)         sigs++;
    e.tier = sigs >= 3 ? 'A' : sigs === 2 ? 'B' : 'C';
  }
  return allNums.slice().sort(function(x, y) { return y.composite - x.composite; });
}

function runScoutBacktest() {
  var N   = allDraws.length;
  var end = (predCutoff > 0 && predCutoff < N) ? predCutoff : N;
  var out = [];
  for (var i = MIN_HIST; i < end; i++) {
    var slice  = allDraws.slice(0, i);
    var ranked = computeRankedBT(slice, recW);
    if (!ranked) continue;

    var actual = allDraws[i].twoNum, mirAct = mirrorNum(actual);
    var actualRank = -1, actualTier = 'C', actualScore = 0;
    for (var r = 0; r < ranked.length; r++) {
      if (ranked[r].num === actual || ranked[r].num === mirAct) {
        actualRank = r + 1; actualTier = ranked[r].tier; actualScore = ranked[r].composite;
        break;
      }
    }

    var tierANums = [];
    for (var tr = 0; tr < topN && tr < ranked.length; tr++) {
      if (ranked[tr].tier === 'A') tierANums.push(ranked[tr].num);
    }

    out.push({
      i: i, dateStr: allDraws[i].dateStr, actual: actual,
      actualRank: actualRank, actualTier: actualTier, actualScore: actualScore,
      topHit:  actualRank > 0 && actualRank <= topN,
      top1:    ranked[0],
      tierANums: tierANums,
      topPicks: ranked.slice(0, topN)
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER BACKTEST (compact preview + link to full page)
// ═══════════════════════════════════════════════════════════════════════════
function renderScoutBacktest() {
  var btEl = $el('scoutBT');
  if (!btEl || !allDraws.length) return;

  var bt = runScoutBacktest(), n = bt.length;
  if (!n) { btEl.innerHTML = '<p style="color:var(--muted-foreground);font-size:.8rem">Not enough data.</p>'; return; }

  var hits = 0, sumRank = 0, rankCount = 0;
  var tierCnt = { A: 0, B: 0, C: 0 }, tierHit = { A: 0, B: 0, C: 0 };
  var bl = topN / 100;
  for (var i = 0; i < n; i++) {
    var r = bt[i];
    if (r.topHit) hits++;
    if (r.actualRank > 0) { sumRank += r.actualRank; rankCount++; }
    tierCnt[r.actualTier]++;
    if (r.topHit) tierHit[r.actualTier]++;
  }
  var pr  = hits / n;
  var z   = (pr - bl) / Math.sqrt(bl * (1 - bl) / n);
  var se  = Math.sqrt(bl * (1 - bl) / n) * 100;
  var avgR = rankCount > 0 ? (sumRank / rankCount).toFixed(1) : '\u2014';

  var sumHtml =
    '<div class="bt-summary">' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Tested</div><div class="bt-sum-val">' + n + '</div></div>' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Top-' + topN + ' hit rate</div>' +
      '<div class="bt-sum-val" style="color:' + (pr > bl ? 'hsl(142,55%,40%)' : 'hsl(5,68%,48%)') + '">' + (pr * 100).toFixed(1) + '%</div></div>' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Random baseline</div><div class="bt-sum-val" style="color:var(--muted-foreground)">' + (bl * 100).toFixed(0) + '%</div></div>' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Z-score</div>' +
      '<div class="bt-sum-val" style="color:' + (Math.abs(z) >= 1.96 ? 'hsl(142,55%,40%)' : 'var(--muted-foreground)') + '">' + z.toFixed(2) + (Math.abs(z) >= 1.96 ? ' \u2713' : ' (not sig.)') + '</div></div>' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Margin of error</div><div class="bt-sum-val" style="color:var(--muted-foreground)">\xb1' + se.toFixed(1) + 'pp</div></div>' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Avg rank of actual</div><div class="bt-sum-val">' + avgR + '/100</div></div>' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Actual was tier A</div><div class="bt-sum-val">' + tierCnt.A + ' (' + (tierCnt.A / n * 100).toFixed(0) + '%)</div></div>' +
    '<div class="bt-sum-item"><div class="bt-sum-lbl">Actual was tier B</div><div class="bt-sum-val">' + tierCnt.B + ' (' + (tierCnt.B / n * 100).toFixed(0) + '%)</div></div>' +
    '</div>';

  var rows = bt.slice(-btRowsN);
  var grid = '<div class="bt-wrap"><div style="min-width:700px">' +
    '<div class="sc-bt-hdr">' +
    '<div>Date</div><div>Drawn</div><div>Rank</div><div>Score</div><div>Tier</div>' +
    '<div>Top pick</div><div>Tier-A picks</div><div>Top chips</div><div style="text-align:center">Hit?</div></div>';

  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var rankColor = row.actualRank <= 5 ? 'hsl(142,55%,40%)' : row.actualRank <= topN ? 'hsl(38,78%,50%)' : 'var(--muted-foreground)';
    var rankStr   = row.actualRank > 0 ? ('#' + row.actualRank) : 'not in top';
    var aStr      = row.tierANums.length > 0 ? row.tierANums.slice(0, 4).join('\u00a0') : '\u2014';
    var chips = '';
    for (var ci = 0; ci < row.topPicks.length && ci < 8; ci++) {
      var pk  = row.topPicks[ci];
      var hit = pk.num === row.actual || pk.num === mirrorNum(row.actual);
      chips += '<span class="bt-chip' + (hit ? ' pair-hit' : '') + (pk.aElev || pk.bElev ? ' elev-pred' : '') + '">' + pk.num + '</span>';
    }
    var tc  = row.actualTier === 'A' ? 'tier-a' : row.actualTier === 'B' ? 'tier-b' : 'tier-c';
    var tc1 = row.top1.tier  === 'A' ? 'tier-a' : row.top1.tier  === 'B' ? 'tier-b' : 'tier-c';
    grid +=
      '<div class="sc-bt-row">' +
      '<div class="bt-date">' + row.dateStr + '</div>' +
      '<div class="bt-actual" style="color:' + (row.topHit ? 'hsl(142,55%,40%)' : 'var(--foreground)') + '">' + row.actual + '</div>' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.75rem;font-weight:600;color:' + rankColor + '">' + rankStr + '</div>' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.7rem;color:var(--muted-foreground)">' + row.actualScore + '/100</div>' +
      '<div><span class="tier-badge ' + tc + '">' + row.actualTier + '</span></div>' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.75rem">' + row.top1.num + '\u00a0<span class="tier-badge ' + tc1 + '">' + row.top1.tier + '</span></div>' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.7rem;color:var(--primary)">' + aStr + '</div>' +
      '<div class="bt-chips">' + chips + '</div>' +
      (row.topHit ? '<div class="bt-cell bt-yes">\u2713</div>' : '<div class="bt-cell bt-no">\u2014</div>') +
      '</div>';
  }
  grid += '</div></div>';

  var footerHtml =
    '<div style="margin-top:.75rem;font-size:.75rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;">' +
    '<span style="color:var(--muted-foreground)">Showing last ' + btRowsN + ' of ' + n + ' predictions</span>' +
    '<a href="backtest.html" style="color:var(--primary);font-weight:600;text-decoration:none">View full backtest history \u2192</a>' +
    '</div>';

  btEl.innerHTML = sumHtml + grid + footerHtml;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function tierBadge(tier) {
  var cls = tier === 'A' ? 'tier-a' : tier === 'B' ? 'tier-b' : 'tier-c';
  return '<span class="tier-badge ' + cls + '">' + tier + '</span>';
}
function signalTags(e) {
  var out = '';
  if (e.composite > 50)                out += '<span class="stag stag-p" title="Model P above median">P\u2191</span>';
  if (e.odBonus > 0.35 && e.freq >= 3) out += '<span class="stag stag-od" title="Number overdue vs own avg gap">OD</span>';
  if (e.aCalib || e.bCalib)            out += '<span class="stag stag-cal" title="Digit in calibrated zone 17\u201322%">\u2713</span>';
  if (e.aElev  || e.bElev)             out += '<span class="stag stag-elev" title="Elevated digit >22%">\u26a0</span>';
  return out;
}
function compBar(v, isElev) {
  var color = isElev ? 'hsl(38,78%,52%)' : v >= 60 ? 'hsl(142,55%,44%)' : v >= 35 ? 'hsl(215,75%,50%)' : 'var(--border)';
  return '<div style="height:5px;background:var(--border);border-radius:3px;min-width:56px">' +
         '<div style="height:100%;width:' + v + '%;background:' + color + ';border-radius:3px"></div></div>' +
         '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.63rem;color:var(--muted-foreground)">' + v + '/100</div>';
}
function hotTag(hs) {
  if (hs >= 1.5) return '<span style="color:hsl(15,78%,50%)">\uD83D\uDD25 \xd7' + hs.toFixed(1) + '</span>';
  if (hs <= 0.5) return '<span style="color:hsl(200,65%,50%)">\u2744 \xd7'  + hs.toFixed(1) + '</span>';
  return '<span style="color:var(--muted-foreground)">\xd7' + hs.toFixed(1) + '</span>';
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER SECTIONS (unchanged from working version)
// ═══════════════════════════════════════════════════════════════════════════
function renderStatCards(data) {
  var last = allDraws[allDraws.length - 1];
  var top  = data.ranked[0], topD = data.rankedDigits[0];
  var tA = 0, tB = 0;
  for (var i = 0; i < data.ranked.length; i++) {
    if (data.ranked[i].tier === 'A') tA++;
    else if (data.ranked[i].tier === 'B') tB++;
  }
  var topMirror = top && mirrorNum(top.num) !== top.num ? ' / ' + mirrorNum(top.num) : '';
  var winNote = (predCutoff > 0 && predCutoff < allDraws.length)
    ? ' <span style="color:var(--primary);font-size:.65rem;font-weight:600">draw #' + predCutoff + '</span>' : '';
  $el('statCards').innerHTML =
    '<div class="stat-card"><div class="stat-card-label">Total draws</div><div class="stat-card-value">' + data.N + '</div>' +
    '<div class="stat-card-sub">' + (allDraws[0] ? allDraws[0].dateStr : '') + ' \u2192 ' + (last ? last.dateStr : '') + '</div></div>' +
    '<div class="stat-card"><div class="stat-card-label">Last TWO result</div>' +
    '<div class="stat-card-value" style="font-family:\'JetBrains Mono\',monospace;color:var(--primary)">' + (last ? last.twoNum : '\u2014') + '</div>' +
    '<div class="stat-card-sub">' + (last ? last.dateStr : '') + '</div></div>' +
    '<div class="stat-card"><div class="stat-card-label">Top composite pick' + winNote + '</div>' +
    '<div class="stat-card-value" style="font-family:\'JetBrains Mono\',monospace;color:var(--primary)">' + (top ? top.num + topMirror : '\u2014') + '</div>' +
    '<div class="stat-card-sub">Score ' + (top ? top.composite : 0) + ' \xb7 Tier ' + (top ? top.tier : '\u2014') + '</div></div>' +
    '<div class="stat-card"><div class="stat-card-label">Tier A / B numbers</div><div class="stat-card-value">' + tA + ' / ' + tB + '</div>' +
    '<div class="stat-card-sub">Numbers with 3 / 2 signals active</div></div>' +
    '<div class="stat-card"><div class="stat-card-label">Top digit</div>' +
    '<div class="stat-card-value" style="font-family:\'JetBrains Mono\',monospace;color:var(--primary)">' + (topD ? topD.d : '\u2014') + '</div>' +
    '<div class="stat-card-sub">' + (topD ? fmt1(topD.prob) + (topD.isElev ? ' \xb7 elevated \u26a0' : topD.isCalib ? ' \xb7 calibrated \u2713' : '') : '') + '</div></div>';
}

function renderDigitSection(data) {
  var html = '<div style="overflow-x:auto"><table class="sc-tbl"><thead><tr>' +
    '<th>Digit</th><th>Model score</th><th>Zone</th><th>Overdue ratio</th><th>Since / avg gap</th><th>Recent hot/cold</th><th>In top-30 picks</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < data.rankedDigits.length; i++) {
    var d = data.rankedDigits[i];
    var zone  = d.isElev  ? '<span class="cpill cpill-amber">Elevated \u26a0</span>' :
                d.isCalib ? '<span class="cpill cpill-green">Calibrated \u2713</span>' :
                            '<span class="cpill cpill-muted">Normal</span>';
    var ovClr = d.ovRatioRaw > 1.5 ? 'hsl(15,78%,50%)' : d.ovRatioRaw > 1 ? 'hsl(38,78%,50%)' : 'var(--muted-foreground)';
    var scClr = d.isCalib ? 'hsl(142,55%,40%)' : d.isElev ? 'hsl(38,78%,40%)' : 'var(--foreground)';
    html += '<tr><td style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:1.1rem">' + d.d + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-weight:600;color:' + scClr + '">' + fmt1(d.prob) + '</td>' +
      '<td>' + zone + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.78rem;color:' + ovClr + '">\xd7' + d.ovRatioRaw.toFixed(2) + '</td>' +
      '<td style="font-size:.75rem;color:var(--muted-foreground)">' + d.since + ' / avg ' + d.avgGap.toFixed(0) + '</td>' +
      '<td>' + hotTag(d.hotScore) + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.8rem;font-weight:' + (d.inTop30 >= 5 ? 700 : 400) + ';color:' + (d.inTop30 >= 5 ? 'hsl(142,55%,40%)' : 'var(--foreground)') + '">' + d.inTop30 + '</td></tr>';
  }
  html += '</tbody></table></div>';
  $el('digitSection').innerHTML = html;
}

function renderBestNumbers(data) {
  var top = data.ranked.slice(0, topN);
  var html = '<div style="overflow-x:auto"><table class="sc-tbl"><thead><tr>' +
    '<th>#</th><th>Number / mirror</th><th>Model P</th><th>Num overdue</th><th>Hot/cold</th><th>Freq</th><th>Composite</th><th>Signals</th><th>Tier</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < top.length; i++) {
    var e = top[i];
    var isSelf = mirrorNum(e.num) === e.num;
    var mirEl  = isSelf ? '' : '<span style="font-family:\'JetBrains Mono\',monospace;font-size:.75rem;color:var(--muted-foreground);margin-left:.35rem">/ ' + mirrorNum(e.num) + '</span>';
    var odStr  = e.freq < 3 ? '<span style="color:var(--muted-foreground);font-size:.7rem">&lt;3 appearances</span>' :
                 e.overdueFrac > 0.1 ? '<span style="color:hsl(15,78%,50%);font-weight:600">+' + (e.overdueFrac * 100).toFixed(0) + '%</span><span style="display:block;font-size:.63rem;color:var(--muted-foreground)">' + e.since + ' / avg ' + e.avgGap.toFixed(0) + '</span>' :
                 '<span style="font-size:.75rem;color:var(--muted-foreground)">' + e.since + ' / avg ' + e.avgGap.toFixed(0) + '</span>';
    html += '<tr title="Digit ' + e.a + ': ' + fmt2(e.aProb) + ' \xb7 Digit ' + e.b + ': ' + fmt2(e.bProb) + '">' +
      '<td style="color:var(--muted-foreground);font-size:.7rem">' + (i + 1) + '</td>' +
      '<td><span style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:.9375rem;color:var(--primary)">' + e.num + '</span>' + mirEl + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.8rem">' + fmt2(e.pM) + '</td>' +
      '<td>' + odStr + '</td><td>' + hotTag(e.hotScore) + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.78rem;color:var(--muted-foreground)">' + e.freq + '\xd7</td>' +
      '<td>' + compBar(e.composite, e.aElev || e.bElev) + '</td>' +
      '<td style="white-space:nowrap">' + signalTags(e) + '</td>' +
      '<td>' + tierBadge(e.tier) + '</td></tr>';
  }
  html += '</tbody></table></div>';
  $el('bestNumbers').innerHTML = html;
}

function renderBestPairs(data) {
  var top = data.pairArr.slice(0, topN);
  var html = '<div style="overflow-x:auto"><table class="sc-tbl"><thead><tr>' +
    '<th>#</th><th>Pair</th><th>Both tickets</th><th>Combined P</th><th>Avg overdue</th><th>Composite</th><th>Tier</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < top.length; i++) {
    var pr = top[i], isSame = pr.da === pr.db;
    var ab = pr.entAB, ba = pr.entBA;
    var avgOD = ba ? (Math.max(0, ab.overdueFrac) + Math.max(0, ba.overdueFrac)) / 2 : Math.max(0, ab.overdueFrac);
    var odStr = avgOD > 0.1 ? '<span style="color:hsl(15,78%,50%);font-weight:600">+' + (avgOD * 100).toFixed(0) + '%</span>' : '<span style="color:var(--muted-foreground)">\u2014</span>';
    var pairTier = (ab.tier === 'A' && (!ba || ba.tier === 'A')) ? 'A' : (ab.tier !== 'C' || (ba && ba.tier !== 'C')) ? 'B' : 'C';
    var anyElev  = ab.aElev || ab.bElev || (ba && (ba.aElev || ba.bElev));
    html += '<tr><td style="color:var(--muted-foreground);font-size:.7rem">' + (i + 1) + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:.9375rem;color:hsl(142,55%,44%)">{' + pr.da + ',' + pr.db + '}</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.8rem;color:var(--muted-foreground)">' + pr.da + pr.db + (isSame ? '' : ' + ' + pr.db + pr.da) + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.8rem">' + fmt2(pr.pPair) + '</td>' +
      '<td>' + odStr + '</td><td>' + compBar(pr.comb, anyElev) + '</td><td>' + tierBadge(pairTier) + '</td></tr>';
  }
  html += '</tbody></table></div>';
  $el('bestPairs').innerHTML = html;
}

function renderAvoidList(data) {
  var withFreq = data.ranked.filter(function(e) { return e.freq >= 2; });
  var bottom   = withFreq.slice(withFreq.length - topN).reverse();
  var html = '<div style="overflow-x:auto"><table class="sc-tbl"><thead><tr>' +
    '<th>#</th><th>Number / mirror</th><th>Model P</th><th>Last seen</th><th>Hot/cold</th><th>Freq</th><th>Composite</th><th>Why skip</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < bottom.length; i++) {
    var e = bottom[i];
    var isSelf = mirrorNum(e.num) === e.num;
    var mirEl  = isSelf ? '' : '<span style="font-family:\'JetBrains Mono\',monospace;font-size:.75rem;color:var(--muted-foreground);margin-left:.35rem">/ ' + mirrorNum(e.num) + '</span>';
    var reasons = '';
    if (e.freq >= 2 && e.since < e.avgGap * 0.5) reasons += '<span class="avoid-tag avoid-recent">Just drawn</span>';
    if (e.hotScore > 1.8 && e.freq >= 3)          reasons += '<span class="avoid-tag avoid-hot">Running hot</span>';
    if (e.overdueFrac < -0.5)                      reasons += '<span class="avoid-tag avoid-fresh">Not overdue</span>';
    if (!reasons)                                  reasons  = '<span class="avoid-tag avoid-low">All signals low</span>';
    html += '<tr><td style="color:var(--muted-foreground);font-size:.7rem">' + (i + 1) + '</td>' +
      '<td><span style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:.9375rem;color:hsl(5,68%,48%)">' + e.num + '</span>' + mirEl + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.78rem;color:var(--muted-foreground)">' + fmt2(e.pM) + '</td>' +
      '<td style="font-size:.72rem;color:var(--muted-foreground)">' + e.since + ' draws ago<br><span style="font-size:.63rem">' + e.lastDate + '</span></td>' +
      '<td>' + hotTag(e.hotScore) + '</td>' +
      '<td style="font-family:\'JetBrains Mono\',monospace;font-size:.78rem;color:var(--muted-foreground)">' + e.freq + '\xd7</td>' +
      '<td>' + compBar(e.composite, false) + '</td>' +
      '<td style="font-size:.72rem">' + reasons + '</td></tr>';
  }
  html += '</tbody></table></div>';
  $el('avoidList').innerHTML = html;
}

function renderMatrix(data) {
  var isDark = document.documentElement.classList.contains('dark');
  var maxC = 0, minC = 100;
  for (var ki in data.numMap) {
    if (data.numMap[ki].composite > maxC) maxC = data.numMap[ki].composite;
    if (data.numMap[ki].composite < minC) minC = data.numMap[ki].composite;
  }
  var range = Math.max(1, maxC - minC);
  function cellBg(comp, isElev) {
    var norm = (comp - minC) / range;
    if (isElev) return isDark ? 'hsl(38,' + Math.round(20+norm*40) + '%,' + Math.round(12+norm*25) + '%)' : 'hsl(38,' + Math.round(55+norm*25) + '%,' + Math.round(97-norm*20) + '%)';
    return isDark ? 'hsl(142,' + Math.round(5+norm*55) + '%,' + Math.round(10+norm*40) + '%)' : 'hsl(142,' + Math.round(6+norm*65) + '%,' + Math.round(97-norm*44) + '%)';
  }
  function cellFg(comp) { return (comp - minC) / range > 0.62 ? (isDark ? '#e2e8f0' : '#1e293b') : 'var(--muted-foreground)'; }

  var html = '<div style="overflow-x:auto"><table class="sc-matrix"><thead><tr><th style="background:transparent;border:none;color:var(--muted-foreground);font-size:.58rem;padding:.2rem .5rem .2rem 0">\u2193 tens</th>';
  for (var c = 0; c <= 9; c++) html += '<th style="background:transparent;border:none;color:var(--muted-foreground);font-size:.63rem;font-family:\'JetBrains Mono\',monospace;text-align:center;padding:.15rem .2rem">\xb7' + c + '</th>';
  html += '</tr></thead><tbody>';
  for (var r = 0; r <= 9; r++) {
    html += '<tr><td style="font-family:\'JetBrains Mono\',monospace;font-size:.63rem;color:var(--muted-foreground);font-weight:600;padding:.15rem .4rem .15rem 0;border:none;white-space:nowrap">' + r + '\xb7</td>';
    for (var c2 = 0; c2 <= 9; c2++) {
      var ns2 = '' + r + c2, e = data.numMap[ns2];
      if (!e) { html += '<td></td>'; continue; }
      html += '<td style="background:' + cellBg(e.composite, e.aElev || e.bElev) + ';color:' + cellFg(e.composite) + ';font-family:\'JetBrains Mono\',monospace;font-size:.56rem;font-weight:600;text-align:center;vertical-align:middle;padding:.18rem .08rem;border-radius:4px;border:none;cursor:default;min-width:2.8rem;height:2.05rem;line-height:1.3;" title="' + ns2 + ' / ' + mirrorNum(ns2) + ' \xb7 Rank ' + e.rank + ' \xb7 Score ' + e.composite + ' \xb7 Tier ' + e.tier + '">' + ns2 + '<br><span style="opacity:.7">' + e.composite + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div><div style="display:flex;align-items:center;gap:1rem;margin-top:.75rem;font-size:.7rem;color:var(--muted-foreground);flex-wrap:wrap;">' +
    '<span style="display:inline-flex;align-items:center;gap:.3rem"><span style="width:12px;height:12px;border-radius:3px;background:' + (isDark ? 'hsl(142,60%,50%)' : 'hsl(142,71%,55%)') + ';display:inline-block"></span>High composite (green)</span>' +
    '<span style="display:inline-flex;align-items:center;gap:.3rem"><span style="width:12px;height:12px;border-radius:3px;background:' + (isDark ? 'hsl(38,60%,37%)' : 'hsl(38,80%,80%)') + ';display:inline-block"></span>Elevated digit &gt;22% (amber)</span>' +
    '<span>Row = tens digit \xb7 Column = units digit \xb7 Number top, score bottom</span></div>';
  $el('signalMatrix').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER ALL
// ═══════════════════════════════════════════════════════════════════════════
function renderAll() {
  var data = computeComposite();
  if (!data) {
    var ids = ['statCards','digitSection','bestNumbers','bestPairs','avoidList','signalMatrix','scoutBT'];
    for (var i = 0; i < ids.length; i++) {
      var el = $el(ids[i]);
      if (el) el.innerHTML = '<p style="color:var(--muted-foreground);font-size:.8rem;padding:.75rem 0">Need at least ' + MIN_HIST + ' draws.</p>';
    }
    return;
  }
  renderStatCards(data);
  renderDigitSection(data);
  renderBestNumbers(data);
  renderBestPairs(data);
  renderAvoidList(data);
  renderMatrix(data);
  renderScoutBacktest();
}

init().catch(function(err) { setStatus('', 'Error: ' + err.message); console.error(err); });
