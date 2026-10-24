// GSB "Sneeuwballengevecht" (Noorderlicht PLAY_GAME 1, TGSBfrmMain in BASNOORD.EXE), game logic, DOM-free.
//
// Bas runs automatically through a 3500-unit track (4 parallax layers); Up = jump (held = higher),
// Down = duck. Tim (at the end) throws snowballs; a pixel-exact mask overlap puts Bas back at the last
// checkpoint (0 / 800 / 2000). Reaching Tim (3500 - pos < 235) wins.
//
// Addresses: FormCreate @0x43162c, restart FUN_00432238, FormClose @0x432374, FormPaint @0x4324d8,
// FormShow @0x43252c, GameTimerTimer @0x432548 (75 ms), FormKeyDown @0x433cd8, FormKeyUp @0x433d0c,
// FormMouseDown @0x433d58. Fields (TGSBfrmMain): +0x24c/0x250/0x254/0x258 = scroll offsets of sky / trees /
// main layer / ground (speeds 2/4/6/8 per tick), +0x25c checkpoint, +0x260 run frame, +0x261 Tim frame,
// +0x262 Bas state, +0x263 Bas y (byte), +0x264 snowball list, +0x268 Tim throw countdown (byte),
// +0x269 Tim may throw, +0x26a music started, +0x26b running, +0x26c result.
// The game plays in SysDispRect of the 800x600 layout (123,85,683,365); everything else is the GSBBACK picture.
import { SRCAND, SRCCOPY, SRCPAINT, type Surface } from '../../engine/surface.ts';

export interface SpriteSet { sprite: Surface; mask: Surface }

export interface GsbResources {
  /** GSBBACK.BMP, 800x600. */
  back: Surface;
  sky: Surface; // GSB009 1680x280
  ground: Surface; // GSB010 6720x30
  trees1: SpriteSet; // GSB001 N/M 150x280 (table @0x44bc94)
  trees2: SpriteSet; // GSB002 N/M 150x280 (table @0x44bcd4)
  bas: SpriteSet[]; // GSB003..005 N/M 60x110 (run frames 0..2)
  tim: SpriteSet[]; // GSB006..008 N/M 50x113
  ball: SpriteSet; // GSB011 N/M 20x20
  check: SpriteSet; // CHECKN/M 108x85
}

/** Sound slots (TWave objects of the form). Option 0x10 = synchronous, 9 = async + SND_NOSTOP. */
export type GsbSound = 'GSB001' | 'GSB002' | 'GSB003' | 'GSB004' | 'GSB005' | 'GSB006' | 'GSB007' | 'GSB008' | 'GSB009';
export const GSB_SOUNDS: GsbSound[] = ['GSB001', 'GSB002', 'GSB003', 'GSB004', 'GSB005', 'GSB006', 'GSB007', 'GSB008', 'GSB009'];

export interface GsbEffects {
  /** sndPlaySound without ASYNC: returns when the WAV has ended. */
  playSync(id: GsbSound): Promise<void>;
  /** sndPlaySound(ASYNC | NOSTOP): skipped if another sound is still playing. */
  playAsyncNoStop(id: GsbSound): void;
  /** Form.Update: paint right now (before a blocking sound). */
  update(): void;
  /** TMediaPlayer: GSB001.MID (looped), and Close. */
  startMusic(): void;
  stopMusic(): void;
  random(n: number): number;
  randomize(): void;
  invalidate(): void;
}

type Rect = [number, number, number, number]; // l, t, r, b

/** SysDispRect (800x600). */
export const DISP: Rect = [123, 85, 683, 365];
const VIEW_W = 0x230, VIEW_H = 0x118; // 560x280
const TRACK = 0xdac; // 3500
/** Tree tables @0x44bc94 / @0x44bcd4: {x, y} (x = centre in layer units). */
export const TREES1: [number, number][] = [[120, 10], [800, 12], [1300, 8], [1500, 17], [1900, 9], [2300, 12], [2700, 13], [3000, 7]];
export const TREES2: [number, number][] = [[320, 31], [580, 35], [1050, 40], [1700, 43], [2100, 30], [2500, 20], [2900, 20], [3250, 28]];

interface Ball { x: number; y: number; speed: number }

const BAS_STAND_Y = 0x98;

export class GsbLogic {
  /** 0x26b: running. */
  running = true;
  /** 0x26c: 0 = stopped (quit), 1 = won. */
  result = 0;
  /** 0x1b8: the picture shown by FormPaint. */
  readonly work: Surface;

  // scroll offsets +0x24c/0x250/0x254/0x258, checkpoint +0x25c
  private p0 = 0;
  private p1 = 0;
  private p2 = 0;
  private p3 = 0;
  private checkpoint = 0;
  private runFrame = 0; // 0x260
  private timFrame = 0; // 0x261
  private state = 0; // 0x262: 0 run, 1 jump up, 2 fall, 3 duck, 4 rise from duck
  private basY = BAS_STAND_Y; // 0x263
  private throwCountdown = 10; // 0x268 (byte)
  private timThrows = true; // 0x269
  private musicStarted = false; // 0x26a
  private balls: Ball[] = [];

  private res: GsbResources;
  private fx: GsbEffects;

  constructor(res: GsbResources, fx: GsbEffects) {
    this.res = res;
    this.fx = fx;
    this.work = res.back.clone();
    fx.randomize();
    this.fillBalls();
  }

  private newBall(x: number): Ball {
    const lowBand = this.fx.random(2) !== 0;
    const y = lowBand ? this.fx.random(16) + 0xd7 : this.fx.random(20) + 0x8c;
    return { x, y, speed: 15 };
  }

  /** The 8 initial snowballs (FormCreate / FUN_00432238). */
  private fillBalls() {
    for (let i = 0; i < 8; i++) this.balls.push(this.newBall(i * 0x177 + 600));
  }

  /** FormKeyDown @0x433cd8 (VK_UP 0x26, VK_DOWN 0x28). */
  keyDown(key: 'Up' | 'Down') {
    if (this.state !== 0) return;
    this.state = key === 'Up' ? 1 : 3;
  }

  /** FormKeyUp @0x433d0c. */
  keyUp(key: 'Up' | 'Down') {
    if (key === 'Up') {
      if (this.state === 1 && this.basY < 0x99) this.state = 2;
    } else if (this.state === 3 && this.basY > 0x97) this.state = 4;
  }

  /** FUN_00432238: back to the last checkpoint after a hit. */
  private restart() {
    this.balls = [];
    const u = Math.trunc(this.checkpoint / 6);
    this.p0 = u * 2;
    this.p1 = u * 4;
    this.p2 = this.checkpoint;
    this.p3 = u * 8;
    this.runFrame = 0;
    this.timFrame = 0;
    this.throwCountdown = 10;
    this.basY = BAS_STAND_Y;
    this.state = 0;
    this.fx.randomize();
    this.fillBalls();
  }

  /** Blit sprite (mask SRCAND, sprite SRCPAINT) at (l,t), clipped like the original to the display rect. */
  private draw(s: SpriteSet, l: number, t: number): Rect {
    const w = s.sprite.width, h = s.sprite.height;
    let L = l, R = l + w, B = t + h, sL = 0;
    if (L < DISP[0]) { sL = DISP[0] - L; L = DISP[0]; }
    if (R > DISP[2]) R = DISP[2];
    if (B > DISP[3]) B = DISP[3];
    const bw = R - L, bh = B - t;
    if (bw > 0 && bh > 0) {
      this.work.bitBlt(L, t, bw, bh, s.mask, sL, 0, SRCAND);
      this.work.bitBlt(L, t, bw, bh, s.sprite, sL, 0, SRCPAINT);
    }
    return [L, t, R, B];
  }

  /** Tree layer: visible if (x - w/2 < pos + 560) && (pos < x + w/2). */
  private drawTrees(s: SpriteSet, table: [number, number][]) {
    const half = Math.trunc(s.sprite.width / 2);
    for (const [x, y] of table) {
      if (x - half < this.p1 + VIEW_W && this.p1 < x + half) this.draw(s, DISP[0] + (x - this.p1) - half, DISP[1] + y);
    }
  }

  /** Mask overlap (both masks black = opaque) of the intersection of two screen rects. */
  private hit(ball: Rect, basRect: Rect, basMask: Surface, ballMask: Surface): boolean {
    const l = Math.max(ball[0], basRect[0]), t = Math.max(ball[1], basRect[1]);
    const r = Math.min(ball[2], basRect[2]), b = Math.min(ball[3], basRect[3]);
    if (l >= r || t >= b) return false; // IntersectRect: empty
    for (let x = 0; x < r - l; x++) {
      for (let y = 0; y < b - t; y++) {
        const a = basMask.getPixel(l - basRect[0] + x, t - basRect[1] + y);
        const c = ballMask.getPixel(l - ball[0] + x, t - ball[1] + y);
        // Canvas.Pixels is clWhite (-1) off-bitmap; black = opaque
        if (((a | c) & 0xffffff) === 0 && a >= 0 && c >= 0) return true;
      }
    }
    return false;
  }

  /** FormShow @0x43252c: Update, then the timer is switched on by the caller. */
  show() {
    this.fx.update();
  }

  /** GameTimerTimer @0x432548. The timer is disabled for the duration of a tick (re-enabled by the caller unless !running). */
  async tick() {
    const { res, fx, work } = this;
    if (TRACK - this.p2 < 0xeb) {
      // reached Tim
      fx.stopMusic();
      await fx.playSync('GSB007');
      this.result = 1;
      this.running = false;
      return;
    }
    this.timThrows = TRACK - this.p2 >= 0x15e;
    if (this.p2 > 800) this.checkpoint = 800;
    if (this.p2 > 2000) this.checkpoint = 2000;

    // layers
    work.bitBlt(DISP[0], DISP[1], VIEW_W, VIEW_H, res.sky, this.p0, 0, SRCCOPY);
    this.drawTrees(res.trees1, TREES1);
    this.drawTrees(res.trees2, TREES2);
    const halfCheck = Math.trunc(res.check.sprite.width / 2);
    for (const cx of [0x3ca, 0x87a]) {
      if (cx - halfCheck < this.p2 + VIEW_W && this.p2 < cx + halfCheck) this.draw(res.check, DISP[0] + (cx - this.p2) - halfCheck, DISP[1] + 0xaa);
    }

    // Bas: state machine of +0x262
    switch (this.state) {
      case 0:
        this.basY = BAS_STAND_Y;
        if (++this.runFrame > 2) this.runFrame = 0;
        break;
      case 1:
        this.runFrame = 0;
        this.basY -= 10;
        if (this.basY < 0x5d) this.state = 2;
        break;
      case 2:
        this.runFrame = 0;
        if (this.basY < 0x98) this.basY += 10;
        else this.state = 0;
        break;
      case 3:
        this.runFrame = 0;
        if (this.basY < 0xbb) this.basY += 10;
        break;
      case 4:
        this.runFrame = 0;
        if (this.basY < 0x99) this.state = 0;
        else this.basY -= 10;
        break;
    }
    const basSet = res.bas[this.runFrame];
    const basRect = this.draw(basSet, DISP[0] + 0xaa, DISP[1] + this.basY);

    // Tim (the countdown byte < 5 runs his throwing animation)
    const timHalf = Math.trunc(res.tim[0].sprite.width / 2);
    if (TRACK - timHalf < this.p2 + VIEW_W && this.p2 < timHalf + TRACK) {
      if (this.throwCountdown < 5 && ++this.timFrame > 2) this.timFrame = 0;
      this.draw(res.tim[this.timFrame], DISP[0] + (TRACK - this.p2) - timHalf, DISP[1] + 0x9b);
    }
    this.throwCountdown = (this.throwCountdown - 1) & 0xff;
    if (this.throwCountdown === 0 && this.timThrows) {
      fx.playAsyncNoStop('GSB008');
      this.balls.push(this.newBall(TRACK));
      this.throwCountdown = 0x19;
    }

    // snowballs (last to first)
    let gotHit = false;
    const ballHalf = Math.trunc(res.ball.sprite.width / 2);
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.x -= b.speed;
      if (b.x - ballHalf < this.p2 + VIEW_W && this.p2 < b.x + ballHalf) {
        const rect = this.draw(res.ball, DISP[0] + (b.x - this.p2) - ballHalf, DISP[1] + b.y);
        if (this.hit(rect, basRect, basSet.mask, res.ball.mask)) gotHit = true;
      }
      if (b.x < this.p2) this.balls.splice(i, 1);
    }

    // ground strip along the bottom of the view
    work.bitBlt(DISP[0], DISP[3] - res.ground.height, VIEW_W, res.ground.height, res.ground, this.p3, 0, SRCCOPY);
    fx.invalidate();

    if (gotHit) {
      fx.update();
      await fx.playSync('GSB009');
      await fx.playSync(`GSB00${3 + fx.random(4)}` as GsbSound);
      this.restart();
      return;
    }
    if (this.state <= 2) {
      this.p0 += 2;
      this.p1 += 4;
      this.p2 += 6;
      this.p3 += 8;
    }
    if (!this.musicStarted) {
      fx.update();
      await fx.playSync('GSB001');
      await fx.playSync('GSB002');
      fx.startMusic();
      this.musicStarted = true;
    }
  }
}
