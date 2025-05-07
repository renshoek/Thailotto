/* Thai Lotto Analyzer – automatic file loader version
   Looks for every YYYY‑MM‑DD.txt (1st & 16th draws) in lottonumbers/
   and re‑implements the full analysis UI without any upload step.
*/


const PRIZE_LIST  = ['FIRST','SECOND','THIRD','FOURTH','FIFTH',
                     'TWO','THREE_FIRST','THREE_LAST','NEAR_FIRST'];
const FILENAME_RE = /(\d{4}-\d{2}-\d{2})/;
const FIXED_START = new Date('2006-12-30T00:00');
const DRAW_DAYS   = [ 30, 31, 1, 2, 3, 14, 15, 16, 17];                       // Thai draws occur on these days

/* ────────────── DOM ELEMENTS ────────────── */
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

/* ─────────────── STATE ─────────────── */
let counts = {}, digitCounts = {}, lastFiles = [];
let dateMap = [];          // {file, date, dateStr}
let selectedDates = new Set();
let resultsByDate = {};    // raw prize strings per draw

/* ─────────────── HELPERS ─────────────── */
const pad2 = n => n.toString().padStart(2,'0');
const getSelectedPrizes = () =>
  Array.from(prizeCheckboxes).filter(cb => cb.checked).map(cb => cb.value);
const getTimeMode = () =>
  Array.from(timeModeRadios).find(r => r.checked).value;

function updateConversionLabels() {
  const mon = parseInt(monthsInput.value,10) || 0;
  const y = Math.floor(mon/12), m = mon % 12;
  monthsLabel.textContent =
    `(${y} year${y!==1?'s':''}${m?`, ${m} month${m!==1?'s':''}`:''})`;
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

function record(prize,val,date) {
  const bucket = counts[prize];
  bucket[val] = bucket[val] || {count:0, dates:[]};
  bucket[val].count++;
  bucket[val].dates.push(date);
  val.split('').forEach((d,i)=>{
    const dc = digitCounts[prize][i];
    dc[d] = (dc[d]||0) + 1;
  });
}

/* ─────────────── AUTO‑DISCOVER FILES ─────────────── */


async function discoverFiles() {








  const files = [];
  const today = new Date();
  for (let y = 2006; y <= today.getFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      for (const d of DRAW_DAYS) {
        if (y === 2006 && m === 12 && d < 30) continue;  // before first modern draw
        const dateStr = `${y}-${pad2(m)}-${pad2(d)}`;
        const url = `lottonumbers/${dateStr}.txt`;
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const txt = await resp.text();
            // minimal File‑like object for downstream code
            files.push({ name: `${dateStr}.txt`, text: () => Promise.resolve(txt) });
          }
        } catch { /* network / 404 errors are ignored */ }
      }
    }
  }

  return files;
}

/* ─────────────── FILE PROCESSING ─────────────── */
async function processFile(file) {
  const mode = getTimeMode();
  const yrs  = parseInt(yearsInput.value,10)  || 0;
  const mon  = parseInt(monthsInput.value,10) || 0;
  const match = file.name.match(FILENAME_RE);
  if (!match) return;

  const dateStr = match[1];
  const fileDate = new Date(dateStr + 'T00:00');

  /* draws‑mode filtering */
  if (mode === 'draws' && !selectedDates.has(dateStr)) return;

  /* other time‑window filtering */
  if (mode !== 'draws') {
    if (fixedStartCB.checked) {
      if (fileDate < FIXED_START) return;
      if (mode==='years' && yrs>0)  {
        const end = new Date(FIXED_START); end.setFullYear(end.getFullYear()+yrs);
        if (fileDate > end) return;
      }
      if (mode==='months' && mon>0) {
        const end = new Date(FIXED_START); end.setMonth(end.getMonth()+mon);
        if (fileDate > end) return;
      }
    } else {
      if (mode==='years' && yrs>0) {
        const cut = new Date(); cut.setFullYear(cut.getFullYear()-yrs);
        if (fileDate < cut) return;
      }
      if (mode==='months' && mon>0) {
        const cut = new Date(); cut.setMonth(cut.getMonth()-mon);
        if (fileDate < cut) return;
      }
    }
  }

  const text  = await file.text();
  const lines = text.split(/\r?\n/);
  resultsByDate[dateStr] = {};

  lines.slice(1).forEach(line=>{
    const parts = line.trim().split(/\s+/);
    const tag   = parts[0];
    const nums  = parts.slice(1);
    if (!counts[tag]) return;               // unknown tag

    const len = tag==='TWO' ? 2 : tag.startsWith('THREE') ? 3 : 6;
    nums.forEach(n => n && record(tag, n.slice(-len), dateStr));
    resultsByDate[dateStr][tag] =
      nums.map(n => n.slice(-len)).join(', ');
  });
}

async function handleFiles(files) {
  lastFiles = [...files];
  dateMap = lastFiles
    .map(f => {
      const m = f.name.match(FILENAME_RE);
      return m ? { file:f, date: new Date(m[1]+'T00:00'), dateStr: m[1] } : null;
    })
    .filter(Boolean)
    .sort((a,b)=>a.date - b.date);

  /* select draw dates (draws‑mode) */
  selectedDates.clear();
  if (getTimeMode() === 'draws') {
    const N = parseInt(drawsInput.value,10) || 1;
    const slice = fixedStartCB.checked
      ? dateMap.filter(x => x.date >= FIXED_START).slice(0,N)    // forward
      : dateMap.filter(x => x.date <= new Date()).slice(-N);     // recent
    slice.forEach(x => selectedDates.add(x.dateStr));
  }

  resetCounts();
  output.innerHTML = '';
  loadingEl.style.display = 'block';

  await Promise.all(lastFiles.map(processFile));

  loadingEl.style.display = 'none';
  renderTables();
}

/* ─────────────── RENDERING ─────────────── */
function renderTables() {
  output.innerHTML = '';

  const showLeast = leastCheckbox.checked;
  const miniOnly  = miniOnlyCheckbox.checked;
  const N         = parseInt(topNInput.value,10) || 5;
  const MAX       = 11;
  const mode      = getTimeMode();
  const selected  = getSelectedPrizes();
  if (!selected.length) return;

  selected.forEach(prize=>{
    const bucket = counts[prize] || {};
    const tot    = Object.values(bucket).reduce((s,b)=>s+b.count,0);

    let data = prize==='TWO'
      ? Array.from({length:100},
          (_,i)=>[pad2(i), bucket[pad2(i)] || {count:0,dates:[]}])
      : Object.entries(bucket);

    data.sort((a,b)=>
      showLeast ? a[1].count - b[1].count : b[1].count - a[1].count);

    const entries = data.slice(0,N).map(([val,info])=>({
      val,
      count: info.count,
      dates: info.dates.slice(0,MAX)
    }));

    /* full table ------------------------------------------------ */
    const header = document.createElement('div');
    header.className = 'prize-header';
    header.textContent = `${prize}: ${tot} drawings`;
    output.appendChild(header);

    const tbl = document.createElement('table');
    tbl.innerHTML =
      `<tr><th colspan="${2+MAX}">${prize}</th></tr>` +
      `<tr><th colspan="${2+MAX}">Drawings: ${tot}</th></tr>` +
      '<tr><th>Value</th><th>Count</th>' +
        Array.from({length:MAX},(_,i)=>`<th>Date ${i+1}</th>`).join('') +
      '</tr>';

    entries.forEach(e=>{
      const pct = tot ? ((e.count/tot)*100).toFixed(1) : '0.0';
      tbl.innerHTML +=
        `<tr><td>${e.val}</td>` +
        `<td style="text-align:center">${e.count} (${pct}%)</td>` +
        Array.from({length:MAX},(_,i)=>`<td>${e.dates[i]||''}</td>`).join('') +
        '</tr>';
    });

    if (miniOnly) {
      const cols = 2+MAX;
      Array.from(tbl.rows).forEach(r=>{
        for (let c=0; c<cols; c++)
          if (r.cells[c]) r.cells[c].style.display='none';
      });
    }
    output.appendChild(tbl);

    /* mini digit‑frequency table ------------------------------- */
    const pods = digitCounts[prize];
    const mini = document.createElement('table');
    mini.className = 'mini-table';

    const ranks = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
    mini.innerHTML =
      '<tr><th>Rank</th>' +
        pods.map((_,i)=>`<th>POD ${i+1}</th>`).join('') +
      '</tr>' +
      ranks.map((r,idx)=>{
        const cells = pods.map(dc=>{
          const arr = Object.entries(dc)
                            .sort((a,b)=> showLeast ? a[1]-b[1] : b[1]-a[1]);
          const [d='',c=0] = arr[idx] || [];
          const p = tot ? ((c/tot)*100).toFixed(1) : '0.0';
          return `<td>${d}${c?` (${c}/${p}%)`:''}</td>`;
        }).join('');
        return `<tr><td>${r}</td>${cells}</tr>`;
      }).join('');
    output.appendChild(mini);

    /* draws‑mode: recent details ------------------------------- */
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
        infoDiv.style.cssText =
          'font-size:0.8em;color:#555;margin-top:4px;';
        infoDiv.textContent = infoDates
          .map(d => `${d}: ${resultsByDate[d][prize] || ''}`)
          .join('  |  ');
        output.appendChild(infoDiv);
      }
    }
  });
}

/* ─────────────── EVENT WIRING ─────────────── */
timeModeRadios.forEach(r=>
  r.addEventListener('input', ()=>{
    toggleTimeControls();
    if (lastFiles.length) handleFiles(lastFiles);
  }));
yearsInput.addEventListener('input',   ()=>{ if(lastFiles.length) handleFiles(lastFiles); });
monthsInput.addEventListener('input',  ()=>{
  updateConversionLabels();
  if (lastFiles.length) handleFiles(lastFiles);
});
drawsInput.addEventListener('input',   ()=>{ if(lastFiles.length) handleFiles(lastFiles); });

topNInput.addEventListener('input',    ()=>{ if(lastFiles.length) renderTables(); });
leastCheckbox.addEventListener('input',()=>{ if(lastFiles.length) renderTables(); });
miniOnlyCheckbox.addEventListener('input', ()=>{ if(lastFiles.length) renderTables(); });

prizeCheckboxes.forEach(cb =>
  cb.addEventListener('input', ()=>{ if(lastFiles.length) renderTables(); }));
selectAll.addEventListener('input', ()=>{
  const c = selectAll.checked;
  prizeCheckboxes.forEach(cb => (cb.checked = c));
  if (lastFiles.length) renderTables();
});
fixedStartCB.addEventListener('input', ()=>{ if(lastFiles.length) handleFiles(lastFiles); });

/* ─────────────── INIT ─────────────── */
toggleTimeControls();
updateConversionLabels();
loadingEl.style.display = 'block';
discoverFiles().then(files => handleFiles(files));
