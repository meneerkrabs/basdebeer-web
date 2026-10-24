// MIDI playback (TMediaPlayer with a .MID file). The games' MIDI files come from the
// user's CD/ISO, so they are synthesised in the browser with spessasynth_lib (an
// AudioWorklet SoundFont synth) and the GeneralUser GS SoundFont (see README credits).
//
// The synthesiser and the 32 MB SoundFont are loaded lazily on the first playMidi().
// One shared synth/sequencer: starting a new MIDI file replaces the one still playing
// (the old handle's `ended` resolves), like the single MCI MIDI sequencer of Windows.

import type { Sequencer, WorkletSynthesizer } from 'spessasynth_lib';
import { audio } from './audio.ts';

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

interface Engine {
  synth: WorkletSynthesizer;
  seq: Sequencer;
}

let enginePromise: Promise<Engine | null> | null = null;

async function createEngine(): Promise<Engine | null> {
  try {
    const [{ WorkletSynthesizer, Sequencer }, workletUrl, sfUrl] = await Promise.all([
      import('spessasynth_lib'),
      import('spessasynth_lib/dist/spessasynth_processor.min.js?url').then((m) => m.default),
      import('../assets/GeneralUser-GS.sf2?url').then((m) => m.default),
    ]);
    const ctx = audio.ctx;
    const [sf] = await Promise.all([
      fetch(sfUrl).then((r) => {
        if (!r.ok) throw new Error(`soundfont HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      ctx.audioWorklet.addModule(workletUrl),
    ]);
    const synth = new WorkletSynthesizer(ctx);
    synth.connect(audio.master);
    await synth.soundBankManager.addSoundBank(sf, 'main');
    await synth.isReady;
    const seq = new Sequencer(synth);
    return { synth, seq };
  } catch (e) {
    console.warn('MIDI synthesiser unavailable', e);
    enginePromise = null; // allow a retry on the next call
    return null;
  }
}

interface Active {
  finish(): void;
}
let active: Active | null = null;

const deadHandle = (): MidiHandle => ({ ended: Promise.resolve(), playing: false, position: 0, stop() {} });

/** Play a Standard MIDI File. Never throws: on failure it returns an already-ended handle. */
export async function playMidi(data: ArrayBuffer, opts: MidiOptions = {}): Promise<MidiHandle> {
  try {
    enginePromise ??= createEngine();
    const engine = await enginePromise;
    if (!engine) return deadHandle();
    const { seq, synth } = engine;

    active?.finish(); // replace a previous MIDI
    let finished = false;
    let resolve!: () => void;
    const ended = new Promise<void>((r) => (resolve = r));
    const me: Active = {
      finish() {
        if (finished) return;
        finished = true;
        if (active === me) active = null;
        seq.eventHandler.removeEvent('songEnded', 'basdebeer');
        resolve();
      },
    };
    active = me;

    seq.eventHandler.addEvent('songEnded', 'basdebeer', () => me.finish());
    // loading is asynchronous in the worklet: play() before 'songChange' plays silence
    const loaded = new Promise<void>((r) => {
      seq.eventHandler.addEvent('songChange', 'basdebeer', () => r());
      setTimeout(r, 3000);
    });
    seq.loadNewSongList([{ binary: data.slice(0) }]);
    await loaded;
    seq.eventHandler.removeEvent('songChange', 'basdebeer');
    if (finished) return { ...deadHandle(), ended }; // replaced/stopped while loading
    seq.loopCount = opts.loop ? Infinity : 0;
    seq.play();

    return {
      ended,
      get playing() {
        return !finished;
      },
      get position() {
        return finished ? 0 : seq.currentTime * 1000;
      },
      stop() {
        if (finished) return;
        me.finish();
        seq.pause();
        synth.stopAll(false);
      },
    };
  } catch (e) {
    console.warn('playMidi failed', e);
    return deadHandle();
  }
}

/** Stop every MIDI handle that is playing (MCI "close all"). */
export function stopAllMidi() {
  if (!active) return;
  active.finish();
  enginePromise?.then((e) => {
    if (!e) return;
    e.seq.pause();
    e.synth.stopAll(false);
  });
}
