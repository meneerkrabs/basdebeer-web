// "Bas de Beer naar Paaseiland" story book — port of TfrmMain in PAASBAAS.EXE.
// Spec: docs/re/paaseiland-engine.md (section numbers in comments refer to it).
//
// The original draws into two 640x480 bitmaps: a front buffer (what is on screen) and a
// clean back buffer without text, bee or quit sign. Here the form's own surface is the
// front buffer and `back` is the clean one.

import { audio, MediaPlayer, SND_ASYNC, SND_LOOP } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { Avi } from '../../engine/avi.ts';
import { SRCAND, SRCPAINT, Surface, type FontSpec } from '../../engine/surface.ts';
import { Form, type Display, type Timer } from '../../engine/vcl.ts';
import { paaseilandGames } from '../../games/paaseiland/index.ts';
import type { MinigameSession } from '../../games/types.ts';
import { runCredits } from './credits.ts';
import { showHelp } from './help.ts';
import { askResume } from './startup.ts';

type Rect = [number, number, number, number]; // left, top, right, bottom
const inRect = (r: Rect, x: number, y: number) => x >= r[0] && y >= r[1] && x < r[2] && y < r[3]; // PtInRect
const inRectIncl = (r: Rect, x: number, y: number) => x >= r[0] && y >= r[1] && x <= r[2] && y <= r[3]; // FUN_0042a6b0

const S = {
  Boot: 0, Run: 1, Busy: 2, Idle: 3, Leave: 4, Anim: 5, Reader: 6, Delay: 7, NextScene: 8,
  EffectWait: 9, Bee: 10, Movie: 11, Game: 14, SignUp: 0x18, SignDown: 0x19, SignWait: 0x1a,
} as const;

/** 16-colour table of INIT_TEXTBOX (FUN_0043d638), as COLORREF. */
const TEXT_COLOURS = [0x000000, 0x000080, 0x008000, 0x008080, 0x800000, 0x800080, 0x808000, 0x808080,
  0xc0c0c0, 0x0000ff, 0x00ff00, 0x00ffff, 0xff0000, 0xff00ff, 0xffff00, 0xffffff];

const TEXT_FONT: Omit<FontSpec, 'color'> = { name: 'Arial', px: 15, bold: true }; // Height 17 (cell)
const TEXT_W = 504;
const TEXT_WIN: Rect = [100, 7, 604, 72];
const HIVE: Rect = [16, 19, 71, 77];
const MOVIE_SKIP: Rect = [477, 390, 605, 470];
/** Menu hit rects (inclusive), section 2.2. */
const MENU_HIT: Rect[] = [[35, 403, 112, 475], [135, 401, 209, 478], [240, 415, 302, 478], [339, 404, 405, 478], [552, 402, 625, 478]];
/** Bookmark resume table (0x445800). */
const RESUME = [0, 2, 2, 3, 3, 5, 6, 6, 8, 9, 10, 11, 12, 12, 14, 15, 16, 16, 18, 19, 20, 21, 21, 23, 23, 25, 26, 27, 28, 29, 0, 0];
const BOOKMARK_KEY = 'bdb-paaseiland-boekenlegger';

interface Anim { name: string; bmp: Surface; frames: number; delay: number; rect: Rect; wav: AudioBuffer | null }
interface ClickArea { name: string; rect: Rect; label: string; enabled: boolean }
interface Word { text: string; rect: Rect; startMs: number; endMs: number; clickFrom: number; clickTo: number; line: number }
interface BeePoint { frame: number; x: number; y: number }

/** Delphi Round (banker's rounding). */
const dRound = (v: number) => {
  const f = Math.floor(v), d = v - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

export async function runPaaseiland(display: Display, assets: Assets): Promise<void> {
  const book = new PaaseilandBook(display, assets);
  if (import.meta.env.DEV) (globalThis as { __book?: unknown }).__book = book;
  await book.start();
  await book.finished;
}

class PaaseilandBook {
  private display: Display;
  private assets: Assets;
  private form: Form;
  private back = new Surface(640, 480);
  private get front() { return this.form.surface; }
  private timer!: Timer;
  finished: Promise<void>;
  private finish!: () => void;

  // fixed resources
  private header!: Surface;
  private menu!: Surface;
  private arrows!: Surface;
  private beeSprites!: Surface;
  private menuSounds: AudioBuffer[] = [];
  private buzz!: AudioBuffer;
  private reader = new MediaPlayer(); // ScriptMedia (channel B)

  // interpreter state (Appendix A)
  private state: number = S.Boot;
  private mode: number = S.Run;
  private savedMode: number = S.Run;
  private script: string[] = [];
  private lineIdx = 0;
  private labels: { name: string; line: number }[] = [];
  private currentScene = 0;
  private nextScene = 0;
  private nextClicks = 0;
  private canTurn = true;
  private repeatAvail = true; // +0x1f1
  private backAvail = true; // +0x1f2
  private displayMode = 0; // +0x1f4
  private exiting = false;
  private onExit = '';
  private hourglass = true;
  private hover = -1;
  private mainImage: Surface | null = null;

  // animation slots: 1..3 are the bee (BijUit, BijIn, Bij)
  private anims: (Anim | null)[] = [null];
  private animCount = 3;
  private animSlot: Anim | null = null;
  private animCur = 0;
  private animFrom = 0;
  private animTo = 0;
  private animPlaySound = false;

  private clickAreas: ClickArea[] = [];
  private effects = new Map<string, AudioBuffer>();
  private delayCount = 0;

  // text
  private words: Word[] = [];
  private wordCount = 0;
  private lineCount = 0;
  private lineFirst: number[] = [];
  private topLine = 1;
  private textColour = 0x800000;
  private hiColour = 0x0000ff;
  private colourText: Surface | null = null;
  private textMask: Surface | null = null;
  private readerWav: AudioBuffer | null = null;
  private readerLast = 0;
  private readerCur = 0;
  private repeatFlag = false;

  // bee
  private bee: BeePoint[] = [];
  private beeCur = 0;
  private loopStart = 0;
  private loopEnd = 0;
  private tipRect: Rect = [0, 0, 0, 0];
  private tipIdx = -1;

  // EINDE sign
  private sign: { yn: Surface; mask: Surface; saved: Surface; step: number; answer: number } | null = null;
  private question: AudioBuffer | null = null;

  // game / movie
  private game: MinigameSession | null = null;
  private gameResult = 0;
  private movie: { stop: () => void; playing: boolean } | null = null;

  constructor(display: Display, assets: Assets) {
    this.display = display;
    this.assets = assets;
    this.form = new Form(display, 640, 480, 'frmMain');
    this.form.inputBehindModal = true;
    this.finished = new Promise((r) => (this.finish = r));
  }

  async start() {
    const a = this.assets;
    [this.header, this.menu, this.arrows, this.beeSprites] = await Promise.all(
      ['HEADER.BMP', 'MENU.BMP', 'PIJLEN.BMP', 'PBS001.BMP'].map((n) => a.image(n)));
    const beeOut = await a.image('PBA001.BMP');
    this.anims[1] = { name: 'BijUit', bmp: beeOut, frames: 14, delay: 100, rect: [9, 19, 76, 74], wav: null };
    this.anims[2] = { name: 'BijIn', bmp: beeOut, frames: 16, delay: 100, rect: [0, 33, 82, 79], wav: null }; // never used
    this.anims[3] = { name: 'Bij', bmp: this.beeSprites, frames: 8, delay: 100, rect: [0, 0, 32, 56], wav: null };
    void a.image('PBA002.BMP').then((b) => { if (this.anims[2]) this.anims[2].bmp = b; }).catch(() => {});
    this.menuSounds = await Promise.all([0, 1, 2, 3, 4].map((i) => a.sound(`MNU00${i}.WAV`)));
    this.buzz = await a.sound('PB002.WAV');

    const f = this.form;
    f.cursor = 'wait';
    f.onMouseDown = (b, _s, x, y) => this.mouseDown(b === 'left', x, y);
    f.onMouseMove = (_s, x, y) => this.mouseMove(x, y);
    f.onKeyDown = (key) => {
      // keyboard shortcuts for the menu (not in the original)
      if (key === 'Escape') this.menuClick(0);
      else if (key === 'ArrowRight' || key === 'PageDown') this.menuClick(3);
      else if (key === 'ArrowLeft' || key === 'PageUp') this.menuClick(2);
    };
    f.onPaint = null; // the front buffer *is* the form surface
    f.show();
    this.timer = f.timer(10, () => this.tick());
  }

  // ---------------------------------------------------------------- timer (3.3, 8)

  private setInterval(ms: number) {
    if (this.timer.interval !== ms) this.timer.setInterval(ms);
  }

  private async tick() {
    switch (this.state) {
      case S.Boot:
        this.state = S.Busy;
        await this.loadScene(0);
        break;
      case S.Run:
        await this.execLine();
        break;
      case S.Leave: {
        this.state = S.Busy;
        this.exiting = true;
        if (!this.onExit) this.state = S.NextScene;
        else {
          const l = this.findLabel(this.onExit);
          if (l) { this.lineIdx = l.line; this.state = S.Run; }
          else this.state = S.NextScene; // original hangs here; continue instead
        }
        break;
      }
      case S.Anim:
        this.state = S.Busy;
        this.drawAnimFrame();
        if (this.animDone()) {
          if (this.mode === S.Bee) this.setInterval(50);
          this.state = this.mode;
        } else this.state = S.Anim;
        break;
      case S.Reader:
        this.state = S.Busy;
        this.readerTick();
        break;
      case S.Delay:
        this.state = S.Busy;
        this.state = --this.delayCount <= 0 ? this.mode : S.Delay;
        break;
      case S.NextScene:
        this.state = S.Busy;
        this.cleanup();
        if (this.currentScene === 31) { await this.close(); break; }
        if (this.currentScene === 0) this.nextScene = await this.bookmarkScene();
        await this.loadScene(this.nextScene);
        break;
      case S.EffectWait:
        // sndPlaySound(PB001, SYNC|NOSTOP) succeeds once channel A is free
        this.state = audio.busy ? S.EffectWait : this.mode;
        break;
      case S.Bee:
        this.state = S.Busy;
        this.drawBee();
        this.beeCur++;
        if (this.beeCur > this.loopEnd) this.beeCur = this.loopStart;
        if (this.state === S.Busy) this.state = S.Bee;
        break;
      case S.Movie:
        if (!this.movie?.playing) {
          this.movie = null;
          this.state = this.mode;
        }
        break;
      case S.Game:
        if (this.gameResult === 1) {
          this.game = null;
          this.state = this.mode;
        } else if (this.gameResult === 2) {
          this.game = null;
          this.state = S.Busy;
          await this.close();
        }
        break;
      case S.SignUp:
        this.state = S.Busy;
        this.drawSign();
        this.sign!.step++;
        if (this.sign!.step === 15) {
          if (this.question) { this.reader.open(this.question); this.reader.play(); }
          this.state = S.SignWait;
        } else this.state = S.SignUp;
        break;
      case S.SignDown:
        this.state = S.Busy;
        this.sign!.step--;
        this.drawSign();
        if (this.sign!.step === 0) await this.finishSign();
        else this.state = S.SignDown;
        break;
    }
  }

  // ---------------------------------------------------------------- scenes (3.1, 3.6)

  private findLabel(name: string) {
    return this.labels.find((l) => l.name === name);
  }

  private async loadScene(n: number) {
    this.hourglass = true;
    this.form.cursor = 'wait';
    this.currentScene = n;
    const name = `${String(n).padStart(3, '0')}.BSB`;
    const text = await this.assets.script(name);
    this.script = text.split(/\r?\n/).filter((l) => l.length > 0);
    this.labels = [];
    this.script.forEach((line, i) => {
      if (line.startsWith('{LABEL}')) this.labels.push({ name: line.slice(7, line.length - 1).slice(0, 20), line: i });
    });
    await this.preload();
    this.lineIdx = 0;
    this.nextClicks = 0;
    this.back.fillRect(0, 0, 640, 480, 0);
    if (this.script[0]?.startsWith('{MOVIE}')) {
      this.displayMode = 1;
    } else {
      this.displayMode = 3;
      if (n !== 0 && n !== 31) {
        this.displayMode = 0;
        this.back.bitBlt(0, 0, 640, 80, this.header, 0, 0);
        this.back.bitBlt(0, 400, 640, 80, this.menu, 0, 0);
        this.drawMenuButtons(true, true, false);
      }
    }
    this.front.bitBlt(0, 0, 640, 480, this.back, 0, 0);
    this.canTurn = true;
    this.state = S.Run;
  }

  /** Fetch every file the scene references in parallel (the CD read them on demand). */
  private async preload() {
    const files = new Set<string>();
    for (const line of this.script) for (const m of line.matchAll(/[\w-]+\.(BMP|WAV|AVI)/gi)) files.add(m[0]);
    await Promise.all([...files].map((f) => {
      const ext = f.slice(-3).toUpperCase();
      const p = ext === 'BMP' ? this.assets.image(f) : ext === 'WAV' ? this.assets.sound(f) : this.assets.raw(f);
      return (p as Promise<unknown>).catch((e) => console.warn(e));
    }));
  }

  private cleanup() {
    this.exiting = false;
    this.loopEnd = 0;
    this.onExit = '';
    this.anims.length = 4;
    this.animCount = 3;
    this.effects.clear();
    this.clickAreas = [];
    this.colourText = this.textMask = null;
  }

  private async bookmarkScene(): Promise<number> {
    const saved = Number(localStorage.getItem(BOOKMARK_KEY) ?? 0);
    const b = RESUME[saved] ?? 0;
    if (b === 0) return 1;
    const r = await askResume(this.display, this.assets, b);
    return r === 2 ? 1 : b;
  }

  private async close() {
    this.state = S.Busy;
    this.timer.enabled = false;
    audio.sndPlaySound(null);
    this.reader.stop();
    this.movie?.stop();
    if (this.currentScene !== 0) localStorage.setItem(BOOKMARK_KEY, String(this.currentScene));
    this.form.hide();
    await runCredits(this.display, this.assets);
    this.form.close();
    this.finish();
  }

  // ---------------------------------------------------------------- script lines (3.2, 3.4, 4)

  /** FUN_0044125c: field n of the current line (1-based), exactly as the original splits it. */
  private arg(n: number): string {
    const line = this.script[this.lineIdx] ?? '';
    if (n === 1) {
      const start = line[0] === '{' ? line.indexOf('}') + 2 : 1;
      const t = line.indexOf('~') + 1;
      return t === 0 ? '' : line.slice(start - 1, t - 1);
    }
    let s = line;
    for (let i = 1; i < n; i++) {
      const p = s.indexOf('~');
      s = p < 0 ? '' : s.slice(p + 1);
    }
    const p = s.indexOf('~');
    if (p >= 0) return s.slice(0, p);
    if (s === '') return '';
    let acc = s;
    this.lineIdx++;
    while (this.lineIdx < this.script.length && !this.script[this.lineIdx].includes('~')) acc += ' ' + this.script[this.lineIdx++];
    return acc + ' ' + (this.script[this.lineIdx] ?? ' ').slice(0, -1);
  }

  /** Read a list of fields that may continue over the following lines (INIT_READER, INIT_CLICKWORD). */
  private listArgs(startField: number, count: number): string[] {
    const out: string[] = [];
    let k = startField;
    let guard = 0;
    while (out.length < count && guard++ < 10000) {
      const v = this.arg(k);
      if (v === '') {
        if (this.lineIdx >= this.script.length - 1) break;
        this.lineIdx++;
        k = 1;
        continue;
      }
      out.push(v);
      k++;
    }
    return out;
  }

  private async execLine() {
    this.state = S.Busy;
    this.setInterval(10);
    this.mode = S.Run;
    const line = this.script[this.lineIdx] ?? '{END}';
    const cmd = line.startsWith('{') ? line.slice(0, line.indexOf('}') + 1) : '';
    switch (cmd) {
      case '{END}':
        if (this.exiting) this.state = S.NextScene;
        else {
          this.state = S.Idle;
          this.mode = S.Idle;
          this.hourglass = false;
          this.form.cursor = 'default';
        }
        return;
      case '{THE_END}':
        this.cleanup();
        await this.close();
        return;
      case '{AUTO_NEXT}':
        this.state = S.Leave;
        return;
      case '{NEXT_SCENE}': this.nextScene = parseInt(this.arg(1)) || 0; break;
      case '{INIT_MAINIMAGE}': this.mainImage = await this.assets.image(this.arg(1)); break;
      case '{ACTIVATE_MAINIMAGE}':
        if (this.mainImage) this.back.bitBlt(0, this.displayMode === 0 ? 80 : 0, this.mainImage.width, this.mainImage.height, this.mainImage, 0, 0);
        this.front.bitBlt(0, 0, 640, 480, this.back, 0, 0);
        break;
      case '{INIT_TEXTBOX}': this.mode = 2; this.initTextbox(); this.state = S.Run; break;
      case '{ACTIVATE_TEXTBOX}':
      case '{TEXT_TOP}':
        this.drawWord(1, false, true);
        break;
      case '{INIT_READER}': await this.initReader(); break;
      case '{ACTIVATE_READER}': this.playReader(parseInt(this.arg(1)), parseInt(this.arg(2))); break;
      case '{INIT_CLICKWORD}': this.initClickWord(); break;
      case '{INIT_ANIMATION}': await this.initAnimation(); break;
      case '{ACTIVATE_ANIMATION}': this.activateAnimation(this.arg(1), parseInt(this.arg(2)), parseInt(this.arg(3)), this.arg(4) === '1'); break;
      case '{INIT_CLICKAREA}':
        this.clickAreas.push({
          name: this.arg(1),
          rect: [+this.arg(2), +this.arg(3) + 80, +this.arg(4), +this.arg(5) + 80],
          label: this.arg(6).slice(0, 20),
          enabled: this.arg(7) === 'TRUE',
        });
        break;
      case '{ENABLE_CLICKAREA}':
      case '{DISABLE_CLICKAREA}': {
        const name = this.arg(1);
        for (const c of this.clickAreas) if (c.name === name) c.enabled = cmd === '{ENABLE_CLICKAREA}';
        break;
      }
      case '{NEXT_CLICKS}': this.nextClicks = parseInt(this.arg(1)) || 0; this.canTurn = false; break;
      case '{ONEXIT}': this.onExit = this.arg(1).slice(0, 20); break;
      case '{INIT_TIPAREA}': this.mode = S.Run; this.initTipArea(this.arg(1)); break;
      case '{DELAY}': this.delayCount = 1; this.setInterval(parseInt(this.arg(1)) || 10); this.state = S.Delay; break;
      case '{INIT_EFFECT}': {
        const name = this.arg(1).slice(0, 20);
        const buf = await this.assets.sound(this.arg(2)).catch(() => null);
        if (buf) this.effects.set(name, buf);
        break;
      }
      case '{ACTIVATE_EFFECT}': {
        const buf = this.effects.get(this.arg(1).slice(0, 20));
        if (buf) {
          audio.sndPlaySound(buf, SND_ASYNC);
          this.setHourglass();
          this.state = S.EffectWait;
        }
        break;
      }
      case '{PLAY_GAME}': await this.playGame(this.arg(1)); break;
      case '{PLAY_MOVIE}': await this.playMovie(this.arg(1)); break;
      default: break; // {LABEL}, {MOVIE}, {BLACKOUT}, {END_TEXT}, {INIT_MENU}, text lines...: no-ops
    }
    if (this.lineIdx >= this.script.length - 1) {
      // end of script without {END}: the original hangs with an hourglass; go idle instead
      if (this.state === S.Busy || this.state === S.Run) { this.state = S.Idle; this.mode = S.Idle; this.hourglass = false; this.form.cursor = 'default'; }
    } else {
      this.lineIdx++;
      if (this.state === S.Busy) this.state = S.Run;
    }
  }

  private setHourglass() {
    this.hourglass = true;
    this.form.cursor = 'wait';
  }

  // ---------------------------------------------------------------- animations

  private async initAnimation() {
    const name = this.arg(1);
    const bmp = await this.assets.image(this.arg(2));
    const wavName = this.arg(9);
    const wav = wavName ? await this.assets.sound(wavName).catch(() => null) : null;
    this.animCount++;
    this.anims[this.animCount] = {
      name, bmp, frames: parseInt(this.arg(3)) || 1, delay: parseInt(this.arg(4)) || 100,
      rect: [+this.arg(5), +this.arg(6) + 80, +this.arg(7), +this.arg(8) + 80], wav,
    };
  }

  private activateAnimation(name: string, from: number, to: number, sound: boolean) {
    let slot: Anim | null = null;
    for (let i = 1; i < this.anims.length; i++) if (this.anims[i]?.name === name) slot = this.anims[i]!;
    if (!slot) { console.warn(`Deze animatie bestaat niet: ${name}`); return; }
    this.animSlot = slot;
    this.animCur = from;
    this.animFrom = from;
    this.animTo = to;
    this.animPlaySound = sound;
    this.setInterval(slot.delay);
    if (this.mode !== S.Bee) this.setHourglass();
    this.state = S.Anim;
  }

  /** FUN_0043d87c */
  private drawAnimFrame() {
    const a = this.animSlot!;
    const w = a.rect[2] - a.rect[0], h = a.rect[3] - a.rect[1];
    const sx = (this.animCur - 1) * w;
    if (this.mode !== S.Bee) this.back.stretchBlt(a.rect[0], a.rect[1], w, h, a.bmp, sx, 0, w, a.bmp.height);
    this.front.stretchBlt(a.rect[0], a.rect[1], w, h, a.bmp, sx, 0, w, a.bmp.height);
    if (this.animPlaySound) {
      if (a.wav) audio.sndPlaySound(a.wav, SND_ASYNC);
      this.animPlaySound = false;
    }
  }

  private animDone(): boolean {
    if (this.animFrom > this.animTo) return --this.animCur < this.animTo;
    return ++this.animCur > this.animTo;
  }

  // ---------------------------------------------------------------- text box (5)

  private initTextbox() {
    this.textColour = TEXT_COLOURS[parseInt(this.arg(1))] ?? 0;
    this.hiColour = TEXT_COLOURS[parseInt(this.arg(2))] ?? 0;
    const paragraphs: string[] = [];
    while (this.lineIdx + 1 < this.script.length && !this.script[this.lineIdx + 1].startsWith('{END_TEXT}')) paragraphs.push(this.script[++this.lineIdx]);
    this.lineIdx++; // the {END_TEXT} line
    const font = { ...TEXT_FONT, color: 0 };
    const H = 17;
    const words: Word[] = [];
    const mk = (): Word => ({ text: '', rect: [0, 0, 0, 0], startMs: 0, endMs: 0, clickFrom: 0, clickTo: 0, line: 0 });
    let lineCount = 1;
    const lineFirst = [0, 1];
    let w = 1;
    words[1] = mk();
    words[1].rect = [5, 5, 5, 5];
    const place = (i: number, pitch: number) => {
      const W = Surface.textWidth(words[i].text, font);
      const [l, t] = words[i].rect;
      words[i].rect = [l, t, l + W, t + H];
      if (l + W > 499) {
        lineCount++;
        lineFirst[lineCount] = i;
        words[i].rect = [5, t + pitch, 5 + W, t + pitch + H];
      }
      words[i].line = lineCount;
      words[i].clickFrom = words[i].clickTo = i;
    };
    for (const p of paragraphs) {
      let s = p;
      let k: number;
      while ((k = s.indexOf(' ')) >= 0) {
        words[w].text = s.slice(0, k + 1);
        place(w, 21);
        words[w + 1] = mk();
        words[w + 1].rect = [words[w].rect[2], words[w].rect[1], words[w].rect[2], words[w].rect[1]];
        s = s.slice(k + 1);
        w++;
      }
      if (s !== '') {
        words[w].text = s;
        place(w, 20); // quirk: 20, not 21
        w++;
        words[w] = mk();
      }
      words[w].rect = [5, words[w - 1].rect[1] + 21, 0, 0];
      lineCount++;
      lineFirst[lineCount] = w;
    }
    this.words = words;
    this.wordCount = w - 1;
    this.lineCount = lineCount;
    this.lineFirst = lineFirst;
    const bottom = (words[this.wordCount]?.rect[1] ?? 0) + 21;
    const bh = Math.max(64, bottom);
    this.colourText = new Surface(TEXT_W, bh + 22, 0);
    this.textMask = new Surface(TEXT_W, bh + 22, 0xffffff);
    for (let i = 1; i <= this.wordCount; i++) this.drawWord(i, false, false);
    this.topLine = 1;
  }

  /** FUN_0044308c */
  private drawWord(w: number, highlight: boolean, blit: boolean) {
    const word = this.words[w];
    if (!this.colourText || !this.textMask) return;
    if (word) {
      this.colourText.textOut(word.rect[0], word.rect[1], word.text, { ...TEXT_FONT, color: highlight ? this.hiColour : this.textColour });
      if (!blit) this.textMask.textOut(word.rect[0], word.rect[1], word.text, { ...TEXT_FONT, color: 0 });
    }
    if (!blit) return;
    if (word) {
      while (word.rect[1] > (this.topLine - 1) * 21 + 65) this.topLine++;
      while ((this.topLine - 1) * 21 > word.rect[1]) this.topLine--;
    }
    const srcY = (this.topLine - 1) * 21;
    const f = this.front;
    f.bitBlt(100, 7, 504, 65, this.header, 100, 7);
    f.bitBlt(100, 7, 504, 65, this.textMask, 0, srcY + 1, SRCAND);
    f.bitBlt(100, 7, 504, 65, this.colourText, 0, srcY + 1, SRCPAINT);
    if (this.lineCount > 3) {
      f.stretchBlt(604, 10, 21, 25, this.arrows, 0, 25, 20, 25, SRCAND);
      f.stretchBlt(604, 10, 21, 25, this.arrows, 0, 0, 20, 25, SRCPAINT);
      f.stretchBlt(604, 44, 21, 25, this.arrows, 20, 25, 20, 25, SRCAND);
      f.stretchBlt(604, 44, 21, 25, this.arrows, 20, 0, 20, 25, SRCPAINT);
    }
  }

  private async initReader() {
    this.readerWav = await this.assets.sound(this.arg(1)).catch(() => null);
    const count = parseInt(this.arg(2)) || 0;
    this.wordCount = count;
    const pairs = this.listArgs(3, count);
    pairs.forEach((p, i) => {
      const [s, e] = p.split(',').map((v) => parseInt(v));
      const w = (this.words[i + 1] ??= { text: '', rect: [0, 0, 0, 0], startMs: 0, endMs: 0, clickFrom: i + 1, clickTo: i + 1, line: 0 });
      w.startMs = s || 0;
      w.endMs = e || 0;
    });
  }

  private initClickWord() {
    const n = parseInt(this.arg(1)) || 0;
    const v = this.listArgs(2, n * 3).map((x) => parseInt(x));
    for (let i = 0; i + 2 < v.length; i += 3) {
      const w = this.words[v[i]];
      if (w) { w.clickFrom = v[i + 1]; w.clickTo = v[i + 2]; }
    }
  }

  /** FUN_00443558 */
  private playReader(from: number, to: number) {
    this.state = S.Busy;
    if (!this.readerWav || !this.words[from] || !this.words[to]) { this.state = this.mode; return; }
    this.readerLast = to;
    this.readerCur = from;
    this.reader.open(this.readerWav);
    this.reader.play(this.words[from].startMs, this.words[to].endMs);
    this.drawWord(from, true, true);
    this.setInterval(100);
    this.state = S.Reader;
  }

  private readerTick() {
    if (this.reader.mode === 'stopped') {
      this.drawWord(this.readerLast, false, true);
      if (this.repeatFlag) { this.drawWord(1, false, true); this.repeatFlag = false; }
      this.state = this.mode;
      return;
    }
    if (this.reader.position > (this.words[this.readerCur]?.endMs ?? Infinity)) {
      this.drawWord(this.readerCur, false, true);
      if (this.readerCur < this.readerLast) {
        this.readerCur++;
        this.drawWord(this.readerCur, true, true);
      }
    }
    this.state = S.Reader;
  }

  // ---------------------------------------------------------------- menu (2.2, 6.3)

  /** FUN_0043fa3c */
  private drawMenuButtons(repeat: boolean, backAvail: boolean, turn: boolean) {
    this.repeatAvail = repeat;
    this.backAvail = backAvail;
    const b = this.back, m = this.menu;
    b.bitBlt(136, 400, 70, 80, m, repeat ? 640 : 136, 0);
    b.bitBlt(242, 400, 59, 80, m, backAvail ? 710 : 242, 0);
    b.bitBlt(338, 400, 50, 80, m, turn ? 769 : 338, 0);
    this.front.bitBlt(136, 400, 252, 80, b, 136, 400);
  }

  private menuAvailable(i: number) {
    return i === 0 || i === 4 || (i === 1 && this.repeatAvail) || (i === 2 && this.backAvail) || (i === 3 && this.canTurn);
  }

  private mouseMove(x: number, y: number) {
    this.form.cursor = this.hourglass ? 'wait' : this.cursorFor(x, y);
    if (this.state !== S.Idle || this.displayMode !== 0) return;
    const i = MENU_HIT.findIndex((r) => inRectIncl(r, x, y));
    if (i >= 0 && this.menuAvailable(i)) {
      if (this.hover !== i) {
        this.hover = i;
        audio.sndPlaySound(this.menuSounds[i], SND_ASYNC);
      }
    } else if (this.hover !== -1) {
      audio.sndPlaySound(null);
      this.hover = -1;
    }
  }

  /** Not in the original (it only had arrow/hourglass): a hand over things that react, for touch-era players. */
  private cursorFor(x: number, y: number): string {
    if (this.displayMode === 0 || this.displayMode === 2) {
      const i = MENU_HIT.findIndex((r) => inRectIncl(r, x, y));
      if (i >= 0 && this.menuAvailable(i)) return 'pointer';
    }
    if (this.state === S.Bee && inRect(this.tipRect, x, y)) return 'pointer';
    if (this.state === S.Idle && this.loopEnd !== 0 && inRect(HIVE, x, y)) return 'pointer';
    if (this.displayMode === 1 && inRect(MOVIE_SKIP, x, y)) return 'pointer';
    return 'default';
  }

  private menuClick(i: number) {
    if (this.hourglass && i !== 0) return;
    if (this.hover === i) { audio.sndPlaySound(null); this.hover = -1; }
    const gameMode = this.displayMode === 2;
    switch (i) {
      case 0: // EINDE
        if (this.hourglass) return;
        if (gameMode) this.game?.requestQuit?.();
        else void this.openSign();
        break;
      case 1: // HERHALEN
        if (!this.repeatAvail) return;
        if (gameMode) this.game?.repeat?.();
        else if (this.state === S.Idle) { this.mode = S.Idle; this.playReader(1, this.wordCount); this.repeatFlag = true; }
        break;
      case 2: // TERUGBLADEREN
        if (!this.backAvail || this.state !== S.Idle || this.displayMode !== 0) return;
        this.nextScene = this.currentScene - 1;
        this.state = S.Leave;
        break;
      case 3: // OMSLAAN
        if (!this.canTurn || this.state !== S.Idle || this.displayMode !== 0 || this.nextClicks > 0) return;
        this.state = S.Leave;
        break;
      case 4: // HELP
        if (this.state === S.Idle || gameMode) void showHelp(this.display, this.assets);
        break;
    }
  }

  // ---------------------------------------------------------------- mouse (6.5)

  private mouseDown(left: boolean, x: number, y: number) {
    if (this.hourglass) return;
    if (this.currentScene === 31) { this.state = S.Leave; return; }
    if (this.state === S.SignUp || this.state === S.SignDown || this.state === S.SignWait) {
      if (this.state === S.SignWait && this.sign) {
        if (x > 255 && x < 304 && y > 255 && y < 290) this.sign.answer = 1;
        else if (x > 324 && x < 385 && y > 258 && y < 291) this.sign.answer = 0;
        else return;
        this.reader.close();
        this.state = S.SignDown;
      }
      return;
    }
    if (this.displayMode === 1) {
      if (inRect(MOVIE_SKIP, x, y) && this.movie?.playing) this.movie.stop();
      return;
    }
    if (!left) return;
    if (this.displayMode === 0 || this.displayMode === 2) {
      const i = MENU_HIT.findIndex((r) => inRectIncl(r, x, y));
      if (i >= 0) { this.menuClick(i); return; }
    }
    if (this.state === S.Bee && this.beeCur >= this.loopStart && inRect(this.tipRect, x, y)) { this.beeClick(); return; }
    if (this.state !== S.Idle) return;
    if (this.loopEnd !== 0 && inRect(HIVE, x, y)) { this.hiveClick(); return; }
    if (this.displayMode === 0 && this.lineCount > 3) {
      if (inRect([604, 10, 625, 35], x, y)) {
        if (this.topLine > 1) { this.topLine--; this.drawWord(this.lineFirst[this.topLine], false, true); }
        return;
      }
      if (inRect([604, 44, 625, 69], x, y)) {
        if (this.lineCount - this.topLine > 3) { this.topLine++; this.drawWord(this.lineFirst[this.topLine], false, true); }
        return;
      }
    }
    if (y >= 80 && y < 400) {
      for (const area of this.clickAreas) {
        if (!inRect(area.rect, x, y)) continue;
        const l = this.findLabel(area.label);
        if (l && area.enabled) this.countClick(l.line);
      }
      if ((this.state as number) === S.Run) return;
    }
    if (this.displayMode === 0 && inRect(TEXT_WIN, x, y)) this.wordClick(x, y);
  }

  /** NEXT_CLICKS accounting + jump to a label (6.2). */
  private countClick(line: number) {
    if (!this.canTurn) {
      this.nextClicks--;
      if (this.nextClicks === 0) {
        this.drawMenuButtons(this.repeatAvail, this.backAvail, true);
        this.canTurn = true;
      }
    }
    this.lineIdx = line;
    this.state = S.Run;
  }

  private wordClick(x: number, y: number) {
    let row = 1;
    if (inRect([100, 29, 604, 50], x, y)) row = 2;
    if (inRect([100, 51, 604, 71], x, y)) row = 3;
    const L = row + this.topLine - 1;
    let w = this.lineFirst[L];
    if (!w) return;
    const off = (this.topLine - 1) * 21;
    for (;;) {
      const word = this.words[w];
      if (!word || word.line !== L || w > this.wordCount) return;
      const r = word.rect;
      if (inRect([r[0] + 100, r[1] + 7 - off, r[2] + 100, r[3] + 7 - off], x, y)) break;
      w++;
    }
    this.mode = S.Idle;
    this.playReader(this.words[w].clickFrom, this.words[w].clickTo);
  }

  // ---------------------------------------------------------------- Bzzz the bee (6.6)

  /** FUN_00441930 */
  private initTipArea(name: string) {
    const idx = this.clickAreas.findIndex((c) => c.name === name);
    if (idx < 0) return;
    const r = this.clickAreas[idx].rect;
    const tx = r[0] + Math.trunc((r[2] - r[0]) / 2) - 20, ty = r[1] + Math.trunc((r[3] - r[1]) / 2) - 35;
    if (tx === 0) return;
    const P: BeePoint[] = [];
    for (let i = 0; i < 16; i++) P.push({ frame: (i + 1) & 3, x: 24 + 2 * i, y: 40 + 3 * i });
    const x0 = P[15].x, y0 = P[15].y, dx = tx - x0, dy = ty - y0;
    const step = dx >= 51 && dx < 641 ? 0.04 : 0.05;
    for (let t = 3.14; t > 1.57; t -= step) P.push({ frame: P.length & 3, x: dRound(tx + dx * Math.cos(t)), y: dRound(y0 + dy * Math.sin(t)) });
    this.loopStart = P.length;
    const cx = P[P.length - 1].x, cy = P[P.length - 1].y + 22;
    for (let t = 4.71; t < 6.28; t += 0.1) P.push({ frame: P.length & 3, x: dRound(cx + 22 * Math.cos(t)), y: dRound(cy + 22 * Math.sin(t)) });
    for (let t = 0; t < 4.71; t += 0.1) P.push({ frame: P.length & 3, x: dRound(cx + 22 * Math.cos(t)), y: dRound(cy + 22 * Math.sin(t)) });
    this.bee = P;
    this.loopEnd = P.length - 1;
    this.beeCur = 0;
    this.tipRect = r;
    this.tipIdx = idx;
  }

  private hiveClick() {
    this.mode = S.Bee;
    this.activateAnimation('BijUit', 1, 14, false);
    audio.sndPlaySound(this.buzz, SND_ASYNC | SND_LOOP);
  }

  /** FUN_0043dac8 */
  private drawBee() {
    const p = this.bee[this.beeCur];
    if (!p) return;
    const prev = this.beeCur > 0 ? this.bee[this.beeCur - 1] : null;
    if (prev) this.front.bitBlt(prev.x, prev.y, 32, 28, this.back, prev.x, prev.y);
    this.front.bitBlt(p.x, p.y, 32, 28, this.beeSprites, p.frame * 32, 28, SRCAND);
    this.front.bitBlt(p.x, p.y, 32, 28, this.beeSprites, p.frame * 32, 0, SRCPAINT);
  }

  private beeClick() {
    this.state = S.Busy;
    const prev = this.bee[this.beeCur - 1];
    if (prev) this.front.bitBlt(prev.x, prev.y, 32, 28, this.back, prev.x, prev.y);
    audio.sndPlaySound(null);
    this.mode = S.Idle;
    this.beeCur = 1;
    const area = this.clickAreas[this.tipIdx];
    const l = area && area.enabled ? this.findLabel(area.label) : undefined;
    if (l) this.countClick(l.line);
    else this.state = S.Idle; // original hangs in state 2 here; stay usable instead
  }

  // ---------------------------------------------------------------- EINDE sign (6.4)

  private async openSign() {
    this.savedMode = this.mode;
    this.mode = this.state;
    this.state = S.Busy;
    if (this.mode === S.Anim || this.mode === S.EffectWait) audio.sndPlaySound(null);
    if (this.mode === S.Reader) this.reader.stop();
    const [yn, mask] = await Promise.all([this.assets.image('YN1.BMP'), this.assets.image('YN1M.BMP')]);
    this.question ??= await this.assets.sound('YN001.WAV').catch(() => null);
    const saved = new Surface(196, 179);
    saved.bitBlt(0, 0, 196, 179, this.front, 220, 221);
    this.sign = { yn, mask, saved, step: 1, answer: 0 };
    this.setInterval(100);
    this.state = S.SignUp;
  }

  private drawSign() {
    const s = this.sign!;
    this.front.bitBlt(220, 221, 196, 179, s.saved, 0, 0);
    const h = 12 * s.step;
    if (h <= 0) return;
    this.front.bitBlt(220, 400 - h, 196, h, s.mask, 0, 0, SRCAND);
    this.front.bitBlt(220, 400 - h, 196, h, s.yn, 0, 0, SRCPAINT);
  }

  private async finishSign() {
    const answer = this.sign?.answer;
    this.sign = null;
    if (answer === 1) { await this.close(); return; }
    if (this.mode === S.Reader) {
      const m = this.mode;
      this.mode = this.savedMode;
      this.playReader(this.readerCur, this.readerLast);
      if (this.state !== S.Reader) this.state = m;
    } else {
      this.state = this.mode;
      this.mode = this.savedMode;
    }
    this.setInterval(this.state === S.Bee ? 50 : this.state === S.Reader ? 100 : this.state === S.Anim ? this.animSlot?.delay ?? 10 : 10);
  }

  // ---------------------------------------------------------------- games and movies (7)

  private async playGame(n: string) {
    this.state = S.Busy;
    const load = paaseilandGames[n];
    if (!load) { console.warn(`spel ${n} ontbreekt`); return; }
    const mod = await load();
    this.gameResult = 0;
    this.displayMode = 2;
    this.drawMenuButtons(true, false, false);
    this.hourglass = false;
    this.form.cursor = 'default';
    const session = mod.default({ display: this.display, assets: this.assets });
    this.game = session;
    session.result.then((r) => (this.gameResult = r === 2 ? 2 : 1));
    this.state = S.Game;
  }

  private async playMovie(file: string) {
    this.state = S.Busy;
    const at: [number, number] = file.toUpperCase() === 'PBM001.AVI' ? [230, 175] : [240, 255];
    try {
      const avi = new Avi(await this.assets.raw(file));
      this.movie = playAvi(avi, this.front, at[0], at[1]);
    } catch (e) {
      console.error('Het filmpje kan niet worden afgespeeld', e);
    }
    this.hourglass = false;
    this.form.cursor = 'default';
    this.state = S.Movie;
  }
}

/** Play an AVI into a surface at (x,y), native size, with its audio; frame timing follows the audio clock. */
function playAvi(avi: Avi, target: Surface, x: number, y: number): { stop: () => void; playing: boolean } {
  const frame = new Surface(avi.width, avi.height);
  const samples = avi.audioSamples();
  let src: AudioBufferSourceNode | null = null;
  const t0 = audio.ctx.currentTime + 0.05;
  if (samples) {
    const buf = audio.ctx.createBuffer(samples.data.length, samples.data[0].length, samples.rate);
    samples.data.forEach((d, i) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, i));
    src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.master);
    src.start(t0);
  }
  const state = { playing: true, stop: () => {} };
  let last = -1;
  const step = () => {
    if (!state.playing) return;
    const t = audio.ctx.currentTime - t0;
    const n = Math.floor(t * avi.fps);
    if (n >= avi.frames.length) { state.stop(); return; }
    if (n >= 0 && n !== last) {
      avi.frame(n, frame);
      target.bitBlt(x, y, avi.width, avi.height, frame, 0, 0);
      last = n;
    }
    requestAnimationFrame(step);
  };
  state.stop = () => {
    state.playing = false;
    try { src?.stop(); } catch { /* not started */ }
  };
  requestAnimationFrame(step);
  return state;
}
