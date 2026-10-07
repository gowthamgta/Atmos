# AtmosIQ forecast pipeline

Fetches ECMWF IFS (about 9 km, O1280 grid) from Open-Meteo's public bucket, cuts out South India
(4-22°N, 68-90°E), regrids to 0.1°, derives RH and feels-like, encodes every variable and forecast hour
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
<model>/latest.json                         {"model","run"}
<model>/<run>/manifest.json                 grid, steps, per-variable range/unit
<model>/<run>/<var>/<hhh>.png               value = min + (R*256+G)/65535*(max-min); B=255 means no data
```
Variables (see `config.py`):
- surface: `t2m`, `rh`, `feels`, `dew` (dew point), `u10`/`v10`, `gust`, `msl`, `precip`, `cloud`, `cloud_low`/`cloud_mid`/`cloud_high`,
  `vis` (visibility, km), `solar` (W/m2), `cape`, `tcwv`, `li` (lifted index, GFS and GRAPES only), `cin` (convective inhibition, magnitude;
  IFS, GFS, UKMO and GRAPES), `rain24` (mm over the next 24 h from each step, see below)
- pressure levels 925, 850, 700, 500, 300 and 200 hPa (about 0.8, 1.5, 3, 5.6, 9.2 and 12 km up), five fields each:
  `u<L>`, `v<L>`, `t<L>`, `rh<L>`, `gh<L>` (geopotential height). These are stored with 12 significant bits (error far below
  anything visible: 0.003 degC, 0.02 m/s), which makes them about 25% smaller.
A model only publishes what it can supply; the manifest lists exactly those variables and the app greys out the rest.
A full run is about 1 MB per forecast step per model, around 200 MB for all seven models.
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

## Chance of rain (`px0`) and extreme-rain probability (`xr`)
`ens.py` reads ECMWF's own ensemble (50 members, open data, CC BY 4.0) and publishes the share of members whose rain over the
next 24 h reaches 0.1 mm (measurable rain), for starts every 6 h to +72 h: PoP = wet members / all members. `attach.py` copies it
onto every model's own timeline (linear in time between starts), so the layer works with any model. Open-Meteo's ensemble
datasets only have an "any rain" probability, which is why ECMWF's files are used. ECMWF's global grids start at 180 E (not 0),
which `ens.read_members` handles; a test builds a GRIB in that layout. The chance is on the ensemble's own 0.25 degree grid
(about 25 km), resampled to 0.1 degree.

`xr` is made by `attach.py` per model, from `extreme.py`: the model's own `rain24`, the all-model blend's `rain24` at the same
time (the blend is built first) and `px0`. The amount sets the probability along a curve (25 mm 25 %, 50 mm 70 %, 75 mm 82 %, 100 mm
90 %, 150 mm and over 95 %, never higher); it is lowered when the model and the blend disagree (by up to 35 % when one has next to
nothing) and falls to nothing when the chance of rain is under 20 % (full weight from 70 %). A model with no blend stands alone.
The amounts are IMD's: heavy rain starts at 64.5 mm a day, very heavy at 115.6 mm.

## All models in one (`blend`)
`blend.py` writes one more model: the weighted mean of every model's published fields, lined up by valid time (a time between
two steps is interpolated only when both exist; wind is averaged as u and v). Weights in `blend.WEIGHTS` (IFS 3, GFS 2, UKMO 2,
AIFS 1.5, ICON 1.5, GDPS 1, GRAPES 1); a model that ends early drops out. Its run id is the assembly time, so a changed input
always gets new URLs.

A plain average is blurrier than every one of its members (measured on a real run: mean gradient of temperature 0.19 against
0.29 for IFS; rain 0.018 against 0.029), because it carries the resolution of its coarsest models. So the blend (a) uses
probability matching for rain and the 24 h total (the position comes from the mean, the intensities are the weighted mean of
the models' own sorted values, so peaks and wet area stay realistic), (b) adds back the fine structure of the best-resolved model
(`blend.RESOLUTION_ORDER`: that model minus a ~28 km smoothed copy of itself, at gain 0.5), and (c) is clipped to the range of
the models at each cell. Result on the same run: 88-99% of IFS's sharpness, the same domain-mean rain, a rain peak of 5.8 mm/h
against 3.1 for the plain mean. `blend.VERSION` and `ens.VERSION` are bumped when a method changes, which makes a run that is
already live under the old method rebuild. The workflow order is: models, `ens.py`, `mirror.py` (unchanged models, ens, blend), `blend.py`, `attach.py`.

## Rain units
`precip` is published as mm/h. The source value is mm in the preceding hour up to +90 h and mm in the preceding
3 h after that (checked against Open-Meteo's hourly API, which divides those by 3), so `derive()` divides by 3 after +90 h.

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
| `gdps` | Environment Canada GDPS (surface + upper-level datasets) | ~15 km, +144 h, 3-hourly | 00Z 12Z | 1 h, then 3 h | low/mid/high cloud, CAPE, visibility, moisture |
| `cma_grapes` | CMA GRAPES global | ~15 km, +120 h, 6-hourly sampled | 00Z 12Z | 3 h | moisture |

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
