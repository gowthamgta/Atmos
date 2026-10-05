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
Variables: t2m, rh, feels, u10, v10, gust, msl, precip, cloud, cape, tcwv (see `config.py`).
Step 0 is the analysis hour, so gust, precip and CAPE are no-data there.
Each deploy replaces the previous one, so only the newest run exists. A client that still holds the old
`latest.json` gets a 404; it should re-fetch `latest.json` and retry.

## One-time GitHub setup
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → nwp → Run workflow**, tick *force* for the first run.
3. Check `https://<user>.github.io/<repo>/ecmwf_ifs/latest.json`.

The repo must stay public for free Pages. GitHub disables scheduled workflows after 60 days without
repository activity; re-enable under the Actions tab if that happens.

## Rain units
`precip` is published as mm/h. The source value is mm in the preceding hour up to +90 h and mm in the preceding
3 h after that (checked against Open-Meteo's hourly API, which divides those by 3), so `derive()` divides by 3 after +90 h.

## Models
| id | source | native grid | runs used | steps | rain after |
|---|---|---|---|---|---|
| `ecmwf_ifs` | Open-Meteo `ecmwf_ifs` | O1280, ~9 km | 00Z, 12Z | 3-hourly to +144 h | +90 h is a 3 h total |
| `gfs` | Open-Meteo `ncep_gfs013` (0.117°: temperature, humidity, wind, rain, cloud, moisture) + `ncep_gfs025` (0.25°: pressure, gusts, CAPE) | regular lat/lon | 00Z, 06Z, 12Z, 18Z | 3-hourly to +144 h | +120 h is a 3 h total |

Both are resampled onto the same 0.1° grid and published in the same format, so the app treats them alike. GFS has no
dew point, so its own relative humidity is used. Observed differences from IFS on a shared valid time: temperature
within about 0.8 °C (correlation 0.95), CAPE about half of IFS's (a known model difference).

`python run.py --model gfs ...` / `--model ecmwf_ifs ...`. The workflow runs both every hour; each exits early when its
newest run is not ready, is not one it uses, or is already live. A Pages deploy replaces the whole site, so `mirror.py`
copies any model that was not rebuilt from the live site into the artifact (otherwise a GFS update would delete IFS).

## Adding another model (AIFS, ICON, UKMO...)
1. Write `fetch_<name>.py` with the same interface as `fetch_ifs.py` / `fetch_gfs.py`: `MODEL_ID`, `LABEL`, `RUN_HOURS`,
   `STEP_HOURS`, `PRECIP_3H_AFTER_H` (None if rain is always hourly), `PRECIP_NOTE`, `latest_run()` and
   `read_step(run, h)` returning the source variables on the 0.1° grid (`temperature_2m`, `dew_point_2m` or
   `relative_humidity_2m`, `wind_u/v_component_10m`, `wind_gusts_10m`, `pressure_msl` in Pa, `precipitation`,
   `cloud_cover`, `cape`, `total_column_integrated_water_vapour`). Check the rain semantics against Open-Meteo's hourly
   API as was done for IFS and GFS.
2. Register the module in `MODELS` in `run.py`, and add the id to the model list in `.github/workflows/nwp.yml`
   (both the build loop and the `mirror.py --models` call).
3. Add one entry to `FORECAST_MODELS` in `src/app/core/forecast/forecast-models.ts` (the folder name must equal
   `MODEL_ID`). The model selector in the layer rail lists it automatically.
