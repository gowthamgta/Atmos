# AtmosIQ forecast pipeline

Fetches ECMWF IFS (about 9 km, O1280 grid) from Open-Meteo's public bucket, cuts out South India
(5.5-14.5°N, 73-89.5°E, the box in `config.py`), regrids to 0.1°, derives RH and feels-like, encodes every variable and forecast hour
as a 16-bit RG PNG, and writes a static site folder. GitHub Actions deploys that folder to **GitHub Pages**:
free, no card, no external bucket, and Pages serves `Access-Control-Allow-Origin: *`.

```
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Windows
python -m pytest -q tests
python run.py --steps 0,3 --out out --force      # quick local test, writes ./out
python run.py --out site --force                 # full run into ./site
```

## Why this data route
- ECMWF's own open data (`data.ecmwf.int`) is 0.25° only; there is no 0.1° product.
- Open-Meteo republishes the full O1280 IFS as `.om` files. Each hourly file is ~129 MB for the whole
  globe, and reading the band over the network is far too slow with `omfiles`, so the pipeline downloads
  each file, reads the band and deletes it. A run is 49 files (3-hourly to +144 h) ≈ 6.3 GB.
- Only the 00Z and 12Z runs are used, to keep the load on Open-Meteo's bucket modest.

## Output (served from `https://<user>.github.io/<repo>/`)
```
<model>/latest.json                         {"model","run","domain"}
<model>/<run>/manifest.json                 grid, steps, per-variable range/unit
<model>/<run>/<var>/<hhh>.png               value = min + (R*256+G)/65535*(max-min); B=255 means no data
```
`latest.json` also names the box (`domain`, the `DOMAIN` id in `config.py`). A run built for another box is not treated as live, so changing `DOMAIN` rebuilds every model on the next run.

Variables (see `config.py`):
- surface: `t2m`, `rh`, `feels`, `dew` (dew point), `u10`/`v10`, `gust`, `msl`, `precip`, `cloud`, `cloud_low`/`cloud_mid`/`cloud_high`,
  `vis` (visibility, km), `solar` (W/m2), `cape`, `tcwv`, `li` (lifted index, GFS only), `cin` (convective inhibition, magnitude;
  IFS, GFS and UKMO), `rain24` (mm over the next 24 h from each step, see below)
- pressure levels 925, 850, 700, 500, 300 and 200 hPa (about 0.8, 1.5, 3, 5.6, 9.2 and 12 km up), five fields each:
  `u<L>`, `v<L>`, `t<L>`, `rh<L>`, `gh<L>` (geopotential height). These are stored with 12 significant bits (error far below
  anything visible: 0.003 degC, 0.02 m/s), which makes them about 25% smaller.
A model only publishes what it can supply; the manifest lists exactly those variables and the app greys out the rest.
The box is 91 × 166 cells (about 40% of the earlier 181 × 221), so a run is about 40% of the earlier ~200 MB for all seven models.
Step 0 is the analysis hour, so gust, precip and CAPE are no-data there.
Each deploy replaces the previous one, so only the newest run exists. A client that still holds the old
`latest.json` gets a 404; it should re-fetch `latest.json` and retry.

## One-time GitHub setup
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → nwp → Run workflow**, tick *force* for the first run.
3. Check `https://<user>.github.io/<repo>/ecmwf_ifs/latest.json`.

The repo must stay public for free Pages. GitHub disables scheduled workflows after 60 days without
repository activity; re-enable under the Actions tab if that happens.

## Rain over the next 24 hours (`rain24`)
Built across steps in `derive.forward_accumulation`: the rain of each gap between two steps is rate x spacing when the model's
rain window covers the gap (exact), otherwise it is estimated from the mean of the rates at both ends (models that are only
sampled, e.g. one hour in three). No data where the run ends before 24 h more. Checked on a real GFS run against Open-Meteo's
hourly totals at 20 places: r = 0.96, totals within 6% (single hot spots can differ by tens of mm).

## All models in one (`blend`)
`blend.py` writes one more model: the weighted mean of every model's published fields, lined up by valid time (a time between
two steps is interpolated only when both exist; wind is averaged as u and v). Weights in `blend.WEIGHTS` (IFS 3, GFS 2, UKMO 2,
AIFS 1.5, ICON 1.5); a model that ends early drops out. Its run id is the assembly time, so a changed input
always gets new URLs.

A plain average is blurrier than every one of its members (measured on a real run: mean gradient of temperature 0.19 against
0.29 for IFS; rain 0.018 against 0.029), because it carries the resolution of its coarsest models. So the blend (a) uses
probability matching for rain and the 24 h total (the position comes from the mean, the intensities are the weighted mean of
the models' own sorted values, so peaks and wet area stay realistic), (b) sums the 24 h rain from the blended rain rate (not averaged
separately, which left the two disagreeing: a 24 h total of 1.3 mm against 0.1 mm of rain in the same day), (c) adds back the fine structure of the best-resolved model
(`blend.RESOLUTION_ORDER`: that model minus a ~28 km smoothed copy of itself, at gain 0.5), and (d) is clipped to the range of
the models at each cell. Result on the same run: 88-99% of IFS's sharpness, the same domain-mean rain, a rain peak of 5.8 mm/h
against 3.1 for the plain mean. `blend.VERSION` (now 5) is bumped when a method changes, which makes a run that is already live under the old method rebuild.
The workflow order is: models, `cyclones.py`, `fy4.py`, `mirror.py` (unchanged models and blend), `blend.py`.

## Rain units
`precip` is published as mm/h. The source value is mm in the preceding hour up to +90 h and mm in the preceding
3 h after that (checked against Open-Meteo's hourly API, which divides those by 3), so `derive()` divides by 3 after +90 h.

## Terrain (`build_terrain.py`)
The ground under the forecast comes from Copernicus DEM GLO-30 (30 m), averaged to 90 m, 270 m and 1.08 km.
`build_terrain.py` writes it into `public/data/terrain/`, which the app serves from Netlify (not Pages). The result is
committed and the workflow does not rebuild it, so run the script only when the box or the source changes:
```
python pipeline/build_terrain.py --cache C:/Temp/dem
```
Downloaded DEM tiles stay in `--cache` (`.dem-cache/` by default, git-ignored), so a second run does not download them
again. A tile the bucket does not have is open sea.

- `L0/`, `L1/`, `L2/`: one lossless WebP per 1° × 1° tile, named by its south-west corner (`N11E078` covers 11–12° N,
  78–79° E), 1200, 400 or 100 cells a side. Red and green hold the metres over 0–4000 m (16 bits); blue holds the land fraction.
- `smooth.png`: the ground smoothed over about 4 km, on a 0.05° grid.
- `model-<K>km.png`: the ground a K km model sees (a box mean), on the forecast grid, for K = 9, 10, 13 and 28.
- `index.json`: the box, the tiles that have ground, the grids and the value range.

The app picks the level by zoom: 90 m from zoom 9.5, 270 m from 7.5, 1.08 km below (`src/app/core/forecast/terrain-tiles.ts`).

## Models
Seven models plus the blend, all resampled onto the same 0.1° grid and published in the same format, so the app treats them alike.
Sources are Open-Meteo's public `data_spatial` datasets.

| id | model | grid / range | runs | rain value covers | not provided |
|---|---|---|---|---|---|
| `ecmwf_ifs` | ECMWF IFS (9 km; winds aloft from the 0.25° IFS dataset) | O1280, +144 h, 3-hourly | 00Z 12Z | 1 h to +90 h, then 3 h | - |
| `ecmwf_aifs` | ECMWF AIFS (AI) | 0.25°, +144 h, 6-hourly | 4 a day | 6 h | gusts, CAPE, moisture, visibility |
| `gfs` | NOAA GFS (0.117° surface + 0.25° pressure/gusts/CAPE) | +144 h, 3-hourly | 4 a day | 1 h to +120 h, then 3 h | - |
| `ukmo` | UK Met Office global 10 km | ~10 km, +60 h, 3-hourly | 00Z 12Z | 1 h to +54 h, then 3 h | sunshine, moisture |
| `dwd_icon` | DWD ICON global | regular grid, +144 h, 3-hourly | 00Z 12Z | 1 h to +78 h, then 3 h | sunshine, visibility, moisture |

How each was checked (one forecast time each): temperature, humidity, wind and pressure against live ECMWF; the rain
accumulation window against Open-Meteo's hourly API (a model's rain value covers the gap between its output times);
850/500 hPa winds against the API (all within about 0.15 m/s). Models without a variable simply do not publish it and
the app greys the matching layer out.

`python run.py --model <id> ...` (`--list-models` prints the ids; the workflow uses it). The workflow runs both every hour; each exits early when its
newest run is not ready, is not one it uses, or is already live. A Pages deploy replaces the whole site, so `mirror.py`
copies any model that was not rebuilt from the live site into the artifact (otherwise a GFS update would delete IFS).

## Adding another model
Most global models in Open-Meteo's bucket are regular-grid datasets: add a `RegularModel` entry to `models_regular.py`
(datasets, variable names, run hours, steps, unavailable variables). The grid and units are read from the files; wind
given as speed and direction is converted to u/v; the rain window comes from the model's own output spacing.
Then add one entry to `FORECAST_MODELS` in `src/app/core/forecast/forecast-models.ts` (the folder name must equal the
model id). The workflow picks the model up from `run.py --list-models`.
Models on other grids (such as ICON's native icosahedral grid) need their own `fetch_<name>.py` with the same interface
as `fetch_ifs.py`: `MODEL_ID`, `LABEL`, `RUN_HOURS`, `STEP_HOURS`, `PRECIP_NOTE`, `UNAVAILABLE_VARS`,
`precip_window_hours(step)`, `latest_run()`, `read_step(run, h)`, and register it in `MODELS` in `run.py`.
Check the rain window and the winds against Open-Meteo's API as was done for the models above.
