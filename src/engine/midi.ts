// MIDI playback (TMediaPlayer with a .MID file). The games' MIDI files come from the
// user's CD/ISO, so they are synthesised in the browser.
//
// Interface used by the books and minigames; the synthesiser behind it can change.

export interface MidiHandle {
  /** Resolves when playback ends (not for looping playback) or stop() is called. */
  readonly ended: Promise<void>;
  readonly playing: boolean;
  /** Playback position in ms. */
  readonly position: number;
  stop(): void;
}

export interface MidiOptions {
  loop?: boolean;
}

/** Play a Standard MIDI File. Never throws: on failure it returns an already-ended handle. */
export async function playMidi(data: ArrayBuffer, opts: MidiOptions = {}): Promise<MidiHandle> {
  void data;
  void opts;
  // placeholder until the synthesiser lands: silent, ends immediately
  return { ended: Promise.resolve(), playing: false, position: 0, stop() {} };
}

/** Stop every MIDI handle that is playing (MCI "close all"). */
export function stopAllMidi() {}
