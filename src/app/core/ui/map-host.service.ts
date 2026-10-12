import { Injectable } from '@angular/core';

/** What the map offers to the rest of the interface (the zoom buttons, the search, the home button). */
export interface MapHost {
  zoomIn(): void;
  zoomOut(): void;
  /** Back to the home view (all of South India, centred on Kallakurichi). */
  home(): void;
  flyTo(lat: number, lon: number, zoom?: number): void;
  /** Moves the camera through the given views, one after the other, each taking `msPerLeg` (the map speed test). */
  tour(legs: readonly { lat: number; lon: number; zoom: number }[], msPerLeg: number): Promise<void>;
  /** The view now, and the graphics chip drawing it. */
  view(): { lat: number; lon: number; zoom: number } | null;
  renderer(): string;
  /** Pans the map just enough that the point lies in the part of the screen left clear (distances in px from each edge). */
  ensureVisible(lat: number, lon: number, clear: { top: number; right: number; bottom: number; left: number }): void;
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

  tour(legs: readonly { lat: number; lon: number; zoom: number }[], msPerLeg: number): Promise<void> {
    return this.host?.tour(legs, msPerLeg) ?? Promise.resolve();
  }

  view(): { lat: number; lon: number; zoom: number } | null {
    return this.host?.view() ?? null;
  }

  renderer(): string {
    return this.host?.renderer() ?? '';
  }

  ensureVisible(lat: number, lon: number, clear: { top: number; right: number; bottom: number; left: number }): void {
    this.host?.ensureVisible(lat, lon, clear);
  }
}
