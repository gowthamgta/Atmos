import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'dark' | 'light';
const KEY = 'atmosiq-theme';

/** Interface theme: the saved choice, else the system's. Sets data-theme on <html> (see styles.css). The map stays dark in both. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(this.initial());

  constructor() {
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0a1224' : '#ffffff');
      try {
        localStorage.setItem(KEY, t);
      } catch {
        /* storage blocked: the choice just lasts for this visit */
      }
    });
  }

  toggle(): void {
    this.theme.update(t => (t === 'dark' ? 'light' : 'dark'));
  }

  private initial(): Theme {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      /* ignore */
    }
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
}
