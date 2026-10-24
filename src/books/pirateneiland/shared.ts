// Shared pieces of the "Naar Pirateneiland" disc programs (Autorun menu, BSPEL32, BBIOS32):
// the INI-style progress flags, the JA/NEE "stop" sign and a Windows-style message box.
// Spec: docs/re/pirateneiland-engine.md section 9.

import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { SRCAND, SRCPAINT, Surface, rgb, type FontSpec } from '../../engine/surface.ts';
import { Form, mrOk, type Display } from '../../engine/vcl.ts';

// ------------------------------------------------------------------ progress (BASWIN.INI)

/** BASWIN.INI [Games] Game1..6 (written by the book when a game is started): JSON array of game numbers. */
export const GAMES_KEY = 'bdb-pirateneiland-games';
/** BASWIN.INI [Movies] Movie2/3 (written by the book when a movie starts): JSON array of movie numbers. */
export const MOVIES_KEY = 'bdb-pirateneiland-movies';

function readList(key: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}
function addToList(key: string, n: number) {
  const l = readList(key);
  if (!l.includes(n)) localStorage.setItem(key, JSON.stringify([...l, n].sort((a, b) => a - b)));
}

/** Debug switch: `?unlock` opens every game and movie in BerenSpellen / BerenBios. */
const unlockAll = () => new URLSearchParams(location.search).has('unlock');

/** The book calls this when it starts minigame `n` (1..6): `[Games] Game<n>=1`. */
export const markGameSeen = (n: number) => addToList(GAMES_KEY, n);
export const isGameSeen = (n: number) => unlockAll() || readList(GAMES_KEY).includes(n);
/** The book calls this when movie 2 or 3 starts: `[Movies] Movie<n>=1`. */
export const markMovieSeen = (n: number) => addToList(MOVIES_KEY, n);
export const isMovieSeen = (n: number) => n === 1 || unlockAll() || readList(MOVIES_KEY).includes(n);

// ------------------------------------------------------------------ geometry helpers

export type Rect = [number, number, number, number]; // left, top, right, bottom
/** Delphi PtInRect: right and bottom exclusive. */
export const ptInRect = (r: Rect, x: number, y: number) => x >= r[0] && y >= r[1] && x < r[2] && y < r[3];

export const SYS_FONT: Omit<FontSpec, 'color'> = { name: 'MS Sans Serif', px: 11 };

// ------------------------------------------------------------------ JA/NEE sign

export interface SignRects { ja: Rect; nee: Rect }

/**
 * The "stop?" sign that slides up from the bottom edge (BSPEL32 FUN_00430984 / BBIOS32 FUN_00428ee4).
 * 196x179 sprite with mask, 12 px per 50 ms tick, `YN001.WAV` asks the question once it is up.
 * Call `tick()` from the 50 ms timer; the result of the player's choice arrives through `tick()`.
 */
export class QuitSign {
  static readonly X = 220;
  static readonly Y = 301;
  static readonly W = 196;
  static readonly H = 179;
  /** 'up' sliding in, 'wait' waiting for JA/NEE, 'down' sliding out. */
  phase: 'idle' | 'up' | 'wait' | 'down' = 'idle';
  private step = 0;
  private saved: Surface | null = null;
  private yes = false;

  private work: Surface;
  private yn: Surface;
  private mask: Surface;
  private question: AudioBuffer | null;
  private rects: SignRects;
  private playQuestion: (b: AudioBuffer | null) => void;
  private stopQuestion: () => void;

  constructor(
    work: Surface, yn: Surface, mask: Surface, question: AudioBuffer | null, rects: SignRects,
    /** How the question sound is played (BBIOS uses its MCI player; default sndPlaySound). */
    playQuestion: (b: AudioBuffer | null) => void = (b) => audio.sndPlaySound(b, SND_ASYNC),
    stopQuestion: () => void = () => audio.sndPlaySound(null),
  ) {
    this.work = work; this.yn = yn; this.mask = mask; this.question = question; this.rects = rects;
    this.playQuestion = playQuestion; this.stopQuestion = stopQuestion;
  }

  get active() {
    return this.phase !== 'idle';
  }

  open() {
    const { X, Y, W, H } = QuitSign;
    this.saved = new Surface(W, H);
    this.saved.bitBlt(0, 0, W, H, this.work, X, Y);
    this.step = 1;
    this.phase = 'up';
  }

  private draw() {
    const { X, Y, W, H } = QuitSign;
    this.work.bitBlt(X, Y, W, H, this.saved!, 0, 0);
    const h = this.step * 12;
    if (h <= 0) return;
    this.work.bitBlt(X, 480 - h, W, h, this.mask, 0, 0, SRCAND);
    this.work.bitBlt(X, 480 - h, W, h, this.yn, 0, 0, SRCPAINT);
  }

  /** Returns 'yes' or 'no' on the tick in which the sign has slid away again. */
  tick(): 'yes' | 'no' | undefined {
    if (this.phase === 'up') {
      this.draw();
      this.step++;
      if (this.step === 15) {
        this.playQuestion(this.question);
        this.phase = 'wait';
      }
    } else if (this.phase === 'down') {
      this.step--;
      this.draw();
      if (this.step === 0) {
        this.phase = 'idle';
        this.saved = null;
        return this.yes ? 'yes' : 'no';
      }
    }
    return undefined;
  }

  /** Mouse click (form coordinates); true if it hit JA or NEE. */
  click(x: number, y: number): boolean {
    if (this.phase !== 'wait') return false;
    const ja = ptInRect(this.rects.ja, x, y), nee = ptInRect(this.rects.nee, x, y);
    if (!ja && !nee) return false;
    this.stopQuestion();
    this.yes = ja;
    this.phase = 'down';
    return true;
  }
}

export async function loadSign(assets: Assets) {
  const [yn, mask, question] = await Promise.all([
    assets.image('YN1.BMP'), assets.image('YN1M.BMP'), assets.sound('YN001.WAV').catch(() => null),
  ]);
  return { yn, mask, question };
}

// ------------------------------------------------------------------ message box

/** A Windows 95 style MessageBox (MB_OK | MB_ICONEXCLAMATION), modal, resolves when OK is pressed. */
export async function messageBox(display: Display, caption: string, text: string): Promise<void> {
  const font: FontSpec = { ...SYS_FONT, px: 12, color: 0x000000 };
  const maxW = 260;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const t = line ? `${line} ${word}` : word;
    if (line && Surface.textWidth(t, font) > maxW) { lines.push(line); line = word; } else line = t;
  }
  if (line) lines.push(line);
  const bodyH = Math.max(32, lines.length * 15);
  const w = 24 + 32 + 16 + maxW + 20, h = 3 + 18 + 18 + bodyH + 24 + 23 + 20;
  const form = new Form(display, w, h, 'messagebox');
  form.center();
  const gray = rgb(192, 192, 192), white = 0xffffff, dark = rgb(128, 128, 128);
  const btn: Rect = [Math.round((w - 75) / 2), h - 23 - 14, Math.round((w - 75) / 2) + 75, h - 14];
  let down = false;
  form.onPaint = () => {
    const s = form.surface;
    s.fillRect(0, 0, w, h, gray);
    s.frameRect(0, 0, w, h, white); // raised window border
    s.fillRect(w - 1, 0, w, h, 0); s.fillRect(0, h - 1, w, h, 0);
    s.fillRect(w - 2, 1, w - 1, h - 1, dark); s.fillRect(1, h - 2, w - 1, h - 1, dark);
    s.fillRect(3, 3, w - 3, 21, rgb(0, 0, 128));
    s.textOut(7, 5, caption, { ...font, bold: true, color: white });
    // exclamation icon: yellow triangle
    const ix = 20, iy = 30;
    for (let r = 0; r < 28; r++) {
      const half = Math.round((r + 2) * 0.55);
      s.fillRect(ix + 16 - half, iy + r, ix + 16 + half + 1, iy + r + 1, rgb(255, 255, 0));
      s.setPixel(ix + 16 - half, iy + r, 0); s.setPixel(ix + 16 + half, iy + r, 0);
    }
    s.fillRect(ix, iy + 27, ix + 33, iy + 28, 0);
    s.fillRect(ix + 15, iy + 9, ix + 18, iy + 19, 0);
    s.fillRect(ix + 15, iy + 21, ix + 18, iy + 24, 0);
    lines.forEach((l, i) => s.textOut(24 + 32 + 16, 32 + i * 15, l, font));
    // OK button (default: black outline + raised 3D)
    s.frameRect(btn[0] - 1, btn[1] - 1, btn[2] + 1, btn[3] + 1, 0);
    s.fillRect(btn[0], btn[1], btn[2], btn[3], gray);
    s.fillRect(btn[0], btn[1], btn[2] - 1, btn[1] + 1, down ? dark : white);
    s.fillRect(btn[0], btn[1], btn[0] + 1, btn[3] - 1, down ? dark : white);
    s.fillRect(btn[0], btn[3] - 1, btn[2], btn[3], down ? white : dark);
    s.fillRect(btn[2] - 1, btn[1], btn[2], btn[3], down ? white : dark);
    const o = down ? 1 : 0;
    s.textOut(btn[0] + 27 + o, btn[1] + 5 + o, 'OK', font);
  };
  form.onMouseDown = (_b, _s, x, y) => { if (ptInRect(btn, x, y)) { down = true; form.invalidate(); } };
  form.onMouseUp = (_b, _s, x, y) => {
    const hit = down && ptInRect(btn, x, y);
    down = false;
    form.invalidate();
    if (hit) form.close(mrOk);
  };
  form.onKeyDown = (key) => { if (key === 'Enter' || key === 'Escape' || key === ' ') form.close(mrOk); };
  await form.showModal();
}
