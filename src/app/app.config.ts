import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // the app and the forecast stay usable with no signal: the service worker keeps the app, the forecast fields and the basemap (ngsw-config.json).
    // The map keeps timers running, so the app never counts as stable: it registers after 20 s at the latest.
    provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode(), registrationStrategy: 'registerWhenStable:20000' }),
  ]
};
