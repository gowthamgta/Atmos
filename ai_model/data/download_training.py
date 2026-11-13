"""Automated ECMWF ERA5 Reanalysis Downloader for Kralveth AI 1km Model Training.

Uses Copernicus Climate Data Store (CDS API) to fetch historical hourly/6-hourly surface & upper-air
reanalysis fields over South India and its seas (2-20°N, 70-99°E).

Prerequisites:
  pip install cdsapi
  Setup ~/.cdsapirc with your free Copernicus API key:
    url: https://cds.climate.copernicus.eu/api
    key: <YOUR-UID>:<YOUR-API-KEY>

Usage:
  python ai_model/data/download_training.py --year 2024 --months 10 11 12 --output-dir ai_model/data/raw_era5
"""
from __future__ import annotations
import argparse, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config as C

SURFACE_VARIABLES = [
    "2m_temperature",
    "2m_dewpoint_temperature",
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
    "mean_sea_level_pressure",
    "surface_pressure",
    "total_precipitation",
    "convective_available_potential_energy",
]

HOURS_6H = ["00:00", "06:00", "12:00", "18:00"]


def download_era5_season(year: int, months: list[int], output_dir: str):
    try:
        import cdsapi
    except ImportError:
        print("Error: cdsapi not installed. Run: pip install cdsapi", file=sys.stderr)
        return

    os.makedirs(output_dir, exist_ok=True)
    c = cdsapi.Client()

    for m in months:
        month_str = f"{m:02d}"
        filename = f"era5_south_india_{year}_{month_str}.nc"
        target_path = os.path.join(output_dir, filename)

        if os.path.exists(target_path):
            print(f"File {target_path} already exists. Skipping.")
            continue

        print(f"Requesting ERA5 reanalysis for {year}-{month_str} over [{C.LAT_MAX}, {C.LON_MIN}, {C.LAT_MIN}, {C.LON_MAX}]...")
        request_params = {
            "product_type": "reanalysis",
            "format": "netcdf",
            "variable": SURFACE_VARIABLES,
            "year": str(year),
            "month": month_str,
            "day": [f"{d:02d}" for d in range(1, 32)],
            "time": HOURS_6H,
            "area": [C.LAT_MAX, C.LON_MIN, C.LAT_MIN, C.LON_MAX],  # North, West, South, East
        }

        c.retrieve("reanalysis-era5-single-levels", request_params, target_path)
        print(f"Downloaded: {target_path}")


def main():
    parser = argparse.ArgumentParser(description="Download ERA5 training data for Kralveth AI 1km")
    parser.add_argument("--year", type=int, default=2024, help="Year to download")
    parser.add_argument("--months", type=int, nargs="+", default=[10, 11, 12], help="Months (e.g. 10 11 12 for Northeast Monsoon)")
    parser.add_argument("--output-dir", default=os.path.join(C.DATA_DIR, "raw_era5"), help="Output directory")
    args = parser.parse_args()

    download_era5_season(args.year, args.months, args.output_dir)


if __name__ == "__main__":
    main()
