import type { Level } from './forecast-layers';

export interface LayerGuide {
  summary: string;
  low: string;
  high: string;
  guideText: string;
}

/** Short plain-English summary of what each layer represents, for menus and tooltips. */
export const LAYER_SUBTITLES: Record<string, string> = {
  temp: '2 m air temperature',
  tmin24: '24 h lowest temperature',
  tmax24: '24 h highest temperature',
  feels: 'Humidity & wind adjusted',
  dew: 'Moisture saturation point',
  wind: '10 m speed & direction',
  gust: 'Peak wind bursts',
  rain: 'Rainfall intensity (mm/h)',
  rain24: '24 h rain accumulation',
  raintot: 'Total rain in chosen period',
  extreme: 'Chance of rain in 24 h (0–100%)',
  humidity: 'Relative air moisture (%)',
  tcwv: 'Total precipitable water',
  vis: 'Horizontal ground visibility',
  pressure: 'Sea-level pressure & fronts',
  cape: 'Thunderstorm potential energy',
  cin: 'Cap holding storms back',
  li: 'Atmospheric instability index',
  vertical: 'Updrafts (rain) vs downdrafts (clear)',
  vorticity: 'Atmospheric spin & storm centers',
  divergence: 'Upper storm exhaust vs gathering',
};

export function layerSubtitle(layerId: string | null | undefined): string | null {
  if (!layerId) return null;
  return LAYER_SUBTITLES[layerId] ?? null;
}

export const LAYER_GUIDES: Record<string, LayerGuide> = {
  vertical: {
    summary: 'Updrafts vs downdrafts in the upper air',
    low: 'Sinking air (clear)',
    high: 'Rising air (clouds & storms)',
    guideText: 'Rising air (+ values, teal/cyan to electric blue and pink) cools and condenses moisture, fueling cloud and thunderstorm growth. Sinking air (- values, earthy amber and rust) suppresses clouds to create clear skies.',
  },
  vorticity: {
    summary: 'Atmospheric spin and storm rotation',
    low: 'Anticyclonic (fair weather ridge)',
    high: 'Cyclonic spin (storms & troughs)',
    guideText: 'Positive values (emerald to royal blue and vivid magenta) show counter-clockwise cyclonic spin in the Northern Hemisphere, marking storm centers, troughs, and tropical depressions. Negative values (warm amber) mark stable high-pressure ridges.',
  },
  divergence: {
    summary: 'Wind evacuation vs gathering',
    low: 'Convergence (gathering air)',
    high: 'Divergence (storm exhaust)',
    guideText: 'Negative values (fiery crimson/amber) show low-level convergence squeezing air together and forcing it upward. Positive values (emerald to vivid sky) show upper-level divergence acting like a chimney exhaust to pull air up from below.',
  },
  cape: {
    summary: 'Thunderstorm potential energy',
    low: 'Stable (0 J/kg)',
    high: 'Severe storms (2500+ J/kg)',
    guideText: 'CAPE measures the atmospheric fuel available for rising air. Values above 1,000 J/kg support thunderstorms, while values over 2,500 J/kg indicate high risk of severe thunderstorms and heavy lightning.',
  },
  li: {
    summary: 'Atmospheric instability index',
    low: 'Severe storms (negative)',
    high: 'Stable air (positive)',
    guideText: 'Lifted Index compares the temperature of rising air to the surrounding air at 500 hPa. Negative values mean rising air remains buoyant, easily generating thunderstorms.',
  },
  cin: {
    summary: 'Convective inhibition cap',
    low: 'Weak cap (storms can trigger)',
    high: 'Strong cap (storms blocked)',
    guideText: 'CIN represents the atmospheric lid holding rising air back. When CIN is weak (<50 J/kg) and CAPE is high, thunderstorms can explode rapidly; strong CIN prevents storm formation.',
  },
  extreme: {
    summary: '24-hour chance of rain',
    low: 'Low chance (<15%)',
    high: 'Very high chance (>70%)',
    guideText: 'The calibrated probability of receiving rain at your location during the next 24 hours. Calibrated from the multi-model ensemble to avoid false drizzle inflation.',
  },
  rain: {
    summary: 'Rainfall rate in mm per hour',
    low: 'Light rain (1–2 mm/h)',
    high: 'Torrential downpour (20+ mm/h)',
    guideText: 'Instantaneous hourly rate of rainfall. 1 to 5 mm/h is light to moderate rain; 5 to 15 mm/h is heavy rain; over 15 mm/h causes rapid water accumulation and localized street flooding.',
  },
  rain24: {
    summary: 'Total 24-hour rainfall accumulation',
    low: 'Light (<15 mm)',
    high: 'Heavy / Flood risk (>70 mm)',
    guideText: 'Rain predicted to accumulate over the next 24 hours. Above 35 mm is heavy rain; above 70 mm can lead to flash flooding and swollen water bodies.',
  },
  raintot: {
    summary: 'Rain in the chosen time window',
    low: 'Light accumulation',
    high: 'Heavy / Flood risk',
    guideText: 'Rain accumulated across the white period selected on the timeline slider.',
  },
  wind: {
    summary: 'Wind speed and direction',
    low: 'Calm / Gentle breeze',
    high: 'Gale / Cyclone winds',
    guideText: 'Wind speed 10 m above ground level. Streaks show the flowing wind path; colors show speed from gentle breezes up to hazardous gales.',
  },
  gust: {
    summary: 'Peak wind bursts',
    low: 'Gentle bursts',
    high: 'Hazardous storm gusts',
    guideText: 'The highest sudden wind burst expected within the forecast step. Gusts are often 30% to 70% stronger than sustained wind.',
  },
  temp: {
    summary: 'Air temperature 2 m above ground',
    low: 'Cold / Mild',
    high: 'Hot / Heatwave',
    guideText: 'Standard shaded air temperature. Downscaled using 90 m terrain elevations to reflect real mountain and valley temperatures.',
  },
  feels: {
    summary: 'Apparent feels-like temperature',
    low: 'Cool',
    high: 'Extreme heat danger',
    guideText: 'Combines air temperature, humidity, and wind speed (Australian BoM Steadman formula) to show how warm or cool the weather actually feels to the human body.',
  },
  humidity: {
    summary: 'Relative air humidity percentage',
    low: 'Dry (<40%)',
    high: 'Very humid / muggy (>75%)',
    guideText: 'Amount of moisture in the air relative to saturation. High humidity (>75%, blue colors) prevents sweat from evaporating, making heat feel stifling.',
  },
  tcwv: {
    summary: 'Total precipitable water in air column',
    low: 'Dry air column',
    high: 'Deep tropical moisture',
    guideText: 'The total water vapor in the entire column of air from ground to outer space. Over 50 kg/m² indicates rich tropical moisture that can fuel intense downpours.',
  },
  vis: {
    summary: 'Horizontal ground visibility',
    low: 'Dense fog / haze hazard',
    high: 'Clear visibility',
    guideText: 'Distance at which objects can be clearly seen. Below 1 km indicates fog or dense smoke/dust haze.',
  },
  pressure: {
    summary: 'Atmospheric pressure & weather systems',
    low: 'Low pressure (stormy)',
    high: 'High pressure (fair)',
    guideText: 'Air pressure reduced to sea level. Low pressure systems (<1006 hPa) bring cloudy, stormy weather; high pressure brings calm, settled conditions.',
  },
};

export function layerGuide(layerId: string | null | undefined, level: Level = 'surface'): LayerGuide | null {
  if (!layerId) return null;
  const g = LAYER_GUIDES[layerId];
  if (!g) return null;
  if (layerId === 'pressure' && level !== 'surface') {
    return {
      summary: `Height of the ${level} hPa pressure surface`,
      low: 'Low height (trough)',
      high: 'High height (ridge)',
      guideText: `Geopotential height of the ${level} hPa surface in metres. Lower heights mark upper troughs and cold air; higher heights mark warm ridges.`,
    };
  }
  return g;
}

/**
 * Returns a concise plain-English interpretation for a numeric reading at a specific point on the map.
 * E.g. 'Rising air · clouds/storms', 'Severe thunderstorm risk', 'High heat stress'.
 */
export function layerMeaning(layerId: string | null | undefined, value: number, level: Level = 'surface'): string | null {
  if (!layerId || Number.isNaN(value)) return null;

  switch (layerId) {
    case 'vertical':
    case 'lvl-w': {
      // In point forecast, value is cm/s (displayScale = 100)
      if (value > 12) return 'Strong updraft · storm growth';
      if (value >= 2.5) return 'Rising air · cloudy / rain favored';
      if (value > -2.5) return 'Calm vertical air';
      if (value >= -12) return 'Sinking air · dry & clearing';
      return 'Strong downdraft · sinking air';
    }
    case 'vorticity':
    case 'lvl-vo': {
      // 10^-5 /s
      if (value > 12) return 'Intense cyclonic vortex · storm';
      if (value >= 3) return 'Cyclonic spin · low pressure';
      if (value > -3) return 'Neutral flow';
      if (value >= -10) return 'Anticyclonic flow · fair ridge';
      return 'Strong high-pressure ridge';
    }
    case 'divergence':
    case 'lvl-dv': {
      // 10^-5 /s
      if (value > 6) return 'Strong divergence · storm exhaust';
      if (value >= 1.5) return 'Divergence · air spreading aloft';
      if (value > -1.5) return 'Neutral horizontal flow';
      if (value >= -6) return 'Convergence · air gathering';
      return 'Strong convergence · low-level inflow';
    }
    case 'cape': {
      if (value < 100) return 'Stable · no storm energy';
      if (value < 600) return 'Low energy · weak showers only';
      if (value < 1500) return 'Moderate storm energy';
      if (value < 2500) return 'High thunderstorm potential';
      return 'Extreme energy · severe storms';
    }
    case 'li': {
      if (value > 2) return 'Stable · no storms';
      if (value >= 0) return 'Stable · storms unlikely';
      if (value >= -3) return 'Marginally unstable · isolated storms';
      if (value >= -6) return 'Unstable · thunderstorms likely';
      return 'Extremely unstable · severe storms';
    }
    case 'cin': {
      if (value < 15) return 'No cap · storms trigger easily';
      if (value < 50) return 'Weak cap · heat can break through';
      if (value < 150) return 'Moderate cap · delays storms';
      return 'Strong cap · storm growth blocked';
    }
    case 'extreme': {
      if (value < 15) return 'Low rain chance (<15%)';
      if (value < 40) return 'Scattered showers possible (15–40%)';
      if (value < 70) return 'Rain likely (40–70%)';
      return 'Rain very likely (>70%)';
    }
    case 'rain': {
      if (value < 0.1) return 'No rain';
      if (value < 2) return 'Light rain / drizzle';
      if (value < 7) return 'Moderate rain';
      if (value < 18) return 'Heavy rainfall';
      return 'Torrential downpour';
    }
    case 'rain24':
    case 'raintot':
    case 'rainrange': {
      if (value < 1) return 'Dry / trace only';
      if (value < 15) return 'Light accumulation';
      if (value < 35) return 'Moderate accumulation';
      if (value < 70) return 'Heavy rainfall accumulation';
      if (value < 120) return 'Very heavy rain';
      return 'Extreme rain · flood risk';
    }
    case 'tcwv': {
      if (value < 28) return 'Dry atmospheric column';
      if (value < 45) return 'Moderate moisture';
      if (value < 60) return 'Moist tropical air';
      return 'Deep tropical moisture';
    }
    case 'vis': {
      if (value < 1) return 'Dense fog / hazard';
      if (value < 4) return 'Mist / haze · reduced visibility';
      if (value < 10) return 'Moderate visibility';
      return 'Clear visibility';
    }
    case 'wind':
    case 'lvl-wind': {
      // value in m/s
      if (value < 3.5) return 'Light breeze';
      if (value < 8.5) return 'Moderate breeze';
      if (value < 14) return 'Fresh to strong wind';
      if (value < 17.5) return 'Near gale';
      if (value < 21) return 'Gale · hazardous';
      return 'Storm force winds';
    }
    case 'gust': {
      if (value < 8.5) return 'Gentle gusts';
      if (value < 14) return 'Moderate gusts';
      if (value < 20) return 'Strong gusts';
      if (value < 25) return 'Gale gusts';
      return 'Severe storm gusts';
    }
    case 'humidity':
    case 'lvl-humidity': {
      if (value < 30) return 'Very dry air';
      if (value < 60) return 'Comfortable humidity';
      if (value < 75) return 'Mildly humid';
      return 'Very humid / muggy';
    }
    case 'feels': {
      if (value >= 42) return 'Extreme heat danger';
      if (value >= 38) return 'Very hot · heat exhaustion risk';
      if (value >= 32) return 'Hot & sultry';
      if (value >= 24) return 'Warm & comfortable';
      if (value >= 18) return 'Pleasant';
      if (value >= 10) return 'Cool';
      return 'Cold';
    }
    case 'temp':
    case 'lvl-temp': {
      if (value >= 40) return 'Extreme heat';
      if (value >= 34) return 'Very hot';
      if (value >= 28) return 'Warm';
      if (value >= 20) return 'Mild';
      if (value >= 12) return 'Cool';
      return 'Cold';
    }
    case 'pressure': {
      if (level === 'surface') {
        if (value < 1004) return 'Deep low pressure · stormy';
        if (value < 1010) return 'Low pressure · unsettled';
        if (value < 1016) return 'Normal atmospheric pressure';
        return 'High pressure · fair weather';
      }
      return null;
    }
    default:
      return null;
  }
}
