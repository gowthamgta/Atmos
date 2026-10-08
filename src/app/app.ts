import { Component, ViewChild } from '@angular/core';
import { MapComponent } from './features/map/map.component';
import { AboutComponent } from './features/about/about.component';
import { RadarPanelComponent } from './features/radar/radar-panel.component';
import { SatellitePanelComponent } from './features/satellite/satellite-panel.component';
import { GibsPanelComponent } from './features/satellite/gibs-panel.component';
import { ImergPanelComponent } from './features/satellite/imerg-panel.component';
import { ForecastLegendComponent } from './features/forecast/forecast-legend.component';
import { LayerMenuComponent } from './features/menu/layer-menu.component';
import { ForecastTimelineComponent } from './features/forecast/forecast-timeline.component';
import { ForecastInspectorComponent } from './features/forecast/forecast-inspector.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    MapComponent,
    AboutComponent,
    RadarPanelComponent,
    SatellitePanelComponent,
    GibsPanelComponent,
    ImergPanelComponent,
    ForecastLegendComponent,
    LayerMenuComponent,
    ForecastTimelineComponent,
    ForecastInspectorComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  @ViewChild(MapComponent) mapComponent!: MapComponent;

  recenter(): void {
    this.mapComponent?.flyToMosaicCenter();
  }

  zoomIn(): void {
    this.mapComponent?.zoomIn();
  }

  zoomOut(): void {
    this.mapComponent?.zoomOut();
  }
}
