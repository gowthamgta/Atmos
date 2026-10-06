import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { PanelService } from '../../core/ui/panel.service';

interface Credit {
  name: string;
  what: string;
}

/** Credits for every data source, which the open-data providers ask to be shown. */
const CREDITS: readonly Credit[] = [
  { name: 'ECMWF IFS and AIFS', what: 'ECMWF open data (CC BY 4.0)' },
  { name: 'NOAA GFS', what: 'NOAA / NCEP (US public domain)' },
  { name: 'DWD ICON', what: 'Deutscher Wetterdienst open data' },
  { name: 'UK Met Office', what: 'Contains Met Office data' },
  { name: 'Canada GDPS', what: 'Environment and Climate Change Canada' },
  { name: 'CMA GRAPES', what: 'China Meteorological Administration' },
  { name: 'Model files', what: 'Republished by Open-Meteo.com (CC BY 4.0)' },
  { name: 'Radar', what: 'India Meteorological Department (IMD), observed' },
  { name: 'Satellite', what: 'Meteosat-9 (Indian Ocean service), © EUMETSAT, via EUMETView' },
  { name: 'Terrain', what: 'AWS Terrain Tiles (SRTM and other public DEMs)' },
  { name: 'Boundaries', what: 'geoBoundaries (ODbL), from the Local Government Directory of India' },
  { name: 'Base map', what: '© OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors; hillshade © Esri' },
];

@Component({
  selector: 'app-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="info-btn" (click)="panels.toggle('about')" [attr.aria-expanded]="open()" aria-label="About and data credits" title="About and data credits">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>
      </svg>
    </button>

    @if (open()) {
      <div class="backdrop" (click)="panels.close('about')" aria-hidden="true"></div>
      <section class="card glass-panel-solid" role="dialog" aria-label="About AtmosIQ">
        <header>
          <strong>AtmosIQ</strong>
          <button type="button" class="close" (click)="panels.close('about')" aria-label="Close" title="Close (Esc)">×</button>
        </header>
        <p>
          A forecast map for South India and the seas around it. Ten weather models, resampled onto one 0.1° grid, with
          temperature and humidity adjusted to 1 km terrain. A personal, non-commercial project; forecasts are model
          output and not a safety warning, so follow IMD for official alerts.
        </p>
        <h2>Data</h2>
        <ul>
          @for (c of credits; track c.name) {
            <li><span class="name">{{ c.name }}</span><span class="what">{{ c.what }}</span></li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .info-btn {
      width: 44px; height: 44px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12);
      background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(16px); color: var(--text-secondary); cursor: pointer;
      display: grid; place-items: center; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }
    .info-btn:hover { color: var(--neon-cyan); border-color: rgba(0,229,255,0.4); }
    .info-btn:focus-visible, .close:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .backdrop { position: fixed; inset: 0; z-index: 1100; background: rgba(2, 6, 14, 0.5); }
    .card {
      position: fixed; z-index: 1101; top: 64px; right: 14px; width: min(380px, calc(100vw - 28px));
      max-height: calc(100vh - 90px); overflow-y: auto; padding: 16px 18px; color: var(--text-primary); font-family: var(--font-body);
    }
    header { display: flex; justify-content: space-between; align-items: center; }
    header strong { font-size: 16px; }
    .close { width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 24px; cursor: pointer; }
    .close:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    p { margin: 8px 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
    h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; flex-direction: column; padding: 6px 0; border-top: 1px solid rgba(255,255,255,0.07); font-size: 12px; }
    .name { font-weight: 600; }
    .what { color: var(--text-secondary); }
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
