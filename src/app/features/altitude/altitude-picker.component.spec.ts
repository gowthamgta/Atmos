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
  const rows = () => [...el.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const row = (text: string) => rows().find(r => r.textContent!.includes(text))!;
  const flush = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const key = (target: HTMLElement, k: string) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const open = async () => { trigger().click(); await flush(); };
  return { fixture, state, panels, el, trigger, rows, row, flush, key, open };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the altitude button', () => {
  it('names the ground, with no height of its own to show', async () => {
    const { el, trigger } = setup();
    expect(el.querySelector('.p-name')!.textContent).toBe('Ground');
    expect(el.querySelector('.p-sub')!.textContent).toBe('2–10 m');
    expect(el.querySelector('app-altitude-picker')!.classList.contains('aloft')).toBe(false);
    expect(trigger().getAttribute('aria-label')).toBe('Altitude: the ground. Choose a height');
  });

  it('shows the pressure over the height and flight level once the layers are drawn aloft', async () => {
    const { el, trigger, state, flush } = setup();
    state.level.set(700);
    await flush();
    expect(el.querySelector('.p-name')!.textContent).toBe('700 hPa');
    expect(el.querySelector('.p-sub')!.textContent).toBe('3000 m · FL100');
    expect(el.querySelector('app-altitude-picker')!.classList.contains('aloft')).toBe(true);
    expect(trigger().getAttribute('aria-label')).toBe('Altitude: 700 hPa, about 3000 metres, flight level 100. Choose a height');
  });
});

describe('the altitude list', () => {
  it('opens above the button with every altitude, the highest first and the ground last, the chosen one marked', async () => {
    const { rows, open, trigger, panels } = setup({ level: 500 });
    expect(rows()).toHaveLength(0);
    await open();
    expect(rows().map(r => r.querySelector('.r-name')!.textContent)).toEqual(['200 hPa', '250 hPa', '300 hPa', '500 hPa', '700 hPa', '850 hPa', '925 hPa', 'Ground']);
    expect(rows().filter(r => r.getAttribute('aria-selected') === 'true').map(r => r.querySelector('.r-name')!.textContent)).toEqual(['500 hPa']);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panels.open()).toBe('altitude');
  });

  it('gives each row its height and flight level, and the ground neither a flight level nor more than 2–10 m', async () => {
    const { row, open } = setup();
    await open();
    const cells = (r: HTMLElement) => [...r.querySelectorAll('span')].map(s => s.textContent);
    expect(cells(row('850'))).toEqual(['850 hPa', '1500 m', 'FL50']);
    expect(cells(row('Ground'))).toEqual(['Ground', '2–10 m', '']);
  });

  it('puts the keyboard focus on the chosen altitude', async () => {
    const { row, open } = setup({ level: 850 });
    await open();
    expect(document.activeElement).toBe(row('850'));
  });

  it('disables the altitudes the model does not have, and says so', async () => {
    const { rows, row, open } = setup({ levels: ['surface', 850, 500] });
    await open();
    expect(rows().filter(r => !r.disabled).map(r => r.querySelector('.r-name')!.textContent)).toEqual(['500 hPa', '850 hPa', 'Ground']);
    expect(row('300').title).toBe('300 hPa is not provided by NOAA GFS');
  });

  it('chooses an altitude on a click, closes, and returns the focus to the button', async () => {
    const { row, open, state, flush, trigger, rows, panels } = setup();
    await open();
    row('300').click();
    await flush();
    expect(state.setLevel).toHaveBeenCalledWith(300);
    expect(rows()).toHaveLength(0);
    expect(panels.open()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('moves with the arrow keys (up is higher), skipping what is disabled, and stops at the ends', async () => {
    const { row, open, key } = setup({ level: 850, levels: ['surface', 850, 700, 500] });
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
    const { trigger, rows, key, flush } = setup();
    trigger().focus();
    const event = key(trigger(), 'ArrowDown');
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(8);
  });

  it('closes on Escape without the key reaching the page, so a menu around it stays open', async () => {
    const { row, open, key, rows, flush, trigger } = setup({ inline: true });
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
    const { row, open, key } = setup();
    const reachedPage = vi.fn();
    window.addEventListener('keydown', reachedPage);
    await open();
    key(row('Ground'), 'ArrowUp');
    window.removeEventListener('keydown', reachedPage);
    expect(reachedPage).not.toHaveBeenCalled();
  });

  it('closes when another panel opens, and when the page is clicked elsewhere', async () => {
    const { rows, open, flush, panels } = setup();
    await open();
    panels.open.set('models');
    await flush();
    expect(rows()).toHaveLength(0);

    await open();
    expect(rows()).toHaveLength(8);
    document.body.click();
    await flush();
    expect(rows()).toHaveLength(0);
  });

  it('in the menu it opens in place, not through the panel service', async () => {
    const { rows, open, panels } = setup({ inline: true });
    await open();
    expect(rows()).toHaveLength(8);
    expect(panels.open()).toBeNull();
  });

  it('says what choosing an altitude does to a layer that is not drawn there', async () => {
    const ground = setup({ layer: 'rain' });
    await ground.open();
    expect(ground.el.querySelector('.note')!.textContent).toContain('Rain exists at the ground only');
    document.body.innerHTML = '';
    TestBed.resetTestingModule();

    const aloft = setup({ layer: 'vertical', level: 850 });
    await aloft.open();
    expect(aloft.el.querySelector('.note')!.textContent).toContain('exists only aloft');
    document.body.innerHTML = '';
    TestBed.resetTestingModule();

    const both = setup({ layer: 'temp' });
    await both.open();
    expect(both.el.querySelector('.note')).toBeNull();
  });
});
