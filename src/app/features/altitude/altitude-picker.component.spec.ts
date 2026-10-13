import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ALL_LEVELS, Level } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { PanelService } from '../../core/ui/panel.service';
import { AltitudePickerComponent } from './altitude-picker.component';

@Component({
  imports: [AltitudePickerComponent],
  template: `<app-altitude-picker [inline]="inline" />`,
})
class HostComponent {
  inline = false;
}

/** The labels join a number and its unit with a non-breaking space ("700 hPa", so a narrow pill never wraps it); the tests read them with plain spaces. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/ /g, ' ');

/** The slice of the forecast state the picker uses, as signals the test can move. */
function setup(options: { inline?: boolean; level?: Level; levels?: Level[]; layer?: string | null } = {}) {
  const state = {
    level: signal<Level>(options.level ?? 'surface'),
    levels: signal<Level[]>(options.levels ?? [...ALL_LEVELS]),
    activeLayerId: signal<string | null>(options.layer === undefined ? 'temp' : options.layer),
    setLevel: vi.fn((level: Level) => state.level.set(level)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: ForecastStateService, useValue: state },
      { provide: ForecastCatalogService, useValue: { model: () => ({ label: 'NOAA GFS' }) } },
    ],
  });
  const fixture: ComponentFixture<HostComponent> = TestBed.createComponent(HostComponent);
  fixture.componentInstance.inline = options.inline ?? false;
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();

  const el = fixture.nativeElement as HTMLElement;
  const panels = TestBed.inject(PanelService);
  const trigger = () => el.querySelector<HTMLButtonElement>('.trigger')!;
  const slider = () => el.querySelector<HTMLInputElement>('input.slider');
  const rows = () => [...el.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const row = (text: string) => rows().find(r => r.textContent!.includes(text))!;
  const readout = () => [plain(el.querySelector('.p-name')!.textContent), plain(el.querySelector('.p-sub')!.textContent)];
  const names = () => rows().map(r => plain(r.querySelector('.r-name')!.textContent));
  const flush = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const key = (target: HTMLElement, k: string) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const open = async () => { trigger().click(); await flush(); };
  /** The knob is moved to a stop (0 is the ground), as the browser's range input reports it while it is dragged. */
  const slide = async (stop: number) => {
    slider()!.value = String(stop);
    slider()!.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  };
  const release = async () => { slider()!.dispatchEvent(new Event('change', { bubbles: true })); await flush(); };
  return { fixture, state, panels, el, trigger, slider, rows, row, names, readout, flush, key, open, slide, release };
}

/** The one in the menu: a button, and a list that opens in place. */
const setupList = (options: Parameters<typeof setup>[0] = {}) => setup({ ...options, inline: true });

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the altitude button', () => {
  it('names the ground, with no height of its own to show', async () => {
    const { el, trigger, readout } = setup();
    expect(readout()).toEqual(['Ground', '2–10 m']);
    expect(el.querySelector('app-altitude-picker')!.classList.contains('aloft')).toBe(false);
    expect(trigger().getAttribute('aria-label')).toBe('Altitude: the ground. Choose a height');
  });

  it('shows the pressure over the height in metres and feet once the layers are drawn aloft', async () => {
    const { el, trigger, state, flush, readout } = setup();
    state.level.set(700);
    await flush();
    expect(readout()).toEqual(['700 hPa', '3000 m · 10000 ft']);
    expect(el.querySelector('app-altitude-picker')!.classList.contains('aloft')).toBe(true);
    expect(trigger().getAttribute('aria-label')).toBe('Altitude: 700 hPa, about 3000 metres, flight level 100. Choose a height');
  });

  it('in the menu it gives the flight level instead of the feet', async () => {
    const { state, flush, readout } = setupList();
    state.level.set(700);
    await flush();
    expect(readout()).toEqual(['700 hPa', '3000 m · FL100']);
  });
});

describe('the altitude slider on the map', () => {
  it('is closed until the button is pressed, then opens on the chosen altitude with the knob focused, through the panel service', async () => {
    const { slider, open, trigger, panels } = setup({ level: 850 });
    expect(slider()).toBeNull();
    await open();
    expect(slider()).not.toBeNull();
    expect(slider()!.value).toBe('2');                                // the ground, 925 hPa, 850 hPa
    expect(document.activeElement).toBe(slider());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panels.open()).toBe('altitude');
  });

  it('puts the ground at the left end and the highest altitude at the right', async () => {
    const { slider, open, slide, readout } = setup({ level: 850 });
    await open();
    expect(slider()!.min).toBe('0');
    expect(slider()!.max).toBe('9');
    await slide(0);
    expect(readout()).toEqual(['Ground', '2–10 m']);
    await slide(9);
    expect(readout()).toEqual(['200 hPa', '11800 m · 38500 ft']);
  });

  it('has a stop for each altitude the model has, and no other', async () => {
    const { slider, open, slide, readout } = setup({ level: 500, levels: ['surface', 850, 500] });
    await open();
    expect(slider()!.max).toBe('2');
    expect(slider()!.value).toBe('2');
    await slide(1);
    expect(readout()[0]).toBe('850 hPa');
  });

  it('names the altitude under the knob at once, and moves the map only when the knob has rested', async () => {
    vi.useFakeTimers();
    const { open, slide, readout, state } = setup({ level: 850 });
    await open();
    await slide(3);
    expect(readout()[0]).toBe('800 hPa');
    expect(state.setLevel).not.toHaveBeenCalled();
    await slide(5);                                                   // swept on: the map never goes to 800 hPa
    await vi.advanceTimersByTimeAsync(100);
    expect(state.setLevel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(state.setLevel).toHaveBeenCalledTimes(1);
    expect(state.setLevel).toHaveBeenCalledWith(600);
    expect(readout()[0]).toBe('600 hPa');
  });

  it('moves the map at once when the knob is let go', async () => {
    const { open, slide, release, state } = setup({ level: 850 });
    await open();
    await slide(4);
    expect(state.setLevel).not.toHaveBeenCalled();
    await release();
    expect(state.setLevel).toHaveBeenCalledTimes(1);
    expect(state.setLevel).toHaveBeenCalledWith(700);
  });

  it('asks the map for nothing when the knob is back where it began', async () => {
    const { open, slide, release, state } = setup({ level: 850 });
    await open();
    await slide(4);
    await slide(2);
    await release();
    expect(state.setLevel).not.toHaveBeenCalled();
  });

  it('follows the map when the altitude is changed somewhere else, as in the menu', async () => {
    const { slider, open, state, flush, readout } = setup({ level: 850 });
    await open();
    state.level.set(500);
    await flush();
    expect(slider()!.value).toBe('6');
    expect(readout()[0]).toBe('500 hPa');
  });

  it('is described to a screen reader by its altitude', async () => {
    const { slider, open, slide } = setup({ level: 850 });
    await open();
    expect(slider()!.getAttribute('aria-label')).toBe('Altitude');
    expect(slider()!.getAttribute('aria-valuetext')).toBe('850 hPa, about 1500 metres, 5000 feet');
    await slide(0);
    expect(slider()!.getAttribute('aria-valuetext')).toBe('The ground');
  });

  it('opens from the button with the arrow keys', async () => {
    const { trigger, slider, key, flush } = setup();
    trigger().focus();
    const event = key(trigger(), 'ArrowDown');
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(slider()).not.toBeNull();
  });

  it('keeps its keys from the page, where the time bar would step the forecast', async () => {
    const { slider, open, key } = setup();
    const reachedPage = vi.fn();
    window.addEventListener('keydown', reachedPage);
    await open();
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) key(slider()!, k);
    window.removeEventListener('keydown', reachedPage);
    expect(reachedPage).not.toHaveBeenCalled();
  });

  it('closes on Escape, returns the focus to the button, and still takes the map to the knob', async () => {
    const { slider, open, slide, key, flush, trigger, state, panels } = setup({ level: 850 });
    await open();
    await slide(3);
    const event = key(slider()!, 'Escape');
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(slider()).toBeNull();
    expect(panels.open()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(state.setLevel).toHaveBeenCalledWith(800);
  });

  it('closes when another panel opens, and when the page is pressed elsewhere', async () => {
    const { slider, open, flush, panels } = setup();
    await open();
    panels.open.set('models');
    await flush();
    expect(slider()).toBeNull();

    await open();
    expect(slider()).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.click();
    await flush();
    expect(slider()).toBeNull();
  });

  it('stays open when a drag that began on the knob ends elsewhere on the page', async () => {
    const { slider, open, flush } = setup();
    await open();
    slider()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));   // pressed on the knob...
    document.body.click();                                                   // ...and let go over the map: the click is the page's
    await flush();
    expect(slider()).not.toBeNull();
  });

  it('opens when the pill is pressed too, not only the button', async () => {
    const { el, slider, state, flush } = setup();
    state.level.set(700);
    await flush();
    el.querySelector<HTMLElement>('.pill')!.click();
    await flush();
    expect(slider()).not.toBeNull();
  });

  it('says under the bar what choosing a height does to a layer that is not drawn there', async () => {
    const rain = setup({ layer: 'rain' });
    await rain.open();
    expect(rain.el.querySelector('.caption')!.textContent).toContain('Rain exists at the ground only');
    document.body.innerHTML = '';
    TestBed.resetTestingModule();

    const temp = setup({ layer: 'temp' });
    await temp.open();
    expect(temp.el.querySelector('.caption')).toBeNull();
  });
});

describe('the altitude list in the menu', () => {
  it('opens in place with every altitude, the highest first and the ground last, the chosen one marked', async () => {
    const { rows, names, open, trigger, panels } = setupList({ level: 500 });
    expect(rows()).toHaveLength(0);
    await open();
    expect(names()).toEqual(['200 hPa', '250 hPa', '300 hPa', '500 hPa', '600 hPa', '700 hPa', '800 hPa', '850 hPa', '925 hPa', 'Ground']);
    expect(rows().filter(r => r.getAttribute('aria-selected') === 'true').map(r => plain(r.querySelector('.r-name')!.textContent))).toEqual(['500 hPa']);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panels.open()).toBeNull();                                 // the menu's list does not go through the panel service
  });

  it('gives each row its height and flight level, and the ground neither a flight level nor more than 2–10 m', async () => {
    const { row, open } = setupList();
    await open();
    const cells = (r: HTMLElement) => [...r.querySelectorAll('span')].map(s => plain(s.textContent));
    expect(cells(row('850'))).toEqual(['850 hPa', '1500 m', 'FL50']);
    expect(cells(row('Ground'))).toEqual(['Ground', '2–10 m', '']);
  });

  it('puts the keyboard focus on the chosen altitude', async () => {
    const { row, open } = setupList({ level: 850 });
    await open();
    expect(document.activeElement).toBe(row('850'));
  });

  it('disables the altitudes the model does not have, and says so', async () => {
    const { rows, row, open } = setupList({ levels: ['surface', 850, 500] });
    await open();
    expect(rows().filter(r => !r.disabled).map(r => plain(r.querySelector('.r-name')!.textContent))).toEqual(['500 hPa', '850 hPa', 'Ground']);
    expect(plain(row('300').title)).toBe('300 hPa is not provided by NOAA GFS');
  });

  it('chooses an altitude on a click, closes, and returns the focus to the button', async () => {
    const { row, open, state, flush, trigger, rows } = setupList();
    await open();
    row('300').click();
    await flush();
    expect(state.setLevel).toHaveBeenCalledWith(300);
    expect(rows()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('moves with the arrow keys (up is higher), skipping what is disabled, and stops at the ends', async () => {
    const { row, open, key } = setupList({ level: 850, levels: ['surface', 850, 700, 500] });
    await open();
    key(row('850'), 'ArrowUp');
    expect(document.activeElement).toBe(row('700'));
    key(row('700'), 'ArrowUp');
    expect(document.activeElement).toBe(row('500'));
    key(row('500'), 'ArrowUp');
    expect(document.activeElement).toBe(row('500'));            // the highest it has
    key(row('500'), 'End');
    expect(document.activeElement).toBe(row('Ground'));
    key(row('Ground'), 'ArrowDown');
    expect(document.activeElement).toBe(row('Ground'));         // nothing below the ground
    key(row('Ground'), 'Home');
    expect(document.activeElement).toBe(row('500'));
  });

  it('opens from the button with the arrow keys', async () => {
    const { trigger, rows, key, flush } = setupList();
    trigger().focus();
    const event = key(trigger(), 'ArrowDown');
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(10);
  });

  it('closes on Escape without the key reaching the page, so a menu around it stays open', async () => {
    const { row, open, key, rows, flush, trigger } = setupList();
    const reachedPage = vi.fn();
    window.addEventListener('keydown', reachedPage);
    await open();
    const event = key(row('Ground'), 'Escape');
    await flush();
    window.removeEventListener('keydown', reachedPage);
    expect(event.defaultPrevented).toBe(true);
    expect(reachedPage).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('keeps the arrow keys from the page, where the time bar would step the forecast', async () => {
    const { row, open, key } = setupList();
    const reachedPage = vi.fn();
    window.addEventListener('keydown', reachedPage);
    await open();
    key(row('Ground'), 'ArrowUp');
    window.removeEventListener('keydown', reachedPage);
    expect(reachedPage).not.toHaveBeenCalled();
  });

  it('closes when the page is clicked elsewhere', async () => {
    const { rows, open, flush } = setupList();
    await open();
    expect(rows()).toHaveLength(10);
    document.body.click();
    await flush();
    expect(rows()).toHaveLength(0);
  });

  it('says what choosing an altitude does to a layer that is not drawn there', async () => {
    const ground = setupList({ layer: 'rain' });
    await ground.open();
    expect(ground.el.querySelector('.note')!.textContent).toContain('Rain exists at the ground only');
    document.body.innerHTML = '';
    TestBed.resetTestingModule();

    const aloft = setupList({ layer: 'vertical', level: 850 });
    await aloft.open();
    expect(aloft.el.querySelector('.note')!.textContent).toContain('exists only aloft');
    document.body.innerHTML = '';
    TestBed.resetTestingModule();

    const both = setupList({ layer: 'temp' });
    await both.open();
    expect(both.el.querySelector('.note')).toBeNull();
  });
});
