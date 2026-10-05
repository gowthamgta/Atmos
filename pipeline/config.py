"""Domain, variables and quantisation ranges for the AtmosIQ forecast pipeline."""
from __future__ import annotations
from dataclasses import dataclass

MODEL = "ecmwf_ifs"
BUCKET_URL = "https://openmeteo.s3.amazonaws.com"
LATEST_URL = f"{BUCKET_URL}/data_spatial/ecmwf_ifs/latest.json"

# South India + seas; regular lat/lon grid at 0.1 degrees (~11 km, close to IFS's native ~9 km)
LAT_MAX, LAT_MIN = 22.0, 4.0
LON_MIN, LON_MAX = 68.0, 90.0
STEP_DEG = 0.1
NY = round((LAT_MAX - LAT_MIN) / STEP_DEG) + 1      # 181 rows, north to south
NX = round((LON_MAX - LON_MIN) / STEP_DEG) + 1      # 221 columns, west to east

# Forecast hours to fetch: 3-hourly out to 144 h (the 1-hourly part is subsampled to keep downloads small)
STEP_HOURS = list(range(0, 145, 3))
RUN_HOURS = (0, 12)                                 # 00Z and 12Z runs only


@dataclass(frozen=True)
class Var:
    id: str
    unit: str
    lo: float          # value at encoded 0
    hi: float          # value at encoded 65535


VARS: dict[str, Var] = {v.id: v for v in [
    Var("t2m", "°C", -10, 50),
    Var("rh", "%", 0, 100),
    Var("feels", "°C", -10, 60),
    Var("u10", "m/s", -60, 60),
    Var("v10", "m/s", -60, 60),
    Var("gust", "m/s", 0, 80),
    Var("msl", "hPa", 950, 1050),
    Var("precip", "mm", 0, 100),
    Var("cloud", "%", 0, 100),
    Var("cape", "J/kg", 0, 6000),
    Var("tcwv", "kg/m²", 0, 80),
]}

# Variables read from the .om files
SOURCE_VARS = [
    "temperature_2m", "dew_point_2m", "wind_u_component_10m", "wind_v_component_10m",
    "wind_gusts_10m", "pressure_msl", "precipitation", "cloud_cover", "cape",
    "total_column_integrated_water_vapour",
]
