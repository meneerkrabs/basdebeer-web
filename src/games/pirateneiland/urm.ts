// The in-game worm helper ("Urm") of BBOEK32.EXE, class 0x42e808 (code 0x42e8ac..0x42fb98). Used by
// G2 KISTENSPEL (timeout rescue) and G3 ROEISPEL (pops up after the instruction, tells the rhythm).
//
// It is a separate implementation from the book's worm (spec 5.6/7.7): it draws straight onto the game's
// visible TImage canvas (`target`), keeps its own 100x100 background save (field +0xc), and plays a
// "path" (array of 28-byte records {frame, rect, delay, flip} at +0x24, count at +0x41c4) from its own
// TTimer (+0x18, UrmTimerEvent @0x42f7b4). Each method of the original blocks (ProcessMessages loop)
// until the path has been played: here they are async and resolve at the same moment.
//
// Original methods and their addresses:
//   enter(mode, x, y)  FUN_0042e8ac  (path builder + run; modes 1 left, 2 right, 3 top, 4 pop up in place)
//   talk(wav)          FUN_0042f5ac  (MCI plays the WAV; random mouth frames while mode == playing)
//   exit(mode)         FUN_0042ef80  (path builder + run, starting from the last rect)
//   timer event        UrmTimerEvent_42f7b4 (restore previous rect, save new rect, draw frame)
//   constructor        FUN_0042f9cc, destructor FUN_0042fb98
// The frame numbers are the book worm's (5.6) +12 (60 frames of 100x100 in URM1A.BMP, masks in URM1B.BMP).

import type { Assets } from '../../engine/assets.ts';
import { MediaPlayer } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, Surface } from '../../engine/surface.ts';
import { rnd } from '../../engine/vcl.ts';

export const URM_SIZE = 100;

export interface UrmRect { l: number; t: number; r: number; b: number }
/** One path record (28 bytes in the original). `delay` is the TTimer interval to use for the NEXT tick. */
export interface UrmRec { frame: number; rect: UrmRect; delay: number; flip: boolean }

const shift = (r: UrmRect, dx: number, dy: number): UrmRect => ({ l: r.l + dx, t: r.t + dy, r: r.r + dx, b: r.b + dy });
const box = (x: number, y: number): UrmRect => ({ l: x, t: y, r: x + URM_SIZE, b: y + URM_SIZE });

/** Path of FUN_0042e8ac(mode, (x, y)). Records are appended exactly like the decompiled loops. */
export function buildEnterPath(mode: number, x: number, y: number): UrmRec[] {
  const recs: UrmRec[] = [];
  const last = () => recs[recs.length - 1];
  const add = (frame: number, rect: UrmRect, delay: number, flip: boolean) => recs.push({ frame, rect, delay, flip });
  if (mode === 1 || mode === 2) {
    const flip = mode === 2;
    const dir = flip ? -1 : 1;
    // start fully outside: (-100,y)-(0,y+100) or (640,y)-(740,y+100)
    add(43, flip ? { l: 640, t: y, r: 740, b: y + URM_SIZE } : { l: -100, t: y, r: 0, b: y + URM_SIZE }, 10, flip);
    // crawl in at 20 px per step until 150 px short of the target
    do add(43, shift(last().rect, dir * 20, 0), 10, flip);
    while (flip ? !(last().rect.l < x + 150) : !(last().rect.l > x - 150));
    // walking cycles (5 frames in place, 5 frames moving 8 px) until the target x is passed
    do {
      for (let f = 44; f <= 48; f++) add(f, last().rect, 10, flip);
      for (let k = 1; k <= 5; k++) add(48 - k, shift(last().rect, dir * 8, 0), 10, flip);
    } while (flip ? !(last().rect.l < x) : !(last().rect.l > x));
    // stand up: 41..36 in place, 100 ms each
    for (let k = 1; k <= 6; k++) add(42 - k, last().rect, 100, flip);
  } else if (mode === 3) {
    add(49, box(x, -100), 10, false);
    // NB the original uses frame 0x33 (51) here, not 0x31 (49) as for the first record
    do add(51, shift(last().rect, 0, 20), 10, false); while (!(last().rect.t > 216));
    do {
      for (let f = 50; f <= 54; f++) add(f, shift(last().rect, 0, 4), 10, false);
      for (let k = 1; k <= 5; k++) add(54 - k, shift(last().rect, 0, 4), 10, false);
    } while (!(last().rect.t > 379));
    for (let k = 1; k <= 6; k++) add(54 + k, last().rect, 100, false);
  } else if (mode === 4) {
    // pop up in place: 31..36, 100 ms each
    for (let f = 31; f <= 36; f++) add(f, box(x, y), 100, false);
  } else throw new Error(`Urm.enter: bad mode ${mode}`);
  return recs;
}

/** Path of FUN_0042ef80(mode) starting from the worm's last rect `from` (field +0x41cc). Modes 1 and 2 only. */
export function buildExitPath(mode: number, from: UrmRect): UrmRec[] {
  const recs: UrmRec[] = [];
  const last = () => recs[recs.length - 1];
  const add = (frame: number, rect: UrmRect, delay: number, flip: boolean) => recs.push({ frame, rect, delay, flip });
  if (mode === 1) {
    add(37, from, 10, false);
    for (let f = 38; f <= 42; f++) add(f, last().rect, 100, false);
    do {
      for (let f = 44; f <= 48; f++) add(f, last().rect, 10, false);
      for (let k = 1; k <= 5; k++) add(48 - k, shift(last().rect, 8, 0), 10, false);
    } while (!(from.l + 150 <= last().rect.l));
    do add(43, shift(last().rect, 20, 0), 10, false); while (!(last().rect.l > 640));
  } else if (mode === 2) {
    add(38, from, 100, true);
    for (let f = 39; f <= 41; f++) add(f, last().rect, 100, true);
    do {
      for (let f = 44; f <= 48; f++) add(f, last().rect, 10, true);
      for (let k = 1; k <= 5; k++) add(48 - k, shift(last().rect, -8, 0), 10, true);
    } while (!(last().rect.l < from.l - 150));
    do add(43, shift(last().rect, -20, 0), 10, true); while (!(last().rect.l < -100));
  } else throw new Error(`Urm.exit: unsupported mode ${mode} (unused by the original games; 3/4 are never called)`);
  return recs;
}

/** One talking burst (loop body of FUN_0042f5ac): s = Random(4)*6, n = Random(3); frames s+1, then s+1..s+n+3. */
export function buildTalkPath(s: number, n: number, at: UrmRect): UrmRec[] {
  const recs: UrmRec[] = [{ frame: s + 1, rect: at, delay: 100, flip: false }];
  for (let i = 1; i <= n + 3; i++) recs.push({ frame: s + i, rect: at, delay: 100, flip: false });
  return recs;
}

export interface UrmOptions {
  /**
   * Real duration of the original's 10 ms "moving" timer intervals. Windows 9x only ticked every
   * ~55 ms, which is what the game was tuned on (10 ms would make the worm zip in at 2000 px/s).
   */
  moveMs?: number;
}

/** Mirror every 100 px frame of a sheet horizontally (StretchBlt with src left > right). */
function flipFrames(src: Surface): Surface {
  const out = new Surface(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let f = 0; f * URM_SIZE < src.width; f++) {
      const x0 = f * URM_SIZE;
      for (let i = 0; i < URM_SIZE; i++) out.px[y * out.width + x0 + i] = src.px[y * src.width + x0 + URM_SIZE - 1 - i];
    }
  }
  return out;
}

export class Urm {
  private readonly target: Surface;
  private readonly sheet: Surface;
  private readonly mask: Surface;
  private flipSheet: Surface | null = null;
  private flipMask: Surface | null = null;
  private readonly invalidate: () => void;
  private readonly moveMs: number;
  /** +0xc: saved 100x100 background under the worm. */
  private readonly save = new Surface(URM_SIZE, URM_SIZE);
  /** +0x41cc: rect of the last drawn record. */
  private lastRect: UrmRect = { l: 0, t: 0, r: URM_SIZE, b: URM_SIZE };
  /** TTimer.Interval of the worm's own timer. A fresh TTimer has 1000 ms and enter() never changes it,
   *  so the first frame of the first path appears a full second after the call. */
  private interval = 1000;
  private disposed = false;
  private wake: (() => void) | null = null;
  private player: MediaPlayer | null = null;

  constructor(target: Surface, sheet: Surface, mask: Surface, invalidate: () => void, opts: UrmOptions = {}) {
    this.target = target;
    this.sheet = sheet;
    this.mask = mask;
    this.invalidate = invalidate;
    this.moveMs = opts.moveMs ?? 55;
  }

  /** Load URM1A.BMP (frames) and URM1B.BMP (masks). `target` is the surface the game shows (its TImage canvas). */
  static async create(assets: Assets, target: Surface, invalidate: () => void, opts: UrmOptions = {}): Promise<Urm> {
    const [sheet, mask] = await Promise.all([assets.image('URM1A.BMP'), assets.image('URM1B.BMP')]);
    return new Urm(target, sheet, mask, invalidate, opts);
  }

  /** Destructor / form closed: stop any pending sequence and the speech. */
  dispose() {
    this.disposed = true;
    this.player?.close();
    this.player = null;
    this.wake?.();
  }

  /** FUN_0042e8ac: walk/pop in at (x, y) and block until the path has finished. */
  async enter(mode: number, x: number, y: number): Promise<void> {
    const recs = buildEnterPath(mode, x, y);
    // the background under the first rect is saved before the timer starts (CopyRect into +0xc)
    this.lastRect = recs[0].rect;
    this.save.bitBlt(0, 0, URM_SIZE, URM_SIZE, this.target, recs[0].rect.l, recs[0].rect.t);
    await this.run(recs, this.interval);
  }

  /**
   * FUN_0042f5ac: play `speech` (MCI) and animate random mouth frames until it ends. The original checks the
   * player's mode between bursts, so the last burst always finishes after the WAV has ended.
   */
  async talk(speech: AudioBuffer | null): Promise<void> {
    if (!speech || this.disposed) return;
    const mp = new MediaPlayer();
    this.player = mp;
    mp.open(speech);
    mp.play();
    while (mp.playing && !this.disposed) {
      const s = rnd.random(4) * 6;
      const n = rnd.random(3);
      await this.run(buildTalkPath(s, n, this.lastRect), 100);
    }
    mp.close();
    if (this.player === mp) this.player = null;
  }

  /** FUN_0042ef80: leave (mode 1 = crawl off to the right) and block until gone. */
  async exit(mode = 1): Promise<void> {
    const recs = buildExitPath(mode, this.lastRect);
    await this.run(recs, recs[0].delay);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.wake = null; resolve(); };
      const t = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** Enable the worm's TTimer and let UrmTimerEvent step through `recs` (the original waits in a message loop). */
  private async run(recs: UrmRec[], firstInterval: number): Promise<void> {
    let interval = firstInterval;
    for (let cur = 0; cur < recs.length; cur++) {
      await this.wait(interval < 50 ? this.moveMs : interval);
      if (this.disposed) return;
      this.step(recs, cur);
      // Interval := delay of the next record (the original reads one past the end after the last record, but
      // then disables the timer; the value is only ever used by the very first enter(), which is 1000).
      if (cur + 1 < recs.length) interval = recs[cur + 1].delay;
    }
    this.interval = 0;
    this.lastRect = recs[recs.length - 1].rect;
  }

  /** UrmTimerEvent_42f7b4 for record `cur`. */
  private step(recs: UrmRec[], cur: number) {
    const rec = recs[cur];
    const prev = cur === 0 ? this.lastRect : recs[cur - 1].rect;
    const r = rec.rect;
    // restore what was under the previous rect (SRCCOPY), then save what is under the new one
    this.target.bitBlt(prev.l, prev.t, URM_SIZE, URM_SIZE, this.save, 0, 0);
    this.save.bitBlt(0, 0, URM_SIZE, URM_SIZE, this.target, r.l, r.t);
    // source rect ((f-1)*100, 0)-(f*100, 100), mirrored when flip; mask SRCAND then sprite SRCPAINT
    let sheet = this.sheet, mask = this.mask;
    if (rec.flip) {
      this.flipSheet ??= flipFrames(this.sheet);
      this.flipMask ??= flipFrames(this.mask);
      sheet = this.flipSheet;
      mask = this.flipMask;
    }
    const sx = (rec.frame - 1) * URM_SIZE;
    this.target.bitBlt(r.l, r.t, URM_SIZE, URM_SIZE, mask, sx, 0, SRCAND);
    this.target.bitBlt(r.l, r.t, URM_SIZE, URM_SIZE, sheet, sx, 0, SRCPAINT);
    this.lastRect = r; // keeps the "previous rect" correct even if a run is cut short by dispose()
    this.invalidate();
  }
}
