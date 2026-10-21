import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RadarService } from '../../core/services/radar.service';

/** The radar readout under the pointer (echo, rain rate, beam heights; see radar-inspector.ts), placed at the pointer on the map. */
@Component({
  selector: 'app-radar-hover-tooltip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (radar.hoverInfo(); as info) {
      <div
        class="radar-hover-tooltip"
        [style.left.px]="info.x"
        [style.top.px]="info.y"
      >
        @if (info.dbz !== null) {
        <div class="tooltip-top-row">
          <span
            class="tooltip-badge-dot"
            [style.background-color]="info.color"
            [style.box-shadow]="'0 0 10px ' + info.color"
          ></span>
          <span class="tooltip-dbz-val" [style.color]="info.color">
            {{ info.dbz }} dBZ
          </span>
          <span class="tooltip-rate-lbl">{{ info.rate }}</span>
        </div>
        }
        <div class="tooltip-desc-row">
          <strong style="color: #f8fafc">{{ info.label }}</strong>
          <span class="tooltip-sep">•</span>
          <span class="tooltip-coords">
            {{ info.lat.toFixed(3) }}°N, {{ info.lng.toFixed(3) }}°E
          </span>
        </div>
        @if (info.beams.length > 0) {
          <div class="tooltip-beams">
            @for (b of info.beams; track b.name) {
              <div class="tooltip-beam">
                <span>{{ b.name }} <span class="tooltip-beam-dist">{{ b.distanceKm.toFixed(0) }} km</span></span>
                <strong>{{ b.centreKm.toFixed(1) }} km up</strong>
                <span class="tooltip-beam-dist">{{ b.bottomKm.toFixed(1) }}–{{ b.topKm.toFixed(1) }}</span>
              </div>
            }
            <div class="tooltip-beam-note">{{ info.beamNote }}</div>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .radar-hover-tooltip {
      position: absolute;
      transform: translate(14px, -110%);
      pointer-events: none;
      z-index: 1000;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(56, 189, 248, 0.35);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 15px rgba(56, 189, 248, 0.15);
      border-radius: 10px;
      padding: 0.55rem 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      white-space: nowrap;
      animation: tooltipFadeIn 0.15s ease-out;
    }
    @keyframes tooltipFadeIn {
      from { opacity: 0; transform: translate(14px, -95%) scale(0.95); }
      to { opacity: 1; transform: translate(14px, -110%) scale(1); }
    }
    .tooltip-top-row {
      display: flex;
      align-items: center;
      gap: 0.45rem;
    }
    .tooltip-badge-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tooltip-dbz-val {
      font-size: 0.95rem;
      font-weight: 800;
      font-family: monospace;
      letter-spacing: -0.02em;
    }
    .tooltip-rate-lbl {
      font-size: 0.75rem;
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    .tooltip-desc-row {
      font-size: 0.75rem;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .tooltip-beams {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(148, 163, 184, 0.25);
      display: grid;
      gap: 2px;
      font-size: 11px;
      color: #cbd5e1;
    }
    .tooltip-beam {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 8px;
      align-items: baseline;
    }
    .tooltip-beam strong { color: #f8fafc; }
    .tooltip-beam-dist { color: #94a3b8; font-size: 11px; }
    .tooltip-beam-note { margin-top: 2px; color: #94a3b8; font-size: 11px; max-width: 240px; }
    .tooltip-sep {
      color: #475569;
    }
    .tooltip-coords {
      font-family: monospace;
      font-size: 0.72rem;
      color: #64748b;
    }
  `],
})
export class RadarHoverTooltipComponent {
  protected readonly radar = inject(RadarService);
}
