// The book's one TMediaPlayer ("ScriptMedia", MCI). The reader, animation sounds, effects, the worm's speech and the
// JA/NEE question all go through this single player, so each of them cuts off the previous one. WAV via MediaPlayer,
// MIDI effects (EFCT002B.MID) via the synthesiser in engine/midi.ts.

import { MediaPlayer } from '../../engine/audio.ts';
import { playMidi, type MidiHandle } from '../../engine/midi.ts';

export class Mci {
  private wav = new MediaPlayer();
  private midi: MidiHandle | null = null;
  /** playMidi() is async: the player counts as playing from the Play call until the handle says it ended. */
  private gen = 0;
  private pendingGen = -1;

  /** Close + FileName + Open + (StartPos/EndPos) + Play of a WAV. */
  playWav(buf: AudioBuffer, startMs = 0, endMs?: number) {
    this.stop();
    this.wav.open(buf);
    this.wav.play(startMs, endMs);
  }

  playMidiFile(data: ArrayBuffer) {
    this.stop();
    const gen = this.gen; // stop() just bumped it; any later stop() invalidates this start
    this.pendingGen = gen;
    void playMidi(data).then((h) => {
      if (gen !== this.gen) h.stop();
      else { this.midi = h; this.pendingGen = -1; }
    }, () => { if (gen === this.gen) this.pendingGen = -1; });
  }

  stop() {
    this.gen++;
    this.wav.stop();
    this.midi?.stop();
    this.midi = null;
  }

  /** TMediaPlayer.Close */
  close() {
    this.stop();
    this.wav.close();
  }

  /** MCI mode == stopped (also true when nothing is open). */
  get stopped(): boolean {
    return !this.wav.playing && this.pendingGen !== this.gen && !this.midi?.playing;
  }

  /** MCI position in ms (WAV). */
  get position(): number {
    return this.wav.position;
  }
}
