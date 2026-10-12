import { Injectable, effect, signal } from '@angular/core';
import {
  METRIC, PRESSURE_UNITS, PressureUnit, Quantity, RAIN_UNITS, RainUnit, TEMP_UNITS, TempUnit, Units, WIND_UNITS, WindUnit,
} from './units';

const KEY = 'atmosiq-units';

/** The units values are shown in (saved in this browser). Click the legend, or choose them in the menu. */
@Injectable({ providedIn: 'root' })
export class UnitsService {
  readonly units = signal<Units>(this.load());

  constructor() {
    effect(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.units()));
      } catch {
        /* storage blocked: the choice just lasts for this visit */
      }
    });
  }

  set<K extends keyof Units>(key: K, value: Units[K]): void {
    this.units.update(u => ({ ...u, [key]: value }));
  }

  /** The next unit of a quantity (the legend's unit label cycles through them, as on windy.com). */
  cycle(q: Quantity): void {
    const u = this.units();
    switch (q) {
      case 'temp': return this.set('temp', next(TEMP_UNITS, u.temp));
      case 'wind': return this.set('wind', next(WIND_UNITS, u.wind));
      case 'rain':
      case 'rainRate': return this.set('rain', next(RAIN_UNITS, u.rain));
      case 'pressure': return this.set('pressure', next(PRESSURE_UNITS, u.pressure));
    }
  }

  private load(): Units {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Units> | null;
      if (saved) {
        return {
          temp: TEMP_UNITS.includes(saved.temp as TempUnit) ? (saved.temp as TempUnit) : METRIC.temp,
          wind: WIND_UNITS.includes(saved.wind as WindUnit) ? (saved.wind as WindUnit) : METRIC.wind,
          rain: RAIN_UNITS.includes(saved.rain as RainUnit) ? (saved.rain as RainUnit) : METRIC.rain,
          pressure: PRESSURE_UNITS.includes(saved.pressure as PressureUnit) ? (saved.pressure as PressureUnit) : METRIC.pressure,
        };
      }
    } catch {
      /* nothing saved, or storage blocked */
    }
    return { ...METRIC };
  }
}

function next<T>(all: readonly T[], current: T): T {
  return all[(all.indexOf(current) + 1) % all.length];
}
