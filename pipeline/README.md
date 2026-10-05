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
ecmwf_ifs/latest.json                       {"model","run"}
ecmwf_ifs/<run>/manifest.json               grid, steps, per-variable range/unit
ecmwf_ifs/<run>/<var>/<hhh>.png             value = min + (R*256+G)/65535*(max-min); B=255 means no data
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

## Known caveat
`precip` is the IFS precipitation at the valid hour. How it is defined for the 3-hourly steps after +90 h
(rate vs 3 h total) still has to be verified against Open-Meteo's API before it is shown as mm/3 h.
