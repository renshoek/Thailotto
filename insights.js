// Thai Lotto Analyzer — Deep Insights
// Reads the same IndexedDB cache as script.js (key: perFileAggMap_v2)
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const PRIZE_LABELS = {
  FIRST:'First Prize', SECOND:'Second Prize', THIRD:'Third Prize',
  FOURTH:'Fourth Prize', FIFTH:'Fifth Prize', TWO:'Two Digit',
  THREE_FIRST:'Three Front', THREE_LAST:'Three Back', NEAR_FIRST:'Near First',
};
// Exact digit length each prize number must have — used to filter malformed data
const PRIZE_DIGITS = {
  FIRST:6, SECOND:6, THIRD:6, FOURTH:6, FIFTH:6,
  TWO:2, THREE_FIRST:3, THREE_LAST:3, NEAR_FIRST:6,
};

const DB_NAME   = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY  = 'perFileAggMap_v2';

const PALETTE = [
  'hsl(215,80%,60%)', 'hsl(35,85%,58%)',
  'hsl(145,55%,48%)', 'hsl(290,55%,62%)',
  'hsl(5,72%,58%)',   'hsl(170,60%,45%)',
  'hsl(55,80%,50%)',  'hsl(330,65%,58%)',
  'hsl(195,70%,52%)', 'hsl(260,60%,65%)',
];

// ── DOM ────────────────────────────────────────────────────────────────────
const prizeSelect    = document.getElementById('prizeSelect');
const topNSelect     = document.getElementById('topNSelect');
const statusText     = document.getElementById('statusText');
const statusDot      = document.getElementById('statusDot');
const themeToggle    = document.getElementById('themeToggle');
const mainContent    = document.getElementById('mainContent');
const winModeRadios  = document.querySelectorAll('input[name="winMode"]');
const lastnWrap      = document.getElementById('lastnWrap');
const lastNInput     = document.getElementById('lastNInput');
const cutoffWrap     = document.getElementById('cutoffWrap');
const cutoffDate     = document.getElementById('cutoffDate');
const applyCutoffBtn     = document.getElementById('applyCutoffBtn');
const lastnCutoffWrap    = document.getElementById('lastnCutoffWrap');
const lastNInput2        = document.getElementById('lastNInput2');
const cutoffDate2        = document.getElementById('cutoffDate2');
const applyCutoffBtn2    = document.getElementById('applyCutoffBtn2');
const rollingSlider       = document.getElementById('rollingSlider');
const rollingValLabel     = document.getElementById('rollingValLabel');
const rollingSeriesSelect = document.getElementById('rollingSeriesSelect');

// ── State ──────────────────────────────────────────────────────────────────
let freqChart     = null;
let rollingChart  = null;
let allDraws      = [];      // [{dateStr, results}] sorted oldest → newest
let currentPrize  = 'TWO';
let currentTopN   = 20;
let rollingWindow = 20;
let rollingSeries = 5;

// Window state
let winMode = 'lastn';   // 'lastn' | 'all' | 'cutoff'
let lastN   = 200;
let cutoff  = null;      // ISO date string or null

// ── Theme ──────────────────────────────────────────────────────────────────
themeToggle.addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  if (allDraws.length) renderAll();
});
{
  const s = localStorage.getItem('theme');
  if (s === 'dark' || (!s && window.matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.classList.add('dark');
}

// ── Helpers ────────────────────────────────────────────────────────────────
const isDark    = () => document.documentElement.classList.contains('dark');
const cssVar    = n  => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const parseNums = s  => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
const $         = id => document.getElementById(id);

// ── IndexedDB ──────────────────────────────────────────────────────────────
async function loadCache() {
  return new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ev => {
      if (!ev.target.result.objectStoreNames.contains(STORE_NAME))
        ev.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = ev => {
      const get = ev.target.result
        .transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(CACHE_KEY);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror   = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  setStatus('loading', 'Loading data from cache…');
  const cached = await loadCache();

  if (!cached || !cached.data || Object.keys(cached.data).length === 0) {
    setStatus('empty', 'No data. Open the Analyzer page first to download and cache lottery data.');
    mainContent.innerHTML = `
      <div style="text-align:center;padding:4rem 2rem;color:var(--muted-foreground)">
        <h2 style="color:var(--foreground);font-size:1.25rem;margin-bottom:0.75rem">No data loaded</h2>
        <p>Please open <a href="index.html" style="color:var(--primary)">the Analyzer</a> first, let it fully load, then return here.</p>
      </div>`;
    return;
  }

  const map = new Map(Object.entries(cached.data));
  allDraws = Array.from(map.entries())
    .map(([dateStr, agg]) => ({ dateStr, results: agg.results || {} }))
    .filter(d => Object.keys(d.results).length > 0)
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr));

  const age = cached.fetchedAt
    ? Math.round((Date.now() - cached.fetchedAt) / 60000)
    : null;
  setStatus('live',
    `${allDraws.length} draws loaded` +
    (age !== null ? ` · cached ${age < 60 ? age + ' min' : Math.round(age / 60) + 'h'} ago` : '') +
    ` · dataset: ${allDraws[0]?.dateStr} → ${allDraws[allDraws.length - 1]?.dateStr}`
  );

  wireControls();
  renderAll();
}

function setStatus(state, text) {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (state === 'live' ? ' live' : '');
}

// ── Window selection ───────────────────────────────────────────────────────
function wireControls() {
  prizeSelect.addEventListener('change',  () => { currentPrize = prizeSelect.value; renderAll(); });
  topNSelect.addEventListener('change',   () => { currentTopN  = parseInt(topNSelect.value, 10); renderAll(); });

  winModeRadios.forEach(r => r.addEventListener('change', () => {
    winMode = r.value;
    lastnWrap.style.display      = winMode === 'lastn'        ? 'flex' : 'none';
    cutoffWrap.style.display     = winMode === 'cutoff'       ? 'flex' : 'none';
    lastnCutoffWrap.style.display = winMode === 'lastn_cutoff' ? 'flex' : 'none';
    renderAll();
  }));

  lastNInput.addEventListener('change', () => {
    lastN = Math.max(10, parseInt(lastNInput.value, 10) || 200);
    lastNInput.value = lastN;
    if (winMode === 'lastn') renderAll();
  });

  applyCutoffBtn.addEventListener('click', () => {
    cutoff = cutoffDate.value || null;
    if (winMode === 'cutoff') renderAll();
  });

  applyCutoffBtn2.addEventListener('click', () => {
    lastN  = Math.max(10, parseInt(lastNInput2.value, 10) || 200);
    cutoff = cutoffDate2.value || null;
    lastNInput2.value = lastN;
    if (winMode === 'lastn_cutoff') renderAll();
  });

  lastNInput2.addEventListener('change', () => {
    lastN = Math.max(10, parseInt(lastNInput2.value, 10) || 200);
    lastNInput2.value = lastN;
  });

  rollingSlider.addEventListener('input', () => {
    rollingWindow = parseInt(rollingSlider.value, 10);
    rollingValLabel.textContent = rollingWindow;
    renderRolling(lastComputedInsights);
  });

  rollingSeriesSelect.addEventListener('change', () => {
    rollingSeries = parseInt(rollingSeriesSelect.value, 10);
    renderRolling(lastComputedInsights);
  });
}

function getWindowedDraws() {
  let draws = allDraws.slice();

  // Apply cutoff date filter (modes: cutoff and lastn_cutoff)
  if ((winMode === 'cutoff' || winMode === 'lastn_cutoff') && cutoff) {
    draws = draws.filter(d => d.dateStr <= cutoff);
  }

  // Trim to last N draws (modes: lastn and lastn_cutoff)
  if (winMode === 'lastn' || winMode === 'lastn_cutoff') {
    const n = Math.max(10, lastN);
    if (n < draws.length) draws = draws.slice(-n);
  }

  return draws;
}

// ── Core computation ───────────────────────────────────────────────────────
// Store last computed so rolling slider can reuse without re-computing
let lastComputedInsights = null;

function computeInsights(draws, prize) {
  const numLen     = PRIZE_DIGITS[prize] || 6;
  const totalDraws = draws.length;

  // Flatten appearances, filtering to correct digit length only
  const all = [];
  draws.forEach((draw, idx) => {
    parseNums(draw.results[prize] || '')
      .filter(num => num.length === numLen)          // ← fix: reject wrong-length numbers
      .forEach(num => all.push({ num, drawIdx: idx, dateStr: draw.dateStr }));
  });

  // Recent window = last 25% of draws
  const recentCutoff    = Math.max(0, totalDraws - Math.ceil(totalDraws * 0.25));
  const recentDrawCount = totalDraws - recentCutoff;

  // ── Frequency maps ──
  const freq        = {};   // num → count in full window
  const recentFreq  = {};   // num → count in recent 25%
  const appearances = {};   // num → sorted list of drawIdx

  all.forEach(({ num, drawIdx }) => {
    freq[num] = (freq[num] || 0) + 1;
    if (drawIdx >= recentCutoff) recentFreq[num] = (recentFreq[num] || 0) + 1;
    if (!appearances[num]) appearances[num] = [];
    appearances[num].push(drawIdx);
  });

  // For TWO include all 00–99 even undrawn
  if (prize === 'TWO') {
    for (let i = 0; i <= 99; i++) {
      const k = String(i).padStart(2, '0');
      if (freq[k] === undefined) freq[k] = 0;
    }
  }

  // ── Gap statistics ──
  const gapStats = {};
  Object.entries(appearances).forEach(([num, idxList]) => {
    if (idxList.length < 2) return;
    const gaps = [];
    for (let i = 1; i < idxList.length; i++) gaps.push(idxList[i] - idxList[i - 1]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    gapStats[num] = { avg, min: Math.min(...gaps), max: Math.max(...gaps), gaps };
  });

  // ── Overdue scoring ──
  // score = (draws since last seen − avg gap) / avg gap
  // Positive = overdue relative to own average
  const overdueList = [];
  Object.entries(appearances).forEach(([num, idxList]) => {
    if (!gapStats[num]) return;
    const sinceLastSeen = totalDraws - 1 - idxList[idxList.length - 1];
    const { avg, min, max } = gapStats[num];
    const score = (sinceLastSeen - avg) / Math.max(1, avg);
    overdueList.push({
      num, sinceLastSeen, avgGap: avg, minGap: min, maxGap: max,
      score, lastDate: draws[idxList[idxList.length - 1]]?.dateStr || '?',
      count: freq[num],
    });
  });
  overdueList.sort((a, b) => b.score - a.score);

  // ── Hot/Cold scoring ──
  // hot score = actual recent appearances / expected recent appearances
  // Expected = (overall rate) × (recent draw count)
  // Overall rate = total appearances / total draws
  // A score of 2.0 means appeared twice as often as expected. 0.0 means not seen at all recently.
  const hotCold = Object.keys(freq)
    .filter(num => (freq[num] || 0) > 0)
    .map(num => {
      const overallRate    = freq[num] / totalDraws;
      const expectedRecent = overallRate * recentDrawCount;
      const actualRecent   = recentFreq[num] || 0;
      // Only compute score when expected > 0.5 (otherwise tiny numbers inflate it wildly)
      const hotScore = expectedRecent > 0.5 ? actualRecent / expectedRecent : (actualRecent > 0 ? 99 : 0);
      const lastIdx  = appearances[num] ? appearances[num][appearances[num].length - 1] : -1;
      return {
        num, hotScore, freq: freq[num], recentFreq: actualRecent,
        expectedRecent, overallRate,
        lastDate: lastIdx >= 0 ? draws[lastIdx]?.dateStr : 'never',
        sinceLastSeen: lastIdx >= 0 ? totalDraws - 1 - lastIdx : totalDraws,
      };
    });

  const hot  = [...hotCold].sort((a, b) => b.hotScore - a.hotScore).slice(0, 10);
  const cold = [...hotCold].sort((a, b) => a.hotScore - b.hotScore).slice(0, 10);

  // ── Digit position frequency (heatmap) ──
  const digitPos = Array.from({ length: numLen }, () => ({}));
  all.forEach(({ num }) => {
    const padded = num.padStart(numLen, '0');
    for (let p = 0; p < numLen; p++) {
      const d = padded[p];
      digitPos[p][d] = (digitPos[p][d] || 0) + 1;
    }
  });

  // Top 10 for rolling trend (actual slice controlled at render time)
  const topNums = Object.entries(freq)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([n]) => n);

  // ── Statistical candidates ──
  const candidates = overdueList
    .filter(x => x.score > 0 && x.count >= 3)
    .slice(0, 5);

  return {
    totalDraws, totalAppearances: all.length,
    uniqueNums: Object.keys(freq).filter(k => (freq[k] || 0) > 0).length,
    recentCutoff, recentDrawCount,
    freq, recentFreq, appearances,
    gapStats, overdueList,
    hot, cold,
    digitPos, numLen,
    topNums, candidates,
  };
}

// Build rolling data separately so the slider can re-trigger it without recomputing everything
function computeRollingData(ins, draws, windowSize, seriesCount) {
  const numsToShow = (ins.topNums || []).slice(0, seriesCount || 5);
  const { appearances } = ins;
  const totalDraws = draws.length;
  const W = Math.max(2, Math.min(windowSize, totalDraws - 1));

  return numsToShow.map(num => {
    const apSet = new Set(appearances[num] || []);
    const points = [];
    for (let i = W; i <= totalDraws; i++) {
      let c = 0;
      for (let j = i - W; j < i; j++) if (apSet.has(j)) c++;
      points.push({ x: draws[i - 1]?.dateStr?.slice(0, 7) || '', y: c });
    }
    return { num, points };
  });
}

// ── Render dispatcher ──────────────────────────────────────────────────────
function renderAll() {
  const draws = getWindowedDraws();
  if (!draws.length) return;
  const ins = computeInsights(draws, currentPrize);
  lastComputedInsights = ins;
  lastComputedInsights._draws = draws;  // store for rolling re-renders

  renderStatCards(ins, draws);
  renderFreqChart(ins);
  renderHeatmap(ins);
  renderHotCold(ins);
  renderOverdue(ins);
  renderGapTable(ins);
  renderRolling(ins);
  renderCandidates(ins);
}

// ── 1. Stat cards ──────────────────────────────────────────────────────────
function renderStatCards(ins, draws) {
  const { totalDraws, totalAppearances, uniqueNums, recentDrawCount, numLen } = ins;
  const from       = draws[0]?.dateStr || '';
  const to         = draws[draws.length - 1]?.dateStr || '';
  const avgPerDraw = totalDraws > 0 ? (totalAppearances / totalDraws).toFixed(1) : '—';
  const spaceDesc  = numLen === 2 ? '100 possible (00–99)' : numLen === 3 ? '1,000 possible (000–999)' : '1,000,000 possible';

  $('statCards').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Draws in window</div>
      <div class="stat-card-value">${totalDraws.toLocaleString()}</div>
      <div class="stat-card-sub">${from} → ${to}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Total appearances</div>
      <div class="stat-card-value">${totalAppearances.toLocaleString()}</div>
      <div class="stat-card-sub">avg ${avgPerDraw} valid numbers per draw</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Unique numbers seen</div>
      <div class="stat-card-value">${uniqueNums.toLocaleString()}</div>
      <div class="stat-card-sub">${spaceDesc}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Hot/Cold window</div>
      <div class="stat-card-value">${recentDrawCount}</div>
      <div class="stat-card-sub">most recent 25% of draws used for hot/cold comparison</div>
    </div>
  `;
}

// ── 2. Frequency bar chart ─────────────────────────────────────────────────
function renderFreqChart(ins) {
  if (freqChart) { freqChart.destroy(); freqChart = null; }

  const { freq, totalDraws } = ins;
  const entries = Object.entries(freq)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, currentTopN);

  const muted   = cssVar('--muted-foreground');
  const border  = cssVar('--border');
  const fg      = cssVar('--foreground');
  const primary = cssVar('--primary');
  const barMuted = isDark() ? 'hsl(215,28%,32%)' : 'hsl(215,38%,76%)';

  freqChart = new Chart($('freqCanvas'), {
    type: 'bar',
    data: {
      labels: entries.map(([n]) => n),
      datasets: [{
        label: 'Times drawn',
        data: entries.map(([, c]) => c),
        backgroundColor: entries.map((_, i) => i === 0 ? primary : barMuted),
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `Number: ${items[0].label}`,
            label: ctx => {
              const pct = totalDraws > 0 ? ((ctx.raw / totalDraws) * 100).toFixed(2) : '0';
              return ` Appeared ${ctx.raw} times  (${pct}% of draws in window)`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: border },
          ticks: { color: muted, font: { size: 11 } },
          title: { display: true, text: 'Times drawn', color: muted, font: { size: 11 } },
        },
        y: {
          grid: { display: false },
          ticks: {
            color: fg,
            font: { family: "'JetBrains Mono', monospace", size: 11, weight: '500' },
          },
        },
      },
    },
  });
}

// ── 3. Digit position heatmap ──────────────────────────────────────────────
function heatColor(norm) {
  return isDark()
    ? `hsl(215,${Math.round(8 + norm * 72)}%,${Math.round(15 + norm * 45)}%)`
    : `hsl(215,${Math.round(6 + norm * 79)}%,${Math.round(96 - norm * 46)}%)`;
}

function renderHeatmap(ins) {
  const { digitPos, numLen } = ins;
  const grid = $('heatmapGrid');
  grid.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.overflowX = 'auto';

  const tbl = document.createElement('table');
  tbl.style.cssText = 'border-collapse:separate;border-spacing:4px;margin:0;box-shadow:none;background:transparent;width:auto;';

  // Column header row
  const thead = document.createElement('thead');
  const hdr   = document.createElement('tr');
  const corner = document.createElement('th');
  corner.style.cssText = 'background:transparent;border:none;padding:2px 8px 2px 0;font-size:0.7rem;color:var(--muted-foreground);text-align:center;';
  corner.textContent = 'Digit';
  hdr.appendChild(corner);
  for (let p = 0; p < numLen; p++) {
    const th = document.createElement('th');
    th.textContent = `Pos ${p + 1}`;
    th.style.cssText = 'background:transparent;border:none;padding:2px 0 4px;font-size:0.7rem;font-weight:600;text-align:center;min-width:56px;color:var(--muted-foreground);';
    hdr.appendChild(th);
  }
  thead.appendChild(hdr);
  tbl.appendChild(thead);

  // Body: digits 0–9 as rows
  const tbody = document.createElement('tbody');
  for (let d = 0; d <= 9; d++) {
    const tr = document.createElement('tr');

    const labelTd = document.createElement('td');
    labelTd.textContent = d;
    labelTd.style.cssText = 'font-weight:700;font-size:0.875rem;text-align:center;background:transparent;border:none;padding:2px 10px 2px 0;color:var(--foreground);font-family:"JetBrains Mono",monospace;';
    tr.appendChild(labelTd);

    for (let p = 0; p < numLen; p++) {
      const posData  = digitPos[p] || {};
      const count    = posData[String(d)] || 0;
      const posTotal = Object.values(posData).reduce((a, b) => a + b, 0);
      const posMax   = Math.max(...Object.values(posData).concat([1]));
      const norm     = count / posMax;
      const pct      = posTotal > 0 ? ((count / posTotal) * 100).toFixed(1) : '0.0';

      const td = document.createElement('td');
      td.style.cssText = `
        width:56px; height:34px;
        text-align:center; vertical-align:middle;
        border-radius:5px; border:none; padding:0;
        background:${heatColor(norm)};
        color:${norm > 0.55 ? (isDark() ? '#e2e8f0' : '#1e293b') : 'var(--muted-foreground)'};
        font-family:'JetBrains Mono',monospace;
        font-size:0.7rem; font-weight:600;
        cursor:default;
      `;
      // Show percentage in cell (fits comfortably), raw count in tooltip
      td.textContent = count > 0 ? pct + '%' : '';
      td.title = `Digit ${d} at position ${p + 1}: appeared ${count} time${count !== 1 ? 's' : ''} (${pct}% of all appearances at this position)`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);

  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;align-items:center;gap:0.625rem;margin-top:0.875rem;font-size:0.7rem;color:var(--muted-foreground);';
  const gradBar = document.createElement('div');
  gradBar.style.cssText = `width:80px;height:8px;border-radius:4px;background:linear-gradient(to right,${heatColor(0)},${heatColor(1)});flex-shrink:0;`;
  legend.appendChild(gradBar);
  legend.appendChild(document.createTextNode('Less frequent → More frequent  (each column normalised independently)'));

  wrap.appendChild(tbl);
  wrap.appendChild(legend);
  grid.appendChild(wrap);
}

// ── 4. Hot & Cold ─────────────────────────────────────────────────────────
function renderHotCold(ins) {
  const { hot, cold, recentDrawCount, totalDraws } = ins;

  const hotWin  = Math.ceil(totalDraws * 0.25);
  $('hotSubtitle').textContent =
    `Compared against the most recent ${recentDrawCount} draws (last 25% of window). ` +
    `A number's "expected" recent count is: (its overall rate in the full window) × ${recentDrawCount}. ` +
    `Hot score = actual ÷ expected. ×2.0 = appeared twice as often as its own baseline.`;
  $('coldSubtitle').textContent =
    `Same scoring reversed — ×0.0 = completely absent in the recent ${recentDrawCount} draws despite normally appearing regularly.`;

  const maxHotScore = Math.max(...hot.map(x => x.hotScore), 1);

  function buildList(items, containerId, isHot) {
    const container = $(containerId);
    container.innerHTML = '';
    if (!items.length) { container.textContent = 'Not enough data.'; return; }

    items.forEach(item => {
      const { num, hotScore, freq: totalFreq, recentFreq, expectedRecent, overallRate, lastDate, sinceLastSeen } = item;
      const row = document.createElement('div');
      row.className = 'temp-row';

      // Full tooltip on the whole row
      const expRounded = expectedRecent.toFixed(1);
      const ratePercent = (overallRate * 100).toFixed(2);
      row.title =
        `${num}\n` +
        `Overall rate: ${ratePercent}% of draws (appeared ${totalFreq}× total)\n` +
        `Expected in last ${recentDrawCount} draws: ${expRounded}\n` +
        `Actually seen: ${recentFreq}×\n` +
        `Hot score: ×${hotScore.toFixed(2)}\n` +
        `Last seen: ${lastDate} (${sinceLastSeen} draws ago)`;

      const numEl = document.createElement('span');
      numEl.className = 'temp-num';
      numEl.textContent = num;
      numEl.style.color = isHot ? 'hsl(15,80%,58%)' : 'hsl(200,70%,55%)';
      row.appendChild(numEl);

      const barWrap = document.createElement('div');
      barWrap.className = 'temp-bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'temp-bar ' + (isHot ? 'temp-bar-hot' : 'temp-bar-cold');
      const barPct = isHot
        ? Math.min(100, (hotScore / maxHotScore) * 100)
        : Math.min(100, (1 - Math.min(1, hotScore)) * 100);
      bar.style.width = barPct + '%';
      barWrap.appendChild(bar);
      row.appendChild(barWrap);

      const meta = document.createElement('span');
      meta.className = 'temp-meta';
      meta.textContent = isHot
        ? `×${hotScore.toFixed(2)}  (${recentFreq} vs exp ${expRounded})`
        : `×${hotScore.toFixed(2)}  (${recentFreq} vs exp ${expRounded})`;
      row.appendChild(meta);

      container.appendChild(row);
    });
  }

  buildList(hot,  'hotList',  true);
  buildList(cold, 'coldList', false);
}

// ── 5. Overdue tracker ─────────────────────────────────────────────────────
function renderOverdue(ins) {
  const { overdueList } = ins;
  const container = $('overdueList');
  container.innerHTML = '';

  const top = overdueList.slice(0, 18);
  if (!top.length) {
    container.textContent = 'Insufficient data — numbers need 2+ appearances to compute an average gap.';
    return;
  }

  const maxVal = Math.max(...top.map(x => Math.max(x.sinceLastSeen, x.avgGap * 1.8)), 1);

  top.forEach(item => {
    const { num, sinceLastSeen, avgGap, minGap, maxGap, score, lastDate, count } = item;
    const isOverdue = score > 0;

    const row = document.createElement('div');
    row.className = 'overdue-row';
    row.title =
      `${num}\n` +
      `Drawn ${count}× in window  ·  Last seen: ${lastDate}\n` +
      `Draws since last appearance: ${sinceLastSeen}\n` +
      `Average gap: ${avgGap.toFixed(1)} draws  ·  Min: ${minGap}  ·  Max: ${maxGap}\n` +
      (isOverdue
        ? `Overdue by ${(score * 100).toFixed(0)}% above average gap`
        : `Within normal range (${(score * 100).toFixed(0)}% of average gap)`);

    // Left: number + last date
    const numWrap = document.createElement('div');
    numWrap.innerHTML = `
      <span class="overdue-num" style="color:${isOverdue ? 'hsl(15,80%,58%)' : 'var(--foreground)'}">${num}</span>
      <div style="font-size:0.6rem;color:var(--muted-foreground);margin-top:1px;font-variant-numeric:tabular-nums;">${lastDate}</div>
    `;
    row.appendChild(numWrap);

    // Progress bar
    const track = document.createElement('div');
    track.className = 'overdue-track';

    const fillPct = Math.min(100, (sinceLastSeen / maxVal) * 100);
    const markPct = Math.min(97,  (avgGap / maxVal) * 100);

    const fill = document.createElement('div');
    fill.className = 'overdue-fill';
    fill.style.width      = fillPct + '%';
    fill.style.background = isOverdue
      ? 'hsl(15,80%,58%)'
      : `hsl(215,75%,${isDark() ? '52' : '62'}%)`;
    fill.style.opacity = '0.8';
    track.appendChild(fill);

    const marker = document.createElement('div');
    marker.className = 'overdue-marker';
    marker.style.left = markPct + '%';
    marker.title      = `Avg gap: ${avgGap.toFixed(1)} draws`;
    track.appendChild(marker);

    row.appendChild(track);

    // Right label
    const label = document.createElement('span');
    label.className = 'overdue-label';
    label.style.color = isOverdue ? 'hsl(15,80%,58%)' : 'var(--muted-foreground)';
    label.textContent = isOverdue
      ? `${sinceLastSeen} draws  (+${(score * 100).toFixed(0)}% overdue)`
      : `${sinceLastSeen} / avg ${avgGap.toFixed(0)}`;
    row.appendChild(label);

    container.appendChild(row);
  });
}

// ── 6. Gap analysis table ──────────────────────────────────────────────────
function renderGapTable(ins) {
  const { freq, gapStats, appearances, totalDraws } = ins;

  const top = Object.entries(freq)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([num, count]) => {
      const gs      = gapStats[num];
      const idxList = appearances[num] || [];
      const lastIdx = idxList.length ? idxList[idxList.length - 1] : -1;
      return {
        num, count,
        pct:   totalDraws > 0 ? ((count / totalDraws) * 100).toFixed(2) : '0.00',
        avg:   gs ? gs.avg.toFixed(1) : '—',
        avgRaw: gs ? gs.avg : null,
        min:   gs ? gs.min : '—',
        max:   gs ? gs.max : '—',
        since: lastIdx >= 0 ? totalDraws - 1 - lastIdx : null,
      };
    });

  const wrap = $('gapTableWrap');
  wrap.innerHTML = '';

  const tbl = document.createElement('table');

  // Tooltips on column headers via title attribute
  tbl.innerHTML = `
    <thead>
      <tr>
        <th title="The winning number">Number</th>
        <th style="text-align:center" title="How many times this number appeared in the selected window">Times drawn</th>
        <th style="text-align:center" title="Appearances ÷ total draws in window">% of draws</th>
        <th style="text-align:center" title="Mean number of draws between consecutive appearances of this number">Avg gap (draws)</th>
        <th style="text-align:center" title="Shortest streak without this number appearing">Min gap</th>
        <th style="text-align:center" title="Longest streak without this number appearing">Max gap</th>
        <th style="text-align:center" title="How many draws have passed since this number last appeared. Turns orange when it exceeds the average gap.">Draws since last seen</th>
      </tr>
    </thead>
  `;

  const tbody = document.createElement('tbody');
  top.forEach((r, i) => {
    const isOverdue = r.since !== null && r.avgRaw !== null && r.since > r.avgRaw;
    const tr = document.createElement('tr');
    tr.title = `${r.num}: drawn ${r.count}× · avg gap ${r.avg} draws · min ${r.min} · max ${r.max} · last seen ${r.since !== null ? r.since + ' draws ago' : 'unknown'}`;
    tr.innerHTML = `
      <td style="font-family:'JetBrains Mono',monospace;font-weight:600;color:${i === 0 ? 'var(--primary)' : 'inherit'}">${r.num}</td>
      <td style="text-align:center;font-variant-numeric:tabular-nums">${r.count}</td>
      <td style="text-align:center;font-variant-numeric:tabular-nums">${r.pct}%</td>
      <td style="text-align:center;font-variant-numeric:tabular-nums">${r.avg}</td>
      <td style="text-align:center;font-variant-numeric:tabular-nums">${r.min}</td>
      <td style="text-align:center;font-variant-numeric:tabular-nums">${r.max}</td>
      <td style="text-align:center;font-variant-numeric:tabular-nums;color:${isOverdue ? 'hsl(15,80%,58%)' : 'inherit'};font-weight:${isOverdue ? '600' : '400'}">
        ${r.since !== null ? r.since : '?'}${isOverdue ? ' ⚠' : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
}

// ── 7. Rolling frequency trend ─────────────────────────────────────────────
function renderRolling(ins) {
  if (!ins) return;
  if (rollingChart) { rollingChart.destroy(); rollingChart = null; }

  const draws = ins._draws || getWindowedDraws();
  const W     = rollingWindow;
  const rollingData = computeRollingData(ins, draws, W, rollingSeries);

  if (!rollingData.length || !rollingData[0].points.length) return;

  $('rollingSubtitle').textContent =
    `Top ${rollingData.length} most frequent numbers in the window. ` +
    `Each data point = how many times that number appeared in the preceding ${W} draws. ` +
    `Rising line = trending hot. Flat = consistently regular. Dropping = cooling off.`;

  const muted  = cssVar('--muted-foreground');
  const border = cssVar('--border');
  const fg     = cssVar('--foreground');

  const labels = rollingData[0].points.map(p => p.x);

  rollingChart = new Chart($('rollingCanvas'), {
    type: 'line',
    data: {
      labels,
      datasets: rollingData.map((d, i) => ({
        label: d.num,
        data: d.points.map(p => p.y),
        borderColor: PALETTE[i],
        backgroundColor: PALETTE[i].replace('hsl(', 'hsla(').replace(')', ',0.06)'),
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: fg,
            font: { family: "'JetBrains Mono', monospace", size: 11 },
            boxWidth: 12, padding: 16,
          },
        },
        tooltip: {
          callbacks: {
            title: items => `Period ending: ${items[0].label}`,
            label: ctx => ` ${ctx.dataset.label}: ${ctx.raw} appearance${ctx.raw !== 1 ? 's' : ''} in last ${W} draws`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: border },
          ticks: { color: muted, font: { size: 10 }, maxTicksLimit: 14 },
        },
        y: {
          grid: { color: border },
          ticks: { color: muted, font: { size: 11 } },
          title: {
            display: true,
            text: `Appearances per ${W}-draw window`,
            color: muted,
            font: { size: 11 },
          },
          beginAtZero: true,
        },
      },
    },
  });
}

// ── 8. Statistical candidates ──────────────────────────────────────────────
function renderCandidates(ins) {
  const { candidates } = ins;
  const container = $('candidatesList');

  if (!candidates.length) {
    container.innerHTML = '<p style="color:var(--muted-foreground);font-size:0.875rem;margin-top:0.5rem;">Not enough data — numbers need at least 3 appearances in the window to compute a reliable average gap.</p>';
    return;
  }

  const cards = candidates.map((c, i) => `
    <div class="candidate-card" title="${c.num}: drawn ${c.count}× · last seen ${c.lastDate} · ${c.sinceLastSeen} draws ago · avg gap ${c.avgGap.toFixed(1)} · overdue by ${(c.score * 100).toFixed(0)}%">
      <div class="candidate-rank">Candidate #${i + 1}</div>
      <div class="candidate-num">${c.num}</div>
      <div class="candidate-meta">
        Drawn <strong>${c.count}×</strong> in window<br>
        Last seen: ${c.lastDate}<br>
        ${c.sinceLastSeen} draws since last appearance<br>
        Avg gap between appearances: ${c.avgGap.toFixed(1)} draws<br>
        <span class="candidate-overdue">+${(c.score * 100).toFixed(0)}% past its own average gap</span>
      </div>
    </div>
  `).join('');

  container.innerHTML = `<div class="candidate-cards">${cards}</div>`;
}

// ── Boot ───────────────────────────────────────────────────────────────────
init().catch(err => {
  console.error('insights.js init error:', err);
  setStatus('empty', 'Failed to load data: ' + err.message);
});
