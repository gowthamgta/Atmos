import build_terrain as B


def test_the_90m_tiles_are_the_south_india_box_only():
    assert B.in_full_res_box(5, 73)          # the south-west tile of the box
    assert B.in_full_res_box(14, 89)         # the north-east tile of the box
    assert B.in_full_res_box(8, 80)          # inside
    assert not B.in_full_res_box(15, 80)     # north of 14.5 N: only the 270 m tile
    assert not B.in_full_res_box(20, 78)     # all of central India
    assert not B.in_full_res_box(4, 80)      # the tile south of 5.5 N (overlaps only the sea)
