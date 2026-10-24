// Mottenspel (Pirateneiland minigame 1, TfrmG1 in BBOEK32.EXE) -- game logic.
//
// A moth circles the candle flame; click it (5 times) before it flies into the flame (5 burns).
// Straight port of the decompiled Delphi methods, free of DOM code. Addresses refer to BBOEK32.EXE.
// Offsets are fields of TfrmG1: 0x1bc state, 0x1bd intro countdown, 0x1d8 caught, 0x1d9 burned,
// 0x221 result, 0x1fc moth frame, 0x220 frame direction, 0x218/0x21c R1/R2, 0x1fe..0x210 a,b,c,d (Real48).

export const SND_ASYNC = 1, SND_LOOP = 8;

/** Sound slots (FormCreate @0x42da0c: objects 0..5 at 0x1c0..0x1d4). */
export const Snd = {
  Loop: 0, // GE001001.WAV, flags ASYNC|LOOP (DAT_0042dccc = 3): the moth buzz
  Caught: 1, // GE001002.WAV, synchronous (flags 0x10 = none)
  Burned: 2, // GE001003.WAV, synchronous
  Instruction: 3, // GAME001A.WAV, synchronous
  Won: 4, // GAME001B.WAV, synchronous
  Lost: 5, // GAME001C.WAV, synchronous (also played by FormClose when closed early)
} as const;

/** The flame: DAT_0043c784 = Rect(320,150,350,204). */
export const FLAME = [320, 150, 350, 204] as const;
export const MOTH = 40;

export interface Rect { l: number; t: number; r: number; b: number }

/** Delphi Round (banker's rounding, FUN_00402af8 = fistp with round-to-nearest-even). */
export const delphiRound = (v: number): number => {
  const f = Math.floor(v), d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
};

export interface MottenEffects {
  random(n: number): number;
  /** sndPlaySound(slot, flags) asynchronously (the looping buzz). */
  playLoop(): void;
  /** sndPlaySound(slot, 0): blocks the original's UI thread until the WAV ends. */
  playSync(slot: number): Promise<void>;
  /** FUN_0042e434: reload KAARS<burned>.BMP, stamp the burned/caught icons, copy to buffer, Repaint. */
  drawBackground(burned: number, caught: number): void;
  /** FUN_0042df60: erase `old` from the clean background, draw the moth (frame 1..3) at `cur`. */
  drawMoth(old: Rect, cur: Rect, frame: number): void;
  /** Form closes with this result (2 won, 3 lost). */
  finish(code: number): void;
}

/** State byte 0x1bc. */
export const St = { Busy: 0, Intro: 1, Play: 2, Clicked: 3 } as const;

export class MottenLogic {
  state: number = St.Busy;
  introCount = 10; // 0x1bd
  caught = 0; // 0x1d8
  burned = 0; // 0x1d9
  result = 0; // 0x221 (set to 1 at the end of FormCreate)
  private r1 = 0; private r2 = 0; // 0x218, 0x21c
  private a = 0; private b = 0; private c = 0; private d = 0;
  private frame = 1; // 0x1fc
  private up = true; // 0x220
  private cur: Rect = { l: 0, t: 0, r: 0, b: 0 }; // 0x1dc
  private old: Rect = { l: 0, t: 0, r: 0, b: 0 }; // 0x1ec

  private fx: MottenEffects;

  constructor(fx: MottenEffects) {
    this.fx = fx;
    this.result = 1;
  }

  /** FormShow @0x42e7a8 */
  show() {
    this.fx.drawBackground(this.burned, this.caught);
    this.state = St.Intro;
  }

  /** GameTimerTimer @0x42e230 (50 ms). The state is 0 while a tick runs (clicks are ignored). */
  async tick() {
    const fx = this.fx;
    const s = this.state;
    if (s === St.Intro) {
      this.state = St.Busy;
      if (--this.introCount === 0) {
        await fx.playSync(Snd.Instruction);
        this.newRound();
        this.state = St.Play;
        return;
      }
      this.state = St.Intro;
    } else if (s === St.Play) {
      this.state = St.Busy;
      this.moveMoth();
      fx.drawMoth(this.old, this.cur, this.frame);
      this.old = this.cur;
      if (this.hitsFlame()) {
        this.burned++;
        await fx.playSync(Snd.Burned);
        if (this.burned === 3 && this.caught === 0) await fx.playSync(Snd.Instruction);
        if (this.burned === 5) {
          await fx.playSync(Snd.Lost);
          this.result = 3;
          fx.finish(3);
          return;
        }
        fx.drawBackground(this.burned, this.caught);
        this.newRound();
      }
      this.state = St.Play;
    } else if (s === St.Clicked) {
      this.state = St.Busy;
      this.caught++;
      await fx.playSync(Snd.Caught);
      if (this.caught === 5) {
        await fx.playSync(Snd.Won);
        this.result = 2;
        fx.finish(2);
        return;
      }
      fx.drawBackground(this.burned, this.caught);
      this.newRound();
      this.state = St.Play;
    }
  }

  /** FormMouseDown @0x42e3c8: any button, only between ticks in the play state. */
  mouseDown(x: number, y: number) {
    if (this.state !== St.Play) return;
    const m = this.cur;
    if (x >= m.l && x < m.r && y >= m.t && y < m.b) this.state = St.Clicked; // PtInRect
  }

  /** FormClose @0x42e40c: closed before a result -> play the fail sound (sync), result 3. */
  async onClose() {
    if (this.result !== 2 && this.result !== 3) {
      this.result = 3;
      await this.fx.playSync(Snd.Lost);
    }
  }

  /** FUN_0042e0d0: start a round. Rects are reset to empty, the buzz loop starts. */
  private newRound() {
    const rnd = this.fx.random;
    this.frame = 1;
    this.r1 = 300;
    this.r2 = 200;
    this.a = rnd(628) * 0.01 - 3.12;
    this.b = rnd(628) * 0.01 - 3.12;
    this.c = rnd(628) * 0.01;
    this.d = rnd(628) * 0.01;
    this.old = { l: 0, t: 0, r: 0, b: 0 };
    this.cur = { l: 0, t: 0, r: 0, b: 0 };
    this.up = true;
    this.fx.playLoop();
  }

  /** FUN_0042dd4c: advance the Lissajous-like path (the shrinking radii draw the moth towards the flame). */
  private moveMoth() {
    this.a += 0.05;
    this.b += 0.06;
    this.c += 0.12;
    this.d += 0.23;
    const r = this.fx.random(3);
    if (this.r1 > 0) this.r1 -= r;
    if (this.r2 > 0) this.r2 -= r;
    const x1 = delphiRound(Math.cos(this.a) * this.r1 + 315);
    const y1 = delphiRound(Math.sin(this.b) * this.r2 + 165);
    const x = delphiRound(Math.cos(this.c) * 30 + x1);
    const y = delphiRound(Math.sin(this.d) * 30 + y1);
    this.cur = { l: x, t: y, r: x + MOTH, b: y + MOTH };
    // frame ping-pong 1..3; the new frame is already used for this tick's drawing
    if (!this.up) {
      if (--this.frame === 1) this.up = true;
    } else if (++this.frame === 3) this.up = false;
  }

  /** FUN_0042e0a0: IntersectRect(moth, flame). */
  private hitsFlame(): boolean {
    const m = this.cur;
    return m.l < FLAME[2] && FLAME[0] < m.r && m.t < FLAME[3] && FLAME[1] < m.b;
  }
}
