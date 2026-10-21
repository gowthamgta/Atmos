import { Injectable, computed, signal } from '@angular/core';
import { summarizeSkill, type ModelSkill, type VerificationFile } from './verification';

/** Days the model list sums the scores over. */
export const SKILL_WINDOW_DAYS = 14;

/** The models' recent scores at the airports (see verification.ts), loaded the first time they are asked for. */
@Injectable({ providedIn: 'root' })
export class VerificationService {
  private readonly file = signal<VerificationFile | null>(null);
  private asked = false;

  /** Skill by model id, a day ahead, over the last SKILL_WINDOW_DAYS days (empty until loaded, or when the file is missing). */
  readonly skill = computed<ReadonlyMap<string, ModelSkill>>(() => {
    const f = this.file();
    return new Map((f ? summarizeSkill(f, SKILL_WINDOW_DAYS, 1) : []).map(s => [s.modelId, s]));
  });
  /** The airports the scores come from. */
  readonly airportCount = computed(() => this.file()?.airports.length ?? 0);

  load(): void {
    if (this.asked) return;
    this.asked = true;
    fetch('/data/verification/scores.json')
      .then(r => (r.ok ? r.json() : null))
      .then((f: VerificationFile | null) => { if (f?.days?.length) this.file.set(f); })
      .catch(() => { this.asked = false; }); // ask again next time the list opens
  }
}
