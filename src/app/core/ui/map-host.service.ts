import { Injectable } from '@angular/core';

/** What the map offers to the rest of the interface (the zoom buttons, the search, the home button). */
export interface MapHost {
  zoomIn(): void;
  zoomOut(): void;
  /** Back to the home view (all of South India, centred on Kallakurichi). */
  home(): void;
  flyTo(lat: number, lon: number, zoom?: number): void;
}

/** A small bridge: the map registers itself here, and controls elsewhere on screen use it without knowing the map component. */
@Injectable({ providedIn: 'root' })
export class MapHostService {
  private host: MapHost | null = null;

  register(host: MapHost | null): void {
    this.host = host;
  }

  zoomIn(): void {
    this.host?.zoomIn();
  }

  zoomOut(): void {
    this.host?.zoomOut();
  }

  home(): void {
    this.host?.home();
  }

  flyTo(lat: number, lon: number, zoom?: number): void {
    this.host?.flyTo(lat, lon, zoom);
  }
}
