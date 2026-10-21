import { Injectable, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/**
 * Puts a new release of the app in place without getting in the way: the service worker downloads it in the background, and the page
 * reloads into it the next time it is out of sight (another app or tab in front), never while it is being looked at.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly updates = inject(SwUpdate);

  start(): void {
    if (!this.updates.isEnabled) return;
    this.updates.versionUpdates.subscribe(event => {
      if (event.type !== 'VERSION_READY') return;
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
