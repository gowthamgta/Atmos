# AtmosIQ forecast pipeline

Fetches ECMWF IFS (about 9 km, O1280 grid) from Open-Meteo's public bucket, cuts out South India
(4-22°N, 68-90°E), regrids to 0.1°, derives RH and feels-like, encodes every variable and forecast hour
as a 16-bit RG PNG and uploads it to Backblaze B2.

```
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Windows
python -m pytest -q tests
python run.py --steps 0,3 --out out --force      # quick local test, writes ./out
python run.py --publish                          # upload (needs B2_* env vars)
```

## Why this data route
- ECMWF's own open data (`data.ecmwf.int`) is 0.25° only; there is no 0.1° product.
- Open-Meteo republishes the full O1280 IFS as `.om` files. Each hourly file is ~129 MB for the whole
  globe, and reading the band over the network is far too slow with `omfiles`, so the pipeline downloads
  each file, reads the band and deletes it. A run is 49 files (3-hourly to +144 h) ≈ 6.3 GB.
- Only the 00Z and 12Z runs are used, to keep the load on Open-Meteo's bucket modest.

## Output layout (bucket root)
```
ecmwf_ifs/latest.json                       {"model","run"}   (cache 60 s)
ecmwf_ifs/<run>/manifest.json               grid, steps, per-variable range/unit
ecmwf_ifs/<run>/<var>/<hhh>.png             immutable; value = min + (R*256+G)/65535*(max-min); B=255 means no data
```
Variables: t2m, rh, feels, u10, v10, gust, msl, precip, cloud, cape, tcwv (see `config.py`).
Step 0 is the analysis hour, so gust, precip and CAPE are no-data there.

## Backblaze B2 setup
1. Bucket must be **Public**.
2. Add CORS rules (Bucket Settings → CORS Rules), allowing `GET` and `HEAD` from `*`, or from your
   Netlify site and `http://localhost:4200`.
3. Repo secrets (Settings → Secrets and variables → Actions): `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`,
   `B2_ENDPOINT` (for example `https://s3.us-west-004.backblazeb2.com`).
4. The app reads `https://<bucket>.<s3-endpoint-host>/ecmwf_ifs/latest.json`
   (or `https://f004.backblazeb2.com/file/<bucket>/...`).

GitHub disables scheduled workflows after 60 days without repository activity; re-enable under the
Actions tab if that happens.

## Known caveat
`precip` is the IFS precipitation at the valid hour. How it is defined for the 3-hourly steps after +90 h
(rate vs 3 h total) still has to be verified against Open-Meteo's API before it is shown as mm/3 h.
