import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  booleanAttribute,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { altitudeFeet, altitudeFeetLine, altitudeLabels, altitudeSubline, flightLevel, roundedMetres } from '../../core/forecast/altitude';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ALL_LEVELS, Level, PRESSURE_LEVELS, forecastLayerById, supportsLevels } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { PanelService } from '../../core/ui/panel.service';
import { IconComponent } from '../../shared/icon.component';

/** Highest first, the way an altitude list reads: the ground is at the bottom. */
const LADDER: readonly Level[] = [...[...PRESSURE_LEVELS].reverse(), 'surface'];
/** How long the knob rests before the map follows it, so that sweeping across the altitudes loads only the one it stops at. */
const REST_MS = 200;
/** The keys a slider moves with: they stay off the page, where the time bar would step the forecast. */
const SLIDER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * The altitude the layers are drawn at, as windy.com shows it: an airplane button with a pill behind it that names the altitude ("700 hPa",
 * "3000 m · 10000 ft") when the layers are drawn aloft (or when the button is pointed at). On the map the button opens a slider in the pill,
 * the ground at the left end and the highest altitude at the right, and the map follows the knob when it rests. In the menu (`inline`) it is a
 * full-width button and the list of altitudes opens in place (highest at the top, the ground at the bottom). The chosen altitude, the knob
 * and the airplane take the accent colour, like everything chosen.
 */
@Component({
  selector: 'app-altitude-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { '[class.inline]': 'inline()', '[class.aloft]': 'aloft()', '[class.open]': 'isOpen()' },
  template: `
    <div class="control" (keydown)="onKeydown($event)" (focusout)="onFocusOut($event)">
      @if (inline()) {
        <button
          #trigger type="button" class="trigger" aria-haspopup="listbox" [attr.aria-expanded]="isOpen()" [attr.aria-controls]="isOpen() ? listId : null"
          [attr.aria-label]="ariaLabel()" [title]="hint()" (click)="toggle()"
        >
          <span class="pill" aria-hidden="true">
            <span class="readout">
              <span class="p-name">{{ current().name }}</span>
              <span class="p-sub">{{ subline() }}</span>
            </span>
          </span>
          <app-icon class="chev" name="chevron" [size]="16" />
          <span class="thumb"><app-icon name="plane" [size]="20" /></span>
        </button>

        @if (isOpen()) {
          <div class="sheet">
            <div class="ladder" role="listbox" aria-label="Altitude" [id]="listId">
              @for (row of rows(); track row.level) {
                <button
                  type="button" role="option" class="row" [class.on]="row.on" [attr.aria-selected]="row.on" [disabled]="!row.available"
                  [attr.tabindex]="row.on ? 0 : -1" [title]="row.title" (click)="choose(row.level)"
                >
                  <span class="r-name">{{ row.labels.name }}</span>
                  <span class="r-m">{{ row.labels.metres }}</span>
                  <span class="r-fl">{{ row.labels.flight }}</span>
                </button>
              }
            </div>
            @if (note(); as n) { <p class="note">{{ n }}</p> }
          </div>
        }
      } @else {
        <button
          #trigger type="button" class="trigger" [attr.aria-expanded]="isOpen()" [attr.aria-controls]="isOpen() ? listId : null"
          [attr.aria-label]="ariaLabel()" [title]="hint()" (click)="toggle()"
        >
          <span class="thumb"><app-icon name="plane" [size]="20" /></span>
        </button>

        <div class="pill" (click)="onPillClick()">
          <span class="readout" aria-hidden="true">
            <span class="p-name">{{ shown().name }}</span>
            <span class="p-sub">{{ shownSub() }}</span>
          </span>
          @if (isOpen()) {
            <input
              #slider type="range" class="slider" [id]="listId" aria-label="Altitude" min="0" [attr.max]="stops().length - 1" step="1"
              [value]="knobAt()" [attr.aria-valuetext]="spoken()" (input)="onSlide($event)" (change)="commit()"
            />
          }
        </div>

        @if (isOpen()) {
          @if (note(); as n) { <p class="caption">{{ n }}</p> }
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; position: relative; }
    .control { position: relative; }

    /* the button: a round airplane button with the pill tucked behind its left side, as on the layer rail */
    .trigger { position: relative; display: block; width: var(--hit); height: var(--hit); padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--text-primary); cursor: pointer; }
    .thumb {
      position: relative; z-index: 1; display: grid; place-items: center; width: var(--hit); height: var(--hit); border-radius: 50%;
      background: var(--surface-1); color: var(--text-primary); box-shadow: var(--shadow-1); transition: background var(--t-fast), color var(--t-fast);
    }
    .pill {
      position: absolute; top: 50%; right: calc(var(--hit) / 2); transform: translate(8px, -50%); display: flex; align-items: center; gap: var(--sp-2);
      height: calc(var(--hit) - 2px); padding: 0 calc(var(--hit) / 2 + 6px) 0 var(--sp-3); border-radius: calc(var(--hit) / 2); background: var(--surface-1); box-shadow: var(--shadow-1);
      white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity var(--t-fast), transform var(--t-fast);
    }
    .readout { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; line-height: 1.15; }
    .p-name { font-size: var(--fs-m); font-weight: var(--fw-strong); font-variant-numeric: tabular-nums; }
    .p-sub { font-size: var(--fs-xs); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .chev { display: none; }
    @media (hover: hover) {
      .trigger:hover .pill, .trigger:hover + .pill { opacity: 1; transform: translate(0, -50%); }
      .trigger:hover .thumb { background: var(--surface-2); }
    }
    .trigger:focus-visible { outline-offset: 0; }
    .trigger:focus-visible .pill, .trigger:focus-visible + .pill { opacity: 1; transform: translate(0, -50%); }
    .trigger[aria-expanded='true'] .thumb { box-shadow: 0 0 0 2px var(--accent-strong), var(--shadow-1); }

    /* drawn aloft: the one place where the altitude is not the ground, so it is named and in the accent colour */
    :host(.aloft) .pill { opacity: 1; transform: translate(0, -50%); pointer-events: auto; background: var(--accent); color: var(--on-accent); cursor: pointer; }
    :host(.aloft) .p-sub { color: inherit; opacity: 0.85; }
    :host(.aloft) .thumb, :host(.aloft) .trigger:hover .thumb { background: var(--accent); color: var(--on-accent); }

    /* on the map, opened: the pill becomes the bar of the slider, in the usual colours (the knob and the airplane carry the accent) */
    :host(:not(.inline).open) .pill { opacity: 1; transform: translate(0, -50%); pointer-events: auto; cursor: default; }
    :host(:not(.inline).aloft.open) .pill { background: var(--surface-1); color: var(--text-primary); }
    :host(:not(.inline).aloft.open) .p-sub { color: var(--text-secondary); opacity: 1; }
    :host(:not(.inline).open) .readout { min-width: 104px; }

    /* the slider: a thin line and a round knob; it steps through the altitudes, so the browser's own range input does the dragging, the keys and the touch */
    .slider {
      -webkit-appearance: none; appearance: none; display: block; width: clamp(96px, calc(100vw - 210px), 240px); height: var(--hit); margin: 0; padding: 0;
      background: transparent; cursor: pointer; touch-action: none; outline: none;
    }
    .slider::-webkit-slider-runnable-track { height: 2px; border-radius: 1px; background: var(--text-muted); }
    .slider::-moz-range-track { height: 2px; border-radius: 1px; background: var(--text-muted); }
    .slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none; width: 22px; height: 22px; margin-top: -10px; border: 0; border-radius: 50%;
      background: var(--accent); box-shadow: var(--shadow-1); transition: box-shadow var(--t-fast);
    }
    .slider::-moz-range-thumb { width: 22px; height: 22px; border: 0; border-radius: 50%; background: var(--accent); box-shadow: var(--shadow-1); transition: box-shadow var(--t-fast); }
    .slider:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--accent-strong); }
    .slider:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--accent-strong); }

    /* what choosing an altitude does to a layer that does not exist there, under the bar */
    .caption {
      position: absolute; top: calc(100% + 6px); right: 0; width: max-content; max-width: min(260px, calc(100vw - 2 * var(--gutter))); margin: 0; padding: var(--sp-2) var(--sp-3);
      border-radius: var(--radius-m); background: var(--surface-1); box-shadow: var(--shadow-1); font-size: var(--fs-xs); line-height: var(--lh-normal, 1.4); color: var(--text-secondary);
    }

    /* the list in the menu */
    .sheet { padding: var(--sp-1); background: var(--surface-solid); border-radius: var(--radius-l); }
    .ladder { display: flex; flex-direction: column; }
    .row {
      display: grid; grid-template-columns: 4.7em 1fr 3.3em; align-items: center; column-gap: var(--sp-2); min-height: calc(var(--hit) - 4px); padding: 0 var(--sp-3);
      border: 0; border-radius: var(--radius-m); background: transparent; color: var(--text-primary); font-size: var(--fs-m); text-align: left; cursor: pointer;
      font-variant-numeric: tabular-nums; transition: background var(--t-fast);
    }
    .row:hover:not(:disabled):not(.on) { background: var(--surface-3); }
    .row.on { background: var(--accent); color: var(--on-accent); }
    .row:disabled { opacity: 0.4; cursor: not-allowed; }
    .row:focus-visible { outline-offset: -2px; }
    .r-name { font-size: var(--fs-l); font-weight: var(--fw-strong); }
    .r-m { text-align: right; }
    .r-fl { text-align: right; color: var(--text-muted); }
    .row.on .r-fl { color: inherit; opacity: 0.85; }
    .note { margin: var(--sp-1) var(--sp-1) var(--sp-1); padding: var(--sp-2) var(--sp-2) 0; border-top: 1px solid var(--line); font-size: var(--fs-xs); line-height: var(--lh-normal, 1.4); color: var(--text-muted); }

    /* in the menu: a full-width button, and the list opens under it */
    :host(.inline) .trigger { display: flex; align-items: center; gap: var(--sp-2); width: 100%; height: auto; min-height: var(--tap); padding: 4px 4px 4px var(--sp-4); border-radius: calc(var(--tap) / 2 + 4px); background: var(--surface-3); text-align: left; transition: background var(--t-fast); }
    :host(.inline) .trigger:hover { background: var(--surface-4); }
    :host(.inline) .pill, :host(.inline.aloft) .pill { position: static; transform: none; opacity: 1; pointer-events: auto; flex: 1; min-width: 0; height: auto; padding: 0; background: transparent; box-shadow: none; color: var(--text-primary); cursor: inherit; }
    :host(.inline) .p-name { font-size: var(--fs-l); }
    :host(.inline) .p-sub { font-size: var(--fs-s); color: var(--text-secondary); opacity: 1; }
    :host(.inline) .chev { display: inline-flex; color: var(--text-muted); transition: transform var(--t-fast); }
    :host(.inline.open) .chev { transform: rotate(180deg); }
    :host(.inline) .thumb { background: var(--surface-4); box-shadow: none; }
    :host(.inline.aloft) .thumb { background: var(--accent); color: var(--on-accent); }
    :host(.inline) .trigger[aria-expanded='true'] .thumb { box-shadow: none; }
    :host(.inline) .sheet { margin-top: var(--sp-1); background: var(--surface-3); }
    :host(.inline) .row:hover:not(:disabled):not(.on) { background: var(--surface-4); }
  `]
})
export class AltitudePickerComponent {
  /** In the menu: the list opens in place and the button is as wide as its column. On the map a slider opens beside the button. */
  readonly inline = input(false, { transform: booleanAttribute });

  private readonly state = inject(ForecastStateService);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly panels = inject(PanelService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly slider = viewChild<ElementRef<HTMLInputElement>>('slider');

  private static nextId = 0;
  protected readonly listId = `altitude-list-${AltitudePickerComponent.nextId++}`;

  /** Whether the list is open, for the one in the menu (the one on the map goes through the panel service, so it never opens with another panel). */
  private readonly menuOpen = signal(false);

  protected readonly isOpen = computed(() => (this.inline() ? this.menuOpen() : this.panels.open() === 'altitude'));
  protected readonly aloft = computed(() => this.state.level() !== 'surface');
  protected readonly current = computed(() => altitudeLabels(this.state.level()));
  protected readonly subline = computed(() => altitudeSubline(this.state.level()));

  protected readonly ariaLabel = computed(() => {
    const level = this.state.level();
    if (level === 'surface') return 'Altitude: the ground. Choose a height';
    return `Altitude: ${level} hPa, about ${roundedMetres(level)} metres, flight level ${flightLevel(level)}. Choose a height`;
  });
  protected readonly hint = computed(() => (this.state.level() === 'surface' ? 'Altitude: the ground. Click to choose a height' : this.ariaLabel()));

  protected readonly rows = computed(() => {
    const have = new Set(this.state.levels());
    const chosen = this.state.level();
    const model = this.catalog.model().label;
    return LADDER.map(level => {
      const labels = altitudeLabels(level);
      const available = have.has(level);
      const title = !available
        ? `${labels.name} is not provided by ${model}`
        : level === 'surface'
          ? 'The ground: 10 m wind and 2 m temperature'
          : `About ${roundedMetres(level)} m up in the standard atmosphere, flight level ${flightLevel(level)}`;
      return { level, labels, available, on: level === chosen, title };
    });
  });

  /** The altitudes the slider steps through, the ground first: the ones the model has. */
  protected readonly stops = computed(() => {
    const have = new Set(this.state.levels());
    return ALL_LEVELS.filter(level => have.has(level));
  });
  /** The altitude under the knob while it is moved, before the map follows (null: the map's own). */
  private readonly draft = signal<Level | null>(null);
  private readonly shownLevel = computed(() => this.draft() ?? this.state.level());
  protected readonly shown = computed(() => altitudeLabels(this.shownLevel()));
  protected readonly shownSub = computed(() => altitudeFeetLine(this.shownLevel()));
  protected readonly knobAt = computed(() => Math.max(0, this.stops().indexOf(this.shownLevel())));
  protected readonly spoken = computed(() => {
    const level = this.shownLevel();
    return level === 'surface' ? 'The ground' : `${level} hPa, about ${roundedMetres(level)} metres, ${altitudeFeet(level)} feet`;
  });

  /** What choosing an altitude does to a layer that does not exist there. */
  protected readonly note = computed(() => {
    const layer = forecastLayerById(this.state.activeLayerId());
    if (!layer) return null;
    if (layer.levelOnly) return `${layer.label} exists only aloft. Choosing the ground shows temperature instead.`;
    if (!supportsLevels(layer)) return `${layer.label} exists at the ground only. Choosing a height shows temperature instead.`;
    return null;
  });

  private rest: ReturnType<typeof setTimeout> | undefined;
  /** Whether the last press began on this control, so a drag of the knob that ends elsewhere is not taken for a click outside. */
  private pressedInside = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.rest));
  }

  protected toggle(): void {
    if (this.isOpen()) this.close(false);
    else this.show();
  }

  /** The pill is part of the button to the eye: pressing it opens the slider too. */
  protected onPillClick(): void {
    if (!this.isOpen()) this.show();
  }

  protected choose(level: Level): void {
    this.state.setLevel(level);
    this.close(true);
  }

  /** The knob moves: its altitude is named at once, and the map follows when it has rested a moment. */
  protected onSlide(event: Event): void {
    const level = this.stops()[Number((event.target as HTMLInputElement).value)];
    if (level === undefined) return;
    this.draft.set(level);
    clearTimeout(this.rest);
    this.rest = setTimeout(() => this.commit(), REST_MS);
  }

  /** The map goes to the altitude of the knob (at once when it is let go). */
  protected commit(): void {
    clearTimeout(this.rest);
    const level = this.draft();
    if (level === null) return;
    this.draft.set(null);
    if (level !== this.state.level()) this.state.setLevel(level);
  }

  private show(): void {
    if (this.inline()) this.menuOpen.set(true);
    else this.panels.open.set('altitude');
    afterNextRender(() => {
      // the chosen altitude takes the focus (the knob, or its row in the list); in the menu the whole list is brought into view (it opens
      // below the button, perhaps past the panel's edge)
      if (this.inline()) {
        this.options().find(o => o.getAttribute('aria-selected') === 'true')?.focus({ preventScroll: true });
        this.host.nativeElement.querySelector('.sheet')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      } else {
        this.slider()?.nativeElement.focus();
      }
    }, { injector: this.injector });
  }

  private close(restoreFocus: boolean): void {
    this.commit();
    if (this.inline()) this.menuOpen.set(false);
    else this.panels.close('altitude');
    if (restoreFocus) this.trigger().nativeElement.focus();
  }

  /** The altitudes that can be chosen, top to bottom. */
  private options(): HTMLButtonElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLButtonElement>('[role="option"]')].filter(o => !o.disabled);
  }

  /**
   * Escape closes it; the arrow keys open it from the button. In the list they move through it (up is higher), Home and End go to the highest
   * and the ground, Enter or Space chooses; the slider moves with its own keys. The keys stop here: the time bar listens for arrow keys on
   * the whole page, and Escape would also close the menu.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      if (!this.isOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
      return;
    }
    if (!this.isOpen()) {
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.target === this.trigger().nativeElement) {
        event.preventDefault();
        event.stopPropagation();
        this.show();
      }
      return;
    }
    if (!this.inline()) {
      if (SLIDER_KEYS.has(event.key)) event.stopPropagation();
      return;
    }
    const options = this.options();
    const at = options.indexOf(event.target as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowUp': next = at <= 0 ? 0 : at - 1; break;
      case 'ArrowDown': next = at < 0 ? 0 : Math.min(at + 1, options.length - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = options.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    options[next]?.focus();
  }

  /** Moving the focus out of the control (Tab) closes it. */
  protected onFocusOut(event: FocusEvent): void {
    const to = event.relatedTarget as Node | null;
    if (this.isOpen() && to && !this.host.nativeElement.contains(to)) this.close(false);
  }

  /** The one on the map closes with Escape pressed anywhere, as the model list does. */
  @HostListener('window:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    if (this.inline() || !this.isOpen()) return;
    this.close(false);
    event.preventDefault();
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onPointerDown(event: Event): void {
    this.pressedInside = this.host.nativeElement.contains(event.target as Node | null);
  }

  /** Clicking anywhere outside closes it (the button that opens it does not count as outside, nor does a drag of the knob that ended elsewhere). */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (this.isOpen() && !this.pressedInside && !this.host.nativeElement.contains(event.target as Node | null)) this.close(false);
  }
}
