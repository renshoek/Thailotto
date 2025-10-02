// Thai Lotto Analyzer - Main Script
const PRIZE_LIST = ['FIRST','SECOND','THIRD','FOURTH','FIFTH','TWO','THREE_FIRST','THREE_LAST','NEAR_FIRST'];
const FIXED_START = new Date('2006-12-30T00:00');
const DRAW_DAYS = [30,31,1,2,3,14,15,16,17];

// DOM Elements
const topNInput = document.getElementById('topN');
const yearsInput = document.getElementById('yearsBack');
const monthsInput = document.getElementById('monthsBack');
const monthsLabel = document.getElementById('monthsLabel');
const drawsInput = document.getElementById('drawsCount');
const leastCheckbox = document.getElementById('leastCheckbox');
const miniOnlyCheckbox = document.getElementById('miniOnlyCheckbox');
const timeModeRadios = document.querySelectorAll('input[name="timeMode"]');
const yearsControl = document.getElementById('yearsControl');
const monthsControl = document.getElementById('monthsControl');
const drawsControl = document.getElementById('drawsControl');
const fixedStartCB = document.getElementById('fixedStartCheckbox');
const output = document.getElementById('output');
const loadingEl = document.getElementById('loading');
const prizeTabsEl = document.getElementById('prizeTabs');
const prizeTabContent = document.getElementById('prizeTabContent');
const themeToggle = document.getElementById('themeToggle');

// State
let counts = {}, digitCounts = {};
let dateMap = [];
let selectedDates = new Set();
let resultsByDate = {};
let perFileAggMap = new Map();

// IndexedDB cache settings
const DB_NAME = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY = 'perFileAggMap_v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Theme toggle
themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
});

// Initialize theme
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark');
}

// Helper functions
const pad2 = n => n.toString().padStart(2,'0');

function getSelectedPrizesFromTabState() {
  const multiBox = prizeTabContent.querySelector('#prizeFieldset');
  if (multiBox) {
    const cbs = Array.from(multiBox.querySelectorAll('input[name="prize"]'));
    return cbs.filter(cb => cb.checked).map(cb => cb.value);
  }
  const active = prizeTabsEl.querySelector('.tab.active');
  if (!active) return [];
  const mode = active.getAttribute('data-prize');
  if (mode === 'all') return PRIZE_LIST.slice();
  if (mode === 'multi') return [];
  return [mode];
}

function getTimeMode() {
  return Array.from(timeModeRadios).find(r=>r.checked).value;
}

function updateConversionLabels() {
  const mon = parseInt(monthsInput.value,10) || 0;
  const y = Math.floor(mon/12), m = mon % 12;
  monthsLabel.textContent = `(${y} year${y!==1?'s':''}${m?`, ${m} month${m!==1?'s':''}`:''})`;
}

function toggleTimeControls() {
  const mode = getTimeMode();
  yearsControl.style.display = mode==='years' ? 'flex':'none';
  monthsControl.style.display = mode==='months' ? 'flex':'none';
  drawsControl.style.display = mode==='draws' ? 'flex':'none';
}

function resetCounts() {
  counts = {}; digitCounts = {};
  PRIZE_LIST.forEach(p=>{
    counts[p] = {};
    const len = p==='TWO' ? 2 : p.startsWith('THREE') ? 3 : 6;
    digitCounts[p] = Array.from({length: len}, () => ({}));
  });
}

function record(prize,val,date) {
  const bucket = counts[prize];
  bucket[val] = bucket[val] || {count:0, dates:[]};
  bucket[val].count++;
  if (bucket[val].dates.length < 50) bucket[val].dates.push(date);
  val.split('').forEach((d,i)=>{
    const dc = digitCounts[prize][i];
    dc[d] = (dc[d]||0) + 1;
  });
}

function buildCandidateUrls() {
  const urls = [];
  const today = new Date();
  for (let y = 2006; y <= today.getFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      for (const d of DRAW_DAYS) {
        if (y === 2006 && m === 12 && d < 30) continue;
        const dateStr = `${y}-${pad2(m)}-${pad2(d)}`;
        urls.push({ dateStr, url: `lottonumbers/${dateStr}.txt` });
      }
    }
  }
  return urls;
}

async function batchFetchWithProgress(urls, concurrency = 20, onProgress = ()=>{}) {
  const results = [];
  let idx = 0;
  let completed = 0;
  const total = urls.length;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const { dateStr, url } = urls[i];
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const text = await resp.text();
          results.push({ dateStr, text });
        }
      } catch (e) {
        // ignore
      } finally {
        completed++;
        onProgress(completed, total, dateStr);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, worker);
  await Promise.all(workers);
  return results;
}

function createParserWorker() {
  const workerCode = `
    const PRIZE_LIST = ${JSON.stringify(PRIZE_LIST)};
    function parseTextToAggregate(dateStr, text) {
      const lines = text.split(/\\r?\\n/);
      const prizesAgg = {};
      const digitAgg = {};
      const results = {};
      PRIZE_LIST.forEach(p=>{
        prizesAgg[p] = {};
        const len = p==='TWO' ? 2 : p.startsWith('THREE') ? 3 : 6;
        digitAgg[p] = Array.from({length: len}, ()=> ({}));
      });
      lines.slice(1).forEach(line=>{
        if (!line.trim()) return;
        const parts = line.trim().split(/\\s+/);
        const tag = parts[0];
        const nums = parts.slice(1).filter(Boolean);
        if (!prizesAgg[tag]) return;
        const len = tag==='TWO' ? 2 : tag.startsWith('THREE') ? 3 : 6;
        const lastVals = nums.map(n => n.slice(-len));
        results[tag] = lastVals.join(', ');
        lastVals.forEach(val=>{
          if (!val) return;
          prizesAgg[tag][val] = (prizesAgg[tag][val] || 0) + 1;
          val.split('').forEach((d,i)=>{
            digitAgg[tag][i][d] = (digitAgg[tag][i][d] || 0) + 1;
          });
        });
      });
      return { dateStr, prizesAgg, digitAgg, results };
    }

    self.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.cmd === 'parseBatch') {
        const files = msg.files || [];
        const out = {};
        for (const f of files) {
          try {
            out[f.dateStr] = parseTextToAggregate(f.dateStr, f.text);
          } catch (err) {
            // skip
          }
        }
        self.postMessage({ type: 'done', results: out });
      }
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveCacheBlob(blob) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(blob, CACHE_KEY);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('abort'));
    });
  } catch (e) {
    // ignore
  }
}

async function loadCacheBlob() {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(CACHE_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

function combineAggregatesForDates(selectedDateStrs, perFileAggMapLocal) {
  resetCounts();
  resultsByDate = {};
  const MAX_DATES_RECORD = 50;

  for (const dateStr of selectedDateStrs) {
    const agg = perFileAggMapLocal.get(dateStr);
    if (!agg) continue;
    for (const prize of PRIZE_LIST) {
      const prizeMap = agg.prizesAgg[prize] || {};
      for (const [val, cnt] of Object.entries(prizeMap)) {
        const bucket = counts[prize];
        bucket[val] = bucket[val] || { count: 0, dates: [] };
        bucket[val].count += cnt;
        if (bucket[val].dates.length < MAX_DATES_RECORD) bucket[val].dates.push(dateStr);
      }
      const pods = agg.digitAgg[prize] || [];
      pods.forEach((pod,i)=>{
        const dest = digitCounts[prize][i];
        for (const [dig, c] of Object.entries(pod)) dest[dig] = (dest[dig]||0) + c;
      });
    }
    resultsByDate[dateStr] = agg.results || {};
  }
}

function el(name, text, attrs = {}) {
  const e = document.createElement(name);
  if (text !== undefined && text !== null) e.textContent = text;
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
  return e;
}

function renderTables() {
  output.innerHTML = '';
  const showLeast = leastCheckbox.checked;
  const miniOnly = miniOnlyCheckbox.checked;
  const N = parseInt(topNInput.value,10) || 5;
  const MAX = 11;
  const mode = getTimeMode();

  const selected = getSelectedPrizesFromTabState();
  if (!selected.length) return;

  const fragment = document.createDocumentFragment();

  selected.forEach(prize=>{
    const bucket = counts[prize] || {};
    const tot = Object.values(bucket).reduce((s,b)=>s+(b.count||0),0);

    let data;
    if (prize === 'TWO') data = Array.from({length:100}, (_,i)=>[pad2(i), bucket[pad2(i)] || {count:0,dates:[]}]);
    else data = Object.entries(bucket);

    data.sort((a,b)=> showLeast ? (a[1].count - b[1].count) : (b[1].count - a[1].count));
    const entries = data.slice(0,N).map(([val,info])=>({ val, count: info.count || 0, dates: (info.dates||[]).slice(0,MAX) }));

    fragment.appendChild(el('div', `${prize}: ${tot} drawings`, { class: 'prize-header' }));

    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const r1 = document.createElement('tr');
    const th1 = document.createElement('th'); th1.colSpan = 2+MAX; th1.textContent = prize; r1.appendChild(th1); thead.appendChild(r1);
    const r2 = document.createElement('tr'); const th2 = document.createElement('th'); th2.colSpan = 2+MAX; th2.textContent = `Drawings: ${tot}`; r2.appendChild(th2); thead.appendChild(r2);
    const r3 = document.createElement('tr'); r3.appendChild(el('th','Winning no.')); r3.appendChild(el('th','Count')); for (let i=0;i<MAX;i++) r3.appendChild(el('th', `Date ${i+1}`)); thead.appendChild(r3);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    entries.forEach(e=>{
      const pct = tot ? ((e.count/tot)*100).toFixed(1) : '0.0';
      const tr = document.createElement('tr');
      tr.appendChild(el('td', e.val));
      const tdCount = el('td', `${e.count} (${pct}%)`); tdCount.style.textAlign = 'center';
      tr.appendChild(tdCount);
      for (let i=0;i<MAX;i++) tr.appendChild(el('td', e.dates[i] || ''));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);

    if (miniOnly) tbl.classList.add('mini-only-table');

    fragment.appendChild(tbl);

    // Container for side-by-side tables
    const tablesContainer = document.createElement('div');
    tablesContainer.className = 'tables-container';

    // mini table (POD/Rank table)
    const pods = digitCounts[prize];
    const mini = document.createElement('table'); mini.className = 'mini-table';
    const miniHead = document.createElement('tr'); miniHead.appendChild(el('th','Rank'));
    const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
    pods.forEach((_,i)=> miniHead.appendChild(el('th', `${ordinals[i] || (i+1)+'th'} no.`)));
    mini.appendChild(miniHead);

    const ranks = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
    for (let rankIdx=0; rankIdx<ranks.length; rankIdx++) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', ranks[rankIdx]));
      pods.forEach((dc)=>{
        const entriesArr = Object.entries(dc);
        entriesArr.sort((a,b)=> showLeast ? (a[1]-b[1]) : (b[1]-a[1]));
        const [d='', c=0] = entriesArr[rankIdx] || [];
        const p = tot ? ((c/tot)*100).toFixed(1) : '0.0';
        tr.appendChild(el('td', c ? `${d} (${c}/${p}%)` : ''));
      });
      mini.appendChild(tr);
    }
    tablesContainer.appendChild(mini);

    // Recent wins table - each cell shows one number and date
    const sorted = dateMap.filter(x => selectedDates.has(x.dateStr)).map(x => x.dateStr).sort((a,b) => b.localeCompare(a));
    // Collect individual winning numbers with their dates
    const individualWins = [];
    for (const dateStr of sorted) {
      if (resultsByDate[dateStr] && resultsByDate[dateStr][prize]) {
        const numsStr = resultsByDate[dateStr][prize];
        const nums = numsStr.split(',').map(n => n.trim()).filter(n => n);
        nums.forEach(num => {
          individualWins.push({ date: dateStr, number: num });
        });
      }
      if (individualWins.length >= 50) break; // Limit total cells
    }

    if (individualWins.length > 0) {
      const winsTable = document.createElement('table');
      winsTable.className = 'mini-table recent-wins-table';
      
      // Create grid: 5 columns
      const cols = 5;
      const rows = Math.ceil(individualWins.length / cols);
      
      for (let row = 0; row < rows; row++) {
        const tr = document.createElement('tr');
        
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;
          const td = document.createElement('td');
          
          if (idx < individualWins.length) {
            const win = individualWins[idx];
            td.innerHTML = `<span class="win-num">${win.number}</span><span class="win-dt">${win.date}</span>`;
          }
          
          tr.appendChild(td);
        }
        winsTable.appendChild(tr);
      }

      tablesContainer.appendChild(winsTable);
    }

    fragment.appendChild(tablesContainer);

    if (mode === 'draws' && ['FIRST','TWO','THREE_FIRST','THREE_LAST'].includes(prize)) {
      const sorted = dateMap.filter(x => selectedDates.has(x.dateStr)).map(x => x.dateStr);
      let infoDates = [];
      if (fixedStartCB.checked) {
        if (sorted.length >= 3) infoDates = sorted.slice(-3).reverse();
      } else {
        if (sorted.length >= 3) infoDates = sorted.slice(0,3);
      }
      if (infoDates.length) {
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'font-size:0.8em;color:var(--muted-foreground);margin-top:4px;';
        infoDiv.textContent = infoDates.map(d => `${d}: ${resultsByDate[d] ? (resultsByDate[d][prize] || '') : ''}`).join('  |  ');
        fragment.appendChild(infoDiv);
      }
    }
  });

  output.appendChild(fragment);
}

function computeSelectedDatesFromMode(perFileDates) {
  selectedDates.clear();
  const mode = getTimeMode();

  if (mode === 'draws') {
    const N = parseInt(drawsInput.value,10) || 1;
    const slice = fixedStartCB.checked
      ? perFileDates.filter(x => x.date >= FIXED_START).slice(0,N)
      : perFileDates.slice(-N);
    slice.forEach(x => selectedDates.add(x.dateStr));
    return;
  }

  if (mode === 'years') {
    const yrs = parseInt(yearsInput.value,10) || 0;
    if (fixedStartCB.checked) {
      const end = new Date(FIXED_START);
      if (yrs > 0) end.setFullYear(end.getFullYear() + yrs);
      perFileDates.filter(x => x.date >= FIXED_START && x.date <= end).forEach(x => selectedDates.add(x.dateStr));
    } else {
      if (yrs > 0) {
        const cut = new Date(); cut.setFullYear(cut.getFullYear() - yrs);
        perFileDates.filter(x => x.date >= cut).forEach(x => selectedDates.add(x.dateStr));
      } else perFileDates.forEach(x => selectedDates.add(x.dateStr));
    }
    return;
  }

  if (mode === 'months') {
    const mon = parseInt(monthsInput.value,10) || 0;
    if (fixedStartCB.checked) {
      const end = new Date(FIXED_START);
      if (mon > 0) end.setMonth(end.getMonth() + mon);
      perFileDates.filter(x => x.date >= FIXED_START && x.date <= end).forEach(x => selectedDates.add(x.dateStr));
    } else {
      if (mon > 0) {
        const cut = new Date(); cut.setMonth(cut.getMonth() - mon);
        perFileDates.filter(x => x.date >= cut).forEach(x => selectedDates.add(x.dateStr));
      } else perFileDates.forEach(x => selectedDates.add(x.dateStr));
    }
    return;
  }

  perFileDates.forEach(x => selectedDates.add(x.dateStr));
}

async function progressiveFetchAndProcess({ concurrency = 30, recentLimit = 150 } = {}) {
  loadingEl.classList.add('show');
  loadingEl.querySelector('.loading-text').textContent = 'Checking cache...';

  const cached = await loadCacheBlob();
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS && cached.data) {
    try {
      perFileAggMap = new Map(Object.entries(cached.data));
    } catch (e) {
      perFileAggMap = new Map();
    }
  }

  const candidates = buildCandidateUrls();
  candidates.sort((a,b)=> a.dateStr.localeCompare(b.dateStr));

  const worker = createParserWorker();

  function parseBatchInWorker(batch) {
    return new Promise((resolve, reject) => {
      const handle = (ev) => {
        if (ev.data && ev.data.type === 'done') {
          worker.removeEventListener('message', handle);
          resolve(ev.data.results || {});
        }
      };
      worker.addEventListener('message', handle);
      worker.postMessage({ cmd: 'parseBatch', files: batch });
    });
  }

  const total = candidates.length;
  const recent = candidates.slice(Math.max(0, total - recentLimit));
  const older = candidates.slice(0, Math.max(0, total - recentLimit));

  const recentToFetch = recent.filter(x => !perFileAggMap.has(x.dateStr));
  const olderToFetch = older.filter(x => !perFileAggMap.has(x.dateStr));

  if (recentToFetch.length > 0) {
    loadingEl.querySelector('.loading-text').textContent = `Fetching recent ${recentToFetch.length} files...`;
    const fetchedRecent = await batchFetchWithProgress(recentToFetch, concurrency, (done, tot, lastDate) => {
      loadingEl.querySelector('.loading-text').textContent = `Recent: ${done}/${tot} ${lastDate || ''}`;
    });
    const groupSize = 50;
    for (let i=0; i<fetchedRecent.length; i+=groupSize) {
      const group = fetchedRecent.slice(i, i+groupSize);
      const parsed = await parseBatchInWorker(group);
      for (const [k,v] of Object.entries(parsed)) perFileAggMap.set(k, v);
    }
  } else {
    loadingEl.querySelector('.loading-text').textContent = 'No recent files to download, using cache.';
  }

  dateMap = Array.from(perFileAggMap.keys()).map(d => ({ dateStr: d, date: new Date(d + 'T00:00') })).sort((a,b)=> a.date - b.date);
  computeSelectedDatesFromMode(dateMap);
  combineAggregatesForDates(Array.from(selectedDates), perFileAggMap);
  renderTables();

  if (olderToFetch.length > 0) {
    loadingEl.querySelector('.loading-text').textContent = `Fetching older ${olderToFetch.length} files...`;
    const fetchedOlder = await batchFetchWithProgress(olderToFetch, concurrency, (done, tot, lastDate) => {
      loadingEl.querySelector('.loading-text').textContent = `Background: ${done}/${tot} ${lastDate || ''}`;
    });
    const groupSize = 50;
    for (let i=0; i<fetchedOlder.length; i+=groupSize) {
      const group = fetchedOlder.slice(i, i+groupSize);
      const parsed = await parseBatchInWorker(group);
      for (const [k,v] of Object.entries(parsed)) perFileAggMap.set(k, v);
    }

    dateMap = Array.from(perFileAggMap.keys()).map(d => ({ dateStr: d, date: new Date(d + 'T00:00') })).sort((a,b)=> a.date - b.date);
    computeSelectedDatesFromMode(dateMap);
    combineAggregatesForDates(Array.from(selectedDates), perFileAggMap);
    renderTables();
  }

  const plainObj = {};
  for (const [k,v] of perFileAggMap.entries()) plainObj[k] = v;
  await saveCacheBlob({ fetchedAt: Date.now(), data: plainObj });

  loadingEl.classList.remove('show');
  worker.terminate();
}

function buildTabs() {
  prizeTabsEl.innerHTML = '';
  const allTab = el('button', 'All', { class: 'tab', 'data-prize': 'all', type: 'button' });
  prizeTabsEl.appendChild(allTab);
  PRIZE_LIST.forEach(p => {
    const b = el('button', p.replace(/_/g,' '), { class: 'tab', 'data-prize': p, type: 'button' });
    prizeTabsEl.appendChild(b);
  });
  const multi = el('button', 'Multiple', { class: 'tab', 'data-prize': 'multi', type: 'button' });
  prizeTabsEl.appendChild(multi);

  setActiveTab('all');

  prizeTabsEl.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    const prize = btn.getAttribute('data-prize');
    setActiveTab(prize);
  });
}

function setActiveTab(prize) {
  Array.from(prizeTabsEl.children).forEach(b=>b.classList.toggle('active', b.getAttribute('data-prize')===prize));
  if (prize === 'multi') {
    renderMultiCheckboxes();
  } else {
    prizeTabContent.innerHTML = '';
  }
  computeSelectedDatesFromMode(dateMap);
  combineAggregatesForDates(Array.from(selectedDates), perFileAggMap);
  renderTables();
}

function renderMultiCheckboxes() {
  const html = document.createElement('div');
  const fs = document.createElement('fieldset'); fs.id = 'prizeFieldset';
  const legend = document.createElement('legend'); legend.textContent = 'Prize Type';
  fs.appendChild(legend);

  const selectAll = document.createElement('label');
  selectAll.className = 'checkbox-label';
  selectAll.innerHTML = '<input type="checkbox" id="selectAllPrizes" checked> <span>Select/Deselect All</span>';
  fs.appendChild(selectAll);

  const grid = document.createElement('div');
  grid.className = 'prize-grid';
  PRIZE_LIST.forEach(p => {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.name = 'prize'; cb.value = p; cb.checked = true;
    label.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = ' ' + p.replace(/_/g,' ');
    label.appendChild(span);
    grid.appendChild(label);
  });

  fs.appendChild(grid);
  html.appendChild(fs);
  prizeTabContent.innerHTML = '';
  prizeTabContent.appendChild(html);

  const selectAllEl = prizeTabContent.querySelector('#selectAllPrizes');
  const prizeCheckboxes = Array.from(prizeTabContent.querySelectorAll('input[name="prize"]'));
  selectAllEl.addEventListener('input', ()=>{ const c = selectAllEl.checked; prizeCheckboxes.forEach(cb=>cb.checked = c); computeAndRender(); });
  prizeCheckboxes.forEach(cb=> cb.addEventListener('input', ()=> computeAndRender()));

  function computeAndRender(){
    computeSelectedDatesFromMode(dateMap);
    combineAggregatesForDates(Array.from(selectedDates), perFileAggMap);
    renderTables();
  }
}

function wireGlobalControls() {
  timeModeRadios.forEach(r => r.addEventListener('input', ()=>{ toggleTimeControls(); computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); }));

  yearsInput.addEventListener('input', ()=>{ updateConversionLabels(); computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); });
  monthsInput.addEventListener('input', ()=>{ updateConversionLabels(); computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); });
  drawsInput.addEventListener('input', ()=>{ computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); });

  topNInput.addEventListener('input', ()=>{ if (perFileAggMap.size) renderTables(); });
  leastCheckbox.addEventListener('input', ()=>{ if (perFileAggMap.size) renderTables(); });
  miniOnlyCheckbox.addEventListener('input', ()=>{ if (perFileAggMap.size) renderTables(); });
  fixedStartCB.addEventListener('input', ()=>{ if (!perFileAggMap.size) return; computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); });
}

// Initialize
toggleTimeControls();
updateConversionLabels();
buildTabs();
wireGlobalControls();
progressiveFetchAndProcess({ concurrency: 30, recentLimit: 150 }).catch(err=>{
  console.error('Error during progressive load', err);
  loadingEl.classList.remove('show');
});
