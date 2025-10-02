// CSV Export Script
const PRIZE_LIST = ['FIRST','SECOND','THIRD','FOURTH','FIFTH','TWO','THREE_FIRST','THREE_LAST','NEAR_FIRST'];
const FIXED_START = new Date('2006-12-30T00:00');
const DRAW_DAYS = [30,31,1,2,3,14,15,16,17];

// DOM Elements
const prizeSelect = document.getElementById('prizeSelect');
const showCsvBtn = document.getElementById('showCsvBtn');
const csvOutput = document.getElementById('csvOutput');
const csvContent = document.getElementById('csvContent');
const copyBtn = document.getElementById('copyBtn');
const themeToggle = document.getElementById('themeToggle');

// State
let perFileAggMap = new Map();

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

// Enable show CSV button when prize is selected
prizeSelect.addEventListener('change', () => {
  showCsvBtn.disabled = !prizeSelect.value;
});

// IndexedDB cache
const DB_NAME = 'thai-lotto-agg-db';
const STORE_NAME = 'agg-store';
const CACHE_KEY = 'perFileAggMap_v2';

async function loadCacheBlob() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = (ev) => {
      const db = ev.target.result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(CACHE_KEY);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

function buildCandidateUrls() {
  const urls = [];
  const start = new Date(FIXED_START);
  const end = new Date();
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDate();
    if (DRAW_DAYS.includes(day)) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2,'0');
      const dd = String(day).padStart(2,'0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      urls.push({ dateStr, url: `lottonumbers/${dateStr}.txt` });
    }
  }
  return urls;
}

// Generate CSV
showCsvBtn.addEventListener('click', async () => {
  const prize = prizeSelect.value;
  if (!prize) return;

  showCsvBtn.disabled = true;
  showCsvBtn.textContent = 'Loading...';
  csvOutput.style.display = 'none';

  // Load cache
  const cached = await loadCacheBlob();
  if (cached && cached.data) {
    try {
      perFileAggMap = new Map(Object.entries(cached.data));
    } catch (e) {
      perFileAggMap = new Map();
    }
  }

  // If cache is empty, we need to fetch data
  if (perFileAggMap.size === 0) {
    alert('No cached data available. Please visit the main page first to load the data.');
    showCsvBtn.disabled = false;
    showCsvBtn.textContent = 'Show CSV';
    return;
  }

  // Generate CSV content
  const lines = [];
  const dateMap = Array.from(perFileAggMap.keys())
    .map(d => ({ dateStr: d, date: new Date(d + 'T00:00') }))
    .sort((a, b) => a.date - b.date);

  for (const { dateStr } of dateMap) {
    const agg = perFileAggMap.get(dateStr);
    if (agg && agg.results && agg.results[prize]) {
      const numbersStr = agg.results[prize];
      const numbers = numbersStr.split(',').map(n => n.trim()).filter(n => n);
      for (const num of numbers) {
        lines.push(`${num},${dateStr}`);
      }
    }
  }

  if (lines.length === 0) {
    csvContent.textContent = 'No data available for this prize type.';
  } else {
    csvContent.textContent = lines.join('\n');
  }

  csvOutput.style.display = 'block';
  showCsvBtn.disabled = false;
  showCsvBtn.textContent = 'Show CSV';
});

// Copy to clipboard
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(csvContent.textContent);
    const originalText = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = originalText;
    }, 2000);
  } catch (err) {
    alert('Failed to copy to clipboard');
  }
});
