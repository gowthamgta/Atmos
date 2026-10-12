import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Arrow keys for a row of tabs (role="tab" buttons in a role="tablist"): left and right move to the neighbour, Home and End to the ends, and the
 * tab reached is chosen at once, as in the WAI-ARIA tabs pattern. The buttons carry tabindex 0 when chosen and -1 otherwise, so Tab moves
 * through the row as one stop. The keys stop here, because the time bar listens for arrow keys on the whole page and would step the forecast.
 */
@Directive({
  selector: '[appRovingTabs]',
  host: { '(keydown)': 'onKey($event)' },
})
export class RovingTabsDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected onKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    const tabs = [...this.host.nativeElement.querySelectorAll<HTMLElement>('[role="tab"]')].filter(t => !(t as HTMLButtonElement).disabled);
    if (tabs.length === 0) return;
    const at = tabs.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    event.stopPropagation();
    tabs[next].focus();
    tabs[next].click();
  }
}
