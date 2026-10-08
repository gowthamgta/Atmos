import config as C
from fetch_regular import INDIA


def test_india_grid_is_the_config_box():
    assert INDIA.nx == C.NX and INDIA.ny == C.NY and INDIA.domain == C.DOMAIN
