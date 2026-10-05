import { Component, computed, inject, ViewChild, signal } from '@angular/core';
import { MapComponent } from './features/map/map.component';
import { LayersComponent } from './features/layers/layers.component';
import { ForecastRailComponent } from './features/forecast/forecast-rail.component';
import { ForecastTimelineComponent } from './features/forecast/forecast-timeline.component';
import { ForecastInspectorComponent } from './features/forecast/forecast-inspector.component';
import { RadarService } from './core/services/radar.service';
import { MapLayerService } from './core/services/map-layer.service';
import { RadarProductKey } from './core/domain/models/radar.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    MapComponent,
    LayersComponent,
    ForecastRailComponent,
    ForecastTimelineComponent,
    ForecastInspectorComponent
  ],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  @ViewChild(MapComponent) mapComponent!: MapComponent;

  readonly radarService = inject(RadarService);
  readonly layerService = inject(MapLayerService);

  readonly showLayers = signal(false);
  readonly activeProduct = this.radarService.activeProduct;
  readonly radarActive = computed(() => this.layerService.layers().some(l => l.id === 'radar' && l.active));

  toggleLayers(): void {
    this.showLayers.update(v => !v);
  }

  setProduct(product: RadarProductKey): void {
    this.radarService.setProduct(product);
  }

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
