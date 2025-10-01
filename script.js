// script.js
// Thai Lotto Analyzer - faster version
// - concurrent fetch with limited concurrency
// - parse each file once into a compact aggregate
// - combine aggregates for UI filters, avoid reparsing
// - simple IndexedDB cache to avoid re-downloading on revisit
// - efficient DOM rendering using DocumentFragment
// Notes: keep this file as module if you load it with type="module"

const PRIZE_LIST  = ['FIRST','SECOND','THIRD','FOURTH','FIFTH',
                     'TWO','THREE_FIRST','THREE_LAST','NEAR_FIRST'];
const FILENAME_RE = /(\d{4}-\d{2}-\d{2})/;
const FIXED_START = new Date('2006-12-30T00:00');
const DRAW_DAYS   = [ 30, 31, 1, 2, 3, 14, 15, 16, 17]; // Thai draws occur on these days

// UI elements
const topNInput   = document.getElementById('topN');
const yearsInput  = document.getElementById('yearsBack');
const monthsInput = document.getElementById('monthsBack');
const monthsLabel = document.getElementById('monthsLabel');
const drawsInput  = document.getElementById('drawsCount');
const leastCheckbox    = document.getElementById('leastCheckbox');
const miniOnlyCheckbox = document.getElementById('miniOnlyCheckbox');
const selectAll        = document.getElementById('selectAllPrizes');
const timeModeRadios   = document.querySelectorAll('input[name="timeMode"]');
const yearsControl  = document.getElementById('yearsControl');
const monthsControl = document.getElementById('monthsControl');
const drawsControl  = document.getElementById('drawsControl');
const fixedStartCB  = document.getElementById('fixedStartCheckbox');
const output        = document.getElementById('output');
const loadingEl     = document.getElementById('loading');
const prizeCheckboxes =
  document.querySelectorAll('#prizeFieldset input[name="prize"]');

// Application state
let counts = {}, digitCounts = {}, lastFiles = [];
let dateMap = [];          // {file, date, dateStr}
let selectedDates = new Set();
let resultsByDate = {};    // raw prize strings per draw

// per-file aggregates map: dateStr -> aggregate
// aggregate shape: { dateStr, prizesAgg: {PRIZE: { val: count, ... } }, digitAgg: {PRIZE: [ {digit:count}, ... ] }, results: {PRIZE: 'a, b'} }
let perFileAggMap = new Map();

// -------------------- helpers --------------------
const pad2 = n => n.toString().padStart(2,'0');
const getSelectedPrizes = () =>
  Array.from(prizeCheckboxes).filter(cb => cb.checked).map(cb => cb.value);
const getTimeMode = () =>
  Array.from(timeModeRadios).find(r => r.checked).value;

function updateConversionLabels() {
  const mon = parseInt(monthsInput.value,10) || 0;
  const y = Math.floor(mon/12), m = mon % 12;
  monthsLabel.textContent =
    `(${y} year${y!==1?'s':''}${m?`, ${m} month${m!==1?'s':''}`:''})`;
}

function toggleTimeControls() {
  const mode = getTimeMode();
  yearsControl.style.display  = mode==='years'  ? 'inline-block':'none';
  monthsControl.style.display = mode==='months' ? 'inline-block':'none';
  drawsControl.style.display  = mode==='draws'  ? 'inline-block':'none';
}

function resetCounts() {
  counts = {}; digitCounts = {}; resultsByDate = {};
  PRIZE_LIST.forEach(p=>{
    counts[p] = {};
    const len = p==='TWO' ? 2 : p.startsWith('THREE') ? 3 : 6;
    digitCounts[p] = Array.from({length: len}, () => ({}));
  });
}

// record function used when combining aggregates; stores date sample up to cap
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

// -------------------- network and parsing --------------------

// build list of candidate URLs from 2006 to today for known draw days
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

// concurrent fetch with limited concurrency
async function batchFetch(urls, concurrency = 20) {
  const results = [];            // {dateStr, text}
  let idx = 0;

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
        // ignore network errors; could add retry logic here
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, worker);
  await Promise.all(workers);
  return results;
}

// parse a single file text to compact aggregate
function parseTextToAggregate(dateStr, text) {
  const lines = text.split(/\r?\n/);
  const prizesAgg = {};
  const digitAgg = {};
  const results = {};

  PRIZE_LIST.forEach(p => {
    prizesAgg[p] = {};   // val -> count
    const len = p === 'TWO' ? 2 : p.startsWith('THREE') ? 3 : 6;
    digitAgg[p] = Array.from({ length: len }, () => ({}));
  });

  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const parts = line.trim().split(/\s+/);
    const tag = parts[0];
    const nums = parts.slice(1).filter(Boolean);
    if (!prizesAgg[tag]) return;
    const len = tag === 'TWO' ? 2 : tag.startsWith('THREE') ? 3 : 6;

    const lastVals = nums.map(n => n.slice(-len));
    results[tag] = lastVals.join(', ');

    lastVals.forEach(val => {
      if (!val) return;
      prizesAgg[tag][val] = (prizesAgg[tag][val] || 0) + 1;
      val.split('').forEach((d, i) => {
        digitAgg[tag][i][d] = (digitAgg[tag][i][d] || 0) + 1;
      });
    });
  });

  return { dateStr, prizesAgg, digitAgg, results };
}

// -------------------- IndexedDB cache --------------------
// Simple wrapper to store a single JSON blob 'perFileAggMap' with fetch time.
const DB_NAME = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY = 'perFileAggMap_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
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
    // ignore cache save errors
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

// -------------------- combining aggregates --------------------

// combine per-file aggregates into global counts for a list of selected dates
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
      // digit counts
      const pods = agg.digitAgg[prize] || [];
      pods.forEach((pod, i) => {
        const dest = digitCounts[prize][i];
        for (const [dig, c] of Object.entries(pod)) {
          dest[dig] = (dest[dig] || 0) + c;
        }
      });
    }

    // store raw per-date results for draw mode display
    resultsByDate[dateStr] = agg.results || {};
  }
}

// -------------------- rendering --------------------

// create a small helper to make table cells easily
function el(name, text, attrs = {}) {
  const e = document.createElement(name);
  if (text !== undefined && text !== null) e.textContent = text;
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
  return e;
}

function renderTables() {
  output.innerHTML = '';

  const showLeast = leastCheckbox.checked;
  const miniOnly  = miniOnlyCheckbox.checked;
  const N         = parseInt(topNInput.value,10) || 5;
  const MAX       = 11;
  const mode      = getTimeMode();
  const selected  = getSelectedPrizes();
  if (!selected.length) return;

  const fragment = document.createDocumentFragment();

  selected.forEach(prize=>{
    const bucket = counts[prize] || {};
    const tot    = Object.values(bucket).reduce((s,b)=>s+(b.count||0),0);

    // build data array
    let data;
    if (prize === 'TWO') {
      data = Array.from({length:100}, (_,i)=>[pad2(i), bucket[pad2(i)] || {count:0,dates:[]}]);
    } else {
      data = Object.entries(bucket);
    }

    data.sort((a,b)=>
      showLeast ? (a[1].count - b[1].count) : (b[1].count - a[1].count)
    );

    const entries = data.slice(0,N).map(([val,info])=>({
      val,
      count: info.count || 0,
      dates: (info.dates || []).slice(0,MAX)
    }));

    // header
    const header = el('div', `${prize}: ${tot} drawings`);
    header.className = 'prize-header';
    fragment.appendChild(header);

    // main table
    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow1 = document.createElement('tr');
    const thAll1 = document.createElement('th');
    thAll1.colSpan = 2 + MAX;
    thAll1.textContent = prize;
    headRow1.appendChild(thAll1);
    thead.appendChild(headRow1);

    const headRow2 = document.createElement('tr');
    const thAll2 = document.createElement('th');
    thAll2.colSpan = 2 + MAX;
    thAll2.textContent = `Drawings: ${tot}`;
    headRow2.appendChild(thAll2);
    thead.appendChild(headRow2);

    const headRow3 = document.createElement('tr');
    headRow3.appendChild(el('th','Value'));
    headRow3.appendChild(el('th','Count'));
    for (let i=0;i<MAX;i++) headRow3.appendChild(el('th', `Date ${i+1}`));
    thead.appendChild(headRow3);

    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    entries.forEach(e=>{
      const pct = tot ? ((e.count/tot)*100).toFixed(1) : '0.0';
      const tr = document.createElement('tr');
      tr.appendChild(el('td', e.val));
      const tdCount = el('td', `${e.count} (${pct}%)`);
      tdCount.style.textAlign = 'center';
      tr.appendChild(tdCount);
      for (let i=0;i<MAX;i++) tr.appendChild(el('td', e.dates[i] || ''));
      tbody.appendChild(tr);
    });

    tbl.appendChild(tbody);

    if (miniOnly) {
      const cols = 2+MAX;
      // hide columns via CSS display inline on cells
      // add a class to mark hidden mode
      tbl.classList.add('mini-only-table');
      // but still append table; column hiding done below
    }

    fragment.appendChild(tbl);

    // mini digit-frequency table
    const pods = digitCounts[prize];
    const mini = document.createElement('table');
    mini.className = 'mini-table';
    const miniHead = document.createElement('tr');
    miniHead.appendChild(el('th', 'Rank'));
    pods.forEach((_,i)=> miniHead.appendChild(el('th', `POD ${i+1}`)));
    mini.appendChild(miniHead);

    const ranks = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
    for (let rankIdx=0; rankIdx<ranks.length; rankIdx++) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', ranks[rankIdx]));
      pods.forEach((dc)=>{
        // build sorted array
        const entriesArr = Object.entries(dc);
        entriesArr.sort((a,b)=> showLeast ? (a[1]-b[1]) : (b[1]-a[1]));
        const [d='', c=0] = entriesArr[rankIdx] || [];
        const p = tot ? ((c/tot)*100).toFixed(1) : '0.0';
        tr.appendChild(el('td', c ? `${d} (${c}/${p}%)` : ''));
      });
      mini.appendChild(tr);
    }
    fragment.appendChild(mini);

    // draws-mode recent details
    if (mode==='draws' &&
        ['FIRST','TWO','THREE_FIRST','THREE_LAST'].includes(prize)) {

      const sorted = dateMap
        .filter(x => selectedDates.has(x.dateStr))
        .map(x => x.dateStr);

      let infoDates = [];
      if (fixedStartCB.checked) {
        if (sorted.length >= 3) infoDates = sorted.slice(-3).reverse();
      } else {
        if (sorted.length >= 3) infoDates = sorted.slice(0,3);
      }

      if (infoDates.length) {
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'font-size:0.8em;color:#555;margin-top:4px;';
        infoDiv.textContent = infoDates
          .map(d => `${d}: ${resultsByDate[d] ? (resultsByDate[d][prize] || '') : ''}`)
          .join('  |  ');
        fragment.appendChild(infoDiv);
      }
    }
  });

  // append once
  output.appendChild(fragment);

  // If miniOnly, hide table cells to reduce DOM paint cost
  if (miniOnly) {
    Array.from(document.querySelectorAll('table.mini-only-table')).forEach(tbl=>{
      const rows = Array.from(tbl.rows);
      for (const r of rows) {
        for (let c=0; c<2+11; c++) {
          if (r.cells[c]) r.cells[c].style.display = 'none';
        }
      }
    });
  }
}

// -------------------- top-level initialization and control wiring --------------------

function computeSelectedDatesFromMode(perFileDates) {
  // perFileDates: array of {dateStr, date}
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
    const yrs  = parseInt(yearsInput.value,10) || 0;
    if (fixedStartCB.checked) {
      const end = new Date(FIXED_START);
      if (yrs > 0) end.setFullYear(end.getFullYear()+yrs);
      perFileDates.filter(x => x.date >= FIXED_START && x.date <= end).forEach(x => selectedDates.add(x.dateStr));
    } else {
      if (yrs > 0) {
        const cut = new Date(); cut.setFullYear(cut.getFullYear()-yrs);
        perFileDates.filter(x => x.date >= cut).forEach(x => selectedDates.add(x.dateStr));
      } else {
        perFileDates.forEach(x => selectedDates.add(x.dateStr));
      }
    }
    return;
  }

  if (mode === 'months') {
    const mon = parseInt(monthsInput.value,10) || 0;
    if (fixedStartCB.checked) {
      const end = new Date(FIXED_START);
      if (mon > 0) end.setMonth(end.getMonth()+mon);
      perFileDates.filter(x => x.date >= FIXED_START && x.date <= end).forEach(x => selectedDates.add(x.dateStr));
    } else {
      if (mon > 0) {
        const cut = new Date(); cut.setMonth(cut.getMonth()-mon);
        perFileDates.filter(x => x.date >= cut).forEach(x => selectedDates.add(x.dateStr));
      } else {
        perFileDates.forEach(x => selectedDates.add(x.dateStr));
      }
    }
    return;
  }

  // fallback: all
  perFileDates.forEach(x => selectedDates.add(x.dateStr));
}

// main fast discover and preprocess flow
async function fastDiscoverAndPreprocess() {
  loadingEl.style.display = 'block';

  // try cache first
  const cached = await loadCacheBlob();
  let cacheUsed = false;
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS && cached.data) {
    try {
      // revive into Map
      perFileAggMap = new Map(Object.entries(cached.data));
      // cached.data stores plain objects; ensure nested objects are fine
      cacheUsed = true;
    } catch (e) {
      perFileAggMap = new Map();
    }
  }

  if (!cacheUsed) {
    // build candidate list
    const candidates = buildCandidateUrls();
    // fetch in concurrent batches - tune concurrency for your server
    const concurrency = 30;
    const fetched = await batchFetch(candidates, concurrency);

    // parse each fetched file
    for (const { dateStr, text } of fetched) {
      try {
        const agg = parseTextToAggregate(dateStr, text);
        perFileAggMap.set(dateStr, agg);
      } catch (e) {
        // continue on parse errors
      }
    }

    // save cache (as plain object)
    const plainObj = {};
    for (const [k, v] of perFileAggMap.entries()) plainObj[k] = v;
    await saveCacheBlob({ fetchedAt: Date.now(), data: plainObj });
  }

  // build dateMap sorted
  dateMap = Array.from(perFileAggMap.keys())
    .map(d => ({ dateStr: d, date: new Date(d + 'T00:00') }))
    .sort((a,b)=>a.date - b.date);

  // compute selectedDates based on current controls
  computeSelectedDatesFromMode(dateMap);

  // combine for those dates and render
  combineAggregatesForDates(Array.from(selectedDates), perFileAggMap);
  loadingEl.style.display = 'none';
  renderTables();
}

// -------------------- event wiring --------------------
timeModeRadios.forEach(r=>
  r.addEventListener('input', ()=>{
    toggleTimeControls();
    if (perFileAggMap.size) {
      computeSelectedDatesFromMode(dateMap);
      combineAggregatesForDates(Array.from(selectedDates), perFileAggMap);
      renderTables();
    }
  }));

yearsInput.addEventListener('input',   ()=>{ if(perFileAggMap.size){ computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); }});
monthsInput.addEventListener('input',  ()=>{
  updateConversionLabels();
  if(perFileAggMap.size){ computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); }
});
drawsInput.addEventListener('input',   ()=>{ if(perFileAggMap.size){ computeSelectedDatesFromMode(dateMap); combineAggregatesForDates(Array.from(selectedDates), perFileAggMap); renderTables(); }});

topNInput.addEventListener('input',    ()=>{ if(perFileAggMap.size) renderTables(); });
leastCheckbox.addEventListener('input',()=>{ if(perFileAggMap.size) renderTables(); });
miniOnlyCheckbox.addEventListener('input', ()=>{ if(perFileAggMap.size) renderTables(); });

prizeCheckboxes.forEach(cb =>
  cb.addEventListener('input', ()=>{ if(perFileAggMap.size) renderTables(); }));

selectAll.addEventListener('input', ()=>{
  const c = selectAll.checked;
  prizeCheckboxes.forEach(cb => (cb.checked = c));
  if(perFileAggMap.size) renderTables();
});

fixedStartCB.addEventListener('input', ()=>{
  if (!perFileAggMap.size) return;
  computeSelectedDatesFromMode(dateMap);
  combineAggregatesForDates(Array.from(selectedDates), perFileAggMap);
  renderTables();
});

// -------------------- init --------------------
toggleTimeControls();
updateConversionLabels();
loadingEl.style.display = 'block';
fastDiscoverAndPreprocess().catch(err=>{
  console.error('Error in preprocess', err);
  loadingEl.style.display = 'none';
});
