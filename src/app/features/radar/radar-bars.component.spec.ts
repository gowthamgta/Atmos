import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RadarNowcastService } from '../../core/services/radar-nowcast.service';
import { RadarService } from '../../core/services/radar.service';
import { RadarBarsComponent, istClock, offsetLabel } from './radar-bars.component';

const MIN = 60_000;
/** 10:30 IST on 13 October 2026. */
const LIVE = Date.UTC(2026, 9, 13, 5, 0);

interface Setup {
  fixture: ComponentFixture<RadarBarsComponent>;
  el: HTMLElement;
  radar: ReturnType<typeof stubRadar>;
}

function stubRadar(history: number, ahead: number) {
  const frames = Array.from({ length: history }, (_, i) => ({ timeMs: LIVE - (history - i) * 10 * MIN }));
  const guesses = Array.from({ length: ahead }, (_, i) => ({ timeMs: LIVE + (i + 1) * 10 * MIN, leadMin: (i + 1) * 10 }));
  const hist = signal(frames);
  const nowcast = signal(guesses);
  const playIndex = signal<number | null>(null);
  const leadIndex = signal<number | null>(null);
  const radar = {
    history: hist,
    nowcast,
    playIndex,
    leadIndex,
    compositeMosaic: signal({ timing: { epochMs: LIVE } }),
    cursor: () => (playIndex() !== null ? playIndex()! : leadIndex() !== null ? hist().length + 1 + leadIndex()! : hist().length),
    cursorMax: () => hist().length + nowcast().length,
    historyLoading: signal(false),
    historyProgress: signal(0),
    historyAvailable: signal(true),
    playing: signal(false),
    togglePlay: vi.fn(),
    pause: vi.fn(),
    setCursor: vi.fn((c: number) => {
      const h = hist().length;
      playIndex.set(c < h ? c : null);
      leadIndex.set(c > h ? c - h - 1 : null);
    }),
  };
  return radar;
}

function setup(history: number, ahead: number, radarOn = true): Setup {
  const radar = stubRadar(history, ahead);
  TestBed.configureTestingModule({
    providers: [
      { provide: RadarService, useValue: radar },
      { provide: RadarNowcastService, useValue: {} },
    ],
  });
  if (radarOn) TestBed.inject(MapLayerService).selectSingleLayer('radar');
  const fixture = TestBed.createComponent(RadarBarsComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, radar };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the time written on the radar bar', () => {
  it('writes IST as hours and minutes, and how far from the live picture a time is', () => {
    expect(istClock(LIVE)).toBe('10:30');
    expect(offsetLabel(LIVE + 30 * MIN, LIVE)).toBe('+30 min');
    expect(offsetLabel(LIVE - 20 * MIN, LIVE)).toBe('−20 min');
    expect(offsetLabel(LIVE, LIVE)).toBe('');
  });
});

describe('the radar bar', () => {
  it('is only there while the radar is on', () => {
    const { el } = setup(3, 2, false);
    expect(el.querySelector('.bar')).toBeNull();
    expect(el.querySelector('.legend')).toBeNull();
  });

  it('puts one notch for each picture: the loop, then "Now", then the nowcast in italics', () => {
    const { el } = setup(3, 2);
    const notches = [...el.querySelectorAll('.notch')];
    expect(notches).toHaveLength(6);
    expect(notches.map(n => n.querySelector('.lbl')!.textContent)).toEqual(['10:00', '10:10', '10:20', 'Now', '10:40', '10:50']);
    expect(notches.map(n => n.classList.contains('now'))).toEqual([false, false, false, true, false, false]);
    expect(notches.map(n => n.classList.contains('guess'))).toEqual([false, false, false, false, true, true]);
    expect(el.querySelector('.zone.guess')).not.toBeNull();                       // the striped stretch that says "nowcast"
    expect(el.querySelector('.zone.guess')!.textContent).toContain('Nowcast');
  });

  it('puts the amber line where the radar clock is, with the time and how far from live', () => {
    const { el, radar, fixture } = setup(3, 2);
    const head = () => el.querySelector<HTMLElement>('.playhead')!;
    expect(head().style.left).toBe('60%');                                       // the live picture: the 4th of 6 notches
    expect(head().querySelector('.tip')!.textContent).toBe('Live 10:30');
    radar.setCursor(0);
    fixture.detectChanges();
    expect(head().style.left).toBe('0%');
    expect(head().querySelector('.tip')!.textContent).toBe('10:00 · −30 min');
    expect(head().classList.contains('guess')).toBe(false);
    radar.setCursor(5);
    fixture.detectChanges();
    expect(head().style.left).toBe('100%');
    expect(head().querySelector('.tip')!.textContent).toBe('10:50 · +20 min');
    expect(head().classList.contains('guess')).toBe(true);                        // the tooltip of a guess is striped
  });

  it('has a slider for the keyboard and the pointer, one step for each picture', () => {
    const { el, radar } = setup(3, 2);
    const input = el.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(input.max).toBe('5');
    expect(input.value).toBe('3');
    input.value = '1';
    input.dispatchEvent(new Event('input'));
    expect(radar.pause).toHaveBeenCalled();
    expect(radar.setCursor).toHaveBeenCalledWith(1);
  });

  it('lets the time badge on the amber line be dragged along the strip, as on the forecast bar, snapping to the pictures', () => {
    const { fixture, el, radar } = setup(6, 3);
    const inner = el.querySelector('.inner') as HTMLElement;
    inner.getBoundingClientRect = () => ({ left: 100, width: 900, right: 1000, top: 0, bottom: 40, height: 40, x: 100, y: 0, toJSON: () => ({}) });
    const tip = el.querySelector('.playhead .tip') as HTMLElement;
    expect(getComputedStyle(tip).cursor).toBe('grab');

    tip.dispatchEvent(new PointerEvent('pointerdown', { clientX: 1000, bubbles: true, cancelable: true }));
    expect(radar.pause).toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 + 900 * (2 / 9) + 20 }));
    expect(radar.setCursor).toHaveBeenLastCalledWith(2);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5 })); // past the left end: the oldest picture
    expect(radar.setCursor).toHaveBeenLastCalledWith(0);
    window.dispatchEvent(new PointerEvent('pointerup', {}));
    radar.setCursor.mockClear();
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 900 }));
    expect(radar.setCursor).not.toHaveBeenCalled(); // let go: the drag is over
    fixture.detectChanges();
  });

  it('plays, steps with the buttons and with the arrow keys, and plays with Space', () => {
    const { el, radar, fixture } = setup(3, 2);
    el.querySelector<HTMLButtonElement>('.play')!.click();
    expect(radar.togglePlay).toHaveBeenCalledTimes(1);
    const [back, forward] = [...el.querySelectorAll<HTMLButtonElement>('.step')];
    forward.click();
    expect(radar.setCursor).toHaveBeenLastCalledWith(4);
    fixture.detectChanges();
    back.click();
    expect(radar.setCursor).toHaveBeenLastCalledWith(3);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(radar.setCursor).toHaveBeenLastCalledWith(2);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(radar.togglePlay).toHaveBeenCalledTimes(2);
  });

  it('leaves the arrow keys to a text box that has the focus', () => {
    const { radar } = setup(3, 2);
    const box = document.createElement('input');
    document.body.appendChild(box);
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(radar.setCursor).not.toHaveBeenCalled();
  });

  it('offers to load the last hour when only the live picture is there, and says how far it has got while it builds', () => {
    const { el, radar, fixture } = setup(0, 0);
    expect(el.querySelectorAll('.notch')).toHaveLength(1);
    expect(el.querySelector('.note')!.textContent).toContain('Press play to load the last hour');
    radar.historyLoading.set(true);
    radar.historyProgress.set(0.4);
    fixture.detectChanges();
    expect(el.querySelector('.note')!.textContent).toContain('Building the last hour… 40%');
    expect(el.querySelector<HTMLButtonElement>('.play')!.disabled).toBe(true);
    expect(el.querySelector('input[type="range"]')).toBeNull();                   // nothing to scrub yet
  });

  it('shows the colour scale in dBZ along the very bottom', () => {
    const { el } = setup(0, 0);
    expect(el.querySelector('.legend .unit')!.textContent).toBe('dBZ');
    expect([...el.querySelectorAll('.legend .tick')].map(t => t.textContent)).toEqual(['20', '30', '40', '50', '60']);
  });
});
