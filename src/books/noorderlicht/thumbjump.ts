// TfrmThumbJump (spec 1.4): the page overview ("bookmark"). 56 thumbnails of which the pages up to the bookmark are
// unlocked; pick one and continue there, or start again.

import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import type { Surface } from '../../engine/surface.ts';
import { Form, type Display } from '../../engine/vcl.ts';
import { inRect, SLOT_NAMES, type Rect } from './common.ts';

const AQUA = 0xffff00, BLUE = 0xff0000, RED = 0x0000ff, PURPLE = 0x800080, WHITE = 0xffffff; // COLORREF 0x00BBGGRR
const VERDER: Rect = [34, 324, 335, 360]; // "VERDER GAAN"
const OPNIEUW: Rect = [37, 376, 333, 453]; // "OPNIEUW BEGINNEN"
const PREVIEW: Rect = [345, 310, 625, 450];
const inflate = (r: Rect, n = 1): Rect => [r[0] - n, r[1] - n, r[2] + n, r[3] + n];

/** Slot rectangles: 10 columns; columns 0-8 are 57 wide (each thumbnail is overpainted by the next one). */
function slotRects(): Rect[] {
  const rs: Rect[] = [];
  for (let i = 0; i < SLOT_NAMES.length; i++) {
    const col = i % 10, row = Math.floor(i / 10);
    const left = 30 + 57 * col, top = 30 + 45 * row;
    rs.push([left, top, left + 72, top + 36]);
    if (col > 0) rs[i - 1][2] = left;
  }
  return rs;
}

/**
 * Shows the overview modally. Resolves with the page to start ("05N": a page always starts in normal mode) or null
 * when it was left with Escape (not in the original).
 */
export async function runThumbJump(display: Display, assets: Assets, bookmark: number): Promise<string | null> {
  const a = assets;
  const [gray, thumbs, tha1, tha2, t00, tpop, tintro, terror] = await Promise.all([
    a.image('BACKGRAY.BMP'), a.image('THUMBS.BMP'), a.image('THA1.BMP'), a.image('THA2.BMP'), a.image('T00.BMP'),
    a.sound('TPOP.WAV').catch(() => null), a.sound('TINTRO.WAV').catch(() => null), a.sound('TERROR.WAV').catch(() => null),
  ]);
  const previews = new Map<number, Surface>();
  const preview = async (i: number): Promise<Surface> => {
    if (i < 0 || i > bookmark) return t00; // locked slots show T00
    let p = previews.get(i);
    if (!p) {
      p = await a.image(`T${SLOT_NAMES[i]}.BMP`).catch(() => t00);
      previews.set(i, p);
    }
    return p;
  };
  await preview(bookmark);

  const rects = slotRects();
  const f = new Form(display, 640, 480, 'frmThumbJump');
  f.center();
  const s = f.surface;
  s.bitBlt(0, 0, 640, 480, gray, 0, 0);

  let pre = -3; // JumpTimer starts at sel = -3: a 600 ms pause
  let pop = 0; // next slot to pop in
  let sel = -1; // selected slot
  let hasSel = false;
  let hover = 0; // 1 = Verder, 2 = Opnieuw
  let chosen: string | null = null;
  let lastClick = { t: 0, slot: -2 };

  /** Rectangle with a clear brush: `inner` on the rect, `outer` on the rect inflated by one. */
  const frame = (r: Rect, outer: number, inner: number) => {
    s.frameRect(r[0], r[1], r[2], r[3], inner);
    const o = inflate(r);
    s.frameRect(o[0], o[1], o[2], o[3], outer);
  };
  const restoreGray = (r: Rect) => s.bitBlt(r[0], r[1], r[2] - r[0], r[3] - r[1], gray, r[0], r[1]);
  const drawPreview = async (i: number) => {
    const p = await preview(i);
    s.bitBlt(PREVIEW[0], PREVIEW[1], 280, 140, p, 0, 0);
    s.frameRect(PREVIEW[0] - 1, PREVIEW[1] - 1, PREVIEW[2] + 1, PREVIEW[3] + 1, WHITE);
  };
  /** FUN_00449388: redraw the old selection with the unlocked frame (or the grey background if it is locked). */
  const unframe = (i: number) => {
    if (i < 0) return;
    if (i <= bookmark) frame(rects[i], BLUE, AQUA);
    else restoreGray(inflate(rects[i]));
  };
  const go = (i: number) => {
    if (i > bookmark) { // locked
      if (terror) audio.sndPlaySound(terror, SND_ASYNC);
      return;
    }
    chosen = `${SLOT_NAMES[i]}N`;
    audio.sndPlaySound(null);
    f.close(1);
  };

  // JumpTimer (200 ms): one step per tick. (In the original `sel` is also the counter, so a click during the
  // animation disturbs it; here the counter is separate.)
  const timer = f.timer(200, async () => {
    if (pre < 0) { pre++; return; }
    if (pop <= bookmark) {
      const r = rects[pop];
      if (tpop) audio.sndPlaySound(tpop, SND_ASYNC);
      s.bitBlt(r[0], r[1], r[2] - r[0], r[3] - r[1], thumbs, pop * 72, 0);
      frame(r, BLUE, AQUA);
      pop++;
      return;
    }
    timer.enabled = false;
    if (!hasSel) {
      await drawPreview(bookmark);
      if (tintro) audio.sndPlaySound(tintro, SND_ASYNC);
      sel = bookmark;
    }
  });

  const slotAt = (x: number, y: number) => {
    for (let i = rects.length - 1; i >= 0; i--) if (inRect(rects[i], x, y)) return i;
    return -1;
  };

  f.onMouseMove = (_s, x, y) => {
    const i = slotAt(x, y);
    const h = inRect(VERDER, x, y) ? 1 : inRect(OPNIEUW, x, y) ? 2 : 0;
    f.cursor = h || (i >= 0 && i <= bookmark) ? 'pointer' : 'default';
    if (h !== hover) {
      if (hover === 1) restoreGray(VERDER);
      if (hover === 2) restoreGray(OPNIEUW);
      if (h === 1) s.bitBlt(VERDER[0], VERDER[1], 301, 36, tha1, 0, 0);
      if (h === 2) s.bitBlt(OPNIEUW[0], OPNIEUW[1], 296, 77, tha2, 0, 0);
      hover = h;
    }
  };

  f.onMouseDown = async (_b, _s, x, y) => {
    if (inRect(VERDER, x, y)) { if (sel >= 0) go(sel); return; }
    if (inRect(OPNIEUW, x, y)) { go(0); return; }
    const i = slotAt(x, y);
    if (i < 0) return;
    // a double-click on the selected slot continues there
    const now = performance.now();
    const dbl = hasSel && i === sel && lastClick.slot === i && now - lastClick.t < 500;
    lastClick = { t: now, slot: i };
    if (dbl) { go(i); return; }
    unframe(sel);
    frame(rects[i], PURPLE, RED);
    sel = i;
    hasSel = true;
    await drawPreview(i);
  };
  f.onKeyDown = (key) => { if (key === 'Escape') f.close(0); };

  await f.showModal();
  audio.sndPlaySound(null);
  return chosen;
}
