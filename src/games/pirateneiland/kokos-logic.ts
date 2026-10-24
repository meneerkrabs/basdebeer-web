// Kokosspel (Pirateneiland minigame 4, TfrmG4 in BBOEK32.EXE) -- game logic.
//
// Two coconuts hang in the palm tree and fall; Bas moves his basket with the mouse and must catch
// 5 of them before 5 hit the ground. Straight port of the decompiled Delphi methods, DOM-free.
// Addresses refer to BBOEK32.EXE. Offsets are fields of TfrmG4: 0x1b0 state, 0x1b1 intro countdown,
// 0x228 basket x, 0x230 old basket x, 0x23c basket frame, 0x240 frame direction, 0x234 caught,
// 0x238 missed, 0x244 result; per coconut i (1..2): x 0x1e4+4i, y 0x1ec+4i, hang counter t 0x1f4+4i,
// vy 0x1fc+4i, frame 0x204+4i, old x 0x20c+4i, old y 0x214+4i.

/** Sound slots (FormCreate @0x431714, objects at 0x1d4..0x1e0, all synchronous: flags 0x10). */
export const Snd = {
  Instruction: 0, // GAME004A.WAV
  Won: 1, // GAME004B.WAV
  Lost: 2, // GAME001C.WAV (also played by FormClose when closed early)
  Miss: 3, // GE001003.WAV
} as const;

export const delphiRound = (v: number): number => {
  const f = Math.floor(v), d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
};

export interface KokosEffects {
  random(n: number): number;
  /** sndPlaySound(slot, 0): blocks the original's UI thread until the WAV ends. */
  playSync(slot: number): Promise<void>;
  /** The mouse x in form coordinates (the original polls GetCursorPos each tick). */
  mouseX(): number;
  /**
   * FUN_00431e3c: erase the old coconut rect, draw the coconut (mask SRCAND, image SRCPAINT, frame 0..2),
   * erase the old basket rect, draw the basket (frame 1..20) at (basketX, 370).
   */
  draw(x: number, y: number, frame: number, oldX: number, oldY: number, basketX: number, oldBasketX: number, basketFrame: number): void;
  /** FUN_00431c4c: stamp a coconut icon into the clean background at (x,y), copy it to the buffer. */
  stampCaught(x: number, y: number, frame: number): void;
  /** FUN_00431d44: same with the miss icon (AG0403). */
  stampMissed(x: number, y: number, frame: number): void;
  finish(code: number): void;
}

export const St = { Busy: 0, Intro: 1, Play: 2 } as const;

export class KokosLogic {
  state: number = St.Busy;
  introCount = 10; // 0x1b1
  result = 0; // 0x244
  caught = 0; // 0x234
  missed = 0; // 0x238
  private basketX = 0; // 0x228
  private oldBasketX = 0; // 0x230
  private basketFrame = 0; // 0x23c
  private basketDir = 1; // 0x240
  // index 0 unused so that coconut i = 1..2 matches the original's arrays
  private x = [0, 0, 0]; private y = [0, 0, 0]; private t = [0, 0, 0]; private vy = [0, 0, 0];
  private frame = [0, 1, 1]; private oldX = [0, 0, 0]; private oldY = [0, 0, 0];
  private fx: KokosEffects;

  constructor(fx: KokosEffects) {
    this.fx = fx;
    this.result = 1;
  }

  /** FormShow @0x43242c */
  show() {
    this.state = St.Intro;
  }

  /** GameTimerTimer @0x432074 (50 ms). */
  async tick() {
    const fx = this.fx;
    if (this.state === St.Intro) {
      this.state = St.Busy;
      if (--this.introCount === 0) {
        await fx.playSync(Snd.Instruction);
        this.state = St.Play;
      } else this.state = St.Intro;
      return;
    }
    if (this.state !== St.Play) return;

    // basket animation: frame ping-pong 1..20
    this.basketFrame += this.basketDir;
    if (this.basketFrame > 19) this.basketDir = -1;
    if (this.basketFrame < 2) this.basketDir = 1;
    // the basket follows the mouse: |cursor - form.Left| - 50 (no clamp)
    this.oldBasketX = this.basketX;
    this.basketX = Math.abs(fx.mouseX()) - 50;

    for (let i = 1; i <= 2; i++) {
      this.oldX[i] = this.x[i];
      this.oldY[i] = this.y[i];
      if (this.t[i] === 0) {
        // spawn: Random(4)*75 + 20 + (i-1)*320, just above the screen
        this.t[i] = 1;
        this.x[i] = fx.random(4) * 75 + 20 + (i - 1) * 320;
        this.y[i] = -10;
        this.vy[i] = 1;
        this.frame[i] = 1;
      }
      if (this.t[i] > 0) {
        this.t[i]++;
        this.x[i] += fx.random(7) - 3; // wobble
        if (this.x[i] < 40) this.x[i] = 40;
        if (this.x[i] > 600) this.x[i] = 600;
        if (++this.frame[i] === 3) this.frame[i] = 0;
      }
      if (this.t[i] > i * 7 + 30) {
        // after hanging 7i+30 ticks: accelerate downwards, faster the more were caught
        this.y[i] += this.vy[i];
        this.vy[i] += delphiRound(this.caught * 0.5) + 1;
      }
      fx.draw(this.x[i], this.y[i], this.frame[i], this.oldX[i], this.oldY[i], this.basketX, this.oldBasketX, this.basketFrame);
      if (this.y[i] > 380) {
        const x = this.x[i];
        if (this.basketX < x && x + 40 < this.basketX + 100) {
          this.caught++;
          fx.stampCaught(0, this.caught * 50, this.frame[i]);
          if (this.caught > 4) {
            this.state = St.Busy;
            await fx.playSync(Snd.Won);
            this.result = 2;
            fx.finish(2);
            return;
          }
          this.t[i] = 0;
        } else if (this.y[i] > 450) {
          this.missed++;
          fx.stampMissed(600, this.missed * 50, this.frame[i]);
          this.t[i] = 0;
          if (this.missed > 4) {
            this.state = St.Busy;
            await fx.playSync(Snd.Lost);
            this.result = 3;
            fx.finish(3);
            return;
          }
          await fx.playSync(Snd.Miss);
        }
      }
    }
  }

  /** FormClose @0x432450 */
  async onClose() {
    if (this.result !== 2 && this.result !== 3) {
      this.result = 3;
      await this.fx.playSync(Snd.Lost);
    }
  }
}
