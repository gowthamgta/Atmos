# Kralveth Weather

Weather maps for South India and the surrounding seas (2-20 N, 70-99 E): IMD radar, Meteosat and Himawari satellite, and forecast models
(Angular 21 with MapLibre).

## Hosting: Cloudflare (Pages or Workers)

**Pages** (https://kralveth-weather.pages.dev, the address the Android app opens; dashboard: Workers & Pages, Create, Pages, Connect to Git, `gowthamgta/Atmos`, branch `main`):

- Framework preset: None. Build command: `npm run build`. Build output directory: `dist/weather-platform/browser`.
- Root directory: empty. Node 22 comes from `.node-version`. No compatibility flags or variables are needed.

`functions/` serves `/api/ildn`, `/api/imd-lightning`, `/api/radar` and `/imd-radar/*`; an unknown path gets the app; `public/_headers`
gives the headers. Pages skips `wrangler.toml` (it has no `pages_build_output_dir`). Locally: `npx ng build && npx wrangler pages dev
dist/weather-platform/browser` (with `wrangler.toml` set aside).

**Workers** (https://weather.kralveth.workers.dev): build command `npm run build`, deploy command `npx wrangler deploy`; `wrangler.toml`
names the Worker `weather` and runs `worker/index.js` first for the same routes. Locally: `npx ng build && npx wrangler dev`.

Both run the Netlify functions of `netlify/functions/` unchanged (web APIs only, through `netlify/cloudflare.js`), and Netlify still works
from `netlify.toml`. Every push to `main` deploys.

The Android app (`android-app/`, built by `.github/workflows/android.yml`) opens the site full-screen.

## What is in the repository

- `src/app/` — the Angular 21 app (signals, standalone components, MapLibre GL): forecast maps, IMD radar, satellite, meteogram and the place card.
- `pipeline/` — the Python forecast pipeline (fetch, derive, encode) and the terrain builder (`build_terrain.py`).
- `scripts/` — the radar pipeline, the boundary builder and the local preview server.
- `.github/workflows/` — the scheduled model, radar and test workflows.
- `functions/`, `worker/`, `netlify/` — the same small proxy functions on Cloudflare Pages, Cloudflare Workers and Netlify.
- `e2e/` — Playwright tests and the phone performance harness.
- `DESIGN-DECISIONS.md` — the looks and behaviours the owner has agreed; read it before changing anything visual.

The map covers 2-20 N, 70-99 E. Forecasts come from ECMWF IFS, DWD ICON, NOAA GFS, UK Met Office, ECMWF AIFS and the Kralveth Blend.

## Development

```bash
npm ci
npm start          # ng serve, http://localhost:4200
npm run build      # production build into dist/weather-platform/browser
```

## Tests

```bash
npx ng test --watch=false           # Vitest unit tests
npx ng build && npx playwright test # end-to-end, desktop and phone
python -m pytest -q pipeline/tests  # pipeline tests
```

The unit tests include the agreed-look fingerprints (`src/app/core/ui/agreed-look.spec.ts`): they fail on purpose when a look changes, so
update them only together with `DESIGN-DECISIONS.md`.

## Phone performance

```bash
npx ng build && node scripts/preview.js   # serves the build on http://localhost:8080
node e2e/perf.mjs                          # Pixel 7, CPU 4x slower, fast 4G, real GPU
```

Keep the worst main-thread task under about 300 ms. Heavy work belongs in a worker.

## Data and schedules

The model data is rebuilt by the GitHub Actions workflows in `.github/workflows/` and published to GitHub Pages. The satellite pictures
and temperatures are made by the separate `gowthamgta/atmos-satellite` repository. The app reads both from GitHub Pages; the proxy
functions exist only for IMD radar and lightning, which do not allow cross-origin requests. A service worker (production only) keeps the
app, forecast data, basemap tiles and point forecast usable offline.
