import { Injectable, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/** A new release found this soon after the page opened is put in place at once: the viewer has hardly started, and would otherwise use the old one. */
const JUST_OPENED_MS = 15_000;

/**
 * Puts a new release of the app in place without getting in the way: the service worker downloads it in the background. Found in the first
 * seconds after the page opened (the usual case: the worker serves the release it has, then finds the new one), the page reloads into it at
 * once; later, the next time the page is out of sight (another app or tab in front), never while it is being looked at.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly updates = inject(SwUpdate);

  start(): void {
    if (!this.updates.isEnabled) return;
    this.updates.versionUpdates.subscribe(event => {
      if (event.type !== 'VERSION_READY') return;
      if (performance.now() < JUST_OPENED_MS) {
        void this.updates.activateUpdate().then(() => location.reload());
        return;
      }
      const reloadWhenHidden = () => {
        if (document.visibilityState !== 'hidden') return;
        document.removeEventListener('visibilitychange', reloadWhenHidden);
        void this.updates.activateUpdate().then(() => location.reload());
      };
      document.addEventListener('visibilitychange', reloadWhenHidden);
      reloadWhenHidden();
    });
    // a page left open for days still learns of new releases
    setInterval(() => void this.updates.checkForUpdate().catch(() => undefined), 6 * 3_600_000);
  }
}
