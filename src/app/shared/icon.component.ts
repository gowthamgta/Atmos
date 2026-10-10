import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ICONS, IconName } from './icons';

/** A decorative icon (aria-hidden); controls that hold only an icon carry their own accessible name. */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" [innerHTML]="markup()"></svg>`,
  styles: [`:host { display: inline-flex; flex: none; line-height: 0; } svg { display: block; }`],
})
export class IconComponent {
  private readonly sanitizer = inject(DomSanitizer);
  readonly name = input.required<IconName>();
  readonly size = input(18);
  // the markup comes from the constant table in icons.ts, never from user input
  protected readonly markup = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(ICONS[this.name()]));
}
