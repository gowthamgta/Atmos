import { Injectable, computed, signal } from '@angular/core';
import { nowcastSkill, summarizeSkill, type ModelSkill, type VerificationFile } from './verification';
import type { CorrectionsFile } from '../meteogram/blend';
import { FORECAST_MODELS } from './forecast-models';

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
    return new Map((f ? summarizeSkill(f, SKILL_WINDOW_DAYS, 1, FORECAST_MODELS.map(m => m.id)) : []).map(s => [s.modelId, s]));
  });
  /** The Blend's skill over the same days (null until it has been scored). */
  readonly blendSkill = computed<ModelSkill | null>(() => {
    const f = this.file();
    return (f && summarizeSkill(f, SKILL_WINDOW_DAYS, 1, ['blend'])[0]) || null;
  });
  /** The radar nowcast 30 minutes ahead over the same days (null until there is enough). */
  readonly nowcast30 = computed(() => {
    const f = this.file();
    return f ? nowcastSkill(f, SKILL_WINDOW_DAYS, 30) : null;
  });
  /** The airports the scores come from. */
  readonly airportCount = computed(() => this.file()?.airports.length ?? 0);

  private correctionsPromise: Promise<CorrectionsFile | null> | null = null;
  /** The corrections and Blend weights (learn_bias.py), once loaded; null until then or when they cannot be had. */
  readonly corrections = signal<CorrectionsFile | null>(null);

  /** Loads the corrections once (a failure is asked again next time). */
  loadCorrections(): Promise<CorrectionsFile | null> {
    this.correctionsPromise ??= fetch('/data/verification/corrections.json')
      .then(r => (r.ok ? (r.json() as Promise<CorrectionsFile>) : null))
      .then(c => {
        const ok = c && c.models && c.airports ? c : null;
        this.corrections.set(ok);
        return ok;
      })
      .catch(() => {
        this.correctionsPromise = null;
        return null;
      });
    return this.correctionsPromise;
  }

  load(): void {
    if (this.asked) return;
    this.asked = true;
    fetch('/data/verification/scores.json')
      .then(r => (r.ok ? r.json() : null))
      .then((f: VerificationFile | null) => { if (f?.days?.length) this.file.set(f); })
      .catch(() => { this.asked = false; }); // ask again next time the list opens
  }
}
