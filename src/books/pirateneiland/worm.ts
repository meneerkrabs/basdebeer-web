// The book's worm "Urm" (spec 5.6): INIT_URM / ACTIVATE_URM, the path builder FUN_00437f28, the draw step FUN_0043ae74 and the
// worm part of MouseTimerTimer_43b1a8. (src/games/pirateneiland/urm.ts is the separate in-game worm: other frame numbers,
// own timer, blocking calls; it does not fit here.)
//
// A path is a list of steps {frame 1..48, x, y, flip} (the 100x100 rect is implied). One step is drawn per MouseTimer tick;
// the per-step delay field of the original is stored but never used, so it is not kept here either.

import { SRCAND, SRCPAINT, Surface } from '../../engine/surface.ts';
import { rnd } from '../../engine/vcl.ts';
import type { Mci } from './mci.ts';
import { copyPixels } from './pixels.ts';

const SIZE = 100;
interface Step { frame: number; x: number; y: number; flip: boolean }

export interface WormHost {
  back: Surface;
  /** Copy a rect of the back buffer to the screen (pixels only: the worm does not touch the text). */
  blit(x: number, y: number, w: number, h: number): void;
  mci: Mci;
  /** ScriptTimer state is 3 (waiting for input): only then the idle counter runs. */
  waiting(): boolean;
}

/** A sprite sheet mirrored frame by frame (the original StretchBlts a reversed source rect for flip = 1). */
function flipFrames(sheet: Surface): Surface {
  const out = new Surface(sheet.width, sheet.height);
  const frames = Math.floor(sheet.width / SIZE);
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < sheet.height; y++) {
      for (let x = 0; x < SIZE; x++) out.px[y * sheet.width + f * SIZE + x] = sheet.px[y * sheet.width + f * SIZE + (SIZE - 1 - x)];
    }
  }
  return out;
}

export class BookWorm {
  // INIT_URM
  private clicksInit = 0;
  private idleInit = 0;
  private clicks = 0; // +0x14b0
  private idle = 0; // +0x14b4 (counts down per MouseTimer tick)
  private wavClick: AudioBuffer | null = null;
  private wavIdle: AudioBuffer | null = null;
  private enterDir = 1;
  private target: [number, number] = [0, 0];
  // ACTIVATE_URM
  private armed = false;
  private done = false; // +0x14a2
  /** +0x14a4: all clicks are ignored while the idle-triggered worm is on screen. */
  blocking = false;
  /** +0x148c == 10: a path is being played (menu hover sounds are off meanwhile). */
  walking = false;
  private snapshot: Surface | null = null;
  private sprite!: Surface;
  private mask!: Surface;
  private spriteF: Surface | null = null;
  private maskF: Surface | null = null;
  // path
  private path: Step[] = [];
  private idx = 0;
  private kind = 0; // +0x14a5: 1 enter, 2 talk, 3 leave
  /** +0x1490: where the worm stands once it has entered (talking and leaving start from here). */
  private standX = 0;
  private standY = 0;
  /** Where the first step of the current path erases from (its own rect for an entry, else the standing place). */
  private firstPrevX = 0;
  private firstPrevY = 0;
  private speech: AudioBuffer | null = null;

  private host: WormHost;

  constructor(host: WormHost) {
    this.host = host;
  }

  /** INIT_URM. `intervalMs` is the ScriptTimer interval at this moment: the idle time is counted in MouseTimer ticks of it. */
  init(a: { clicks: number; seconds: number; intervalMs: number; wavClick: AudioBuffer | null; wavIdle: AudioBuffer | null;
    enterDir: number; x: number; y: number; exitDir: number }) {
    this.clicksInit = this.clicks = a.clicks;
    this.idleInit = this.idle = Math.trunc((a.seconds * 1000) / Math.max(1, a.intervalMs));
    this.wavClick = a.wavClick;
    this.wavIdle = a.wavIdle;
    this.enterDir = a.enterDir;
    this.target = [a.x, a.y];
    // a.exitDir is not kept: every script uses 1 and the other exits are unused
  }

  /** ACTIVATE_URM: snapshot the page (used to erase the worm) and load the sprites. */
  activate(sprite: Surface, mask: Surface) {
    const b = this.host.back;
    this.snapshot = new Surface(b.width, b.height);
    this.snapshot.px.set(b.px);
    this.sprite = sprite;
    this.mask = mask;
    this.spriteF = this.maskF = null;
    this.done = false;
    this.armed = true;
  }

  /** FUN_0043b8bc (worm part): forget everything when the page changes. */
  reset() {
    this.armed = false;
    this.done = false;
    this.blocking = false;
    this.walking = false;
    this.path = [];
    this.idx = 0;
    this.kind = 0;
    this.clicksInit = this.clicks = 0;
    this.idleInit = this.idle = 0;
    this.wavClick = this.wavIdle = null;
    this.snapshot = null;
    this.standX = this.standY = this.firstPrevX = this.firstPrevY = 0;
  }

  /** Mouse-down accounting (end of MainImageMouseDown_43a5d4): a hit resets both counters, a miss counts down. */
  onClick(hit: boolean) {
    if (!this.armed || this.done || this.clicks <= 0) return;
    if (!hit) {
      this.clicks--;
      if (this.clicks === 0) {
        this.build(1);
        this.speech = this.wavClick;
        this.walking = true;
      }
    } else {
      this.clicks = this.clicksInit;
      this.idle = this.idleInit;
    }
  }

  /** One MouseTimer tick. */
  tick() {
    if (!this.armed) return;
    if (!this.done && this.idle > 0 && this.host.waiting()) {
      this.idle--;
      if (this.idle === 0) {
        this.build(1);
        this.speech = this.wavIdle;
        this.blocking = true;
        this.walking = true;
      }
    }
    if (!this.walking) return;
    this.walking = false;
    this.drawStep();
    this.idx++;
    if (this.idx > this.path.length) {
      if (this.kind === 3) {
        this.done = true;
        this.blocking = false;
        return; // phase stays 0
      }
      if (this.kind === 2) {
        if (!this.host.mci.stopped) this.build(2);
        else this.build(3);
      } else if (this.kind === 1) {
        if (this.speech) this.host.mci.playWav(this.speech);
        this.build(2);
      }
    }
    this.walking = true;
  }

  // ---------------------------------------------------------------- draw step (FUN_0043ae74)

  private drawStep() {
    const snap = this.snapshot, back = this.host.back;
    const s = this.path[this.idx - 1];
    if (!snap || !s) return;
    const px = this.idx === 1 ? this.firstPrevX : this.path[this.idx - 2].x;
    const py = this.idx === 1 ? this.firstPrevY : this.path[this.idx - 2].y;
    // restore the previous place from the snapshot (and on the screen if the worm moved)
    copyPixels(back, snap, px, py, SIZE, SIZE);
    if (s.x !== px || s.y !== py) this.host.blit(px, py, SIZE, SIZE);
    let sprite = this.sprite, mask = this.mask;
    if (s.flip) {
      sprite = this.spriteF ??= flipFrames(this.sprite);
      mask = this.maskF ??= flipFrames(this.mask);
    }
    const sx = (s.frame - 1) * SIZE;
    back.bitBlt(s.x, s.y, SIZE, SIZE, mask, sx, 0, SRCAND);
    back.bitBlt(s.x, s.y, SIZE, SIZE, sprite, sx, 0, SRCPAINT);
    this.host.blit(s.x, s.y, SIZE, SIZE);
  }

  // ---------------------------------------------------------------- path builder (FUN_00437f28)

  private build(kind: number) {
    this.kind = kind;
    const p: Step[] = [];
    const last = () => p[p.length - 1];
    const add = (frame: number, x: number, y: number, flip: boolean) => p.push({ frame, x, y, flip });
    const [tx, ty] = this.target;
    if (kind === 1) {
      switch (this.enterDir) {
        case 2: // from the right, mirrored
          add(31, 640, ty, true);
          do add(31, last().x - 20, ty, true); while (!(last().x < tx + 150));
          do {
            for (let f = 32; f <= 36; f++) add(f, last().x, ty, true);
            for (let k = 1; k <= 5; k++) add(36 - k, last().x - 8, ty, true);
          } while (!(last().x < tx));
          for (let k = 1; k <= 6; k++) add(30 - k, last().x, ty, true);
          break;
        case 3: // dropping from the top (ignores the target y)
          add(37, tx, -100, false);
          do add(39, tx, last().y + 20, false); while (!(last().y > 216));
          do {
            for (let f = 38; f <= 42; f++) add(f, tx, last().y + 4, false);
            for (let k = 1; k <= 5; k++) add(42 - k, tx, last().y + 4, false);
          } while (!(last().y > 379));
          for (let k = 1; k <= 6; k++) add(42 + k, tx, last().y, false);
          break;
        case 4: // appears in place
          add(19, tx, ty, false);
          for (let f = 20; f <= 24; f++) add(f, tx, ty, false);
          break;
        default: // 1: from the left
          add(31, -100, ty, false);
          do add(31, last().x + 20, ty, false); while (!(tx - 150 < last().x));
          do {
            for (let f = 32; f <= 36; f++) add(f, last().x, ty, false);
            for (let k = 1; k <= 5; k++) add(36 - k, last().x + 8, ty, false);
          } while (!(tx < last().x));
          for (let k = 1; k <= 6; k++) add(30 - k, last().x, ty, false);
      }
      // the first step erases nothing but its own rect; afterwards the worm stands at the last rect
      this.firstPrevX = p[0].x;
      this.firstPrevY = p[0].y;
      this.standX = last().x;
      this.standY = last().y;
      this.path = p;
      this.idx = 1;
      return;
    }
    if (kind === 2) {
      // talking: random mouth frames in place
      const base = rnd.random(4) * 6;
      const r = rnd.random(3);
      const flip = this.enterDir === 2;
      const { standX: x, standY: y } = this;
      add(base + 1, x, y, flip);
      for (let c = 1; c <= r + 3; c++) add(base + c, x, y, flip);
      this.firstPrevX = x;
      this.firstPrevY = y;
      this.path = p;
      this.idx = 1;
      return;
    }
    // kind 3: leave (exit direction 1; the others are unused by all scripts and fall back to it)
    const { standX: x0, standY: y0 } = this;
    this.firstPrevX = x0;
    this.firstPrevY = y0;
    add(25, x0, y0, false);
    for (let f = 26; f <= 30; f++) add(f, x0, y0, false);
    do {
      for (let f = 32; f <= 36; f++) add(f, last().x, y0, false);
      for (let k = 1; k <= 5; k++) add(36 - k, last().x + 8, y0, false);
    } while (!(x0 + 150 <= last().x));
    do add(31, last().x + 20, y0, false); while (!(640 < last().x));
    this.path = p;
    this.idx = 1;
  }
}
