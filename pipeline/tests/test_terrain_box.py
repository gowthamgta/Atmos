import build_terrain as B


def test_the_90m_tiles_cover_the_forecast_box():
    assert B.in_full_res_box(2, 70)          # the south-west tile of the box
    assert B.in_full_res_box(19, 98)         # the north-east tile of the box
    assert B.in_full_res_box(15, 80)         # north of the old South India box: now 90 m too
    assert not B.in_full_res_box(20, 78)     # north of 20 N: outside the box
    assert not B.in_full_res_box(15, 69)     # west of 70 E
    assert not B.in_full_res_box(1, 80)      # the tile south of 2 N
