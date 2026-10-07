"""The extreme-rain probability: how likely it is that a place gets a lot of rain in the next 24 hours.

Three things are put together, per place and time:
  - the rain of the next 24 h (mm) of the model being looked at, and of the all-model blend (the consensus of every model);
  - the ensemble's chance of any rain (>= 0.1 mm, `px0`) as a check that rain is really expected there.

The amount sets the probability: about 25 mm is a 25 % chance of an extreme day, 50 mm 70 %, 100 mm 90 %, never above 95 %
(IMD's heavy rain starts at 64.5 mm and very heavy at 115.6 mm a day). It is lowered when the model and the blend disagree
(50 mm in one and 25 mm in the other is a weaker case than 50 mm in both), and goes to nothing when the ensemble does not expect
rain there at all (chance of rain under 20 %, full weight from 70 %).
"""
from __future__ import annotations
import numpy as np

# (mm of rain in 24 h, probability of an extreme day) at the corners of the curve; between them it is a straight line
AMOUNT_POINTS = ((0.0, 0.0), (10.0, 0.0), (25.0, 0.25), (50.0, 0.70), (75.0, 0.82), (100.0, 0.90), (150.0, 0.95))
CAP = 0.95
MIN_MM_FOR_AGREEMENT = 5.0          # below this the two amounts are both "little rain", not a disagreement
DISAGREEMENT_WEIGHT = 0.35          # how much of the probability the worst disagreement takes away
CHANCE_FULL, CHANCE_NONE = 70.0, 20.0


def amount_score(mm: np.ndarray) -> np.ndarray:
    """Probability (0..CAP) that a day with this much rain is an extreme one. NaN stays NaN."""
    xs, ys = zip(*AMOUNT_POINTS)
    mm = np.asarray(mm, np.float64)
    return np.where(np.isfinite(mm), np.interp(np.nan_to_num(mm), xs, ys), np.nan)


def extreme_rain_percent(own_mm: np.ndarray, blend_mm: np.ndarray | None, chance_pct: np.ndarray) -> np.ndarray:
    """Extreme-rain probability in percent (float32).

    `own_mm` is the model's own 24 h rain, `blend_mm` the blend's (None or NaN where the blend has none: the model stands alone),
    `chance_pct` the ensemble's chance of rain (>= 0.1 mm). NaN wherever the model's rain or the chance is unknown.
    """
    own = np.asarray(own_mm, np.float64)
    chance = np.asarray(chance_pct, np.float64)
    if blend_mm is None:
        blend = np.full(own.shape, np.nan)
    else:
        blend = np.asarray(blend_mm, np.float64)
    have_blend = np.isfinite(blend)
    consensus = np.where(have_blend, 0.5 * (own + blend), own)
    both = have_blend & (own >= MIN_MM_FOR_AGREEMENT) & (blend >= MIN_MM_FOR_AGREEMENT)
    with np.errstate(invalid="ignore", divide="ignore"):
        ratio = np.where(both, np.minimum(own, blend) / np.maximum(own, blend), 1.0)
    agreement = (1.0 - DISAGREEMENT_WEIGHT) + DISAGREEMENT_WEIGHT * ratio
    rain_expected = np.clip((chance - CHANCE_NONE) / (CHANCE_FULL - CHANCE_NONE), 0.0, 1.0)
    out = 100.0 * amount_score(consensus) * agreement * rain_expected
    return np.clip(out, 0.0, 100.0 * CAP).astype(np.float32)
