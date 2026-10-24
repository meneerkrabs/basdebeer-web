// GROTSPEL (Pirateneiland minigame 6, TfrmG6 in BBOEK32.EXE) - game logic, free of DOM code.
//
// Bas runs through a cave of 5 screens; a bee / boulder / sparks obstacle moves across. Left mouse
// button = duck (hold), right mouse button = jump. A pixel-exact mask overlap is a hit; 3 lives.
// Addresses refer to BBOEK32.EXE: FormCreate @0x433604, screen loader @0x433b7c, obstacle set-up
// @0x433e30, obstacle step @0x434230, collision @0x43439c, draw+collide @0x43458c,
// GameTimerTimer @0x43493c, FormMouseDown @0x434d18, FormMouseUp @0x434d64. Offsets are TfrmG6 fields.
import { SRCAND, SRCCOPY, SRCPAINT, type Surface } from '../../engine/surface.ts';

/** Sound objects (all flags 0x10 = SND_NOSTOP|SYNC: block until the WAV ends, skipped if another is playing). */
export type SoundId =
  | 'GE007001' | 'GE007002' | 'GE007003' | 'GE007004' | 'GE007005' | 'GE007006' | 'GE007007' | 'GE007008';
export const SOUND_IDS: SoundId[] = [
  'GE007001', 'GE007002', 'GE007003', 'GE007004', 'GE007005', 'GE007006', 'GE007007', 'GE007008',
];

export interface SpriteSet { sprite: Surface; mask: Surface }
export interface GrotResources {
  /** IG0700.BMP: shown until screen 1 is drawn. */
  title: Surface;
  /** Per screen layer set 1..4 (screen 5 reuses 1): a = background, b = foreground colours, c = foreground mask. */
  layers: Record<number, { a: Surface; b: Surface; c: Surface }>;
  bee: SpriteSet; // AG0703(+M): 11 frames of 100x100
  boulder: SpriteSet; // AG0702(+M): 21 frames
  sparks: SpriteSet; // AG0704(+M): 21 frames
  bas: SpriteSet; // ag0705(+m): 11 frames of 124x229
}

export interface GrotEffects {
  playSync(id: SoundId): Promise<void>;
  /** Form.Invalidate / Repaint. */
  invalidate(): void;
  setTimerInterval(ms: number): void;
}

type Rect = [number, number, number, number]; // l, t, r, b

const BAS_W = 124, BAS_H = 229; // ag0705.bmp is 1364x229 = 11 frames (Round(Width/11))
const OBS = 100; // frame width/height of the obstacle sheets
const BAS_Y = 230; // obj+0x210

export class GrotLogic {
  /** 0x1b1: 1 = start countdown, 4 = running, 5 = hit, 0 = busy/finished. */
  state = 0;
  private intro = 10; // 0x1b0 (50 ms ticks)
  private screen = 0; // 0x21c
  private lives = 3; // 0x220
  private bx = 0; // 0x20c
  private by = BAS_Y; // 0x210
  private f = 0; // 0x214: Bas frame (0-5 walk, 6-10 duck, >12 jump)
  private step = 0; // 0x218
  private ox = 0; // 0x1f4
  private oy = 0; // 0x1f8
  private ofr = 0; // 0x1fc
  private ovy = 0; // 0x200
  private obs: SpriteSet;
  private layer = 1;
  /** 0x224 / 0x234: rectangles drawn last time (restored from the background first). */
  private prevBas: Rect = [0, 0, 0, 0];
  private prevObs: Rect = [0, 0, 0, 0];
  /** 0x1c0: working bitmap shown by FormPaint. */
  readonly work: Surface;
  /** 0x244: 1 playing, 2 won, 3 lost. */
  result = 1;

  private res: GrotResources;
  private fx: GrotEffects;

  constructor(res: GrotResources, fx: GrotEffects) {
    this.res = res;
    this.fx = fx;
    this.work = res.title.clone();
    this.obs = res.bee;
  }

  /** FormShow @0x434cd8 (the timer, 50 ms, is switched on by the caller). */
  show() {
    this.state = 1;
  }

  /** FormMouseDown @0x434d18: button 0 = left (duck), 1 = right (jump). */
  mouseDown(button: number) {
    if (button === 0 && this.f < 6) {
      this.f = 6;
      this.step = 1;
    }
    if (button === 1 && this.f < 12) {
      this.f = 12;
      this.step = 2;
    }
  }

  /** FormMouseUp @0x434d64 (also reached during a jump, shortening it: original behaviour). */
  mouseUp(button: number) {
    if (button === 0 && this.f > 5) {
      this.step = -1;
      this.f--;
    }
  }

  /** FUN_00433b7c: sound for screens 2..4, then compose A (SRCCOPY), C (SRCAND), B (SRCPAINT) into the work bitmap. */
  private async loadScreen(n: number) {
    if (n === 2) await this.fx.playSync('GE007006');
    else if (n === 3) await this.fx.playSync('GE007007');
    else if (n === 4) await this.fx.playSync('GE007008');
    this.layer = n === 5 ? 1 : n;
    const L = this.res.layers[this.layer];
    this.work.bitBlt(0, 0, 640, 480, L.a, 0, 0, SRCCOPY);
    this.work.bitBlt(0, 0, 640, 480, L.c, 0, 0, SRCAND);
    this.work.bitBlt(0, 0, 640, 480, L.b, 0, 0, SRCPAINT);
    this.fx.invalidate();
  }

  /** FUN_00433e30: obstacle graphics and start state of the current screen. */
  private setupObstacle() {
    switch (this.screen) {
      case 1: case 4: // bee
        this.obs = this.res.bee; this.ox = 540; this.oy = 185; this.ovy = 0; this.ofr = 0; break;
      case 2: case 5: // boulder
        this.obs = this.res.boulder; this.ox = 540; this.oy = 350; this.ovy = -25; this.ofr = 0; break;
      case 3: // sparks
        this.obs = this.res.sparks; this.ox = 290; this.oy = -100; this.ovy = 0; this.ofr = 0; break;
    }
  }

  /** FUN_00434230 (once per tick, before Bas moves). */
  private stepObstacle() {
    const s = this.screen;
    if (s === 2 || s === 5) {
      this.ox -= 4;
      this.ovy++;
      this.oy += this.ovy;
      if (this.oy > 350) { this.ovy = -25; this.oy = 350; }
      if (this.ox < -100) { this.ox = 640; this.oy = 350; this.ovy = -25; }
      if (++this.ofr === 20) this.ofr = 1;
    }
    if (s === 1 || s === 4) {
      this.ox -= 2;
      if (this.ox < -100) { this.ox = 640; this.oy = 185; this.ovy = -20; }
      if (++this.ofr === 10) this.ofr = 1;
    }
    if (s === 3) {
      this.oy += 10;
      if (this.oy > 480) this.oy = -100;
      if (++this.ofr === 20) this.ofr = 1;
    }
  }

  /**
   * FUN_0043439c: do the opaque pixels of the two masks (black = shape) overlap? Obstacle and Bas
   * masks are OR-ed over the intersection of the two destination rects; any non-white pixel = hit.
   */
  private collide(obsDst: Rect, basDst: Rect, obsSrc: Rect, basSrc: Rect): boolean {
    const l = Math.max(obsDst[0], basDst[0]), t = Math.max(obsDst[1], basDst[1]);
    const r = Math.min(obsDst[2], basDst[2]), b = Math.min(obsDst[3], basDst[3]);
    if (l >= r || t >= b) return false; // IntersectRect fails on an empty intersection
    const om = this.obs.mask, bm = this.res.bas.mask;
    const ox0 = obsSrc[0] + (l - obsDst[0]), oy0 = obsSrc[1] + (t - obsDst[1]);
    const bx0 = basSrc[0] + (l - basDst[0]), by0 = basSrc[1] + (t - basDst[1]);
    for (let x = 0; x < r - l; x++) {
      for (let y = 0; y < b - t; y++) {
        // getPixel is -1 (white) outside a bitmap
        if (((om.getPixel(ox0 + x, oy0 + y) | bm.getPixel(bx0 + x, by0 + y)) & 0xffffff) !== 0xffffff) return true;
      }
    }
    return false;
  }

  /**
   * FUN_0043458c: restore the old rects, draw obstacle + Bas (mask SRCAND, sprite SRCPAINT), re-apply the
   * foreground layer over all four rects (so trees stay in front), test the collision. On a hit state = 5
   * (the old rects are then NOT updated, as in the original).
   */
  private drawAndCollide(bx: number, by: number, bf: number): boolean {
    const { work, obs } = this;
    const { bas } = this.res;
    const L = this.res.layers[this.layer];
    const obsSrc: Rect = [this.ofr * OBS, 0, this.ofr * OBS + OBS, OBS];
    const obsDst: Rect = [this.ox, this.oy, this.ox + OBS, this.oy + OBS];
    const basDst: Rect = [bx, by, bx + BAS_W, by + BAS_H];
    const basSrc: Rect = [bf * BAS_W, 0, bf * BAS_W + BAS_W, BAS_H];
    const hit = this.collide(obsDst, basDst, obsSrc, basSrc);
    const blit = (rop: number, dst: Rect, src: Surface, s: Rect) =>
      work.bitBlt(dst[0], dst[1], dst[2] - dst[0], dst[3] - dst[1], src, s[0], s[1], rop);
    blit(SRCCOPY, this.prevBas, L.a, this.prevBas);
    blit(SRCCOPY, this.prevObs, L.a, this.prevObs);
    blit(SRCAND, basDst, bas.mask, basSrc);
    blit(SRCAND, obsDst, obs.mask, obsSrc);
    blit(SRCPAINT, basDst, bas.sprite, basSrc);
    blit(SRCPAINT, obsDst, obs.sprite, obsSrc);
    for (const rc of [this.prevBas, this.prevObs, basDst, obsDst]) blit(SRCAND, rc, L.c, rc);
    for (const rc of [this.prevBas, this.prevObs, basDst, obsDst]) blit(SRCPAINT, rc, L.b, rc);
    this.fx.invalidate();
    if (hit) {
      this.state = 5;
      return true;
    }
    this.prevBas = basDst;
    this.prevObs = obsDst;
    return false;
  }

  /** (Re)start screen 1 with Bas at the left edge (also after a hit). */
  private async startScreen1() {
    await this.loadScreen(1);
    this.screen = 1;
    this.setupObstacle();
    this.bx = -100;
    this.by = BAS_Y;
    this.f = 1;
    this.step = 1;
    this.state = 4;
  }

  /** GameTimerTimer @0x43493c: 50 ms during the countdown, then 100 ms. */
  async tick() {
    const fx = this.fx;
    if (this.state === 1) {
      this.state = 0;
      if (--this.intro === 0) {
        await fx.playSync('GE007001'); // instructions
        await this.startScreen1();
        fx.setTimerInterval(100);
      } else this.state = 1;
    } else if (this.state === 4) {
      this.state = 0;
      this.stepObstacle();
      if (this.f < 6) {
        this.bx += 8;
        if (this.drawAndCollide(this.bx, this.by, this.f)) return;
      } else {
        if (this.f < 12 && this.drawAndCollide(this.bx, this.by + (this.f - 5) * 8, this.f)) return;
        if (this.f > 12) {
          // jump: the frame counter doubles as height (apex y 170), 15 px forward per tick
          if (this.drawAndCollide(this.bx, this.by + (this.f - 12) * -5, 1)) return;
          this.bx += 15;
        }
      }
      this.f += this.step;
      if (this.f > 23) this.step = -2;
      if (this.f === 12) { this.f = 1; this.step = 1; }
      if (this.f === 0) this.step = 1;
      if (this.f === 5) this.step = -1;
      if (this.f === 10) this.step = 0;
      if (this.bx > 620) {
        this.bx = -100;
        this.f = 1;
        this.step = 1;
        this.screen++;
        if (this.screen === 6) {
          await fx.playSync('GE007004'); // cave cleared
          this.result = 2;
          this.state = 0;
          return;
        }
        await this.loadScreen(this.screen);
        this.setupObstacle();
      }
      this.state = 4;
    } else if (this.state === 5) {
      await fx.playSync('GE007002'); // hit
      this.lives--;
      if (this.lives === 0) {
        await fx.playSync('GE007003');
        this.result = 3;
        this.state = 0;
      } else {
        if (this.lives === 1) await fx.playSync('GE007005'); // last life warning
        await this.startScreen1();
      }
    }
  }
}
