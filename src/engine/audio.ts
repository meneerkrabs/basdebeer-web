// Audio: Web Audio emulation of the Win32 sound APIs the games use.
//  - sndPlaySound/PlaySound: one global "system sound" channel; a new sound cuts the old one.
//  - TMediaPlayer (MCI): independent channels (WAV/MIDI) with end notification.

export const SND_SYNC = 0;
export const SND_ASYNC = 1;
export const SND_NODEFAULT = 2;
export const SND_MEMORY = 4;
export const SND_LOOP = 8;
export const SND_NOSTOP = 0x10;

class AudioSystem {
  ctx: AudioContext;
  master: GainNode;
  private current: { src: AudioBufferSourceNode; done: Promise<void>; finished: boolean } | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    // ?mute=1 silences everything (used for automated browser tests)
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('mute')) this.master.gain.value = 0;
  }

  /** Must be called from a user gesture once (browser autoplay policy). */
  async unlock() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  decode(buf: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(buf);
  }

  /** True while the sndPlaySound channel is playing. */
  get busy(): boolean {
    return !!this.current && !this.current.finished;
  }

  /**
   * sndPlaySound(buffer, flags). Returns false when SND_NOSTOP is given and a sound is
   * still playing (the Win32 behaviour several games use as an "is it done yet?" probe).
   * For synchronous calls (no SND_ASYNC) await `sndPlaySoundSync` instead.
   */
  sndPlaySound(buffer: AudioBuffer | null, flags = SND_ASYNC): boolean {
    if (flags & SND_NOSTOP && this.busy) return false;
    this.stopSystemSound();
    if (!buffer) return true;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!(flags & SND_LOOP);
    src.connect(this.master);
    let resolve!: () => void;
    const entry = { src, done: new Promise<void>((r) => (resolve = r)), finished: false };
    src.onended = () => {
      entry.finished = true;
      resolve();
    };
    this.current = entry;
    src.start();
    return true;
  }

  async sndPlaySoundSync(buffer: AudioBuffer | null, flags = 0): Promise<boolean> {
    if (!this.sndPlaySound(buffer, flags & ~SND_ASYNC)) return false;
    await this.current?.done;
    return true;
  }

  /** Resolves when the current system sound has finished (immediately if none). */
  whenSystemSoundDone(): Promise<void> {
    return this.current && !this.current.finished ? this.current.done : Promise.resolve();
  }

  stopSystemSound() {
    const c = this.current;
    this.current = null;
    if (c && !c.finished) {
      c.src.onended = null;
      c.finished = true;
      try { c.src.stop(); } catch { /* already stopped */ }
    }
  }
}

export const audio = new AudioSystem();

/** Minimal TMediaPlayer for audio files (WAV, or MIDI pre-rendered to M4A). */
export class MediaPlayer {
  private src: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private startedAt = 0;
  onNotify: (() => void) | null = null;
  loop = false;

  open(buffer: AudioBuffer) {
    this.stop();
    this.buffer = buffer;
  }

  play() {
    if (!this.buffer) return;
    this.stop();
    const src = audio.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.connect(audio.master);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      this.onNotify?.();
    };
    this.src = src;
    this.startedAt = audio.ctx.currentTime;
    src.start();
  }

  stop() {
    const s = this.src;
    this.src = null;
    if (s) {
      s.onended = null;
      try { s.stop(); } catch { /* ignore */ }
    }
  }

  close() {
    this.stop();
    this.buffer = null;
  }

  get playing() {
    return this.src !== null;
  }

  /** Position in ms (MCI TimeFormat = tfMilliseconds). */
  get position(): number {
    return this.src ? (audio.ctx.currentTime - this.startedAt) * 1000 : 0;
  }

  get length(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }
}
