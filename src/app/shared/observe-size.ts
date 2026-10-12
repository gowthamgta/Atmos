/**
 * Calls back with the size of an element now and whenever it changes (a resize of the window, a sheet that opens). Returns the function that
 * stops watching. Where ResizeObserver is missing, it reports the size once.
 */
export function observeSize(el: Element, callback: (width: number, height: number) => void): () => void {
  const report = (): void => {
    const rect = el.getBoundingClientRect();
    callback(Math.round(rect.width), Math.round(rect.height));
  };
  report();
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(() => report());
  observer.observe(el);
  return () => observer.disconnect();
}
