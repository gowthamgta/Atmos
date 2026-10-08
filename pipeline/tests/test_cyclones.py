from datetime import datetime, timezone

import cyclones as cy

RUN = datetime(2026, 10, 7, 12, tzinfo=timezone.utc)
GAP = -1e100


def _arrays(centres, winds=None, pressures=None):
    """ECMWF's layout: three positions at the analysis, then per lead time the centre and the strongest-wind position."""
    lat, lon = [], []
    (la0, lo0) = centres[0]
    lat += [la0, la0 - 0.4, la0]
    lon += [lo0, lo0 - 0.2, lo0]
    for la, lo in centres[1:]:
        lat += [la, la + 0.5]
        lon += [lo, lo + 0.5]
    n = len(centres)
    return {
        "latitude": lat, "longitude": lon, "timePeriod": [6 * (k + 1) for k in range(n - 1)],
        "pressureReducedToMeanSeaLevel": pressures or [100000.0 - 500 * k for k in range(n)],
        "windSpeedAt10M": winds or [15.0 + k for k in range(n)],
    }


def test_the_track_follows_the_storm_centre_not_the_strongest_wind_position():
    track = cy.storm_track(_arrays([(15.0, 85.0), (15.5, 84.0), (16.0, 83.0)]), RUN)
    assert [(p["h"], p["lat"], p["lon"]) for p in track] == [(0, 15.0, 85.0), (6, 15.5, 84.0), (12, 16.0, 83.0)]
    assert track[0]["pMsl"] == 1000.0 and track[1]["pMsl"] == 995.0 and track[2]["wind"] == 17.0


def test_a_lead_time_with_no_position_is_left_out_and_longitudes_are_east_west():
    arrays = _arrays([(15.0, 85.0), (GAP, GAP), (16.0, 275.0)])
    track = cy.storm_track(arrays, RUN)
    assert [p["h"] for p in track] == [0, 12]
    assert track[1]["lon"] == -85.0


def test_basin_comes_from_the_storm_identifier():
    assert cy.basin("01B") == "Bay of Bengal" and cy.basin("02A") == "Arabian Sea" and cy.basin("70S") == "Indian Ocean"


def test_only_storms_near_the_region_are_kept_and_members_are_attached():
    near = {"id": "03B", "name": "TEST", "member": 51, "track": cy.storm_track(_arrays([(14.0, 88.0), (15.0, 87.0), (16.0, 86.0)]), RUN)}
    far = {"id": "20E", "name": "FAR", "member": 51, "track": cy.storm_track(_arrays([(15.0, -100.0), (16.0, -101.0)]), RUN)}
    member = {"id": "03B", "name": "TEST", "member": 3, "track": cy.storm_track(_arrays([(14.0, 88.0), (15.5, 86.0), (17.0, 84.0)]), RUN)}
    data = cy.build([near, far], [member], RUN)
    assert [s["id"] for s in data["storms"]] == ["03B"] and data["run"] == "20261007T12Z"
    storm = data["storms"][0]
    assert storm["basin"] == "Bay of Bengal" and len(storm["track"]) == 3
    assert storm["members"] == [[[0, 14.0, 88.0], [12, 17.0, 84.0]]]               # only the 12-hourly positions
    assert cy.build([far], [], RUN)["storms"] == []                                  # nothing near: an empty list, not an error
