// "Bas de Beer naar Pirateneiland" story book: port of TMainForm in BBOEK32.EXE.
// Spec: docs/re/pirateneiland-engine.md (section numbers in comments refer to it).
//
// Like the original, one script line runs per ScriptTimer tick, with a byte-sized state machine (`st`, return state `ret`):
// a back buffer `back` (the page: picture, text box, menu, animations, worm) and the screen image (here: the form's surface),
// which receives rect copies of the back buffer. The mouse cursor is a sprite drawn straight on the screen by the MouseTimer.
//
// Deviations from the original (all marked "deviation" below):
//  - the MouseTimer (cursor animation, worm steps, worm idle countdown) ticks at 55 ms (Win95's timer resolution, spec 10.1);
//    the cursor sprite itself is painted by Display.overlay on every frame, so it follows the pointer smoothly;
//  - {DELAY} shorter than the timer interval waits one tick (the original underflows and hangs);
//  - an unknown animation / effect / script is logged instead of showing a message box or raising;
//  - assets of a page are decoded when the page loads and dropped when it ends (the CD was read on demand), which bounds memory;
//  - INIT_LARGEBOX is ignored (it only applies at 120 dpi), printing goes through window.print().

import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { SRCAND, SRCPAINT, Surface, decodeBmp, type TextRun } from '../../engine/surface.ts';
import { Form, type Display, type Timer } from '../../engine/vcl.ts';
import { pirateneilandGames } from '../../games/pirateneiland/index.ts';
import { skipMedia, somethingToSkip } from '../../engine/skip.ts';
import { runCredits } from './credits.ts';
import { SpriteCursor } from './cursor.ts';
import { Mci } from './mci.ts';
import { playMovieWindow } from './movie.ts';
import { copyPixels } from './pixels.ts';
import { Script, toInt } from './script.ts';
import { markGameSeen, markMovieSeen } from './shared.ts';
import { readLegger, writeLegger } from './storage.ts';
import {
  colourIndex, colourValue, drawBoxBackground, drawWord, emptyWord, layoutText, styleIndex, MAX_WORDS, TEXT_FONT,
  type Rect, type Word,
} from './textbox.ts';
import { BookWorm } from './worm.ts';

/** ScriptTimer states (+0x1c4). */
const S = {
  Idle: 0, Run: 2, Wait: 3, Reader: 4, Load: 5, Anim: 6, Quit: 7, Delay: 8, Effect: 9,
  SignUp: 11, SignDown: 12, SignWait: 13, Intro: 20, MovieWait: 21, Game: 22,
} as const;

const inRect = (r: Rect, x: number, y: number) => x >= r[0] && y >= r[1] && x < r[2] && y < r[3]; // PtInRect
const inRectIncl = (r: Rect, x: number, y: number) => x >= r[0] && y >= r[1] && x <= r[2] && y <= r[3];

/** Names of the minigames and their number (the INI key GameN). */
const GAME_NUMBERS: Record<string, number> = { MOTTENSPEL: 1, KISTENSPEL: 2, ROEISPEL: 3, KOKOSSPEL: 4, MEMORYSPEL: 5, GROTSPEL: 6 };

/** The sign (YN1.BMP): screen rect (220,301)-(416,480); strict inequalities of MainImageMouseDown. */
const SIGN: Rect = [220, 301, 416, 480];
const SIGN_JA = (x: number, y: number) => x > 254 && x < 305 && y > 334 && y < 371;
const SIGN_NEE = (x: number, y: number) => x > 323 && x < 386 && y > 337 && y < 372;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MOUSE_TICK_MS = 55; // deviation: nominally 10 ms (DFM), really ~55 ms on Win9x

interface Anim { name: string; bmp: Surface; frames: number; delay: number; rect: Rect; wav: AudioBuffer | null }
interface Effect { name: string; file: string; wav: AudioBuffer | null; midi: ArrayBuffer | null }
interface Area { rect: Rect; label: string }
interface MenuButton { rect: Rect; id: number }

export async function runPirateneiland(display: Display, assets: Assets): Promise<void> {
  const book = new PirateneilandBook(display, assets);
  if (import.meta.env.DEV) (globalThis as { __book?: unknown }).__book = book;
  await book.start();
  await book.finished;
}

class PirateneilandBook {
  private form: Form;
  private back = new Surface(640, 480);
  private get front() { return this.form.surface; }
  private scriptTimer!: Timer;
  private mouseTimer!: Timer;
  finished: Promise<void>;
  private finish!: () => void;

  private mci = new Mci();
  private cursor: SpriteCursor;
  private worm: BookWorm;

  // interpreter (+0x1c4 st, +0x1c5 ret, +0x638 curScene, +0x63c nextScene)
  private st: number = S.Intro;
  private ret: number = S.Run;
  private sc: Script | null = null;
  private curScene = 0;
  private nextScene = 0;
  /** INI Pagina as read at start-up (DAT_0043d674): bookmarks written later do not change it. */
  private bookmark = readLegger();
  private introFlag = false;
  private gameModalDepth = 0;
  private movieDone = false;
  private closing = false;
  private ff = false; // "Sla over" is fast-forwarding the script
  private gameSkipped = false;
  private gameStart = 0;
  private gameIntroHeard = false;
  private gameIntroDone = false;

  // resources that stay for the whole run
  private pattern!: Surface;
  private menuSheet!: Surface;
  private signYn!: Surface;
  private signMask!: Surface;
  private uaSprite!: Surface;
  private uaMask!: Surface;
  private menuSounds: AudioBuffer[] = [];
  private signSounds: (AudioBuffer | null)[] = [];
  // per-page asset caches
  private imgCache = new Map<string, Promise<Surface>>();
  private sndCache = new Map<string, Promise<AudioBuffer | null>>();
  private rawCache = new Map<string, Promise<ArrayBuffer | null>>();

  // page
  private mainName = '';
  private mainImage: Surface | null = null;

  // text box
  private box: Rect = [0, 0, 0, 0];
  private words: Word[] = Array.from({ length: MAX_WORDS + 2 }, emptyWord);
  private wordCount = 0;
  private textColour = 0;
  private hiColour = 0;
  private bgIndex = 1;
  private boxStyle = 0;
  private readerWav: AudioBuffer | null = null;
  private readFrom = 0;
  private readTo = 0;
  private readCur = 0;

  // menu
  private menuDef = { x: 0, y: 0, horiz: false, enabled: [false, false, false, false, false] };
  private menuButtons: MenuButton[] = [];
  private menuStrip: Rect = [0, 0, 0, 0];
  private lastHover = 0;

  private areas: Area[] = [];
  private anims: Anim[] = [];
  private anim: Anim | null = null;
  private animCur = 0;
  private animFrom = 0;
  private animTo = 0;
  private animSound = false;
  private effects: Effect[] = [];
  private delayTicks = 0;

  // JA/NEE sign
  private sign: { saved: Surface; n: number; mode: number; answer: boolean; hidden: [TextRun[], TextRun[]] } | null = null;

  // games
  private gameResult = 0; // 0 = playing, 2 = won, 3 = lost
  private failScene = 0;
  /** A movie window or a game covers the book: no cursor sprite. */
  private covered = false;
  private mouseSeen = false;

  private display: Display;
  private assets: Assets;

  constructor(display: Display, assets: Assets) {
    this.display = display;
    this.assets = assets;
    this.form = new Form(display, 640, 480, 'frmMain');
    this.form.cursor = 'none'; // the book draws its own cursor (spec 5.7, 10.4)
    this.finished = new Promise((r) => (this.finish = r));
    this.cursor = new SpriteCursor();
    this.worm = new BookWorm({
      back: this.back, blit: (x, y, w, h) => copyPixels(this.front, this.back, x, y, w, h), mci: this.mci, waiting: () => this.st === S.Wait,
    });
  }

  // ---------------------------------------------------------------- start / stop

  async start() {
    const a = this.assets;
    const [pattern, menuSheet, signYn, signMask, ua, uam, ...cursors] = await Promise.all([
      a.image('PATTERN.BMP'), a.image('MENU2.BMP'), a.image('YN1.BMP'), a.image('YN1M.BMP'), a.image('UA.BMP'), a.image('UAM.BMP'),
      a.image('msMouse1.BMP'), a.image('msMouth1.BMP'), a.image('mstv1.BMP'),
    ]);
    this.pattern = pattern; this.menuSheet = menuSheet; this.signYn = signYn; this.signMask = signMask;
    this.uaSprite = ua; this.uaMask = uam;
    this.cursor.setSprites(cursors);
    this.menuSounds = await Promise.all([1, 2, 3, 4, 5].map((i) => a.sound(`MNU00${i}.WAV`)));
    this.signSounds = await Promise.all(['YN001.WAV', 'YN002.WAV'].map((n) => a.sound(n).catch(() => null)));

    const f = this.form;
    f.onMouseDown = (_b, _s, x, y) => { this.mouseSeen = true; this.mouseDown(x, y); };
    f.onMouseMove = (_s, x, y) => { this.mouseSeen = true; this.mouseMove(x, y); };
    f.show();
    // FormCreate: ScriptTimer 70 ms, state 20 (intro movie). The MouseTimer stays off until the first SETMOUSETYPE.
    this.scriptTimer = f.timer(70, () => this.tick());
    this.mouseTimer = f.timer(MOUSE_TICK_MS, () => this.mouseTick(), false);
    this.display.skipProvider = () => this.skipInfo();
    this.display.overlay = (screen) => {
      if (this.mouseTimer.enabled && !this.covered && this.mouseSeen) this.cursor.paint(screen, this.display.mouseX, this.display.mouseY);
    };
  }

  private setInterval(ms: number) {
    if (ms > 0 && this.scriptTimer.interval !== ms) this.scriptTimer.setInterval(ms);
  }

  /** FUN_0043ad28: pick the cursor sprite. It also (re-)enables the MouseTimer. */
  private setMouseType(n: number) {
    this.cursor.setType(n);
    this.mouseTimer.enabled = true;
  }

  private async close() {
    if (this.closing) return;
    this.closing = true;
    this.st = S.Idle;
    this.scriptTimer.enabled = false;
    this.mouseTimer.enabled = false;
    this.display.overlay = null;
    this.display.skipProvider = null;
    audio.sndPlaySound(null);
    this.mci.close();
    this.form.hide();
    await runCredits(this.display, this.assets);
    this.form.close();
    this.finish();
  }

  // ---------------------------------------------------------------- per-page asset cache

  private img(name: string): Promise<Surface> {
    const k = name.trim().toUpperCase();
    let p = this.imgCache.get(k);
    if (!p) this.imgCache.set(k, (p = this.assets.raw(k).then(decodeBmp)));
    return p;
  }

  private snd(name: string): Promise<AudioBuffer | null> {
    const k = name.trim().toUpperCase();
    let p = this.sndCache.get(k);
    if (!p) {
      p = this.assets.raw(k).then((b) => audio.decode(b)).catch((e) => { console.warn(`geluid ${k}:`, e.message ?? e); return null; });
      this.sndCache.set(k, p);
    }
    return p;
  }

  private raw(name: string): Promise<ArrayBuffer | null> {
    const k = name.trim().toUpperCase();
    let p = this.rawCache.get(k);
    if (!p) this.rawCache.set(k, (p = this.assets.raw(k).catch((e) => { console.warn(`bestand ${k}:`, e.message ?? e); return null; })));
    return p;
  }

  /** Decode everything the page names (the CD read it lazily). Missing files are logged, not fatal. */
  private async preload(lines: string[]) {
    const names = new Set<string>();
    for (const line of lines) for (const m of line.matchAll(/[\w-]+\.(BMP|WAV|MID)\b/gi)) names.add(m[0].toUpperCase());
    await Promise.all([...names].map((n) => {
      if (n.endsWith('.BMP')) return this.img(n).catch((e) => console.warn(`plaatje ${n}:`, e.message ?? e));
      if (n.endsWith('.WAV')) return this.snd(n);
      return this.raw(n);
    }));
  }

  // ---------------------------------------------------------------- ScriptTimer (3.4)

  private async tick() {
    if (this.ff) return; // "Sla over" is fast-forwarding the script
    switch (this.st) {
      case S.Intro: { // FormCreate's first tick: the intro movie
        this.st = S.Idle;
        this.introFlag = true;
        this.mouseTimer.enabled = false;
        this.blackout();
        this.startMovie(1);
        this.st = S.MovieWait;
        break;
      }
      case S.MovieWait:
        if (this.movieDone) {
          this.covered = false;
          if (this.introFlag) {
            this.introFlag = false;
            this.nextScene = 0;
            this.st = S.Load;
          } else this.st = S.Run;
        }
        break;
      case S.Run:
        await this.runLine();
        break;
      case S.Wait:
      case S.Idle:
        break;
      case S.Reader:
        this.tickReader();
        break;
      case S.Load: {
        this.st = S.Idle;
        this.cleanup();
        this.curScene = this.nextScene;
        await this.loadScript(this.curScene);
        break;
      }
      case S.Anim: {
        this.st = S.Idle;
        this.drawAnimFrame();
        if (this.animTo < this.animFrom) {
          this.animCur--;
          if (this.animCur < this.animTo) { this.st = this.ret; break; }
        } else {
          this.animCur++;
          if (this.animTo < this.animCur) { this.st = this.ret; break; }
        }
        this.st = S.Anim;
        break;
      }
      case S.Quit:
        this.st = S.Idle;
        this.cleanup();
        await this.close();
        break;
      case S.Delay:
        this.st = S.Idle;
        this.delayTicks--;
        this.st = this.delayTicks === 0 ? this.ret : S.Delay;
        break;
      case S.Effect:
        this.st = this.mci.stopped ? this.ret : S.Effect;
        break;
      case S.SignUp:
        this.st = S.Idle;
        this.drawSign();
        this.sign!.n++;
        if (this.sign!.n === 15) {
          const q = this.signSounds[this.sign!.mode === 1 ? 0 : 1];
          if (q) this.mci.playWav(q);
          this.st = S.SignWait;
        } else this.st = S.SignUp;
        break;
      case S.SignDown:
        this.st = S.Idle;
        this.sign!.n--;
        this.drawSign();
        if (this.sign!.n === 0) this.finishSign();
        else this.st = S.SignDown;
        break;
      case S.SignWait:
        break;
      case S.Game:
        if (this.gameResult !== 0) {
          if (this.gameResult !== 2) this.nextScene = this.failScene;
          this.covered = false;
          this.st = this.ret;
        }
        break;
    }
  }

  /** The back buffer and the screen to black (a game or movie is about to cover the book). */
  private blackout() {
    this.back.fillRect(0, 0, 640, 480, 0);
    this.front.bitBlt(0, 0, 640, 480, this.back, 0, 0);
  }

  // ---------------------------------------------------------------- scene loading (3.1)

  /** FUN_0043b8bc: free the page's animations/menu sheet and reset the worm. */
  private cleanup() {
    this.anims = [];
    this.anim = null;
    this.areas = [];
    this.effects = [];
    this.worm.reset();
  }

  private async loadScript(n: number) {
    this.imgCache.clear();
    this.sndCache.clear();
    this.rawCache.clear();
    const name = `${String(n).padStart(3, '0')}.BSB`;
    let text: string;
    try {
      text = await this.assets.script(name);
    } catch (e) {
      // the original raises an exception here (page does not exist); stay on the current page instead
      console.error(`pagina ${name} ontbreekt`, e);
      this.st = S.Wait;
      return;
    }
    this.sc = new Script(text);
    await this.preload(this.sc.lines);
    this.st = S.Run;
  }

  // ---------------------------------------------------------------- RUN_LINE (3.4, 4)

  private async runLine() {
    const sc = this.sc!;
    this.st = S.Idle;
    this.ret = S.Run;
    const cmd = sc.command;
    if (cmd === '{END}') { this.st = S.Wait; this.ret = S.Wait; }
    switch (cmd) {
      case '{NEXT_SCENE}': this.nextScene = toInt(sc.arg(1)); break;
      case '{INIT_MAINIMAGE}': {
        this.mainName = sc.arg(1);
        this.mainImage = await this.img(this.mainName).catch((e) => { console.warn(e); return null; });
        break;
      }
      case '{ACTIVATE_MAINIMAGE}':
        // the back buffer is replaced by the picture: menu, text box and worm vanish from it, instantly, no transition
        if (this.mainImage) this.back.bitBlt(0, 0, 640, 480, this.mainImage, 0, 0);
        this.front.bitBlt(0, 0, 640, 480, this.back, 0, 0);
        break;
      case '{INIT_LARGEBOX}': break; // only used at 120 dpi
      case '{INIT_TEXTBOX}': this.initTextbox(); break;
      case '{ACTIVATE_TEXTBOX}': this.activateTextbox(); break;
      case '{INIT_MENU}': this.initMenu(); break;
      case '{ACTIVATE_MENU}': this.activateMenu(); break;
      case '{CLICK_AREA}': {
        const r: Rect = [toInt(sc.arg(1)), toInt(sc.arg(2)), toInt(sc.arg(3)), toInt(sc.arg(4))];
        this.areas.push({ rect: r, label: sc.arg(5).slice(0, 20) });
        break;
      }
      case '{INIT_READER}': await this.initReader(); break;
      case '{ACTIVATE_READER}': this.activateReader(toInt(sc.arg(1)), toInt(sc.arg(2))); break;
      case '{INIT_CLICKWORD}': this.initClickWord(); break;
      case '{INIT_ANIMATION}': await this.initAnimation(); break;
      case '{ACTIVATE_ANIMATION}': this.activateAnimation(); break;
      case '{THE_END}':
        this.st = S.Idle;
        this.mouseTimer.enabled = false;
        this.cleanup();
        await this.close();
        return;
      case '{AUTO_NEXT}':
        this.curScene = this.nextScene;
        this.st = S.Load;
        return;
      case '{DELAY}': {
        // deviation: shorter than one interval waits one tick (the original's counter would underflow and hang)
        this.delayTicks = Math.max(1, Math.trunc(toInt(sc.arg(1)) / this.scriptTimer.interval));
        this.st = S.Delay;
        break;
      }
      case '{INIT_EFFECT}': await this.initEffect(); break;
      case '{ACTIVATE_EFFECT}': this.activateEffect(); break;
      case '{SETMOUSETYPE}': this.setMouseType(toInt(sc.arg(1))); break;
      case '{FIND_LEGGER}':
        if (this.bookmark !== 0) {
          this.nextScene = this.bookmark;
          this.st = S.Load;
          return;
        }
        break;
      case '{INIT_URM}': await this.initUrm(); break;
      case '{ACTIVATE_URM}': this.worm.activate(this.uaSprite, this.uaMask); break;
      case '{PLAY_GAME}': await this.playGame(); break;
      case '{PLAY_MOVIE}': this.playMovie(toInt(sc.arg(1))); break;
      default: break; // {LABEL}, text continuation lines, unknown commands ({ACTIVATE_ANIMATIONT} in 035) do nothing
    }
    if (sc.ip === sc.lastIndex) this.st = S.Wait; // the end of the file acts as {END}
    sc.ip++;
    if (this.st === S.Idle) this.st = S.Run;
  }

  // ---------------------------------------------------------------- text box (4: INIT_TEXTBOX/ACTIVATE_TEXTBOX)

  private initTextbox() {
    const sc = this.sc!;
    const x = toInt(sc.arg(1)), y = toInt(sc.arg(2)), w = toInt(sc.arg(3));
    this.textColour = colourValue(sc.arg(4));
    this.hiColour = colourValue(sc.arg(5));
    this.bgIndex = colourIndex(sc.arg(6));
    this.boxStyle = styleIndex(sc.arg(7));
    const text = sc.arg(8); // last: a multi-line text moves the line pointer
    const font = { ...TEXT_FONT, color: 0 };
    const lay = layoutText(x, y, w, text, (s) => Surface.textWidth(s, font));
    this.box = lay.box;
    this.words = lay.words;
    this.wordCount = lay.count;
  }

  /** FUN_004374c0 */
  private activateTextbox() {
    drawBoxBackground(this.back, this.pattern, this.box, this.bgIndex, this.boxStyle);
    for (let i = 1; i <= this.wordCount; i++) this.drawWordBack(i, false);
    this.refreshBox();
  }

  /** FUN_00437550 (drawing half): the word (plain or highlighted, with its shadow) into the back buffer. */
  private drawWordBack(i: number, highlight: boolean) {
    const w = this.words[i];
    if (!w || !w.text) return;
    drawWord(this.back, w, highlight ? this.hiColour : this.textColour);
  }

  /**
   * Copy of the text box from the back buffer to the screen. The original copies just the word's rect; copying the whole
   * box gives the same picture and keeps the engine's text runs (hi-res text mode) of neighbouring words intact.
   */
  private refreshBox() {
    const [l, t, r, b] = this.box;
    this.front.bitBlt(l, t, r - l, b - t, this.back, l, t);
  }

  private paintWord(i: number, highlight: boolean) {
    this.drawWordBack(i, highlight);
    this.refreshBox();
  }

  /** Copy a rect of the back buffer to the screen; if it only grazes the text box, refresh the whole box too (see refreshBox). */
  private blitFront(l: number, t: number, w: number, h: number) {
    this.front.bitBlt(l, t, w, h, this.back, l, t);
    const [bl, bt, br, bb] = this.box;
    const touches = l < br && l + w > bl && t < bb && t + h > bt;
    const covers = l <= bl && t <= bt && l + w >= br && t + h >= bb;
    if (touches && !covers) this.refreshBox();
  }

  // ---------------------------------------------------------------- reader (4: INIT_READER/ACTIVATE_READER/INIT_CLICKWORD)

  /** FUN_004364b4: file, word count (overrides the layout count) and start,end pairs that may continue on the next lines. */
  private async initReader() {
    const sc = this.sc!;
    this.readerWav = await this.snd(sc.arg(1));
    const count = toInt(sc.arg(2));
    this.wordCount = count;
    let k = 3;
    for (let i = 1; i <= count; i++) {
      if (sc.arg(k) === '') {
        k = 1;
        sc.ip++;
        if (sc.ip >= sc.lines.length) break; // truncated script
      }
      const pair = sc.arg(k);
      const comma = pair.indexOf(',');
      const w = (this.words[i] ??= emptyWord());
      w.startMs = toInt(comma < 0 ? pair : pair.slice(0, comma));
      w.endMs = toInt(comma < 0 ? '' : pair.slice(comma + 1));
      k++;
    }
  }

  /** FUN_00436718: triples (word, first, last): clicking word reads first..last. */
  private initClickWord() {
    const sc = this.sc!;
    let w = toInt(sc.arg(1)), from = toInt(sc.arg(2)), to = toInt(sc.arg(3));
    let k = 0;
    while (w !== 0) {
      const word = this.words[w];
      if (word) { word.clickFrom = from; word.clickTo = to; }
      if (sc.arg(k + 4) === '') {
        w = 0;
      } else {
        w = toInt(sc.arg(k + 4));
        from = toInt(sc.arg(k + 5));
        to = toInt(sc.arg(k + 6));
      }
      k += 3;
    }
  }

  /** Close/Open the reader file, StartPos/EndPos = word times, Play. A zero-length range ends at once (EndPos 0). */
  private playRange(from: number, to: number) {
    this.mci.stop();
    const a = this.words[from]?.startMs ?? 0, b = this.words[to]?.endMs ?? 0;
    if (this.readerWav && b > a) this.mci.playWav(this.readerWav, a, b);
  }

  /** FUN_00436608 */
  private activateReader(from: number, to: number) {
    this.readFrom = from;
    this.readTo = to;
    this.readCur = from;
    this.playRange(from, to);
    this.setMouseType(2);
    this.paintWord(this.readCur, true);
    this.setInterval(40);
    this.st = S.Reader;
  }

  private tickReader() {
    this.st = S.Idle;
    if (this.mci.stopped) {
      // deviation: the current word is also unhighlighted (the original only redraws the last one, which can leave a
      // word lit when the timer lagged behind the audio)
      if (this.readCur !== this.readTo) this.drawWordBack(this.readCur, false);
      this.drawWordBack(this.readTo, false);
      this.refreshBox();
      this.setMouseType(1);
      this.st = this.ret;
      return;
    }
    const w = this.words[this.readCur];
    if (this.mci.position > (w ? w.endMs : Infinity)) {
      this.drawWordBack(this.readCur, false);
      if (this.readCur < this.readTo) {
        this.readCur++;
        this.drawWordBack(this.readCur, true);
      }
      this.refreshBox();
    }
    this.st = S.Reader;
  }

  // ---------------------------------------------------------------- menu (5.5)

  private initMenu() {
    const sc = this.sc!;
    this.menuDef = {
      x: toInt(sc.arg(1)), y: toInt(sc.arg(2)), horiz: sc.arg(3) === '1',
      enabled: [4, 5, 6, 7, 8].map((n) => sc.arg(n) === '1'),
    };
    // args 9 and 10 (colour, style) are parsed by the original and never used
  }

  /** FUN_00436b20: enabled buttons packed in order, drawn from MENU2.BMP (mask SRCAND, image SRCPAINT). */
  private activateMenu() {
    const { x, y, horiz, enabled } = this.menuDef;
    const ids = [1, 2, 3, 4, 5].filter((i) => enabled[i - 1]);
    if (ids.length === 0) return;
    const dx = horiz ? 50 : 0, dy = horiz ? 0 : 50;
    const n = ids.length;
    this.menuStrip = [x - 2, y, (n - 1) * dx + x + 54, (n - 1) * dy + y + 50];
    this.menuButtons = ids.map((id, i) => {
      const r: Rect = [i * dx + x, i * dy + y, i * dx + x + 50, i * dy + y + 50];
      this.back.bitBlt(r[0], r[1], 50, 50, this.menuSheet, (id - 1) * 50, 50, SRCAND);
      this.back.bitBlt(r[0], r[1], 50, 50, this.menuSheet, (id - 1) * 50, 0, SRCPAINT);
      return { rect: r, id };
    });
    const [l, t, r, b] = this.menuStrip;
    this.blitFront(l, t, r - l, b - t);
  }

  /** MainImageMouseMove_43b620: hover sounds of the menu icons (own sound channel, does not disturb the reader). */
  private mouseMove(x: number, y: number) {
    if (this.st !== S.Wait || this.worm.walking) return;
    const s = this.menuStrip;
    if (s[2] === s[0] || s[2] - s[0] < 0 || !inRect(s, x, y)) {
      if (this.lastHover !== 0) {
        audio.sndPlaySound(null);
        this.lastHover = 0;
      }
      return;
    }
    for (const b of this.menuButtons) {
      if (inRect(b.rect, x, y) && b.id !== this.lastHover) {
        this.lastHover = b.id;
        audio.sndPlaySound(this.menuSounds[b.id - 1], SND_ASYNC);
      }
    }
  }

  /** The five icon actions of MainImageMouseDown_43a5d4. */
  private menuAction(id: number) {
    switch (id) {
      case 1: // read the whole text again (FUN_00436824)
        if (this.readTo > 1) {
          this.readFrom = 1;
          this.readTo = this.wordCount;
          this.readCur = 1;
          this.playRange(1, this.wordCount);
          this.setMouseType(2);
          this.paintWord(this.readCur, true);
          this.setInterval(40);
          this.st = S.Reader;
        }
        break;
      case 2: this.openSign(1); break; // stop
      case 3: this.st = S.Load; break; // next page
      case 4: writeLegger(this.curScene); break; // bookmark (no visual feedback)
      case 5: this.openSign(2); break; // print
    }
  }

  // ---------------------------------------------------------------- JA/NEE sign (5.5)

  private openSign(mode: number) {
    this.ret = this.st;
    const saved = new Surface(196, 179);
    copyPixels(saved, this.back, 0, 0, 196, 179, SIGN[0], SIGN[1]);
    // The sign covers the text beneath it. In hi-res text mode the text is not part of the pixels, so lift the runs that touch
    // the sign's rect while it is up (and put them back afterwards).
    const touching = (r: TextRun) => { const q = Surface.runBox(r); return q[0] < SIGN[2] && q[2] > SIGN[0] && q[1] < SIGN[3] && q[3] > SIGN[1]; };
    const hidden: [TextRun[], TextRun[]] = [this.back.textRuns.filter(touching), this.front.textRuns.filter(touching)];
    this.back.textRuns = this.back.textRuns.filter((r) => !touching(r));
    this.front.textRuns = this.front.textRuns.filter((r) => !touching(r));
    this.sign = { saved, n: 0, mode, answer: false, hidden };
    this.setInterval(100);
    this.st = S.SignUp;
  }

  /** FUN_0043b6f8: restore the snapshot, draw the top n*12 rows of the sign at the bottom edge, copy the region to the screen. */
  private drawSign() {
    const s = this.sign!;
    copyPixels(this.back, s.saved, SIGN[0], SIGN[1], 196, 179, 0, 0);
    const h = s.n * 12;
    if (h > 0) {
      this.back.bitBlt(SIGN[0], 480 - h, 196, h, this.signMask, 0, 0, SRCAND);
      this.back.bitBlt(SIGN[0], 480 - h, 196, h, this.signYn, 0, 0, SRCPAINT);
    }
    copyPixels(this.front, this.back, SIGN[0], SIGN[1], 196, 179);
  }

  /** FUN_0043b858 */
  private finishSign() {
    const s = this.sign!;
    this.sign = null;
    this.back.textRuns.push(...s.hidden[0]);
    this.front.textRuns.push(...s.hidden[1]);
    if (!s.answer) this.st = this.ret;
    else if (s.mode === 1) this.st = S.Quit;
    else {
      if (this.mainImage) printImage(this.mainImage);
      this.st = this.ret;
    }
  }

  // ---------------------------------------------------------------- mouse (5.4)

  private mouseDown(x: number, y: number) {
    // any mouse button counts, as in the original (no Button test)
    const st = this.st;
    if (st === S.SignUp || st === S.SignDown || st === S.SignWait) {
      if (st === S.SignWait && this.sign) {
        if (SIGN_JA(x, y)) this.sign.answer = true;
        else if (!SIGN_NEE(x, y)) return;
        this.mci.close();
        this.st = S.SignDown;
      }
      return;
    }
    if (this.worm.blocking) return;
    let hit = false;
    if (st === S.Wait) {
      for (const b of [...this.menuButtons]) {
        if (inRect(b.rect, x, y)) {
          audio.sndPlaySound(null);
          hit = true;
          this.menuAction(b.id);
        }
      }
      const sc = this.sc;
      for (const a of this.areas) {
        if (!inRectIncl(a.rect, x, y) || !sc) continue;
        for (const l of sc.labels) {
          if (l.name !== a.label) continue;
          hit = true;
          sc.ip = l.line;
          this.st = S.Run;
        }
      }
    }
    if ((this.ret === S.Wait && this.st === S.Reader) || this.st === S.Wait) {
      if (inRectIncl(this.box, x, y) && this.wordCount > 0) {
        for (let i = 1; i <= this.wordCount; i++) {
          const w = this.words[i];
          if (!w) continue;
          const r = w.rect;
          if (x >= r[0] && x <= r[2] - 1 && y >= r[1] && y <= r[3] - 2) {
            hit = true;
            this.clickWord(i);
          }
        }
      }
    }
    this.worm.onClick(hit);
  }

  /** Reading by clicking a word (5.3): the interval is not touched. */
  private clickWord(i: number) {
    if (this.st === S.Reader) {
      this.paintWord(this.readCur, false);
      this.st = S.Wait;
    }
    const w = this.words[i];
    this.readFrom = w.clickFrom;
    this.readTo = w.clickTo;
    this.readCur = this.readFrom;
    this.playRange(this.readFrom, this.readTo);
    this.setMouseType(2);
    this.paintWord(this.readCur, true);
    this.st = S.Reader;
  }

  // ---------------------------------------------------------------- MouseTimer: cursor sprite and worm (5.6, 5.7)

  private mouseTick() {
    this.cursor.tick();
    this.worm.tick();
  }

  // ---------------------------------------------------------------- animations (4: INIT_ANIMATION/ACTIVATE_ANIMATION)

  /** FUN_00435f50: name~strip.BMP~frames~(TRUE|FALSE, unused)~delay~x1~y1~x2~y2~sound.wav~ */
  private async initAnimation() {
    const sc = this.sc!;
    const name = sc.arg(1);
    const bmp = await this.img(sc.arg(2));
    const wavName = sc.arg(10);
    const wav = wavName ? await this.snd(wavName) : null;
    this.anims.push({
      name, bmp, frames: toInt(sc.arg(3)), delay: toInt(sc.arg(5)),
      rect: [toInt(sc.arg(6)), toInt(sc.arg(7)), toInt(sc.arg(8)), toInt(sc.arg(9))], wav,
    });
  }

  /** FUN_004360d8: the animation timer interval becomes the animation's delay. */
  private activateAnimation() {
    const sc = this.sc!;
    const name = sc.arg(1);
    let found: Anim | undefined;
    for (const a of this.anims) if (a.name === name) found = a; // the last one with that name
    if (!found) {
      console.warn(`Deze animatie bestaat niet: ${name} (pagina ${this.curScene})`); // deviation: no message box
      return;
    }
    this.animFrom = toInt(sc.arg(2));
    this.animTo = toInt(sc.arg(3));
    this.animCur = this.animFrom;
    this.anim = found;
    this.animSound = sc.arg(4) === '1';
    this.setInterval(found.delay);
    this.st = S.Anim;
  }

  /** FUN_00438f4c: frame animCur of the strip into the back buffer and the screen; the sound starts with the first frame. */
  private drawAnimFrame() {
    const a = this.anim;
    if (!a) return;
    const [l, t, r, b] = a.rect;
    const w = r - l, h = b - t;
    const sx = (this.animCur - 1) * w;
    this.back.stretchBlt(l, t, w, h, a.bmp, sx, 0, w, a.bmp.height);
    this.blitFront(l, t, w, h);
    if (this.animSound && a.wav) this.mci.playWav(a.wav);
    this.animSound = false;
  }

  // ---------------------------------------------------------------- effects (4: INIT_EFFECT/ACTIVATE_EFFECT)

  private async initEffect() {
    const sc = this.sc!;
    const name = sc.arg(1).slice(0, 20), file = sc.arg(2).slice(0, 12);
    const isMidi = /\.MID$/i.test(file);
    const e: Effect = { name, file, wav: null, midi: null };
    if (isMidi) e.midi = await this.raw(file);
    else e.wav = await this.snd(file);
    this.effects.push(e);
  }

  /** FUN_00436398: Play through the MCI player and wait (state 9) until it has stopped. */
  private activateEffect() {
    const name = this.sc!.arg(1).slice(0, 20);
    let e: Effect | undefined;
    for (const x of this.effects) if (x.name === name) e = x;
    if (!e) {
      console.warn(`effect ${name} niet gevonden (pagina ${this.curScene})`);
      return;
    }
    if (e.midi) this.mci.playMidiFile(e.midi);
    else if (e.wav) this.mci.playWav(e.wav);
    else return;
    this.st = S.Effect;
  }

  // ---------------------------------------------------------------- worm (4: INIT_URM)

  private async initUrm() {
    const sc = this.sc!;
    const clicks = toInt(sc.arg(1)), seconds = toInt(sc.arg(2));
    const wavClick = sc.arg(3), wavIdle = sc.arg(4);
    this.worm.init({
      clicks, seconds, intervalMs: this.scriptTimer.interval,
      wavClick: wavClick ? await this.snd(wavClick) : null,
      wavIdle: wavIdle ? await this.snd(wavIdle) : null,
      enterDir: toInt(sc.arg(5)), x: toInt(sc.arg(6)), y: toInt(sc.arg(7)), exitDir: toInt(sc.arg(8)),
    });
  }

  // ---------------------------------------------------------------- PLAY_GAME / PLAY_MOVIE (6)

  /** FUN_0043591c */
  private async playGame() {
    const sc = this.sc!;
    const name = sc.arg(1).toUpperCase();
    this.failScene = toInt(sc.arg(2));
    const n = GAME_NUMBERS[name];
    if (n === undefined) { this.blackout(); return; } // unknown name: the original only blacks the screen
    markGameSeen(n);
    this.blackout();
    this.gameResult = 0;
    this.gameSkipped = false;
    this.gameStart = performance.now();
    this.gameIntroHeard = this.gameIntroDone = false;
    this.covered = true;
    this.st = S.Game;
    const load = pirateneilandGames[name];
    if (!load) {
      console.warn(`spel ${name} ontbreekt: telt als gewonnen`);
      this.gameResult = 2;
      return;
    }
    try {
      const mod = await load();
      this.gameModalDepth = this.display.modalDepth;
      const session = mod.default({ display: this.display, assets: this.assets });
      // the games report 2 = won, 3 = lost (or closed early)
      session.result.then((r) => { this.gameResult = this.gameSkipped || r === 2 ? 2 : 3; }, (e) => { console.error(e); this.gameResult = this.gameSkipped ? 2 : 3; });
    } catch (e) {
      console.error(`spel ${name} kon niet starten, telt als gewonnen`, e);
      this.gameResult = 2;
    }
  }

  /** FUN_00435cbc */
  private playMovie(n: number) {
    if (n === 2 || n === 3) markMovieSeen(n); // unlocks the film in the cinema (BBIOS)
    this.blackout();
    this.startMovie(n);
    this.st = S.MovieWait;
  }

  private startMovie(n: number) {
    this.movieDone = false;
    this.covered = true;
    playMovieWindow(this.display, this.assets, n).catch((e) => console.error(e)).then(() => { this.movieDone = true; });
  }

  // ---------------------------------------------------------------- "Sla over" (not in the original)

  /** What the skip button offers right now. */
  private skipInfo(): { label: string; action: () => void } | null {
    const st = this.st;
    if (this.closing || st === S.Intro || st === S.Load || st === S.Quit) return null;
    if (st === S.SignUp || st === S.SignDown || st === S.SignWait) return null;
    if (st === S.MovieWait) return { label: 'Film overslaan ⏭', action: () => skipMedia() };
    if (st === S.Game) {
      // the spoken instructions start shortly after the game opens; once they are over (or skipped)
      // the button offers to skip the game itself
      if (!this.gameIntroDone) {
        const playing = somethingToSkip();
        if (playing) this.gameIntroHeard = true;
        else if (this.gameIntroHeard || performance.now() - this.gameStart > 4000) this.gameIntroDone = true;
        if (!this.gameIntroDone) return { label: 'Uitleg overslaan ⏭', action: () => { skipMedia(); this.gameIntroDone = true; } };
      }
      return { label: 'Spel overslaan ⏭', action: () => this.skipGame() };
    }
    if (st === S.Wait && !this.worm.busy) {
      if (this.sc && this.nextScene === this.curScene) return null; // nowhere to go
      return { label: 'Volgende pagina ⏭', action: () => this.skipPage() };
    }
    return { label: 'Sla over ⏭', action: () => void this.fastForward() };
  }

  /** Run the page's script instantly up to the point where it waits for the player. */
  private async fastForward() {
    if (this.ff) return;
    this.ff = true;
    try {
      skipMedia();
      this.worm.skip();
      for (let i = 0; i < 5000; i++) {
        const st = this.st;
        if (st === S.Anim) {
          this.animSound = false;
          this.animCur = this.animTo;
          this.drawAnimFrame(); // show the last frame
          this.st = this.ret;
        } else if (st === S.Delay) this.st = this.ret;
        else if (st === S.Effect) {
          this.mci.stop();
          this.st = this.ret;
        } else if (st === S.Reader) {
          this.mci.stop();
          this.tickReader();
        } else if (st === S.Run) await this.runLine();
        else if (st === S.Idle) await sleep(10);
        else break;
        audio.stopSystemSound(); // sounds started by the skipped lines
      }
      if (this.st !== S.Reader) this.mci.stop();
    } finally {
      this.ff = false;
    }
  }

  /** Go to the next page now, like the menu's "next page" icon. */
  private skipPage() {
    audio.sndPlaySound(null);
    this.mci.stop();
    this.st = S.Load;
  }

  /** Leave the minigame as if it was won. */
  private skipGame() {
    this.gameSkipped = true;
    audio.skipSounds();
    this.display.closeModalsFrom(this.gameModalDepth, 2);
    this.gameResult = 2;
  }
}

/** FUN_00435df4: print the page picture scaled to the page width (the "Bezig met printen" dialog is not needed). */
function printImage(s: Surface) {
  const c = document.createElement('canvas');
  c.width = s.width;
  c.height = s.height;
  const ctx = c.getContext('2d')!;
  const data = ctx.createImageData(s.width, s.height);
  s.toImageData(data);
  ctx.putImageData(data, 0, 0);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><title>Bas de Beer</title><style>@page{margin:10mm}body{margin:0}img{width:100%;height:auto;display:block}</style><img src="${c.toDataURL('image/png')}">`);
  doc.close();
  const img = doc.querySelector('img')!;
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60000);
  };
  if (img.complete) go();
  else img.onload = go;
}
