import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { PanelService } from '../../core/ui/panel.service';
import { IconComponent } from '../../shared/icon.component';

interface Credit {
  name: string;
  what: string;
}

/** Credits for every data source, which the open-data providers ask to be shown. */
const CREDITS: readonly Credit[] = [
  { name: 'ECMWF IFS', what: 'ECMWF open data (CC BY 4.0)' },
  { name: 'UK Met Office', what: 'Contains Met Office data' },
  { name: 'Model files', what: 'Republished by Open-Meteo.com (CC BY 4.0)' },
  { name: 'Radar', what: 'India Meteorological Department (IMD), observed' },
  { name: 'Satellite', what: 'Meteosat-9 over India, © EUMETSAT, via EUMETView; the 250 m VIIRS and MODIS true-colour pictures via NASA GIBS (EOSDIS); cyclone tracks from ECMWF open data' },
  { name: 'Terrain', what: 'Copernicus DEM GLO-30 (© DLR and Airbus), averaged to 90 m' },
  { name: 'Boundaries', what: 'geoBoundaries (ODbL), from the Local Government Directory of India' },
  { name: 'Base map', what: '© OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors; hillshade © Esri' },
];


@Component({
  selector: 'app-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <button type="button" class="btn-icon" (click)="panels.toggle('about')" [attr.aria-expanded]="open()" aria-haspopup="dialog" aria-label="About and data credits" title="About and data credits">
      <app-icon name="info" [size]="17" />
    </button>

    @if (open()) {
      <div class="backdrop" (click)="panels.close('about')" aria-hidden="true"></div>
      <section class="card" role="dialog" aria-label="About AtmosIQ">
        <header>
          <strong>About AtmosIQ</strong>
          <button type="button" class="btn-icon" (click)="panels.close('about')" aria-label="Close" title="Close (Esc)"><app-icon name="close" [size]="16" /></button>
        </header>
        <div class="scroll">
          <p>
            A forecast map for South India and the seas around it: ECMWF IFS for all of India and the UK Met Office model for
            South India, with temperature and humidity adjusted to the 90 m terrain. A personal, non-commercial project;
            forecasts are model output and not a safety warning, so follow IMD for official alerts.
          </p>
          <h2>Keyboard</h2>
          <ul class="keys">
            <li><kbd>Space</kbd> play or pause</li>
            <li><kbd>←</kbd> <kbd>→</kbd> one hour back or forward</li>
            <li><kbd>Shift</kbd> + <kbd>←</kbd> <kbd>→</kbd> one day</li>
            <li><kbd>Esc</kbd> close a panel</li>
          </ul>
          <h2>Data</h2>
          <ul>
            @for (c of credits; track c.name) {
              <li><span class="name">{{ c.name }}</span><span class="what">{{ c.what }}</span></li>
            }
          </ul>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .backdrop { position: fixed; inset: 0; z-index: 1100; background: var(--scrim); }
    .card {
      position: fixed; z-index: 1101; top: calc(var(--bar-h) + 8px); right: var(--gutter); width: min(400px, calc(100vw - 24px));
      max-height: calc(100dvh - var(--bar-h) - 20px); display: flex; flex-direction: column; color: var(--text-primary);
      background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-l); box-shadow: var(--shadow-2); animation: sheet-in var(--t-med) both;
    }
    header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px 6px 16px; }
    header strong { font-size: 15px; }
    .scroll { overflow-y: auto; padding: 0 16px 16px; }
    p { margin: 4px 0 14px; font-size: 13px; line-height: 1.55; color: var(--text-secondary); }
    h2 { margin: 0 0 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
    ul { list-style: none; margin: 0 0 14px; padding: 0; }
    li { display: flex; flex-direction: column; padding: 7px 0; border-top: 1px solid var(--line); font-size: 12px; }
    .keys li { flex-direction: row; align-items: center; gap: 5px; color: var(--text-secondary); }
    kbd { font: 600 11px var(--font-mono); padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--surface-3); color: var(--text-primary); }
    .name { font-weight: 650; }
    .what { color: var(--text-secondary); }
    @media (max-width: 700px) {
      .card { top: auto; bottom: 0; left: 0; right: 0; width: auto; max-height: 82dvh; border-radius: var(--radius-l) var(--radius-l) 0 0; }
    }
  `]
})
export class AboutComponent {
  protected readonly credits = CREDITS;
  protected readonly panels = inject(PanelService);
  protected readonly open = computed(() => this.panels.open() === 'about');

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    this.panels.close('about');
  }
}
