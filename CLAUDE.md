# Operating rules for this repository

The WMA screener (`dashboard/`, `scripts/`, `.github/workflows/fetch-daily.yml`) collects TradingView daily bars every
day and deploys a GitHub Pages site. The owner set these rules; keep to them.

- **TradingView without a login.** Fetch anonymously. Do not add TradingView login cookies (`TV_SESSIONID`,
  `TV_SESSIONID_SIGN`) to any workflow; the owner deleted those secrets on 2026-10-05. Anonymous daily bars were
  checked to be the same as logged-in ones, and a login ties the automated requests to the owner's account.
- **No workarounds for GitHub's 60-day schedule rule.** Never add dummy or keepalive commits, and never call the
  "enable workflow" API automatically. GitHub took down keepalive-workflow for circumventing that policy. The daily
  data commit is the only activity the repo relies on; if the schedule is ever disabled, the owner re-enables it by
  hand in the Actions tab (or with a commit that changes the cron line).
- **Record every fixed coin match.** When a TradingView ticker (`manual` entry in `data/tickers.json`) or a CoinGecko
  match (`ids` pin in `data/exclusions.json`) is corrected, add an entry to `data/mapping-log.json` and update its
  `checkedAt`. The page shows this record at the top.
- **Credit CoinGecko.** The site uses CoinGecko data (coin list, ranks, some market caps), so keep the linked
  "Data provided by CoinGecko" credit on the page.
- **Custom timeframes need a login.** Anonymous requests get only standard resolutions (1D, 1W, 1M, 3M, 6M, 12M);
  2D, 3W, 2M and the like fail with `custom_resolution`. The screener needs 1D only. `data/tv-history.json` (native
  bars in all 20 timeframes for six reference tickers) stays at its last logged-in fetch of 2026-10-05, and the
  manual-only `fetch-tv-data.yml` workflow fails without a login.
- **Keep `data/daily` under 3,000 files.** `scripts/build-site.mjs` warns from 2,700; split the folder before 3,000.
- **Stale data must be loud.** `scripts/check-fresh.mjs` fails the daily run when the data stops moving, and the page
  warns when the last fetch is over 36 hours old. Do not weaken these to make a run pass.
