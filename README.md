# Thai Lotto Analyzer

A client-side web app for analyzing Thai Government Lottery draw data since December 2006. It fetches and caches historical results in IndexedDB, then lets you explore number frequency, probability models, and backtested predictions across all nine prize categories.

**[→ Live demo: renshoek.github.io/Thailotto/](https://renshoek.github.io/Thailotto/)**

---

## Pages

| Page | File | Description |
|---|---|---|
| Analyzer | `index.html` | Frequency tables and digit-rank breakdowns. Configurable time windows (by year, month, or draw count), direction (backward from now or forward from start), and optional custom anchor date. |
| Insights | `insights.html` | Deeper statistical views — gap analysis, streak tracking, and cross-prize patterns — all from the same cached dataset. |
| Predictions | `predictions.html` | Two-digit prize probability model. Combines recency, overdue-ness, and base rate signals (weights: 0.50 / 0.20 / 0.30). Includes a walk-forward backtest; top-15 hit rate 18.2% vs 15.0% baseline (Z=1.87, n=458 draws). |
| Scout | `scout.html` | Composite cross-signal ranking for two-digit numbers. Same model as Predictions, adds mirror-number pairing and a side-by-side backtest view. |
| Results | `results.html` | Browsable draw history, newest first. Full-text search highlights any number across all draws and prize categories. |
| CSV Export | `csv.html` | Exports raw draw data for any prize type to CSV (number, date), ready to paste into a spreadsheet or pipe into another tool. |

---

## Data

Draw data is sourced from the [`vicha-w/thai-lotto-archive`](https://github.com/vicha-w/thai-lotto-archive) repository. Each draw file is a plain `.txt` file named by date (`YYYY-MM-DD.txt`) under the `lottonumbers/` folder.

The Thai Government Lottery draws twice per month — on the **1st** and **16th**. Nine prize categories are tracked:

| Key | Prize | Numbers drawn |
|---|---|---|
| `FIRST` | First Prize | 1 six-digit number |
| `SECOND` | Second Prize | 5 six-digit numbers |
| `THIRD` | Third Prize | 10 six-digit numbers |
| `FOURTH` | Fourth Prize | 50 six-digit numbers |
| `FIFTH` | Fifth Prize | 100 six-digit numbers |
| `TWO` | Two Digit | 1 independently drawn two-digit number |
| `THREE_FIRST` | Three Front | 2 independently drawn three-digit numbers |
| `THREE_LAST` | Three Back | 2 independently drawn three-digit numbers |
| `NEAR_FIRST` | Near First | First prize number ±1 |

---

## Architecture

- **Pure client-side** — no server, no build step. Open `index.html` in a browser or serve the folder statically.
- **IndexedDB cache** — on first load, all draw files are fetched in parallel (concurrency 30). Results are parsed in a Web Worker and stored in IndexedDB with a 24-hour TTL. Subsequent page loads skip already-cached dates.
- **Shared cache** — all pages read from the same `perFileAggMap_v2` IndexedDB key. The Analyzer page must be opened first to populate it.

---

## Local setup

No dependencies to install for the front-end. Just serve the project root:

```bash
# Python
python -m http.server 8080

# Node
npx serve .
```

Then open `http://localhost:8080`.

### Updating draw data

A Node.js helper script downloads the latest `lottonumbers/` folder from the archive repo:

```bash
node updateLottoFolder.js
```

Requires Node 18+ and `adm-zip`:

```bash
npm install adm-zip
```

---

## Caveats

The probability model is descriptive, not prescriptive. The backtested lift over baseline (18.2% vs 15.0%) does not reach p<0.05, and the draw has been confirmed statistically fair by Chi² test (15.09 < 16.9 critical). Use the predictions and scout pages for pattern exploration, not as a betting system.
