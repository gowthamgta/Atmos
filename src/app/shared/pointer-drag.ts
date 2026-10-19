/**
 * Follows a drag that began with `start` (a pointerdown) until the pointer is let go: `move` gets every pointermove, wherever on the
 * page the pointer goes, so a drag that leaves the element it began on keeps going. The listeners are removed when it ends.
 */
export function followDrag(start: PointerEvent, move: (e: PointerEvent) => void): void {
  start.preventDefault();
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

/** Where a pointer is along an element, from 0 at its left edge to 1 at its right (clamped). */
export function fractionAlong(el: HTMLElement, clientX: number): number {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
}
