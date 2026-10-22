import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LIGHTNING_AGE_COLOURS, LIGHTNING_CREDIT } from '../../core/forecast/lightning';

/** What the lightning bolts' colours mean: how many minutes ago the stroke was (ILDN, the last 15 minutes). */
@Component({
  selector: 'app-lightning-key',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="key" role="img" aria-label="Lightning in the last 15 minutes, by how long ago: white newest, then yellow, orange and red" [title]="credit">
      <span class="label">Lightning, min ago</span>
      @for (c of colours; track c[2]) {
        <span class="item"><svg viewBox="0 0 48 48" width="15" height="15" aria-hidden="true"><path d="M29 4 L11 27 L23 27 L18 44 L37 20 L25 20 Z" [attr.fill]="c[1]" stroke="rgba(40,8,40,0.9)" stroke-width="4" stroke-linejoin="round" /></svg>{{ c[2] }}</span>
      }
    </div>
  `,
  styles: [`
    .key { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 8px; font-size: 11px; color: var(--text-secondary); }
    .label { margin-right: 2px; }
    .item { display: inline-flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; }
  `],
})
export class LightningKeyComponent {
  protected readonly colours = LIGHTNING_AGE_COLOURS;
  protected readonly credit = LIGHTNING_CREDIT;
}
