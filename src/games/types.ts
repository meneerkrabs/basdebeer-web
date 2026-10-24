import type { Assets } from '../engine/assets.ts';
import type { Display } from '../engine/vcl.ts';

/** What a ported minigame (one of the original TfrmGn forms) gets from the book engine. */
export interface MinigameHost {
  display: Display;
  assets: Assets;
  /** Book-specific launch parameters, e.g. Noorderlicht's { mode: 'N' | 'D' } (normal / 3D glasses). */
  params?: Record<string, string | number>;
}

export interface MinigameSession {
  /**
   * Resolves when the game's form closes with the exit code the original book engine
   * read from the form (by convention 1 = finished/won, 2 = player chose to stop).
   */
  result: Promise<number>;
  /** The book's stop icon was clicked while the game runs (originals show a JA/NEE sign). */
  requestQuit?(): void;
  /** The book's HERHALEN button during the game (originals replay the spoken instructions). */
  repeat?(): void;
}

/** Creates the game's form(s), shows them and starts the game. */
export type Minigame = (host: MinigameHost) => MinigameSession;

export type MinigameRegistry = Record<string, () => Promise<{ default: Minigame; title?: string }>>;
