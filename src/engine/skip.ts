// "Sla over" (skip) support shared by the books and games: anything that plays for a while
// (movies, long sounds) can be ended early, as if it had finished.

import { audio, MediaPlayer } from './audio.ts';

const skippables = new Set<() => void>();

/** Register a way to end something early (e.g. a movie); returns the unregister function. */
export function onSkip(end: () => void): () => void {
  skippables.add(end);
  return () => skippables.delete(end);
}

/** True while a movie or a sound is playing that "Sla over" can end. */
export function somethingToSkip(): boolean {
  return skippables.size > 0 || audio.busy || MediaPlayer.playing.size > 0;
}

/** End movies and sounds now, as if they had finished (MIDI music keeps playing). */
export function skipMedia() {
  for (const end of [...skippables]) end();
  audio.skipSounds();
}
