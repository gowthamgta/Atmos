import { Component, inject } from '@angular/core';
import { MapComponent } from './features/map/map.component';
import { AboutComponent } from './features/about/about.component';
import { RadarPanelComponent } from './features/radar/radar-panel.component';
import { SatellitePanelComponent } from './features/satellite/satellite-panel.component';
import { GibsPanelComponent } from './features/satellite/gibs-panel.component';
import { ForecastLegendComponent } from './features/forecast/forecast-legend.component';
import { MenuPanelComponent } from './features/menu/menu-panel.component';
import { MeteogramComponent } from './features/meteogram/meteogram.component';
import { LayerRailComponent } from './features/menu/layer-rail.component';
import { ForecastTimelineComponent } from './features/forecast/forecast-timeline.component';
import { PlaceCardComponent } from './features/place/place-card.component';
import { MapControlsComponent } from './features/map/map-controls.component';
import { ForecastCatalogService } from './core/forecast/forecast-catalog.service';
import { PanelService } from './core/ui/panel.service';
import { UrlStateService } from './core/ui/url-state.service';
import { IconComponent } from './shared/icon.component';
import { StationCardComponent } from './features/observations/station-card.component';
import { ThemeService } from './shared/theme.service';
import { PerfMeterComponent } from './features/perf/perf-meter.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    MapComponent,
    AboutComponent,
    RadarPanelComponent,
    SatellitePanelComponent,
    GibsPanelComponent,
    ForecastLegendComponent,
    MenuPanelComponent,
    MeteogramComponent,
    LayerRailComponent,
    ForecastTimelineComponent,
    PlaceCardComponent,
    MapControlsComponent,
    IconComponent,
    StationCardComponent,
    PerfMeterComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly panels = inject(PanelService);
  // created at the start: the saved theme is applied before the first paint, and a shared link is applied before the map opens
  private readonly theme = inject(ThemeService);
  private readonly urlState = inject(UrlStateService);

  protected retry(): void {
    void this.catalog.refresh();
  }
}
