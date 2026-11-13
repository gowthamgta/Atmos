"""WeatherUnion (by Zomato) Hyperlocal Weather Observation Ingestion & Neural Correction Engine.

Provides real-time ground truth from 265+ automated weather stations (AWS & ARG) across South India
(Chennai, Coimbatore, Bengaluru, Hyderabad, Kochi, Trivandrum, Mumbai, Pune, etc.).

Metrics Captured:
- Temperature (°C)
- Relative Humidity (%)
- Wind Speed (m/s) & Direction (degrees)
- Rain Accumulation (mm) & Rain Intensity (mm/h)

Usage:
  python obs_weatherunion.py --fetch                # Fetch hourly observation batch
  python obs_weatherunion.py --all                  # Fetch all 265 stations
  python obs_weatherunion.py --status               # Check cache status & station count
"""
from __future__ import annotations
import argparse, json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import urllib.request
import urllib.error

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
STATIONS_FILE = os.path.join(BASE_DIR, "data", "verification", "weatherunion_stations.json")
CACHE_FILE = os.path.join(BASE_DIR, "data", "verification", "weatherunion_cache.json")
CORRECTIONS_FILE = os.path.join(PROJECT_ROOT, "public", "data", "verification", "weatherunion_corrections.json")

# API Configuration
API_KEY = "1ca0b4821aefd17585362e776d69af37"
BASE_URL = "https://www.weatherunion.com/gw/weather/external/v0"
TIMEOUT_S = 6.0
MAX_HOURLY_REQUESTS = 40  # 40 * 24 = 960 requests/day, stays safely within 1000/day quota


def load_stations() -> list[dict]:
    """Loads station catalog covering South India domain."""
    if os.path.exists(STATIONS_FILE):
        try:
            with open(STATIONS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []


def load_cached_observations() -> dict:
    """Loads last recorded observation cache."""
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"last_updated": None, "stations": {}}


def save_cached_observations(cache: dict) -> None:
    """Saves updated observation cache."""
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2)


def fetch_station(loc_id: str, name: str, lat: float, lon: float, dev_type: int) -> dict | None:
    """Queries live weather data for a single WeatherUnion locality."""
    url = f"{BASE_URL}/get_locality_weather_data?locality_id={loc_id}"
    req = urllib.request.Request(
        url,
        headers={
            "x-zomato-api-key": API_KEY,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KralvethAI/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if str(data.get("status")) == "200":
                w = data.get("locality_weather_data", {})
                return {
                    "loc_id": loc_id,
                    "name": name,
                    "lat": lat,
                    "lon": lon,
                    "dev_type": dev_type,
                    "temperature": w.get("temperature"),
                    "humidity": w.get("humidity"),
                    "wind_speed": w.get("wind_speed"),
                    "wind_direction": w.get("wind_direction"),
                    "rain_intensity": w.get("rain_intensity"),
                    "rain_accumulation": w.get("rain_accumulation"),
                    "aqi_pm_10": w.get("aqi_pm_10"),
                    "aqi_pm_2_point_5": w.get("aqi_pm_2_point_5"),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
    except Exception as e:
        # Fail-soft: individual network timeout or error does not halt the run
        return None
    return None


def fetch_hourly_batch(limit: int | None = MAX_HOURLY_REQUESTS, force_all: bool = False) -> dict:
    """Fetches real-time observations for stations, updating the local cache."""
    all_stations = load_stations()
    if not all_stations:
        print("obs_weatherunion: No station definitions found.", flush=True)
        return load_cached_observations()

    # Prioritize Tamil Nadu, Bengaluru, and major South Indian AWS stations
    priority_cities = ["Chennai", "Coimbatore", "Bengaluru", "Kochi", "Trivandrum", "Madurai", "Hyderabad", "Vijayawada"]
    aws_stations = [s for s in all_stations if s.get("dev_type") == 1]
    arg_stations = [s for s in all_stations if s.get("dev_type") == 2]

    # Sort so priority cities are at the top
    def sort_key(s):
        name = s.get("name", "")
        for idx, city in enumerate(priority_cities):
            if city.lower() in name.lower():
                return (0, idx)
        return (1, 0)

    sorted_aws = sorted(aws_stations, key=sort_key)
    sorted_arg = sorted(arg_stations, key=sort_key)

    if force_all or limit is None:
        target_stations = sorted_aws + sorted_arg
    else:
        # Blend AWS (temp/wind/rh/rain) and ARG (hyperlocal rain)
        n_aws = min(len(sorted_aws), int(limit * 0.75))
        n_arg = min(len(sorted_arg), limit - n_aws)
        target_stations = sorted_aws[:n_aws] + sorted_arg[:n_arg]

    print(f"obs_weatherunion: Fetching {len(target_stations)} stations (quota budget: {limit})...", flush=True)
    t0 = time.time()

    cache = load_cached_observations()
    station_dict = cache.get("stations", {})
    success_count = 0

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(
                fetch_station,
                s["loc_id"],
                s["name"],
                s["lat"],
                s["lon"],
                s.get("dev_type", 1),
            ): s["loc_id"]
            for s in target_stations
        }
        for future in as_completed(futures):
            res = future.result()
            if res:
                station_dict[res["loc_id"]] = res
                success_count += 1

    t1 = time.time()
    now_iso = datetime.now(timezone.utc).isoformat()
    cache["last_updated"] = now_iso
    cache["stations"] = station_dict
    save_cached_observations(cache)

    print(
        f"obs_weatherunion: Successfully fetched {success_count}/{len(target_stations)} stations in {t1-t0:.2f}s (Cache now holds {len(station_dict)} stations).",
        flush=True,
    )
    return cache


def get_active_observations() -> list[dict]:
    """Returns all valid ground observations from cache for data assimilation."""
    cache = load_cached_observations()
    stations = cache.get("stations", {})
    return list(stations.values())


def main():
    parser = argparse.ArgumentParser(description="WeatherUnion Station Observations Ingestion")
    parser.add_argument("--fetch", action="store_true", help="Fetch hourly batch of stations")
    parser.add_argument("--all", action="store_true", help="Fetch all 265 stations (consumes quota)")
    parser.add_argument("--limit", type=int, default=MAX_HOURLY_REQUESTS, help="Maximum requests to make")
    parser.add_argument("--status", action="store_true", help="Print observation cache status")
    args = parser.parse_args()

    if args.status:
        cache = load_cached_observations()
        stations = cache.get("stations", {})
        print(f"WeatherUnion Cache Status:")
        print(f"  Last Updated: {cache.get('last_updated')}")
        print(f"  Total Cached Stations: {len(stations)}")
        t_count = sum(1 for s in stations.values() if s.get("temperature") is not None)
        rh_count = sum(1 for s in stations.values() if s.get("humidity") is not None)
        wind_count = sum(1 for s in stations.values() if s.get("wind_speed") is not None)
        rain_count = sum(1 for s in stations.values() if s.get("rain_accumulation") is not None and s.get("rain_accumulation") > 0)
        print(f"  Active Temp Stations: {t_count}")
        print(f"  Active RH Stations: {rh_count}")
        print(f"  Active Wind Stations: {wind_count}")
        print(f"  Rain Accumulation Stations (>0 mm): {rain_count}")
        return

    fetch_hourly_batch(limit=args.limit, force_all=args.all)


if __name__ == "__main__":
    main()
