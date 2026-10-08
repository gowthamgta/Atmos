import numpy as np
import config as C
import models_regular
from fetch_regular import INDIA, WORLD
from regular import regrid_regular


def test_india_grid_is_the_config_box():
    assert INDIA.nx == C.NX and INDIA.ny == C.NY and INDIA.domain == C.DOMAIN


def test_world_grid_covers_the_globe():
    assert WORLD.nx == 360 and WORLD.ny == 181
    assert WORLD.lats()[0] == 90 and WORLD.lats()[-1] == -90
    assert WORLD.lons()[0] == -180 and WORLD.lons()[-1] == 179


def test_world_model_publishes_on_the_world_grid():
    assert models_regular.WORLD_IFS.GRID is WORLD
    assert models_regular.WORLD_IFS.MODEL_ID == "world_ifs"
    assert models_regular.WORLD_IFS in models_regular.ALL


def test_global_regrid_keeps_latitude():
    # a global window of 0.25 degree rows (south to north), each row holding its own latitude
    lat = np.arange(-90, 90.001, 0.25, dtype=np.float32)
    window = np.repeat(lat[:, None], 1440, axis=1)
    lats, lons = WORLD.lats(), WORLD.lons()
    out = regrid_regular(window, -90.0, 0.25, -180.0, 0.25, lats, lons)
    assert out.shape == (181, 360)
    assert np.allclose(out, lats[:, None], atol=1e-3)
