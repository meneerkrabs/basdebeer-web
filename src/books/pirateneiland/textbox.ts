// The text box of the story book: word layout (FUN_00436f9c), stippled background (FUN_00429528) and
// word drawing (FUN_00437550). Spec 4 (INIT_TEXTBOX/ACTIVATE_TEXTBOX) and 5.1/5.2.

import { SRCAND, SRCPAINT, Surface, type FontSpec } from '../../engine/surface.ts';

export type Rect = [number, number, number, number]; // left, top, right, bottom

/** Arial 12 pt bold = 16 px em at 96 dpi (FormCreate / ACTIVATE_MAINIMAGE: Name Arial, Size 12, Style [fsBold]). */
export const TEXT_FONT: Omit<FontSpec, 'color'> = { name: 'Arial', px: 16, bold: true };
/** TextHeight("W") of that font, and the fixed line pitch (0x12). */
export const TEXT_HEIGHT = 18;
export const LINE_PITCH = 18;
export const MAX_WORDS = 80;

/** The 16 colour names of FUN_00435194 (TColor values, i.e. COLORREF), in the order of FUN_00435414's indices 1..16. */
const COLOUR_NAMES = ['BLACK', 'MAROON', 'GREEN', 'OLIVE', 'NAVY', 'PURPLE', 'TEAL', 'GRAY', 'SILVER', 'RED', 'LIME',
  'YELLOW', 'BLUE', 'FUCHSIA', 'AQUA', 'WHITE'];
const COLOUR_VALUES = [0x000000, 0x000080, 0x008000, 0x008080, 0x800000, 0x800080, 0x808000, 0x808080, 0xc0c0c0,
  0x0000ff, 0x00ff00, 0x00ffff, 0xff0000, 0xff00ff, 0xffff00, 0xffffff];

export const colourValue = (name: string) => COLOUR_VALUES[COLOUR_NAMES.indexOf(name.toUpperCase())] ?? 0;
/** FUN_00435414: row of PATTERN.BMP for a colour name (1..16; unknown names behave like BLACK here). */
export const colourIndex = (name: string) => Math.max(0, COLOUR_NAMES.indexOf(name.toUpperCase())) + 1;
/** LOW = 0, MEDIUM = 1, anything else = 2. */
export const styleIndex = (name: string) => (name.toUpperCase() === 'LOW' ? 0 : name.toUpperCase() === 'MEDIUM' ? 1 : 2);

export interface Word {
  text: string;
  rect: Rect;
  startMs: number;
  endMs: number;
  clickFrom: number;
  clickTo: number;
}

export const emptyWord = (): Word => ({ text: '', rect: [0, 0, 0, 0], startMs: 0, endMs: 0, clickFrom: 0, clickTo: 0 });

export interface Layout {
  box: Rect;
  /** Index 1..MAX_WORDS (slot 0 unused). */
  words: Word[];
  /** +0x11cc: the number of the last word slot in use (see the note on trailing spaces below). */
  count: number;
}

/**
 * INIT_TEXTBOX: cut `text` into words (each including its trailing space), wrap at box.right-5, 18 px per line.
 * `measure` is TextWidth() of the 16 px bold Arial canvas.
 */
export function layoutText(x: number, y: number, w: number, text: string, measure: (s: string) => number): Layout {
  const words: Word[] = Array.from({ length: MAX_WORDS + 2 }, emptyWord);
  const left = x, right = x + w;
  const limit = right - 5; // local_24
  const th = TEXT_HEIGHT;
  // slot 1 starts at (left+5, top+5)
  words[1].rect = [left + 5, y + 5, limit, y];
  let i = 1;
  let s = text;
  const place = (word: Word, tw: number) => {
    const [l, t] = word.rect;
    word.rect = [l, t, l + tw, t + th];
    if (limit < word.rect[2]) word.rect = [left + 5, t + LINE_PITCH, left + 5 + tw, t + LINE_PITCH + th];
    word.clickFrom = word.clickTo = i;
  };
  let sp: number;
  while ((sp = s.indexOf(' ')) >= 0 && i <= MAX_WORDS) {
    const word = words[i];
    word.text = s.slice(0, sp + 1);
    place(word, measure(word.text));
    // the next slot starts where this one ends
    words[i + 1].rect = [word.rect[2], word.rect[1], word.rect[2], word.rect[1]];
    s = s.slice(sp + 1);
    i++;
  }
  if (s.length > 0 && i <= MAX_WORDS) {
    const word = words[i];
    word.text = s;
    place(word, measure(s));
  }
  // The original ends with count = i: when the text ends in a space, i is one past the last real word and the
  // (empty) slot decides the box bottom, so the last line is not included. Faithful; no script does that.
  const bottom = words[i].rect[3] + 5;
  return { box: [left, y, right, bottom], words, count: i };
}

/**
 * FUN_00429528: tile PATTERN.BMP over the box. Per 20x20 tile: SRCAND with the mask tile (style*20, 0), then SRCPAINT with the
 * colour tile (style*20, bgIndex*20); tiles at the right/bottom edge are clipped. Then a 1 px black outline (GDI Rectangle).
 */
export function drawBoxBackground(dest: Surface, pattern: Surface, box: Rect, bgIndex: number, style: number) {
  const [l, t, r, b] = box;
  const sx = style * 20;
  for (let ty = t; ty < b; ty += 20) {
    const h = Math.min(20, b - ty);
    for (let tx = l; tx < r; tx += 20) {
      const w = Math.min(20, r - tx);
      dest.bitBlt(tx, ty, w, h, pattern, sx, 0, SRCAND);
      dest.bitBlt(tx, ty, w, h, pattern, sx, bgIndex * 20, SRCPAINT);
    }
  }
  dest.frameRect(l, t, r, b, 0);
}

/**
 * FUN_00437550: TextOut a word with a black shadow at (+2,+2), then in the text/highlight colour, straight onto `dest`.
 * Returns the rect the original blits to the screen: (x, y, x+TextWidth+2, y+TextHeight+2).
 */
export function drawWord(dest: Surface, word: Word, colour: number): Rect {
  const [x, y] = word.rect;
  dest.textOut(x + 2, y + 2, word.text, { ...TEXT_FONT, color: 0 });
  dest.textOut(x, y, word.text, { ...TEXT_FONT, color: colour });
  return [x, y, x + Surface.textWidth(word.text, { ...TEXT_FONT, color: 0 }) + 2, y + TEXT_HEIGHT + 2];
}
