import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { RovingTabsDirective } from './roving-tabs.directive';

@Component({
  imports: [RovingTabsDirective],
  template: `
    <div role="tablist" appRovingTabs>
      <button type="button" role="tab" id="a" (click)="clicked.push('a')">A</button>
      <button type="button" role="tab" id="b" (click)="clicked.push('b')">B</button>
      <button type="button" role="tab" id="c" (click)="clicked.push('c')">C</button>
      <button type="button" role="tab" id="d" disabled>D</button>
    </div>
  `,
})
class HostComponent {
  clicked: string[] = [];
}

function setup() {
  const fixture = TestBed.createComponent(HostComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const tab = (id: string) => fixture.nativeElement.querySelector(`#${id}`) as HTMLButtonElement;
  const press = (from: string, key: string) => {
    tab(from).focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    tab(from).dispatchEvent(event);
    return event;
  };
  return { fixture, tab, press };
}

describe('RovingTabsDirective', () => {
  it('moves to the next tab with the right arrow and chooses it', () => {
    const { fixture, tab, press } = setup();
    const event = press('a', 'ArrowRight');
    expect(document.activeElement).toBe(tab('b'));
    expect(fixture.componentInstance.clicked).toEqual(['b']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('goes round: past the last tab to the first, and back from the first to the last (a disabled tab is skipped)', () => {
    const { tab, press } = setup();
    press('c', 'ArrowRight');
    expect(document.activeElement).toBe(tab('a'));
    press('a', 'ArrowLeft');
    expect(document.activeElement).toBe(tab('c'));
  });

  it('goes to the ends with Home and End', () => {
    const { tab, press } = setup();
    press('b', 'End');
    expect(document.activeElement).toBe(tab('c'));
    press('b', 'Home');
    expect(document.activeElement).toBe(tab('a'));
  });

  it('keeps the arrow keys from reaching the page, where the time bar would step the forecast', () => {
    const { press } = setup();
    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    press('a', 'ArrowRight');
    expect(reached).not.toHaveBeenCalled();
    document.removeEventListener('keydown', reached);
  });

  it('leaves other keys alone', () => {
    const { fixture, press } = setup();
    const event = press('a', 'Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(fixture.componentInstance.clicked).toEqual([]);
  });
});
