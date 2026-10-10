import { Component, HostListener, ViewChild, inject, signal } from '@angular/core';
import { MapComponent } from './features/map/map.component';
import { AboutComponent } from './features/about/about.component';
import { RadarPanelComponent } from './features/radar/radar-panel.component';
import { SatellitePanelComponent } from './features/satellite/satellite-panel.component';
import { GibsPanelComponent } from './features/satellite/gibs-panel.component';
import { ForecastLegendComponent } from './features/forecast/forecast-legend.component';
import { LayerMenuComponent } from './features/menu/layer-menu.component';
import { ForecastTimelineComponent } from './features/forecast/forecast-timeline.component';
import { ForecastInspectorComponent } from './features/forecast/forecast-inspector.component';
import { ForecastCatalogService } from './core/forecast/forecast-catalog.service';
import { IconComponent } from './shared/icon.component';
import { ThemeService } from './shared/theme.service';

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
    LayerMenuComponent,
    ForecastTimelineComponent,
    ForecastInspectorComponent,
    IconComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  @ViewChild(MapComponent) mapComponent!: MapComponent;

  protected readonly theme = inject(ThemeService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly fullscreen = signal(false);
  protected readonly fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled === true;

  recenter(): void {
    this.mapComponent?.flyToMosaicCenter();
  }

  zoomIn(): void {
    this.mapComponent?.zoomIn();
  }

  zoomOut(): void {
    this.mapComponent?.zoomOut();
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  @HostListener('document:fullscreenchange')
  protected onFullscreenChange(): void {
    this.fullscreen.set(!!document.fullscreenElement);
  }

  protected retry(): void {
    void this.catalog.refresh();
  }
}
