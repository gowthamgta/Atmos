import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RadarService } from '../../core/services/radar.service';

/**
 * The radar readout where the map was clicked (see radar-inspector.ts): the echo, its rain rate (and the last hour's) and what kind of rain it
 * is. The coordinates and each radar's beam heights are no longer shown (the owner, 3 Nov 2026: "remove the unwanted tooltip data").
 */
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
        </div>
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
  `],
})
export class RadarHoverTooltipComponent {
  protected readonly radar = inject(RadarService);
}
