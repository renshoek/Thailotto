// Thai Lotto Analyzer – Draw Results Page
// Reads from the same IndexedDB cache as script.js

const PRIZE_LIST = ['FIRST','SECOND','THIRD','FOURTH','FIFTH','TWO','THREE_FIRST','THREE_LAST','NEAR_FIRST'];
const PRIZE_LABELS = {
  FIRST: 'First',
  SECOND: 'Second',
  THIRD: 'Third',
  FOURTH: 'Fourth',
  FIFTH: 'Fifth',
  TWO: 'Two Digit',
  THREE_FIRST: 'Three (Front)',
  THREE_LAST: 'Three (Back)',
  NEAR_FIRST: 'Near First',
};

const DB_NAME = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY = 'perFileAggMap_v2';

// DOM
const drawList     = document.getElementById('drawList');
const searchInput  = document.getElementById('searchInput');
const limitSelect  = document.getElementById('limitSelect');
const prizeFilter  = document.getElementById('prizeFilterSelect');
const expandAllBtn = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const matchInfo    = document.getElementById('matchInfo');
const matchDrawCount = document.getElementById('matchDrawCount');
const matchNumCount  = document.getElementById('matchNumCount');
const themeToggle  = document.getElementById('themeToggle');

// State
let allDraws = []; // [{ dateStr, results: { PRIZE: 'num1, num2, ...' } }], newest first

// ── Theme ────────────────────────────────────────────────────────────────────
themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
});
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark');
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────
async function loadCache() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (ev) => {
      const db = ev.target.result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const get = store.get(CACHE_KEY);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  setStatus('loading', 'Loading data from cache…');

  const cached = await loadCache();

  if (!cached || !cached.data || Object.keys(cached.data).length === 0) {
    setStatus('empty', 'No cached data. Visit the main Analyzer page first to load lottery data.');
    renderEmpty();
    return;
  }

  const map = new Map(Object.entries(cached.data));
  const age = cached.fetchedAt ? Math.round((Date.now() - cached.fetchedAt) / 60000) : null;
  const ageStr = age !== null ? ` · cached ${age < 60 ? age + ' min' : Math.round(age/60) + 'h'} ago` : '';

  // Build sorted draws array (newest first)
  allDraws = Array.from(map.entries())
    .map(([dateStr, agg]) => ({ dateStr, results: agg.results || {} }))
    .filter(d => Object.keys(d.results).length > 0)
    .sort((a, b) => b.dateStr.localeCompare(a.dateStr));

  setStatus('live', `${allDraws.length} draws loaded${ageStr}`);
  render();
}

function setStatus(state, text) {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (state === 'live' ? ' live' : '');
}

function renderEmpty() {
  drawList.innerHTML = `
    <div class="empty-state">
      <h2>No data available</h2>
      <p>
        The results page reads from the same cache as the Analyzer.<br>
        Please open <a href="index.html" style="color:var(--primary)">index.html</a>
        first to let it fetch and cache the lottery data, then come back here.
      </p>
    </div>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function getVisibleDraws() {
  const limit = parseInt(limitSelect.value, 10);
  return limit > 0 ? allDraws.slice(0, limit) : allDraws;
}

function getSearchTerm() {
  return searchInput.value.trim();
}

function getActivePrizes() {
  const f = prizeFilter.value;
  return f ? [f] : PRIZE_LIST;
}

function numberMatchesSearch(num, term) {
  if (!term) return false;
  // Match if the number contains the search term (supports partial, e.g. last 2 digits)
  return num.includes(term) || num.endsWith(term);
}

function render() {
  const draws = getVisibleDraws();
  const term  = getSearchTerm();
  const prizes = getActivePrizes();

  let totalMatchDraws = 0;
  let totalMatchPositions = 0;

  const fragment = document.createDocumentFragment();

  draws.forEach((draw, idx) => {
    const card = buildCard(draw, term, prizes);

    // Track match stats
    if (term) {
      let drawHasMatch = false;
      prizes.forEach(prize => {
        const nums = parseNums(draw.results[prize] || '');
        nums.forEach(n => {
          if (numberMatchesSearch(n, term)) {
            drawHasMatch = true;
            totalMatchPositions++;
          }
        });
      });
      if (drawHasMatch) totalMatchDraws++;
    }

    fragment.appendChild(card);
  });

  drawList.innerHTML = '';
  drawList.appendChild(fragment);

  // Match info
  if (term) {
    matchInfo.style.display = '';
    matchDrawCount.textContent = totalMatchDraws;
    matchNumCount.textContent = totalMatchPositions;
  } else {
    matchInfo.style.display = 'none';
  }
}

function parseNums(str) {
  if (!str) return [];
  return str.split(',').map(n => n.trim()).filter(Boolean);
}

function buildCard(draw, term, activePrizes) {
  const { dateStr, results } = draw;

  // Check if any match exists in this card
  let hasMatch = false;
  if (term) {
    activePrizes.forEach(p => {
      parseNums(results[p] || '').forEach(n => {
        if (numberMatchesSearch(n, term)) hasMatch = true;
      });
    });
  }

  const card = document.createElement('div');
  card.className = 'draw-card' + (hasMatch ? ' has-match' : '');

  // Header
  const header = document.createElement('div');
  header.className = 'draw-card-header';

  const datePart = document.createElement('div');
  datePart.style.display = 'flex';
  datePart.style.alignItems = 'center';
  datePart.style.gap = '0.75rem';

  const dateEl = document.createElement('span');
  dateEl.className = 'draw-date';
  dateEl.textContent = dateStr;

  const firstNum = parseNums(results['FIRST'] || '')[0] || '—';
  const firstBadge = document.createElement('span');
  firstBadge.className = 'draw-first-badge';
  firstBadge.textContent = firstNum;

  datePart.appendChild(dateEl);
  datePart.appendChild(firstBadge);

  if (hasMatch) {
    const mc = document.createElement('span');
    mc.className = 'match-count';
    mc.textContent = '✓ match';
    datePart.appendChild(mc);
  }

  const rightPart = document.createElement('div');
  rightPart.className = 'draw-meta';

  // Quick summary of key prizes in collapsed view
  const twoNum = parseNums(results['TWO'] || '')[0] || '—';
  const summary = document.createElement('span');
  summary.textContent = `2-digit: ${twoNum}`;
  rightPart.appendChild(summary);

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = '▼';
  rightPart.appendChild(chevron);

  header.appendChild(datePart);
  header.appendChild(rightPart);

  // Body
  const body = document.createElement('div');
  body.className = 'draw-card-body';

  const rows = document.createElement('div');
  rows.className = 'prize-rows';

  activePrizes.forEach(prize => {
    const nums = parseNums(results[prize] || '');
    if (nums.length === 0) return;

    const row = document.createElement('div');
    row.className = 'prize-row';

    const label = document.createElement('span');
    label.className = 'prize-label';
    label.textContent = PRIZE_LABELS[prize] || prize;
    row.appendChild(label);

    const numWrap = document.createElement('div');
    numWrap.className = 'prize-numbers';

    nums.forEach(n => {
      const badge = document.createElement('span');
      const isMatch = term && numberMatchesSearch(n, term);
      badge.className = 'num-badge' +
        (prize === 'FIRST' ? ' first-prize' : '') +
        (isMatch ? ' match' : '');
      badge.textContent = n;
      numWrap.appendChild(badge);
    });

    row.appendChild(numWrap);
    rows.appendChild(row);
  });

  body.appendChild(rows);

  // Toggle expand
  header.addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  card.appendChild(header);
  card.appendChild(body);

  // Auto-expand if there's a match or it's the first card
  if (hasMatch) card.classList.add('expanded');

  return card;
}

// ── Controls ─────────────────────────────────────────────────────────────────
let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(render, 200);
});

limitSelect.addEventListener('change', render);
prizeFilter.addEventListener('change', render);

expandAllBtn.addEventListener('click', () => {
  drawList.querySelectorAll('.draw-card').forEach(c => c.classList.add('expanded'));
});

collapseAllBtn.addEventListener('click', () => {
  drawList.querySelectorAll('.draw-card').forEach(c => c.classList.remove('expanded'));
});

// ── Init ─────────────────────────────────────────────────────────────────────
init().catch(err => {
  console.error('results.js init error:', err);
  setStatus('empty', 'Failed to load data.');
  renderEmpty();
});