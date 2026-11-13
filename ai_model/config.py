"""Configuration for Kralveth AI 1km Regional Weather Model.

Domain: South India and adjoining seas (2-20°N, 70-99°E)
Resolutions:
  - Synoptic Input Grid: 0.1° (~11 km), 181 x 291 nodes
  - High-Definition 1km Grid: 0.01° (~1.08 km), 1801 x 2901 nodes
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)

# Geographic Domain
LAT_MAX = 20.0
LAT_MIN = 2.0
LON_MIN = 70.0
LON_MAX = 99.0

# Synoptic Grid (0.1 deg)
SYNOPTIC_STEP = 0.1
NY_SYNOPTIC = round((LAT_MAX - LAT_MIN) / SYNOPTIC_STEP) + 1  # 181
NX_SYNOPTIC = round((LON_MAX - LON_MIN) / SYNOPTIC_STEP) + 1  # 291

# High-Resolution 1km Grid (0.01 deg)
STEP_1KM = 0.01
NY_1KM = round((LAT_MAX - LAT_MIN) / STEP_1KM) + 1  # 1801
NX_1KM = round((LON_MAX - LON_MIN) / STEP_1KM) + 1  # 2901

# Forecast Reach & Frequency
REACH_HOURS = 72  # 3 days
STEP_HOURS = 3    # 3-hourly time steps

# Atmospheric Variables
TARGET_VARIABLES = [
    "precip",     # Precipitation (mm/h or 3h/24h accumulated mm)
    "t2m",        # 2-metre Temperature (°C)
    "u10",        # 10-metre U-wind component (m/s)
    "v10",        # 10-metre V-wind component (m/s)
    "wind_speed", # Scalar wind speed (m/s)
    "cape",       # Convective Available Potential Energy (J/kg)
    "mslp",       # Mean Sea Level Pressure (hPa)
    "rh2m",       # 2-metre Relative Humidity (%)
]

# Static Physical Channels (Conditioning)
STATIC_CHANNELS = [
    "elevation",  # Metres above sea level (0 - 2695m)
    "land_mask",  # 0.0 = sea, 1.0 = land
    "slope_x",    # Topographic zonal slope (∂z/∂x)
    "slope_y",    # Topographic meridional slope (∂z/∂y)
    "sin_lat",    # Continuous latitude positional encoding
    "cos_lon",    # Continuous longitude positional encoding
]

# Paths
DATA_DIR = os.path.join(BASE_DIR, "data")
WEIGHTS_DIR = os.path.join(BASE_DIR, "weights")
STATIC_1KM_FILE = os.path.join(DATA_DIR, "static_1km.npz")
TERRAIN_TILES_DIR = os.path.join(PROJECT_ROOT, "pipeline", "data", "terrain", "L2")

# Metadata
MODEL_ID = "kralveth_ai"
MODEL_LABEL = "Kralveth AI 1km"
MODEL_SHORT = "AI 1km"
MODEL_RESOLUTION = "1 km high definition neural model, South India and its seas"
