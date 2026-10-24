// Voetballen (Paaseiland minigame 4, TfrmG4 in PAASBAAS.EXE) — game logic + software rendering.
//
// Bongo (a rabbit hypnotised by Professor Punthoofd) paces back and forth in front of the hut
// (BongoTimer, 100 ms). The player aims a crosshair horizontally (mouse X, the sprite follows the
// cursor at y 100..140) and clicks to kick the football; it flies up out of the picture and comes
// down far away at the aimed spot, getting smaller. If it lands on Bongo he runs off into the
// woods (61 steps) and the game is won (exit code 1); otherwise the ball can be kicked again.
// The AniTimer (100 ms) only drives the spoken instructions and the JA/NEE "stop?" sign.
//
// Straight port of the decompiled Delphi methods (addresses in comments), free of DOM code.
// The original was compiled with {$R+,$Q+}; `rc` marks the BOUND checks that exist in the binary.
// The game draws with GDI: `work` (0x1b8) is the 640x320 back buffer, `bg` (0x1b4) the pristine
// I022.BMP used to erase sprites, `screen` is the form's canvas. InvalidateRect + WM_PAINT is
// emulated by copying the invalidated rectangle from `work` to `screen` immediately.

import { SRCAND, SRCCOPY, SRCPAINT, Surface, type Rop } from '../../engine/surface.ts';

export const SND_ASYNC = 1, SND_MEMORY = 4, SND_NOSTOP = 0x10;

/** Field 0x2bd of TfrmG4: the AniTimer state machine. */
export const Ani = {
  Intro: 0, // countdown (10 ticks), then GE2201.WAV is played
  Idle: 2,
  Greeting: 0x11, // waits (SND_NOSTOP) until GE2201 has finished, then plays GE2211
  SignUp: 0x18, // JA / NEE sign slides up
  SignDown: 0x19, // sign slides down
  SignWait: 0x1a, // waiting for a click on JA / NEE
} as const;

/** Field 0x1b00: the BongoTimer state machine. */
export const Bs = {
  Off: 0, // transient (original leaves it 0 only for a moment, or for good when the game is over)
  BuildPath: 1,
  Walk: 2,
  Throw: 4, // the player clicked: compute the ball trajectory
  Hit: 5, // the ball landed on Bongo
} as const;

export interface Rect { l: number; t: number; r: number; b: number }
const rect = (l: number, t: number, r: number, b: number): Rect => ({ l, t, r, b });
const isEmpty = (a: Rect) => a.r <= a.l || a.b <= a.t;

/** Win32 IntersectRect: an empty result is all zeroes. */
function intersect(a: Rect, b: Rect): Rect {
  const r = rect(Math.max(a.l, b.l), Math.max(a.t, b.t), Math.min(a.r, b.r), Math.min(a.b, b.b));
  return isEmpty(r) ? rect(0, 0, 0, 0) : r;
}
/** Win32 UnionRect: empty rectangles are ignored. */
function union(a: Rect, b: Rect): Rect {
  if (isEmpty(a)) return isEmpty(b) ? rect(0, 0, 0, 0) : { ...b };
  if (isEmpty(b)) return { ...a };
  return rect(Math.min(a.l, b.l), Math.min(a.t, b.t), Math.max(a.r, b.r), Math.max(a.b, b.b));
}

/** Canvas.CopyRect(dest, srcCanvas, srcRect): a size mismatch turns into a StretchBlt. */
function copyRect(dst: Surface, d: Rect, src: Surface, s: Rect, rop: Rop = SRCCOPY) {
  const dw = d.r - d.l, dh = d.b - d.t, sw = s.r - s.l, sh = s.b - s.t;
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  if (dw === sw && dh === sh) dst.bitBlt(d.l, d.t, dw, dh, src, s.l, s.t, rop);
  else dst.stretchBlt(d.l, d.t, dw, dh, src, s.l, s.t, sw, sh, rop);
}

const SCREEN = rect(0, 0, 640, 320);
/** DAT_00445838: the ball's frames in A02205/A02206 (it shrinks as it flies away). */
const BALL_FRAMES: readonly Rect[] = [
  rect(0, 0, 200, 219), rect(200, 0, 350, 164), rect(400, 0, 500, 110), rect(600, 0, 650, 55), rect(800, 0, 825, 27),
];
/** Sprite rectangles set in FormCreate: 57x73 for sprites 0..5, 40x40 (crosshair) for 6 and 7. */
const SPRITE_RECTS: readonly Rect[] = [
  rect(0, 0, 57, 73), rect(0, 0, 57, 73), rect(0, 0, 57, 73), rect(0, 0, 57, 73),
  rect(0, 0, 57, 73), rect(0, 0, 57, 73), rect(0, 0, 40, 40), rect(0, 0, 40, 40),
];

/** 12-byte entries at 0xf00 (Bongo's path) and 0x1b04 (the ball's flight): frame, x, y. */
interface Step { frame: number; x: number; y: number }
const zeroSteps = () => Array.from({ length: 256 }, (): Step => ({ frame: 0, x: 0, y: 0 }));

export interface FootballEffects {
  /** sndPlaySound(memory sound i, flags); i = 0..4 = GE2211..GE2215. False when SND_NOSTOP and busy. */
  playSound(i: number | null, flags: number): boolean;
  /** sndPlaySound('GE2201.WAV', SND_ASYNC): the spoken instructions. */
  playIntro(): void;
  /** sndPlaySound('yn001.wav', SND_ASYNC): "wil je stoppen?". */
  playQuestion(): void;
  /** GetCursorPos + ScreenToClient: the mouse X in form coordinates. */
  cursorX(): number;
  /** Form.Close. */
  close(): void;
  /** Whole-form repaint (Invalidate -> FormPaint). */
  repaintAll(): void;
}

export interface FootballGfx {
  bg: Surface; // 0x1b4: I022.BMP (private copy: the stop sign is drawn into it)
  work: Surface; // 0x1b8: back buffer, starts as a copy of bg
  screen: Surface; // the form's canvas
  sprites: Surface[]; // A02201..A02208 (0/2 = Bongo walking left/right, 1/3 = masks, 4/5 ball + mask, 6/7 crosshair + mask)
  sign: Surface; // YN1.BMP
  signMask: Surface; // YN1M.BMP
}

export class RangeCheckError extends Error {
  constructor(where: string, v: number, lo: number, hi: number) {
    super(`Range check error at ${where}: ${v} not in ${lo}..${hi}`);
  }
}

export class FootballLogic {
  // AniTimer
  aniState: number = Ani.Intro; // 0x2bd
  aniSaved = 2; // 0x2be: state to return to after the sign
  countdown = 10; // 0x2bc
  signStep = 0; // 0x2718
  signYes = false; // 0x271c: JA (true) / NEE (false)
  signKind = 0; // 0x271d (1 = stop question)
  private signSaved: Surface | null = null; // 0x2714: the form region under the sign
  // BongoTimer
  bState: number = Bs.Walk; // 0x1b00
  pose = 2; // 0x1b01: 0 = walks left (sprites 0/1), 2 = walks right (sprites 2/3)
  everThrown = false; // 0x1b02 (set at the first click, never cleared)
  canThrow = false; // 0x1b03
  cursorOn = true; // 0x2707: crosshair visible
  flying = false; // 0x2708: ball in flight
  eraseBall = false; // 0x2709
  step = 0; // 0x2704: index into the flight table
  last = 0; // 0x2705: last index of the flight table
  landing = false; // 0x2706: ball is on its way down (hit test enabled)
  path: Step[] = zeroSteps(); // 0xf00
  pathLast = 0; // 0xee8
  pathIdx = 0; // 0xee9
  ball: Step[] = zeroSteps(); // 0x1b04
  hitRun = false; // 0xefd: Bongo was hit and is running away
  firstReset = true; // 0xefc
  cursorRect: Rect = rect(0, 0, 0, 0); // 0xeec: last drawn crosshair rectangle
  exitCode = 0; // 0x2720: 1 = won, 2 = stopped
  rangeErrors: string[] = [];

  private fx: FootballEffects;
  private g: FootballGfx;
  private strict: boolean;

  constructor(fx: FootballEffects, gfx: FootballGfx, strict = false) {
    this.fx = fx;
    this.g = gfx;
    this.strict = strict;
  }

  private rc(where: string, v: number, lo: number, hi: number): number {
    if (v >= lo && v <= hi) return v;
    const err = new RangeCheckError(where, v, lo, hi);
    if (this.strict) throw err;
    this.rangeErrors.push(err.message);
    console.warn(`[voetbal] ${err.message} (original crashed here)`);
    return Math.min(hi, Math.max(lo, v));
  }

  /** FormCreate tail @0x438e5b: draws the ball in Bongo's reach, starts Bongo in state 1. */
  create() {
    this.resetBall();
  }

  /** FormShow @0x43ac8c. */
  show() {
    this.aniState = Ani.Intro;
  }

  /** FormClose @0x43ac94. */
  onClose() {
    this.fx.playSound(null, SND_ASYNC);
    if (this.exitCode === 0) this.exitCode = 2;
  }

  // ---------------------------------------------------------------- drawing

  /** InvalidateRect(rect) followed by the WM_PAINT it causes: FormPaint copies work -> canvas. */
  private invalidate(r: Rect) {
    const c = intersect(r, SCREEN);
    if (isEmpty(c)) return;
    this.g.screen.bitBlt(c.l, c.t, c.r - c.l, c.b - c.t, this.g.work, c.l, c.t);
  }

  /** FormPaint @0x438f00. */
  paint() {
    this.g.screen.bitBlt(0, 0, 640, 320, this.g.work, 0, 0);
  }

  /** The nested procedure @0x4393e4 of BongoTimerTimer: erase + redraw Bongo, ball and crosshair. */
  private draw() {
    const { bg, work, sprites } = this.g;
    // Bongo: source = frame `frame` of the sprite sheet, destination = path position
    const spr = this.rc('0x4393ff', this.pose, 0, 7);
    const sr = SPRITE_RECTS[spr];
    const w = sr.r - sr.l;
    const pe = this.path[this.rc('0x439440', this.pathIdx, 0, 255)];
    const bongoSrc = rect((pe.frame - 1) * w, 0, pe.frame * w, sprites[0].height); // height of sprite[0xeea = 0]
    const bongoDst = rect(pe.x, pe.y, pe.x + w, pe.y + (sr.b - sr.t));

    // ball
    let ballDst = rect(0, 0, 0, 0); // local_44 (stale stack garbage in the original when no ball flies)
    let ballSrc = rect(0, 0, 0, 0); // local_34
    if (this.flying) {
      const e = this.ball[this.rc('0x439552', this.step, 0, 255)];
      const tr = BALL_FRAMES[this.rc('0x43956f', e.frame, 0, 4)];
      const left = e.x - ((tr.r - tr.l) >> 1);
      ballDst = rect(left, e.y, tr.r + left - tr.l, tr.b + e.y - tr.t);
      ballSrc = { ...tr };
      // IntersectRect clips the *destination* only. The source is then cropped only when the
      // clipped edge is exactly the screen's top (0) or bottom (320) edge, otherwise CopyRect
      // squeezes the whole frame into the clipped rectangle.
      ballDst = intersect(ballDst, SCREEN);
      const top = ballDst.t;
      if (top === 0) ballSrc.t = ballSrc.b - ballDst.b; // @0x43974e
      if (ballDst.b === 320) ballSrc.b = 320 - top; // @0x439768
    }
    // where the previous frame of the ball was (unclipped), from the entry before step
    let prevBall = rect(0, 0, 0, 0); // local_54
    if (this.step > 1) {
      const p = this.ball[this.rc('0x4397a9', this.step - 1, 0, 255)];
      const tr = BALL_FRAMES[this.rc('0x4397c3', p.frame, 0, 4)];
      const left = p.x - ((tr.r - tr.l) >> 1);
      prevBall = rect(left, p.y, tr.r + left - tr.l, tr.b + p.y - tr.t);
    }
    const ballErase = intersect(union(ballDst, prevBall), SCREEN); // local_64

    // crosshair: follows the mouse X, fixed at y 100..140
    let cur = rect(0, 0, 0, 0); // local_74
    if (this.cursorOn || this.everThrown) {
      const cx = Math.min(490, Math.max(150, this.fx.cursorX()));
      cur = rect(cx - 20, 100, cx + 20, 140);
    }

    // --- erase, then draw (@0x439aa8)
    if (this.cursorOn || this.everThrown) copyRect(work, this.cursorRect, bg, this.cursorRect);
    copyRect(work, bongoDst, bg, bongoDst); // only Bongo's *new* rectangle is erased
    if (this.flying || this.eraseBall) copyRect(work, ballErase, bg, ballErase);
    copyRect(work, bongoDst, sprites[this.rc('0x439b6f', this.pose + 1, 0, 7)], bongoSrc, SRCAND);
    copyRect(work, bongoDst, sprites[this.rc('0x439bad', this.pose, 0, 7)], bongoSrc, SRCPAINT);
    if (this.flying) {
      copyRect(work, ballDst, sprites[5], ballSrc, SRCAND);
      copyRect(work, ballDst, sprites[4], ballSrc, SRCPAINT);
    }
    if (this.cursorOn) {
      copyRect(work, cur, sprites[7], SPRITE_RECTS[7], SRCAND);
      copyRect(work, cur, sprites[6], SPRITE_RECTS[6], SRCPAINT);
    }
    // --- InvalidateRect
    this.invalidate(bongoDst);
    if (this.flying) this.invalidate(ballErase);
    if (this.eraseBall) {
      this.invalidate(ballErase);
      this.eraseBall = false;
    }
    if (this.cursorOn || this.everThrown) this.invalidate(union(cur, this.cursorRect));
    this.cursorRect = cur;
  }

  /** @0x43922c: the ball waits in Bongo's reach (frame 0 at the bottom); Bongo resumes. */
  private resetBall() {
    const { work, sprites } = this.g;
    const dst = rect(220, 180, 420, 320);
    const src = rect(BALL_FRAMES[0].l, BALL_FRAMES[0].t, BALL_FRAMES[0].r, BALL_FRAMES[0].t + 140);
    copyRect(work, dst, sprites[5], src, SRCAND);
    copyRect(work, dst, sprites[4], src, SRCPAINT);
    this.fx.repaintAll(); // @0x439238 call [vmt+0x44] (Invalidate): the whole form is repainted after the handler
    this.flying = false;
    if (this.firstReset) {
      this.bState = Bs.BuildPath;
      this.pose = 2;
    } else {
      this.bState = Bs.Walk;
    }
    this.firstReset = false;
  }

  // ---------------------------------------------------------------- BongoTimer @0x439d8c

  bongoTick() {
    switch (this.bState) {
      case Bs.BuildPath: this.buildPath(); break;
      case Bs.Walk: this.walk(); break;
      case Bs.Throw: this.throwBall(); break;
      case Bs.Hit: this.hit(); break;
    }
  }

  /** State 1: Bongo's 76-step walk across the picture (3 px per step, 15 animation frames). */
  private buildPath() {
    this.bState = Bs.Off;
    for (let i = 0; i < 0x4c; i++) {
      const e = this.path[this.rc('0x439df7', i, 0, 255)];
      if (this.pose === 2) {
        e.frame = Math.abs((i % 15) - 15);
        e.x = i * 3 + 0xb8;
      } else {
        e.frame = (i % 15) + 1;
        e.x = 0x199 - i * 3;
      }
      e.y = 100;
    }
    this.pathLast = 0x4c - 1;
    this.pathIdx = 1;
    this.bState = Bs.Walk;
  }

  /** State 2 @0x439f0a. */
  private walk() {
    this.draw();
    this.pathIdx = this.rc('0x439f14', this.pathIdx + 1, 0, 255);
    if (this.pathIdx > this.pathLast) {
      if (this.hitRun) {
        // Bongo has left the picture: game won (the main form polls 0x2720)
        this.bState = Bs.Off;
        this.exitCode = 1;
        this.fx.close();
        return;
      }
      this.pose = this.pose === 2 ? 0 : 2;
      this.bState = Bs.BuildPath;
    }
    if (!this.flying) return;
    this.step = this.rc('0x439f9a', this.step + 1, 0, 255);
    if (this.step === 0x19) this.fx.playSound(2, SND_ASYNC | SND_MEMORY); // GE2213: the ball comes down
    if (this.step > 0x28) this.landing = true;
    if (this.landing) {
      // hit test: the ball's bottom is below Bongo's body, x overlaps [bx+15, bx+46)
      const e = this.ball[this.rc('0x439fee', this.step, 0, 255)];
      const bongo = this.path[this.rc('0x43a016', this.pathIdx, 0, 255)];
      if (e.y + 0x1b > bongo.y + 0xf) {
        const bx = bongo.x;
        const l = e.x - 10, r = e.x + 10;
        if ((l > bx + 15 && l < bx + 0x2e) || (r > bx + 15 && r < bx + 0x2e)) this.bState = Bs.Hit;
      }
    }
    if (this.step > this.last) {
      // the ball missed: back to the start
      this.flying = false;
      this.fx.playSound(3, SND_ASYNC | SND_MEMORY); // GE2214
      this.bState = Bs.Off;
      this.cursorOn = true;
      this.eraseBall = true;
      this.canThrow = true;
      this.draw();
      this.resetBall();
    }
  }

  /** State 4 @0x43a1e9: build the ball's flight table from the crosshair position. */
  private throwBall() {
    this.bState = Bs.Off;
    this.eraseBall = false;
    this.landing = false;
    const cx = Math.min(490, Math.max(150, this.fx.cursorX()));
    const xs = Math.trunc((cx - 320) / 2); // sar + adc: rounds toward zero
    const d = Math.trunc(xs / 20); // Delphi `div` truncates toward zero
    const d3 = Math.trunc(xs / 37);
    const b = this.ball;
    let n = 0;
    const put = (frame: number, x: number, y: number) => {
      const e = b[this.rc('0x43a27f', n, 0, 255)];
      e.frame = frame; e.x = x; e.y = y;
      n++;
    };
    // 1) frame 0 (200x219), up 23 px per step, 9 steps
    for (let i = 0; i < 9; i++) put(0, d * i + 320, 180 - 23 * i);
    // 2) frame 1, 16 steps further up (largely off the top of the picture)
    let ex = b[n - 1].x, ey = b[n - 1].y;
    for (let i = 0; i < 16; i++) put(1, d * i + ex, ey - 14 * i);
    // 3) the ball re-enters far away, above the picture, at the aimed spot: frame 2, 8 steps
    for (let i = 0; i < 8; i++) put(2, d3 * i + xs + 320, -100 + 5 * i);
    // 4) frame 3, 9 steps
    ey = b[n - 1].y + 0x6e - 0x37;
    ex = b[n - 1].x + d3;
    for (let i = 0; i < 9; i++) put(3, d3 * i + ex, ey + 5 * i);
    // 5) frame 4 (25x27), 23 steps down to Bongo's level
    ex = b[n - 1].x + d3;
    ey = b[n - 1].y + 0x37 - 0x1b;
    for (let i = 0; i < 0x17; i++) put(4, d3 * i + ex, ey + 4 * i);
    this.last = n - 1;
    this.step = 1;
    this.flying = true;
    this.bState = Bs.Walk;
  }

  /** State 5 @0x43a6da: Bongo is hit; he walks off (61 steps of 5 px). */
  private hit() {
    this.flying = false;
    this.eraseBall = true;
    this.fx.playSound(4, SND_ASYNC | SND_MEMORY); // GE2215
    this.draw();
    const sx = this.path[this.rc('0x43a71d', this.pathIdx, 0, 255)].x;
    this.hitRun = true;
    for (let i = 0; i < 0x3d; i++) {
      const e = this.path[i];
      if (this.pose === 2) {
        e.frame = Math.abs((i % 15) - 15);
        e.x = i * 5 + sx;
      } else {
        e.frame = (i % 15) + 1;
        e.x = sx - i * 5;
      }
      e.y = 100;
    }
    this.pathLast = 0x3d - 1;
    this.pathIdx = 1;
    this.bState = Bs.Walk;
  }

  // ---------------------------------------------------------------- input

  /** FormMouseDown @0x439300. x, y in form coordinates. */
  mouseDown(x: number, y: number) {
    const a = this.aniState;
    if (a === Ani.SignUp || a === Ani.SignDown || a === Ani.SignWait) {
      if (a === Ani.SignWait) {
        if (y >= 0xb9 && y <= 0xdc && x >= 0x1c7 && x <= 0x1f8) {
          this.signYes = true;
          this.aniState = Ani.SignDown;
        }
        if (y >= 0xbc && y <= 0xdd && x >= 0x20c && x <= 0x249) {
          this.signYes = false;
          this.aniState = Ani.SignDown;
        }
      }
    } else if (!this.flying && !this.hitRun && this.canThrow) {
      this.fx.playSound(1, SND_ASYNC | SND_MEMORY); // GE2212: the kick
      this.bState = Bs.Throw;
      this.everThrown = true;
      this.cursorOn = false;
      this.canThrow = false;
    }
  }

  // ---------------------------------------------------------------- AniTimer @0x438fec

  aniTick() {
    switch (this.aniState) {
      case Ani.SignUp:
        this.aniState = Ani.Idle;
        this.drawSign();
        this.signStep++;
        if (this.signStep === 0xd) {
          this.fx.playQuestion(); // yn001.wav
          this.aniState = Ani.SignWait;
        } else {
          this.aniState = Ani.SignUp;
        }
        break;
      case Ani.Intro:
        this.countdown--;
        if (this.countdown === 0) {
          this.fx.playIntro(); // GE2201.WAV (instructions, ~19 s)
          this.aniSaved = Ani.Greeting;
          this.canThrow = true;
          this.aniState = Ani.Greeting;
        } else {
          this.aniState = Ani.Intro;
        }
        break;
      case Ani.Greeting:
        this.aniState = Ani.Idle;
        // sndPlaySound(GE2211, SND_MEMORY|SND_NOSTOP): only plays once the instructions are over
        if (!this.fx.playSound(0, SND_MEMORY | SND_NOSTOP)) {
          this.aniState = Ani.Greeting;
        } else {
          this.aniState = Ani.Idle;
          this.aniSaved = Ani.Idle;
        }
        break;
      case Ani.SignDown:
        this.aniState = Ani.Idle;
        this.signStep--;
        this.drawSign();
        if (this.signStep === 0) this.answered();
        else this.aniState = Ani.SignDown;
        break;
      // Ani.SignWait: nothing (waits for FormMouseDown)
    }
  }

  /** @0x43a924: draw the sign (12 px per step) into bg and straight onto the canvas. */
  private drawSign() {
    const { bg, screen, sign, signMask } = this.g;
    const area = rect(420, 165, 616, 320);
    if (this.signSaved) copyRect(bg, area, this.signSaved, rect(0, 0, 196, 155));
    const h = this.signStep * 12;
    const dst = rect(420, 320 - h, 616, 320);
    const src = rect(0, 0, 196, h);
    copyRect(bg, dst, signMask, src, SRCAND);
    copyRect(bg, dst, sign, src, SRCPAINT);
    copyRect(screen, area, bg, area, SRCCOPY);
  }

  /** @0x43aa84: the sign is gone again. */
  private answered() {
    this.signSaved = null;
    if (!this.signYes) {
      this.aniState = this.aniSaved;
    } else if (this.signKind === 1) {
      this.exitCode = 2;
      this.fx.close();
    }
  }

  /** @0x43aad0: the book's stop icon: show the "stop?" sign (only while the ball is in hand). */
  requestQuit() {
    if (!this.canThrow) return;
    const a = this.aniState;
    if (a === Ani.SignUp || a === Ani.SignDown || a === Ani.SignWait) return;
    const saved = new Surface(196, 179);
    copyRect(saved, rect(0, 0, 196, 155), this.g.screen, rect(420, 165, 616, 320));
    this.signSaved = saved;
    this.signStep = 1;
    this.signKind = 1;
    this.aniSaved = Ani.Idle;
    this.aniState = Ani.SignUp;
  }
}
