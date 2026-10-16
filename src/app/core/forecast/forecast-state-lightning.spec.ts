import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { ForecastStateService } from './forecast-state.service';

describe('lightning with the observed layers', () => {
  it('comes on by default with the radar and with the satellite, and can be switched off after', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    const state = TestBed.inject(ForecastStateService);
    state.lightning.set(false);
    state.selectRadar();
    expect(state.lightning()).toBe(true);
    state.toggleLightning();
    expect(state.lightning()).toBe(false);
    state.selectSatellite();
    expect(state.lightning()).toBe(true);
  });
});
