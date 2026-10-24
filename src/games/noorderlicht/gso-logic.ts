// GSO "Proeverij / Sjaak-o-maat" (Noorderlicht PLAY_GAME 4, TGSOfrmMain in BASNOORD.EXE), game logic, DOM-free.
//
// Choose at most one of six ingredients per row (4 rows, 24 buttons GSONKnn, 6-frame strips), click the troll
// to taste. The ingredient code s1*1000+s2*100+s3*10+s4 (s = 1..6, 0 = none) is looked up in a table of 134
// "good recipes"; a good one plays GSOS01, a bad one GSOS02 plus two more troll animations. The recipe is then
// spoken (ingredient names GSOI01-24, connectors GSOK01-04) and the chosen buttons spring back.
//
// Addresses: FormCreate @0x4399a0, FormPaint @0x43a068, FormClose @0x43a0bc, FormMouseDown @0x43a0c4,
// click handler @0x43a254, toggle @0x43a4f0, draw-frame @0x43a568, AniTimer @0x43a64c (70 ms buttons),
// start-animation @0x43a824, recipe check @0x43a85c, taste result @0x43a8b0, speak recipe @0x43aa54,
// FormShow @0x43ac48, FormMouseMove @0x43ae48. Tables: button rects 0x44c8f4 (24 x 16 bytes), troll rects
// 0x44ca74, troll frame counts 0x44cab4, troll intervals 0x44cab8, good recipes 0x44cac8 (134 x i32).
// Sound options (TWave FUN_0042dfe0): ingredient/connector/GSOS/GSO002 = 0x10 (synchronous: the UI thread
// blocks until the sound is done), troll sounds = 1 (async), GSO001 = 1, GSO004 = 8 (SND_NOSTOP, sync).
import { SRCCOPY, type Surface } from '../../engine/surface.ts';

export type Rect = [number, number, number, number]; // l, t, r, b

/** SysDispRect, mode 1 (800x600): the button / troll rects below are relative to its top-left. */
export const DISP: Rect = [123, 85, 683, 365];
/** SysPrevRect / SysNextRect / SysStopRect, mode 1. */
export const BOOK_RECTS = { prev: [90, 410, 200, 470] as Rect, next: [600, 405, 715, 470] as Rect, stop: [145, 495, 260, 600] as Rect };

/** The 24 ingredient buttons (0x44c8f4), 6 columns x 4 rows. Frame strips are 6 frames wide. */
export const BUTTON_RECTS: Rect[] = [
  [10, 40, 39, 69], [56, 39, 90, 72], [103, 39, 138, 72], [151, 40, 183, 71], [201, 41, 230, 70], [247, 40, 279, 70],
  [10, 100, 38, 129], [56, 100, 85, 127], [105, 99, 134, 128], [152, 99, 181, 130], [200, 98, 230, 129], [247, 99, 278, 129],
  [10, 159, 39, 186], [58, 159, 87, 187], [106, 159, 134, 188], [153, 160, 182, 187], [201, 159, 231, 187], [248, 160, 278, 189],
  [11, 217, 39, 247], [58, 218, 87, 247], [106, 220, 132, 249], [153, 219, 182, 248], [200, 218, 230, 248], [248, 219, 277, 247],
];
export const BUTTON_FRAMES = 6;
export const BUTTON_INTERVAL = 70; // 0x46

/** The four troll animations GSON001-004 (0x44ca74 / 0x44cab4 / 0x44cab8). */
export const TROLLS: { rect: Rect; frames: number; interval: number }[] = [
  { rect: [285, 67, 524, 223], frames: 10, interval: 100 },
  { rect: [379, 73, 534, 228], frames: 7, interval: 100 }, // also the click target "the troll"
  { rect: [418, 77, 499, 158], frames: 16, interval: 170 },
  { rect: [399, 70, 529, 222], frames: 6, interval: 250 },
];
export const TROLL_CLICK = TROLLS[1].rect;

/** 0x44cac8: the 134 good recipes (code s1*1000+s2*100+s3*10+s4). */
export const GOOD_RECIPES: readonly number[] = [
  1000, 1300, 1310, 1313, 1320, 1323, 1330, 1333, 1340, 1343, 1350, 1353, 1360, 1363, 1404, 2000, 2003, 3000, 3100, 3110,
  3111, 3113, 3115, 3123, 3143, 3153, 3153, 3163, 3200, 3203, 3300, 3310, 3313, 3320, 3323, 3330, 3333, 3350, 3353, 3360,
  3363, 3503, 4000, 4300, 4310, 4311, 4313, 4316, 4306, 4320, 4321, 4323, 4326, 4330, 4331, 4333, 4336, 4340, 4341, 4343,
  4346, 4350, 4351, 4353, 4356, 4360, 4361, 4363, 4366, 4010, 4013, 4016, 4020, 4023, 4026, 4030, 4036, 4040, 4043, 4046,
  4050, 4053, 4056, 4060, 4063, 4066, 4003, 4006, 5000, 6000, 6001, 6003, 300, 310, 313, 316, 320, 323, 326, 330,
  333, 336, 340, 343, 346, 350, 353, 356, 360, 363, 366, 526, 566, 10, 13, 16, 20, 23, 26, 40,
  46, 50, 53, 56, 60, 61, 63, 66, 1, 2, 3, 4, 5, 6,
];

/** FUN_0043a85c: sel[0..3] = chosen ingredient (1..6) per row, 0 = none. */
export function isGoodRecipe(sel: readonly number[]): boolean {
  const code = sel[0] * 1000 + sel[1] * 100 + sel[2] * 10 + sel[3];
  return GOOD_RECIPES.includes(code);
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
export const ingredientWav = (n: number) => `GSOI${pad2(n)}.WAV`; // n = 1..24
export const connectorWav = (n: number) => `GSOK${pad2(n)}.WAV`; // n = 1..4
export const trollWav = (n: number) => `GSOT${pad2(n)}.WAV`; // n = 1..4
export const buttonImage = (n: number) => `GSONK${pad2(n)}.BMP`;
export const trollImage = (n: number) => `GSON00${n}.BMP`;

/** Every wav the game can play (to preload). */
export function allSounds(): string[] {
  const s = ['GSO001.WAV', 'GSO002.WAV', 'GSO004.WAV', 'GSOS01.WAV', 'GSOS02.WAV'];
  for (let i = 1; i <= 24; i++) s.push(ingredientWav(i));
  for (let i = 1; i <= 4; i++) s.push(connectorWav(i), trollWav(i));
  return s;
}

/** One animation in the AniTimer's list (a 0x3c-byte record copy). */
interface Item {
  strip: Surface;
  rect: Rect; // absolute (screen) rect
  frames: number;
  interval: number;
  frame: number;
  dir: 1 | 2 | 3; // 1 forward, 2 backward, 3 forward then back
  sound: string | null; // played once on the first frame drawn
}

export interface GsoHost {
  /** sndPlaySound(ASYNC): cuts a running sound. */
  playAsync(name: string): void;
  /** sndPlaySound(SYNC): resolves when the sound is done. */
  playSync(name: string): Promise<void>;
  /** sndPlaySound(NOSTOP), synchronous: false at once when another sound is still playing. */
  playSyncNoStop(name: string): Promise<boolean>;
  /** AniTimer.Interval (the timer is always enabled). */
  setInterval(ms: number): void;
  invalidate(): void;
}

export interface GsoImages {
  back: Surface;
  buttons: Surface[]; // 24
  trolls: Surface[]; // 4
}

export class GsoLogic {
  /** Offscreen picture drawn by FormPaint. */
  readonly work: Surface;
  /** +0x88c: 0 idle, 1 draw a frame, 2 item finished, 3 start-up (waiting for the intro narration). */
  state = 0;
  /** +0x88d..: chosen ingredient (1..6) per row, 0 = none. */
  readonly sel = [0, 0, 0, 0];
  private tasting = false; // +0x8b0
  private afterAnim = false; // +0x8b1: speak the recipe when the list is empty
  private readonly on = new Array<number>(24).fill(0); // button record +0x28 (0 normal, 1 pressed)
  private readonly queue: Item[] = [];

  private readonly img: GsoImages;
  private readonly host: GsoHost;

  constructor(img: GsoImages, host: GsoHost) {
    this.img = img;
    this.host = host;
    this.work = img.back.clone();
  }

  /** FormShow: intro narration, then GSO004 once the intro is over (state 3 polls it with NOSTOP). */
  show() {
    this.host.playAsync('GSO001.WAV');
    this.state = 3;
    this.host.setInterval(10);
  }

  get idle() { return this.state === 0 && !this.tasting && !this.afterAnim; }

  /** Click inside the picture area relative to SysDispRect (FUN_0043a254). */
  async click(x: number, y: number) {
    if (!this.idle) return;
    for (let i = 0; i < 24; i++) {
      const r = BUTTON_RECTS[i];
      if (x < r[0] || x >= r[2] || y < r[1] || y >= r[3]) continue;
      const n = i + 1, row = Math.floor((n + 5) / 6); // 1..4
      const cur = this.sel[row - 1];
      if (cur !== 0) this.toggle((row - 1) * 6 + cur - 1); // spring the old one back
      this.toggle(i);
      this.sel[row - 1] = n % 6 === 0 ? 6 : n % 6;
      this.startAnim();
      return;
    }
    const t = TROLL_CLICK;
    if (x >= t[0] && x < t[2] && y >= t[1] && y < t[3]) {
      if (this.sel.some((v) => v !== 0)) {
        // troll 1 forward, troll 2 forward, troll 1 backward, all with their sound
        this.queue.push(this.trollItem(0, 1, 1), this.trollItem(1, 1, 1), this.trollItem(0, 2, 1));
        this.tasting = true;
        this.startAnim();
      } else {
        await this.host.playSync('GSO002.WAV');
      }
    }
  }

  /** FUN_0043a4f0: toggle a button (0-based index) and queue a copy of its record. */
  private toggle(i: number) {
    let dir: 1 | 2, frame: number;
    if (this.on[i] === 0) { dir = 1; frame = 1; this.on[i] = 1; } else { dir = 2; frame = BUTTON_FRAMES; this.on[i] = 0; }
    const r = BUTTON_RECTS[i];
    this.queue.push({
      strip: this.img.buttons[i], rect: [r[0] + DISP[0], r[1] + DISP[1], r[2] + DISP[0], r[3] + DISP[1]],
      frames: BUTTON_FRAMES, interval: BUTTON_INTERVAL, frame, dir, sound: null,
    });
  }

  private trollItem(i: number, dir: 1 | 2 | 3, frameFirst: number): Item {
    const t = TROLLS[i];
    return {
      strip: this.img.trolls[i], rect: [t.rect[0] + DISP[0], t.rect[1] + DISP[1], t.rect[2] + DISP[0], t.rect[3] + DISP[1]],
      frames: t.frames, interval: t.interval, frame: dir === 2 ? t.frames : frameFirst, dir, sound: trollWav(i + 1),
    };
  }

  /** FUN_0043a824 */
  private startAnim() {
    this.state = 1;
    this.host.setInterval(this.queue[0].interval);
  }

  /** FUN_0043a568: draw the front item's current frame. A frame past the end of the strip (the original
   *  runs 1..n over strips of n frames) draws nothing. */
  private drawFrame(it: Item) {
    const w = it.rect[2] - it.rect[0], h = it.rect[3] - it.rect[1];
    this.work.bitBlt(it.rect[0], it.rect[1], w, h, it.strip, it.frame * w, 0, SRCCOPY);
    this.host.invalidate();
  }

  /** AniTimer.OnTimer. */
  async tick() {
    if (this.state === 1) {
      this.state = 0;
      const it = this.queue[0];
      if (!it) return;
      this.drawFrame(it);
      if (it.sound) { this.host.playAsync(it.sound); it.sound = null; }
      if (it.dir === 1) {
        it.frame++;
        if (it.frames < it.frame) { this.state = 2; return; }
      } else if (it.dir === 2) {
        it.frame--;
        if (it.frame < 0) { this.state = 2; return; }
      } else {
        it.frame++;
        if (it.frames < it.frame) { it.frame -= 2; it.dir = 2; }
      }
      this.state = 1;
    } else if (this.state === 2) {
      this.state = 0;
      this.queue.shift();
      if (this.queue.length === 0) {
        if (this.afterAnim) await this.speakRecipe();
        this.afterAnim = false;
        if (this.tasting) {
          this.tasting = false;
          await this.tasteResult();
        }
      } else {
        this.host.setInterval(this.queue[0].interval);
        this.state = 1;
      }
    } else if (this.state === 3) {
      if (await this.host.playSyncNoStop('GSO004.WAV')) this.state = 0;
    }
  }

  /** FUN_0043a8b0: the troll has tasted. */
  private async tasteResult() {
    if (!isGoodRecipe(this.sel)) {
      await this.host.playSync('GSOS02.WAV');
      // troll 3 forward, troll 4 forward-and-back (both with sound); then speak the recipe
      this.queue.push(this.trollItem(2, 1, 1), this.trollItem(3, 3, 1));
      this.startAnim();
      this.afterAnim = true;
    } else {
      await this.host.playSync('GSOS01.WAV');
      await this.speakRecipe();
    }
  }

  /** FUN_0043aa54: spring the chosen buttons back (queued), speak the recipe, then run the animations. */
  private async speakRecipe() {
    const good = isGoodRecipe(this.sel);
    const picked: number[] = []; // 1-based ingredient numbers, in row order
    for (let row = 0; row < 4; row++) {
      if (this.sel[row] !== 0) {
        const n = row * 6 + this.sel[row];
        picked.push(n);
        this.toggle(n - 1);
        this.sel[row] = 0;
      }
    }
    if (picked.length === 0) return;
    await this.host.playSync(ingredientWav(picked[0]));
    for (let k = 1; k < picked.length; k++) {
      await this.host.playSync(connectorWav(k === 1 ? 1 : 2));
      await this.host.playSync(ingredientWav(picked[k]));
    }
    await this.host.playSync(connectorWav(good ? 3 : 4));
    this.startAnim();
  }
}
