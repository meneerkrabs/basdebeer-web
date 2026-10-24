// TfrmStoryPlayer (spec 1.5, 2-6): the script interpreter, reader and page navigation of the Noorderlicht books.
//
// The original runs three TTimers (CommandTimer 10 ms, AniTimer, clTimer) over a flat command list. The same
// structure is kept here: the form's own surface is the screen buffer, `bg` holds the clean backgrounds.

import { audio, MediaPlayer, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { playMidi, stopAllMidi, type MidiHandle } from '../../engine/midi.ts';
import { SRCAND, SRCPAINT, Surface, type FontSpec } from '../../engine/surface.ts';
import { Form, type Display, type Timer } from '../../engine/vcl.ts';
import { noorderlichtGames } from '../../games/noorderlicht/index.ts';
import { inRect, pageExists, writeBookmark, withMode, type Rect, type Session } from './common.ts';
import { askDialog, showKlikTip } from './dialogs.ts';

// ---------------------------------------------------------------- layout (800x600, spec 4.1)

const DISP: Rect = [123, 85, 683, 365]; // SysDispRect: the 560x280 main image
const TEXT: Rect = [205, 405, 595, 478]; // SysTextRect: 390x73, three lines
const TEXT_W = 390;
const LINE = 22; // line pitch in the text bitmaps

interface Button { rect: Rect; n: [number, number, string]; d: [number, number, string] }
/** Prev, Next, Stop, Read, Mode, Klik: hit rect, and the greyed overlay (x, y, file) for N and D mode (spec 4.2). */
const BUTTONS: Button[] = [
  { rect: [90, 410, 200, 470], n: [120, 426, 'NPREV.BMP'], d: [119, 425, 'DPREV.BMP'] },
  { rect: [600, 405, 715, 470], n: [627, 420, 'NNEXT.BMP'], d: [630, 422, 'DNEXT.BMP'] },
  { rect: [145, 495, 260, 600], n: [153, 497, 'NSTOP.BMP'], d: [152, 494, 'DSTOP.BMP'] },
  { rect: [280, 495, 400, 600], n: [291, 497, 'NREAD.BMP'], d: [292, 496, 'DREAD.BMP'] },
  { rect: [420, 495, 540, 600], n: [465, 498, 'NMODE.BMP'], d: [463, 497, 'DMODE.BMP'] },
  { rect: [555, 495, 675, 600], n: [568, 497, 'NKLIK.BMP'], d: [569, 498, 'DKLIK.BMP'] },
];
const B_PREV = 0, B_NEXT = 1, B_STOP = 2, B_READ = 3, B_MODE = 4, B_KLIK = 5;

const TEXT_FONT: Omit<FontSpec, 'color'> = { name: 'Arial', px: 15, bold: true }; // Height 18 cell; px 15 matches the word rects
const WHITE = 0xffffff, RED = 0x0000ff; // COLORREF: the INIT_TEXTBOX colours are ignored by the original (quirk 1)

// ---------------------------------------------------------------- script (spec 2)

const KEYWORDS = ['ACTIVATE_MAINIMAGE', 'END', 'ACTIVATE_TEXTBOX', 'TEXT_TOP', 'THE_END', 'AUTO_NEXT', 'NEXT_SCENE',
  'INIT_MAINIMAGE', 'NEXT_CLICKS', 'ONEXIT', 'INIT_CLICKAREA', 'ENABLE_CLICKAREA', 'DISABLE_CLICKAREA',
  'ACTIVATE_READER', 'INIT_ANIMATION', 'ACTIVATE_ANIMATION', 'INIT_TIPAREA', 'DELAY', 'INIT_EFFECT',
  'ACTIVATE_EFFECT', 'PLAY_GAME', 'PLAY_MOVIE', 'LABEL', 'INIT_CONTINUOUS_LABEL', 'INIT_TEXTBOX'] as const;

interface WordRec { text: string; start: number; end: number; first: number; last: number; x1: number; y1: number; x2: number; y2: number; line: number }
interface Cmd { t: (typeof KEYWORDS)[number]; a: string[]; words?: WordRec[] }

/** FUN_0042ec58: a line matching no keyword is dropped; INIT_TEXTBOX swallows its word lines up to {END_TEXT}. */
function parseScript(lines: string[]): Cmd[] {
  const cmds: Cmd[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = KEYWORDS.find((k) => line.startsWith(`{${k}}`));
    if (!t) continue;
    const parts = line.slice(line.indexOf('}') + 1).split('~');
    if (parts[parts.length - 1] === '') parts.pop();
    const cmd: Cmd = { t, a: parts };
    if (t === 'INIT_TEXTBOX') {
      cmd.words = [];
      while (++i < lines.length && !lines[i].startsWith('{END_TEXT}')) {
        const f = lines[i].split('~');
        const n = (k: number) => parseInt(f[k], 10) || 0;
        cmd.words.push({ text: f[0].slice(0, 20), start: n(1), end: n(2), first: n(3), last: n(4), x1: n(5), y1: n(6), x2: n(7), y2: n(8), line: n(9) });
      }
    }
    cmds.push(cmd);
  }
  return cmds;
}

// ---------------------------------------------------------------- runtime records

interface Anim { name: string; bmp: Surface; frames: number; interval: number; rect: Rect; wave: AudioBuffer | null; playSnd: boolean; cur: number }
interface Area { name: string; rect: Rect; enabled: boolean; labelIdx: number }
interface Effect { name: string; type: number; wave: AudioBuffer | null; midi: string }
interface TextRT { voice: AudioBuffer | null; words: WordRec[]; A: Surface; B: Surface; lineStart: number[]; lineCount: number; topLine: number }

/** The ready-flag values of runState (0x21e). */
const RS_IDLE = 0, RS_ONEXIT = 1, RS_RUN = 3;

export interface StoryEnv { display: Display; assets: Assets; session: Session }

export class StoryPlayer {
  readonly form: Form;
  readonly closed: Promise<void>;
  private finish!: () => void;
  private env: StoryEnv;
  private get front() { return this.form.surface; }
  private get mode() { return this.env.session.mode; }

  private bg!: [Surface, Surface]; // BACKN, BACKD
  private arrows!: Surface; // PIJLEN
  private overlays: [Surface, Surface][] = [];
  private reader = new MediaPlayer();
  private midi: MidiHandle | null = null;
  private cmdTimer!: Timer;
  private aniTimer!: Timer;
  private clTimer!: Timer;

  // page state
  page = '';
  readonly history: string[] = [];
  private cmds: Cmd[] = [];
  private pc = -1;
  private ready = false;
  private runState = RS_IDLE;
  private waitState = 0; // 1 delay, 2 wav, 3 midi, 4 game
  private sceneId = 0;
  private swapping = false; // between Unload and the end of LoadScene: input is ignored
  private hourglass = true;
  private closing = false;
  private turning = false;
  private theEnd = false;
  private goForward = true;
  private returnTo3D = false;
  private nextScene = '';
  private onExit = 0;
  private nextClicks = 2;
  private runIdle: (() => void) | null = null;

  private mainImage: Surface | null = null;
  private anims: Anim[] = [];
  private areas: Area[] = [];
  private effects: Effect[] = [];
  private text: TextRT | null = null;

  // buttons (spec 4.2)
  private enabled = [false, false, true, false, false, false];
  private saved = false; // +0x2eb
  private savedPrev = false;
  private savedNext = false;

  // AniTimer: main-interpreter animation and reader
  private animating = false;
  private animCur: Anim | null = null;
  private animFrom = 0;
  private animTo = 0;
  private readerState = 0; // 1 reading, 2 post-read countdown
  private readerContinues = false;
  private readerScrollBack = false;
  private readerCur = 0;
  private readerLast = 0;
  private countdown = 0;
  private gameResult: number | null = null;
  private gameParams: Record<string, string | number> | null = null;

  // clTimer: continuous labels (spec 3.4)
  private clState = 0;
  private clPC = 0;
  private clLabel = 0;
  private clPeriod = 0;
  private clCountdown = 0;
  private clAnim: Anim | null = null;
  private clFrom = 0;
  private clTo = 0;
  private clSoundPlaying = false;

  constructor(env: StoryEnv) {
    this.env = env;
    this.form = new Form(env.display, 800, 600, 'frmStoryPlayer');
    this.closed = new Promise((r) => (this.finish = r));
  }

  // ---------------------------------------------------------------- Start / close (spec 1.5)

  /** Start() (FUN_00444380): the page decides the mode (last character not 'N' = D). */
  async start(page: string) {
    const a = this.env.assets;
    this.hourglass = true;
    this.swapping = true;
    const [bn, bd, arrows] = await Promise.all([a.image('BACKN.BMP'), a.image('BACKD.BMP'), a.image('PIJLEN.BMP')]);
    this.bg = [bn, bd];
    this.arrows = arrows;
    this.overlays = await Promise.all(BUTTONS.map(async (b) => [await a.image(b.n[2]), await a.image(b.d[2])] as [Surface, Surface]));
    this.page = page.toUpperCase();
    this.env.session.mode = this.page.endsWith('N') ? 0 : 1;
    this.returnTo3D = false;
    this.front.bitBlt(0, 0, 800, 600, this.bg[this.mode], 0, 0);
    const f = this.form;
    f.cursor = 'wait';
    f.onMouseDown = (_b, _s, x, y) => this.mouseDown(x, y);
    f.onMouseMove = (_s, x, y) => this.mouseMove(x, y);
    f.onKeyDown = (key) => this.keyDown(key); // not in the original
    f.show();
    this.cmdTimer = f.timer(10, () => this.commandTick(), false);
    this.aniTimer = f.timer(10, () => this.aniTick());
    this.clTimer = f.timer(10, () => this.clTick());
    await this.loadScene();
  }

  /** FormClose: unload everything and hand over to the credits (or to whoever started us). */
  close() {
    if (this.closing) return;
    this.closing = true;
    this.sceneId++;
    this.ready = false;
    this.runState = RS_IDLE;
    this.reader.close();
    this.midi?.stop();
    stopAllMidi();
    audio.sndPlaySound(null);
    this.form.close(0);
    this.runIdle?.();
    this.runIdle = null;
    this.finish();
  }

  // ---------------------------------------------------------------- buttons (spec 4.2)

  private drawButtons() {
    const m = this.mode;
    BUTTONS.forEach((b, i) => {
      const [x, y, ] = m === 0 ? b.n : b.d;
      const img = this.overlays[i][m];
      if (this.enabled[i]) this.front.bitBlt(x, y, img.width, img.height, this.bg[m], x, y); // coloured art again
      else this.front.bitBlt(x, y, img.width, img.height, img, 0, 0); // greyed overlay
    });
  }

  /** FUN_00443ee0 */
  private disableButtons() {
    if (this.saved) return;
    this.savedPrev = this.enabled[B_PREV];
    this.savedNext = this.enabled[B_NEXT];
    this.enabled = [false, false, true, false, false, false];
    this.drawButtons();
    this.saved = true;
  }

  /** FUN_00443f50 */
  private restoreButtons() {
    this.enabled = [this.savedPrev, this.savedNext, true, true, true, true];
    this.drawButtons();
    this.saved = false;
  }

  // ---------------------------------------------------------------- scenes (spec 3.2, 6.1)

  private findLabel(name: string): number {
    const n = name.toLowerCase();
    const i = this.cmds.findIndex((c) => c.t === 'LABEL' && (c.a[0] ?? '').toLowerCase() === n);
    return i < 0 ? 0 : i; // a missing label is 0 (quirk 2)
  }

  private setHourglass(on: boolean) {
    this.hourglass = on;
    this.form.cursor = on ? 'wait' : 'default';
  }

  /** LoadScene (FUN_00445068) */
  private async loadScene() {
    this.setHourglass(true);
    this.swapping = true;
    const id = ++this.sceneId;
    this.anims = [];
    this.areas = [];
    this.effects = [];
    this.text = null;
    this.mainImage = null;
    let lines: string[];
    try {
      lines = (await this.env.assets.script(`${this.page}.BSB`)).split(/\r?\n/).filter((l) => l.length > 0);
    } catch (e) {
      console.error(`Script ${this.page} kan niet worden geladen`, e);
      this.close();
      return;
    }
    this.cmds = parseScript(lines);
    await this.preload();
    if (id !== this.sceneId || this.closing) return;
    this.nextScene = '';
    this.onExit = 0;
    this.nextClicks = 2;
    this.pc = -1;
    this.animating = false;
    this.readerState = 0;
    this.waitState = 0;
    this.clState = 0;
    this.goForward = true;
    this.gameResult = null;
    this.enabled = [this.history.length > 0, false, true, false, false, false];
    this.saved = false;
    this.disableButtons();
    this.runState = RS_RUN;
    this.ready = true;
    this.cmdTimer.enabled = true;
    this.swapping = false;
  }

  /** The CD read files on demand; here every file the page names is fetched up front, in parallel. */
  private async preload() {
    const a = this.env.assets;
    const files = new Set<string>();
    for (const c of this.cmds) {
      if (c.t === 'INIT_MAINIMAGE' || c.t === 'INIT_ANIMATION' || c.t === 'INIT_EFFECT' || c.t === 'INIT_TEXTBOX') {
        for (const x of c.a) if (/\.(BMP|WAV)$/i.test(x) && a.path(x)) files.add(x.toUpperCase());
      }
    }
    await Promise.all([...files].map((f) => (f.endsWith('.BMP') ? a.image(f) : a.sound(f)).catch(() => null)));
  }

  /** Unload (FUN_00445358) */
  private unload() {
    this.setHourglass(true);
    this.swapping = true;
    this.sceneId++;
    this.ready = false;
    this.runState = RS_IDLE;
    this.animating = false;
    this.readerState = 0;
    this.waitState = 0;
    this.clState = 0;
    this.reader.close();
    this.midi?.stop();
    this.midi = null;
    this.text = null;
    this.anims = [];
    this.areas = [];
    this.effects = [];
    if (this.theEnd) this.close();
  }

  /** NextPage (FUN_00445534) */
  private async nextPage() {
    if (this.turning || this.closing) return;
    this.turning = true;
    try {
      if (this.goForward && this.onExit > 0) { // run the ONEXIT label to its {END}
        this.pc = this.onExit;
        this.runState = RS_ONEXIT;
        this.ready = true;
        await new Promise<void>((r) => (this.runIdle = r));
        if (this.closing) return;
      }
      if (!this.goForward) {
        // the popped entry keeps the suffix it was pushed with in the original, which can show a D page on the N
        // background after a toggle; here it follows the current mode
        const p = this.history.pop();
        this.page = p ? withMode(p, this.mode) : this.page;
      } else {
        this.history.push(this.page);
        if (this.returnTo3D && pageExists(this.env.assets, withMode(this.nextScene, 1))) {
          this.nextScene = withMode(this.nextScene, 1);
          this.env.session.mode = 1;
          this.front.bitBlt(0, 0, 800, 600, this.bg[1], 0, 0);
          this.returnTo3D = false;
        }
        this.page = this.nextScene;
      }
      this.unload();
      if (this.theEnd) return;
      if (this.mode === 1 && !pageExists(this.env.assets, this.page)) {
        await askDialog(this.env.display, this.env.assets, 3, this.mode); // "no 3D-plus page here"
        this.returnTo3D = true;
        this.env.session.mode = 0;
        this.front.bitBlt(0, 0, 800, 600, this.bg[0], 0, 0);
        this.page = withMode(this.page, 0);
      }
      if (!pageExists(this.env.assets, this.page)) {
        console.error(`Applicatie wordt gestopt. Het volgende script bestaat nog niet : ${this.page}`);
        this.close();
        return;
      }
      writeBookmark(this.page);
      await this.loadScene();
    } finally {
      this.turning = false;
    }
  }

  /** FUN_004440a8: switch between normal and 3D-plus; the page restarts in the other mode. */
  private async toggleMode() {
    const env = this.env;
    if (this.mode === 0) {
      const dPage = withMode(this.page, 1);
      if (!pageExists(env.assets, dPage)) {
        await askDialog(env.display, env.assets, 3, this.mode);
        return;
      }
      if (!(await askDialog(env.display, env.assets, 1, this.mode))) return;
      this.unload();
      if (this.theEnd) return;
      this.page = dPage;
      env.session.mode = 1;
    } else {
      if (!(await askDialog(env.display, env.assets, 2, this.mode))) return;
      this.unload();
      if (this.theEnd) return;
      this.page = withMode(this.page, 0);
      env.session.mode = 0;
    }
    this.front.bitBlt(0, 0, 800, 600, this.bg[this.mode], 0, 0);
    await this.loadScene();
  }

  /** The Stop button (FUN_0044406c). */
  private async stopButton() {
    if (await askDialog(this.env.display, this.env.assets, 0, this.mode)) {
      this.unload();
      this.close();
    }
  }

  // ---------------------------------------------------------------- CommandTimer (spec 3.1, 2.3)

  private soundIdle() {
    // a never-unlocked AudioContext would keep every sound "playing"
    return !audio.busy || audio.ctx.state !== 'running';
  }

  private async commandTick() {
    if (!this.ready) return;
    this.ready = false;
    this.pc++;
    const cmd = this.cmds[this.pc];
    if (!cmd) { // the original runs off the end of the list; here the page just goes idle
      this.restoreButtons();
      this.runState = RS_IDLE;
      this.runIdle?.();
      this.runIdle = null;
      return;
    }
    const id = this.sceneId;
    const readyNow = await this.exec(cmd, id);
    if (id === this.sceneId && readyNow) this.ready = true;
  }

  /** Runs one command; returns true when it finishes at once (otherwise a timer sets `ready` later). */
  private async exec(c: Cmd, id: number): Promise<boolean> {
    const a = c.a;
    const as = this.env.assets;
    switch (c.t) {
      case 'ACTIVATE_MAINIMAGE': // FUN_004460c4
        if (this.mainImage) this.front.bitBlt(DISP[0], DISP[1], this.mainImage.width, this.mainImage.height, this.mainImage, 0, 0);
        if (!this.form.visible) this.form.show(); // after a game
        this.setHourglass(false);
        return true;
      case 'END':
        this.restoreButtons();
        this.runState = RS_IDLE;
        this.runIdle?.();
        this.runIdle = null;
        return false; // ready stays 0: the interpreter halts
      case 'ACTIVATE_TEXTBOX':
      case 'TEXT_TOP':
        this.drawWord(0, false, true);
        return true;
      case 'THE_END':
        this.theEnd = true;
        return true;
      case 'AUTO_NEXT':
        if (this.runState !== RS_ONEXIT) { void this.nextPage(); return false; }
        return true;
      case 'NEXT_SCENE':
        this.nextScene = (a[0] ?? '').slice(0, 3).toUpperCase() + (this.mode === 0 ? 'N' : 'D'); // scripts write 13b, 14a
        return true;
      case 'INIT_MAINIMAGE': {
        const img = await as.image(a[0] ?? '').catch((e) => { console.warn(e.message); return null; });
        if (id === this.sceneId) this.mainImage = img;
        return true;
      }
      case 'NEXT_CLICKS':
        this.nextClicks = (parseInt(a[0], 10) || 0) & 255; // a byte: 1000 wraps (quirk 5)
        return true;
      case 'ONEXIT':
        this.onExit = this.findLabel(a[0] ?? '');
        return true;
      case 'INIT_CLICKAREA': // name~x1~y1~x2~y2~enabled~label~
        this.areas.push({
          name: a[0] ?? '', rect: [+a[1] || 0, +a[2] || 0, +a[3] || 0, +a[4] || 0],
          enabled: (a[5] ?? '').toUpperCase() === 'TRUE', labelIdx: this.findLabel(a[6] ?? ''),
        });
        return true;
      case 'ENABLE_CLICKAREA':
        for (const ar of this.areas) if (ar.name.toLowerCase() === (a[0] ?? '').toLowerCase()) ar.enabled = true;
        return true;
      case 'DISABLE_CLICKAREA': {
        const n = (a[0] ?? '').toLowerCase();
        for (const ar of this.areas) if (n === 'sysall' || ar.name.toLowerCase() === n) ar.enabled = false;
        return true;
      }
      case 'ACTIVATE_READER': { // a~b~ (1-based, 0 = all words); blocks until the audio ends
        const t = this.text;
        if (!t || !t.voice || t.words.length === 0) return true;
        const from = parseInt(a[0], 10) || 0;
        const first = from === 0 ? 0 : from - 1;
        const last = from === 0 ? t.words.length - 1 : (parseInt(a[1], 10) || 0) - 1;
        if (!t.words[first] || !t.words[last]) return true;
        this.startReader(first, last, true, true);
        return false;
      }
      case 'INIT_ANIMATION': { // name~file~frames~interval~x1~y1~x2~y2~wav~
        const bmp = await as.image(a[1] ?? '').catch((e) => { console.warn(e.message); return null; });
        const wave = a[8] ? await as.sound(a[8]).catch(() => null) : null;
        if (id !== this.sceneId) return true;
        if (bmp) {
          this.anims.push({
            name: a[0] ?? '', bmp, frames: parseInt(a[2], 10) || 1, interval: parseInt(a[3], 10) || 100,
            rect: [+a[4] || 0, +a[5] || 0, +a[6] || 0, +a[7] || 0], wave, playSnd: false, cur: 0,
          });
        }
        return true;
      }
      case 'ACTIVATE_ANIMATION': { // name~from~to~sound~ ; blocks until the last frame
        const an = this.findAnim(a[0] ?? '');
        if (!an) return true;
        this.animFrom = parseInt(a[1], 10) || 0;
        this.animTo = parseInt(a[2], 10) || 0;
        an.cur = this.animFrom;
        an.playSnd = (a[3] ?? '').toUpperCase() === 'TRUE' && !!an.wave;
        this.animCur = an;
        this.aniTimer.setInterval(Math.max(an.interval, 1));
        this.animating = true;
        return false;
      }
      case 'INIT_TIPAREA':
      case 'PLAY_MOVIE':
        return true;
      case 'DELAY':
        this.aniTimer.setInterval(Math.max((parseInt(a[0], 10) || 0) * 10, 1));
        this.waitState = 1;
        return false;
      case 'INIT_EFFECT': { // name~file~type~  (all shipped scripts use type 1 = WAV)
        const type = parseInt(a[2], 10) || 0;
        const wave = type === 1 ? await as.sound(a[1] ?? '').catch((e) => { console.warn(e.message); return null; }) : null;
        if (id === this.sceneId) this.effects.push({ name: a[0] ?? '', type, wave, midi: a[1] ?? '' });
        return true;
      }
      case 'ACTIVATE_EFFECT': { // blocks until the sound ends
        const n = (a[0] ?? '').toLowerCase();
        const e = this.effects.find((x) => x.name.toLowerCase() === n);
        if (!e) { // the original never sets ready here and the page hangs (quirk 6); carry on instead
          console.warn(`effect ${a[0]} bestaat niet`);
          return true;
        }
        this.disableButtons();
        if (e.type === 1) {
          if (!e.wave) return true;
          audio.sndPlaySound(e.wave, SND_ASYNC);
          this.waitState = 2;
        } else {
          const raw = await as.raw(e.midi).catch(() => null);
          if (id !== this.sceneId) return true;
          if (!raw) return true;
          this.midi?.stop();
          this.midi = await playMidi(raw);
          this.waitState = 3;
        }
        return false;
      }
      case 'PLAY_GAME':
        await this.playGame(a[0] ?? '', id);
        return false;
      case 'LABEL':
        return true;
      case 'INIT_CONTINUOUS_LABEL': // label~secs~
        this.clLabel = this.findLabel(a[0] ?? '');
        this.clPeriod = this.clCountdown = (parseInt(a[1], 10) || 0) & 255; // a byte: 1000 -> 232 (quirk 5)
        this.clTimer.setInterval(1000);
        this.clState = 2;
        this.clSoundPlaying = false;
        return true;
      case 'INIT_TEXTBOX':
        this.initTextbox(c);
        return true;
    }
  }

  private findAnim(name: string): Anim | undefined {
    const n = name.toLowerCase();
    return this.anims.find((x) => x.name.toLowerCase() === n);
  }

  /** CopyRect of frame k (1-based) of the strip into the main image area (spec 4.4): no transparency. */
  private drawFrame(a: Anim, k: number) {
    const w = a.rect[2] - a.rect[0], h = a.rect[3] - a.rect[1];
    if (k < 1 || w <= 0 || h <= 0) return;
    this.front.stretchBlt(DISP[0] + a.rect[0], DISP[1] + a.rect[1], w, h, a.bmp, (k - 1) * w, 0, w, a.bmp.height);
  }

  // ---------------------------------------------------------------- AniTimer (spec 3.5)

  private aniTick() {
    switch (this.waitState) {
      case 1:
        this.waitState = 0;
        this.ready = true;
        return;
      case 2:
        if (this.soundIdle()) {
          this.waitState = 0;
          this.ready = true;
          this.restoreButtons();
        }
        return;
      case 3:
        if (!this.midi || !this.midi.playing) {
          this.waitState = 0;
          this.ready = true;
        }
        return;
      case 4:
        if (this.gameResult !== null) this.gameReturn();
        return;
    }
    if (this.readerState === 1) this.readerTick();
    else if (this.readerState === 2 && --this.countdown === 0) {
      this.readerState = 0;
      this.drawWord(0, false, true); // scroll back to the top
    }
    if (this.animating && this.animCur) {
      const a = this.animCur;
      this.drawFrame(a, a.cur);
      if (a.playSnd) {
        if (a.wave) audio.sndPlaySound(a.wave, SND_ASYNC);
        a.playSnd = false;
      }
      if (this.animTo < this.animFrom) {
        if (--a.cur < this.animTo) { this.ready = true; this.animating = false; }
      } else if (++a.cur > this.animTo) { this.ready = true; this.animating = false; }
    }
  }

  // ---------------------------------------------------------------- text box (spec 5)

  /** FUN_00447008 */
  private initTextbox(c: Cmd) {
    const words = c.words ?? [];
    const voice = c.a[2] ? this.env.assets.sound(c.a[2]) : null;
    const last = words[words.length - 1];
    const h = Math.max((last?.y2 ?? 0) + 5, TEXT[3]); // the TextRect.bottom term is a harmless oddity of the original
    const lineStart: number[] = [0];
    let lineCount = 0;
    words.forEach((w, i) => {
      if (w.line > lineCount) { lineCount = w.line; lineStart[w.line] = i + 1; }
    });
    const rt: TextRT = { voice: null, words, A: new Surface(TEXT_W, h, 0), B: new Surface(TEXT_W, h, 0xffffff), lineStart, lineCount, topLine: 1 };
    this.text = rt;
    words.forEach((_, i) => this.paintWord(rt, i, WHITE, true));
    // the narration wav was preloaded with the page
    void voice?.then((v) => { if (this.text === rt) rt.voice = v; }).catch(() => {});
  }

  /** TextOut of one word on the text bitmap (opaque brush): colour on A, and black on the white mask B. */
  private paintWord(t: TextRT, i: number, colour: number, alsoMask: boolean) {
    const w = t.words[i];
    const width = Math.max(w.x2 - w.x1, Surface.textWidth(w.text, { ...TEXT_FONT, color: 0 }));
    const hh = Math.max(w.y2 - w.y1, 18);
    t.A.fillRect(w.x1, w.y1, w.x1 + width, w.y1 + hh, 0);
    t.A.textOut(w.x1, w.y1, w.text, { ...TEXT_FONT, color: colour });
    if (alsoMask) {
      t.B.fillRect(w.x1, w.y1, w.x1 + width, w.y1 + hh, WHITE);
      t.B.textOut(w.x1, w.y1, w.text, { ...TEXT_FONT, color: 0 });
    }
  }

  /** FUN_00447244: redraw a word (normal or highlighted) and optionally composite the text window. */
  private drawWord(i: number, highlight: boolean, compose: boolean) {
    const t = this.text;
    if (!t) return;
    const w = t.words[i];
    if (w) this.paintWord(t, i, highlight ? RED : WHITE, false);
    if (!compose) return;
    if (w) {
      while ((t.topLine - 1) * LINE + 65 < w.y1) t.topLine++;
      while (w.y1 < (t.topLine - 1) * LINE) t.topLine--;
    }
    const sy = (t.topLine - 1) * LINE;
    const f = this.front;
    const bgm = this.bg[this.mode];
    f.bitBlt(TEXT[0], TEXT[1], TEXT_W, 73, bgm, TEXT[0], TEXT[1]);
    f.bitBlt(TEXT[0], TEXT[1], TEXT_W, 73, t.B, 0, sy, SRCAND); // transparent text on the board
    f.bitBlt(TEXT[0], TEXT[1], TEXT_W, 73, t.A, 0, sy, SRCPAINT);
    if (t.lineStart[3]) { // scroll arrows (shown from 3 lines, they only do something with more: quirk 7)
      f.bitBlt(TEXT[2] - 20, TEXT[1] + 5, 20, 25, this.arrows, 0, 25, SRCAND);
      f.bitBlt(TEXT[2] - 20, TEXT[1] + 5, 20, 25, this.arrows, 0, 0, SRCPAINT);
      f.bitBlt(TEXT[2] - 20, TEXT[1] + 38, 20, 25, this.arrows, 20, 25, SRCAND);
      f.bitBlt(TEXT[2] - 20, TEXT[1] + 38, 20, 25, this.arrows, 20, 0, SRCPAINT);
    }
  }

  // ---------------------------------------------------------------- reader (spec 5.4)

  /** Play words first..last (0-based) with the highlight following the playback position. */
  private startReader(first: number, last: number, fromScript: boolean, scrollBack: boolean) {
    const t = this.text;
    if (!t || !t.voice) { if (fromScript) this.ready = true; return; }
    audio.sndPlaySound(null);
    this.reader.open(t.voice);
    this.reader.play(t.words[first].start, t.words[last].end);
    this.readerLast = last;
    this.readerCur = first;
    this.drawWord(first, true, true);
    this.aniTimer.setInterval(10);
    this.readerContinues = fromScript;
    this.disableButtons();
    this.readerScrollBack = scrollBack;
    this.readerState = 1;
  }

  private readerTick() {
    const t = this.text;
    if (!t) { this.readerState = 0; return; }
    if (this.reader.mode === 'stopped' || this.readerFinished()) {
      this.drawWord(this.readerLast, false, true);
      this.countdown = 30;
      this.readerState = this.readerScrollBack ? 2 : 0;
      if (this.readerContinues) this.ready = true;
      else this.restoreButtons();
    } else if (this.readerCur < t.words.length - 1 && t.words[this.readerCur + 1].start < this.reader.position) {
      this.drawWord(this.readerCur, false, true);
      if (this.readerCur < this.readerLast) {
        this.readerCur++;
        this.drawWord(this.readerCur, true, true);
      }
    }
  }

  /** A locked AudioContext never ends a sound: do not wait for it. */
  private readerFinished() {
    return audio.ctx.state !== 'running';
  }

  // ---------------------------------------------------------------- clTimer (spec 3.4)

  private clTick() {
    switch (this.clState) {
      case 2:
        if (--this.clCountdown <= 0) {
          this.clPC = this.clLabel;
          this.clTimer.setInterval(10);
          this.clState = 1;
        }
        break;
      case 1: {
        this.clPC++;
        this.clState = 0;
        const c = this.cmds[this.clPC];
        if (!c || c.t === 'END') { // loop forever
          this.clCountdown = this.clPeriod;
          this.clTimer.setInterval(1000);
          this.clState = 2;
          break;
        }
        switch (c.t) {
          case 'ACTIVATE_ANIMATION': {
            const an = this.findAnim(c.a[0] ?? '');
            if (!an) { this.clState = 1; break; }
            this.clFrom = parseInt(c.a[1], 10) || 0;
            this.clTo = parseInt(c.a[2], 10) || 0;
            this.clTimer.setInterval(Math.max(an.interval, 1));
            an.cur = this.clFrom;
            an.playSnd = this.runState === RS_IDLE && !!an.wave && (c.a[3] ?? '').toUpperCase() === 'TRUE';
            this.clAnim = an;
            this.clState = 4;
            break;
          }
          case 'DELAY': // milliseconds here, not x10 (quirk 4)
            this.clTimer.setInterval(Math.max(parseInt(c.a[0], 10) || 0, 1));
            this.clState = 3;
            break;
          case 'ACTIVATE_EFFECT': {
            const n = (c.a[0] ?? '').toLowerCase();
            const e = this.effects.find((x) => x.name.toLowerCase() === n);
            if (!e) { this.clState = 1; break; }
            if (e.type === 1) {
              if (e.wave && !audio.busy) { // skipped while another sound plays (quirk 9)
                this.clSoundPlaying = true;
                audio.sndPlaySound(e.wave, SND_ASYNC);
                this.clState = 5;
              } else this.clState = 1;
            } else {
              void this.env.assets.raw(e.midi).then((raw) => playMidi(raw)).then((h) => { this.midi?.stop(); this.midi = h; });
              this.clState = 6;
            }
            break;
          }
          default:
            this.clState = 1; // LABEL and everything else is ignored
        }
        break;
      }
      case 3:
        this.clState = 1;
        break;
      case 4: {
        const an = this.clAnim!;
        this.drawFrame(an, an.cur);
        if (this.clSoundPlaying && this.soundIdle()) this.clSoundPlaying = false;
        if (an.playSnd) {
          if (an.wave) audio.sndPlaySound(an.wave, SND_ASYNC);
          this.clSoundPlaying = true;
          an.playSnd = false;
        }
        const done = this.clTo < this.clFrom ? --an.cur < this.clTo : ++an.cur > this.clTo;
        if (done) { this.clTimer.setInterval(10); this.clState = 1; }
        break;
      }
      case 5:
        if (this.soundIdle()) {
          this.clTimer.setInterval(10);
          this.clState = 1;
          this.clSoundPlaying = false;
        }
        break;
      case 6:
        if (!this.midi || !this.midi.playing) { this.clTimer.setInterval(10); this.clState = 1; }
        break;
    }
  }

  // ---------------------------------------------------------------- minigames (spec 7.1)

  private async playGame(n: string, id: number) {
    this.gameResult = null;
    const load = noorderlichtGames[n];
    if (!load) { // not available (yet): carry on with the next page
      console.warn(`spel ${n} ontbreekt`);
      this.gameResult = 1;
      this.waitState = 4;
      this.aniTimer.setInterval(10);
      return;
    }
    let mod;
    try { mod = await load(); } catch (e) {
      console.error(`spel ${n} kan niet worden geladen`, e);
      this.gameResult = 1;
      this.waitState = 4;
      return;
    }
    if (id !== this.sceneId) return;
    this.gameParams = { mode: this.mode === 0 ? 'N' : 'D', prev: this.history.length > 0 ? 1 : 0 };
    this.form.hide(); // the story player re-shows itself at the next ACTIVATE_MAINIMAGE
    this.waitState = 4;
    this.aniTimer.setInterval(20);
    const session = mod.default({ display: this.env.display, assets: this.env.assets, params: this.gameParams });
    void session.result.then((r) => (this.gameResult = r), (e) => { console.error(e); this.gameResult = 1; });
  }

  /** AniTimer state 4: the game form ended. 0 = stop (credits), 1 = next page, 2 = previous page. */
  private gameReturn() {
    const r = this.gameResult;
    this.gameResult = null;
    this.waitState = 0;
    // a game with its own 3D button (GMG) may have changed the mode: fix the suffixes and the background
    const m: 0 | 1 = this.gameParams?.mode === 'D' ? 1 : 0;
    this.gameParams = null;
    if (m !== this.mode) {
      this.env.session.mode = m;
      this.page = withMode(this.page, m);
      if (this.nextScene) this.nextScene = withMode(this.nextScene, m);
      this.front.bitBlt(0, 0, 800, 600, this.bg[m], 0, 0);
    }
    if (r === 0) {
      this.unload();
      this.close();
    } else if (r === 2) {
      this.goForward = false;
      void this.nextPage();
    } else void this.nextPage();
  }

  // ---------------------------------------------------------------- input (spec 6.1, 6.2)

  private mouseDown(x: number, y: number) {
    if (this.runState === RS_ONEXIT || this.swapping || this.closing) return;
    if (inRect(DISP, x, y)) { this.hotspotClick(x - DISP[0], y - DISP[1]); return; }
    if (inRect(TEXT, x, y)) { this.textClick(x - TEXT[0], y - TEXT[1]); return; }
    const hit = (i: number) => this.enabled[i] && inRect(BUTTONS[i].rect, x, y);
    if (hit(B_NEXT)) void this.nextPage();
    else if (hit(B_PREV)) { this.goForward = false; void this.nextPage(); }
    else if (hit(B_STOP)) void this.stopButton();
    else if (hit(B_READ)) {
      const t = this.text;
      if (t && t.words.length) this.startReader(0, t.words.length - 1, false, true);
    } else if (hit(B_MODE)) void this.toggleMode();
    else if (hit(B_KLIK)) void showKlikTip(this.env.display, this.env.assets);
  }

  /** FUN_00445b44: the first enabled click area under the pointer runs its label. */
  private hotspotClick(x: number, y: number) {
    if (this.runState !== RS_IDLE || this.readerState === 1) return;
    const area = this.areas.find((a) => a.enabled && inRect(a.rect, x, y));
    if (!area) return;
    if (this.clSoundPlaying) audio.sndPlaySound(null);
    this.pc = area.labelIdx;
    this.disableButtons();
    this.runState = RS_RUN;
    this.ready = true;
    if (this.nextClicks < 1) return;
    if (--this.nextClicks === 0) this.savedNext = true; // Next comes back at the label's {END}
  }

  /** FUN_00445c0c: scroll arrows and word clicks in the text window. */
  private textClick(x: number, y: number) {
    const t = this.text;
    if (!t || this.runState !== RS_IDLE || this.readerState !== 0) return;
    if (this.clSoundPlaying) audio.sndPlaySound(null);
    const w = TEXT_W;
    if (x > w - 20) {
      if (inRect([w - 20, 5, w, 35], x, y) && t.topLine > 1) {
        t.topLine--;
        this.drawWord(t.lineStart[t.topLine] - 1, false, true);
      }
      if (inRect([w - 20, 38, w, 63], x, y) && t.lineCount - t.topLine > 2) {
        t.topLine++;
        this.drawWord(t.lineStart[t.topLine] - 1, false, true);
      }
      return;
    }
    let row = 1; // a click in a gap counts as the first row
    if (inRect([0, 22, w, 42], x, y)) row = 2;
    if (inRect([0, 44, w, 63], x, y)) row = 3;
    const line = t.topLine + row - 1;
    const off = (t.topLine - 1) * LINE;
    for (let i = (t.lineStart[line] || 0) - 1; i >= 0 && i < t.words.length; i++) {
      const wd = t.words[i];
      if (wd.line !== line) break;
      if (inRect([wd.x1, wd.y1 - off, wd.x2, wd.y2 - off], x, y)) {
        const first = wd.first - 1, last = wd.last - 1;
        if (!t.words[first] || !t.words[last]) return;
        this.startReader(first, last, false, false);
        return;
      }
    }
  }

  private mouseMove(x: number, y: number) {
    if (this.hourglass || this.swapping) { this.form.cursor = 'wait'; return; }
    let hand = false;
    if (inRect(DISP, x, y)) {
      hand = this.runState === RS_IDLE && this.readerState !== 1 && this.areas.some((a) => a.enabled && inRect(a.rect, x - DISP[0], y - DISP[1]));
    } else hand = BUTTONS.some((b, i) => this.enabled[i] && inRect(b.rect, x, y));
    this.form.cursor = hand ? 'pointer' : 'default';
  }

  /** Not in the original: keyboard shortcuts for the buttons. */
  private keyDown(key: string) {
    if (this.swapping || this.closing || this.runState === RS_ONEXIT) return;
    if (key === 'Escape') void this.stopButton();
    else if ((key === 'ArrowRight' || key === 'PageDown') && this.enabled[B_NEXT]) void this.nextPage();
    else if ((key === 'ArrowLeft' || key === 'PageUp') && this.enabled[B_PREV]) { this.goForward = false; void this.nextPage(); }
  }
}
