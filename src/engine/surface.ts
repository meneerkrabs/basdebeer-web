// A software framebuffer that emulates the bits of Win32 GDI the original games use
// (BitBlt with raster ops, StretchBlt, FillRect, TextOut). Pixels are stored as
// 0x00BBGGRR (the alpha byte is forced to 0xFF on presentation), matching a COLORREF.

export const SRCCOPY = 0xcc0020;
export const SRCPAINT = 0xee0086; // dst | src
export const SRCAND = 0x8800c6; // dst & src
export const SRCINVERT = 0x660046; // dst ^ src
export const SRCERASE = 0x440328; // src & ~dst
export const NOTSRCCOPY = 0x330008; // ~src
export const NOTSRCERASE = 0x1100a6; // ~(dst | src)
export const MERGEPAINT = 0xbb0226; // dst | ~src
export const DSTINVERT = 0x550009; // ~dst
export const BLACKNESS = 0x000042;
export const WHITENESS = 0xff0062;
export const DSNA = 0x220326; // dst & ~src

export type Rop = number;

/** COLORREF helpers (0x00BBGGRR). */
export const rgb = (r: number, g: number, b: number) => ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
export const cssColor = (c: number) => `rgb(${c & 255},${(c >> 8) & 255},${(c >> 16) & 255})`;

/** Delphi TColor names used by the games' scripts/forms. */
export const DELPHI_COLORS: Record<string, number> = {
  clblack: 0x000000, clmaroon: 0x000080, clgreen: 0x008000, clolive: 0x008080,
  clnavy: 0x800000, clpurple: 0x800080, clteal: 0x808000, clgray: 0x808080,
  clsilver: 0xc0c0c0, clred: 0x0000ff, cllime: 0x00ff00, clyellow: 0x00ffff,
  clblue: 0xff0000, clfuchsia: 0xff00ff, claqua: 0xffff00, clwhite: 0xffffff,
  black: 0x000000, maroon: 0x000080, green: 0x008000, olive: 0x008080, navy: 0x800000,
  purple: 0x800080, teal: 0x808000, gray: 0x808080, silver: 0xc0c0c0, red: 0x0000ff,
  lime: 0x00ff00, yellow: 0x00ffff, blue: 0xff0000, fuchsia: 0xff00ff, aqua: 0xffff00, white: 0xffffff,
};

export function parseColor(s: string): number {
  const k = s.trim().toLowerCase();
  if (k in DELPHI_COLORS) return DELPHI_COLORS[k];
  if (k.startsWith('$')) return parseInt(k.slice(1), 16) & 0xffffff;
  const n = Number(k);
  return Number.isFinite(n) ? n & 0xffffff : 0;
}

export interface FontSpec {
  name: string;
  /** Pixel height of the em (Delphi Font.Height is -px; Font.Size pt -> px = pt*96/72). */
  px: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color: number;
}

const FONT_FALLBACK: Record<string, string> = {
  'ms sans serif': '"MS Sans Serif", "Microsoft Sans Serif", Tahoma, Arial, sans-serif',
  arial: 'Arial, Helvetica, sans-serif',
  'times new roman': '"Times New Roman", Times, serif',
  'comic sans ms': '"Comic Sans MS", "Comic Sans", "Chalkboard SE", cursive',
};
export const cssFont = (f: FontSpec) =>
  `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${f.px}px ${FONT_FALLBACK[f.name.toLowerCase()] ?? `"${f.name}", Arial, sans-serif`}`;

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function textCtx(): OffscreenCanvasRenderingContext2D {
  if (!measureCtx) measureCtx = new OffscreenCanvas(1024, 128).getContext('2d', { willReadFrequently: true })!;
  return measureCtx;
}

/**
 * A piece of text drawn with textOut while Surface.hiResText is on. It is not rasterised into
 * the 640x480 pixels; the Display draws it at screen resolution instead. Runs travel with
 * the pixels they stand for (BitBlt copies them, opaque fills/copies over them remove them).
 */
export interface TextRun {
  x: number;
  y: number;
  text: string;
  font: FontSpec;
  /** Visible area (this surface's coordinates), from blits that clipped the run. */
  clip: [number, number, number, number] | null;
  /**
   * Parts of the run that were painted over afterwards, like the pixels of real GDI text
   * would have been: a rect (background restored / opaque copy) or a sprite mask
   * (SRCAND: mask pixel (x + mx, y + my) black = covered).
   */
  holes?: TextHole[];
  /** Cached text width. */
  w?: number;
}

export interface TextHole {
  rect: [number, number, number, number];
  /** Covered where the mask pixel is black, or (with `key`) where it isn't the transparent key colour. */
  mask?: { surface: Surface; mx: number; my: number; key?: number };
}

type Box = [number, number, number, number];
const intersects = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const inside = (a: Box, b: Box) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
const MAX_HOLES = 24;

/** Per-pixel weight of a stippled SRCAND mask (see Surface.smoothStipple); NaN = not stipple. */
interface PendingStipple { surface: Surface; dx: number; dy: number; w: number; h: number; white: Float32Array }
let pendingStipple: PendingStipple | null = null;

export class Surface {
  /**
   * 'Smooth' display mode: 1990s sprites faked translucent shadows with a stippled mask
   * (SRCAND mask, then SRCPAINT sprite). When set, stippled mask areas are drawn as a real
   * blend with the matching SRCPAINT instead, which reads as a soft shadow.
   */
  static smoothStipple = false;
  /** 'Smooth' display mode: keep text as runs and let the Display draw it sharp (see TextRun). */
  static hiResText = false;

  /** Text runs on this surface (only used when hiResText is on). */
  textRuns: TextRun[] = [];

  readonly width: number;
  readonly height: number;
  readonly px: Uint32Array;
  /** Palette of the source 8-bit bitmap, if any (for colour-key lookups). */
  palette?: Uint32Array;
  /** Original palette indices of an 8-bit bitmap (some games test pixel indices). */
  indices?: Uint8Array;

  constructor(width: number, height: number, fill = 0) {
    this.width = Math.max(0, width | 0);
    this.height = Math.max(0, height | 0);
    this.px = new Uint32Array(this.width * this.height);
    if (fill) this.px.fill(fill);
  }

  clone(): Surface {
    const s = new Surface(this.width, this.height);
    s.px.set(this.px);
    s.palette = this.palette;
    s.indices = this.indices;
    s.textRuns = this.textRuns.map((r) => ({ ...r }));
    return s;
  }

  /** Bounding box of a run, intersected with its clip. */
  static runBox(r: TextRun): [number, number, number, number] {
    const w = (r.w ??= Surface.textWidth(r.text, r.font)), h = Math.ceil(r.font.px * 1.2);
    let b: [number, number, number, number] = [r.x, r.y, r.x + w, r.y + h];
    if (r.clip) b = [Math.max(b[0], r.clip[0]), Math.max(b[1], r.clip[1]), Math.min(b[2], r.clip[2]), Math.min(b[3], r.clip[3])];
    return b;
  }

  /** An opaque write to (x1,y1)-(x2,y2) removes runs it fully covers and punches a hole in the others. */
  private coverRuns(x1: number, y1: number, x2: number, y2: number, mask?: TextHole['mask']) {
    if (!this.textRuns.length) return;
    const r: Box = [x1, y1, x2, y2];
    this.textRuns = this.textRuns.filter((run) => {
      const b = Surface.runBox(run);
      if (b[2] <= b[0] || b[3] <= b[1]) return false;
      if (!intersects(b, r)) return true;
      if (!mask && inside(b, r)) return false;
      const holes = (run.holes ??= []);
      holes.push({ rect: r, mask });
      if (holes.length > MAX_HOLES) {
        // too many sprite stamps on one word: merge them into one covering rectangle
        const u = holes.reduce<Box>((a, h) => [Math.min(a[0], h.rect[0]), Math.min(a[1], h.rect[1]), Math.max(a[2], h.rect[2]), Math.max(a[3], h.rect[3])], [1e9, 1e9, -1e9, -1e9]);
        run.holes = [{ rect: u }];
      }
      return true;
    });
  }

  /** Copy the runs of src's (sx,sy,w,h) to (dx,dy), clipped to the destination rect. */
  private copyRuns(src: Surface, dx: number, dy: number, w: number, h: number, sx: number, sy: number) {
    const ox = dx - sx, oy = dy - sy;
    const dest: Box = [dx, dy, dx + w, dy + h];
    for (const r of src.textRuns) {
      const b = Surface.runBox(r);
      if (b[2] <= sx || b[0] >= sx + w || b[3] <= sy || b[1] >= sy + h) continue;
      const c = r.clip ?? [-1e9, -1e9, 1e9, 1e9];
      const clip: Box = [Math.max(c[0] + ox, dx), Math.max(c[1] + oy, dy), Math.min(c[2] + ox, dx + w), Math.min(c[3] + oy, dy + h)];
      const holes = r.holes?.map((hl) => ({
        rect: [hl.rect[0] + ox, hl.rect[1] + oy, hl.rect[2] + ox, hl.rect[3] + oy] as Box,
        mask: hl.mask && { ...hl.mask, mx: hl.mask.mx - ox, my: hl.mask.my - oy },
      }));
      const run: TextRun = { ...r, x: r.x + ox, y: r.y + oy, clip, holes };
      // the same word already here (e.g. redrawn highlighted, or refreshed in parts): the
      // visible area grows, and inside the refreshed rect the text is fresh again
      const old = this.textRuns.find((o) => o.x === run.x && o.y === run.y && o.text === run.text);
      if (old) {
        if (old.clip) run.clip = [Math.min(old.clip[0], clip[0]), Math.min(old.clip[1], clip[1]), Math.max(old.clip[2], clip[2]), Math.max(old.clip[3], clip[3])];
        else run.clip = null;
        const kept = old.holes?.filter((hl) => !intersects(hl.rect, dest)) ?? [];
        run.holes = [...kept, ...(holes ?? [])];
        this.textRuns = this.textRuns.filter((o) => o !== old);
      }
      this.textRuns.push(run);
    }
  }

  getPixel(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return this.px[y * this.width + x];
  }

  setPixel(x: number, y: number, c: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.px[y * this.width + x] = c & 0xffffff;
  }

  fillRect(x1: number, y1: number, x2: number, y2: number, color: number) {
    const ax = Math.max(0, x1 | 0), ay = Math.max(0, y1 | 0);
    const bx = Math.min(this.width, x2 | 0), by = Math.min(this.height, y2 | 0);
    for (let y = ay; y < by; y++) this.px.fill(color & 0xffffff, y * this.width + ax, y * this.width + bx);
    this.coverRuns(ax, ay, bx, by);
  }

  /** Win32 Rectangle/FrameRect-style outline (right/bottom exclusive). */
  frameRect(x1: number, y1: number, x2: number, y2: number, color: number, width = 1) {
    this.fillRect(x1, y1, x2, y1 + width, color);
    this.fillRect(x1, y2 - width, x2, y2, color);
    this.fillRect(x1, y1, x1 + width, y2, color);
    this.fillRect(x2 - width, y1, x2, y2, color);
  }

  /** BitBlt(this, dx, dy, w, h, src, sx, sy, rop). */
  bitBlt(dx: number, dy: number, w: number, h: number, src: Surface | null, sx = 0, sy = 0, rop: Rop = SRCCOPY) {
    dx |= 0; dy |= 0; w |= 0; h |= 0; sx |= 0; sy |= 0;
    // clip against destination
    if (dx < 0) { sx -= dx; w += dx; dx = 0; }
    if (dy < 0) { sy -= dy; h += dy; dy = 0; }
    if (dx + w > this.width) w = this.width - dx;
    if (dy + h > this.height) h = this.height - dy;
    if (src) {
      // pixels outside the source read as black, like an off-bitmap DC area
      if (sx < 0) { dx -= sx; w += sx; sx = 0; }
      if (sy < 0) { dy -= sy; h += sy; sy = 0; }
      if (sx + w > src.width) w = src.width - sx;
      if (sy + h > src.height) h = src.height - sy;
    }
    if (w <= 0 || h <= 0) return;
    if (this.textRuns.length || src?.textRuns.length) {
      if (rop === SRCCOPY || rop === NOTSRCCOPY || rop === BLACKNESS || rop === WHITENESS) this.coverRuns(dx, dy, dx + w, dy + h);
      else if (rop === SRCAND && src && this.textRuns.length) this.coverRuns(dx, dy, dx + w, dy + h, { surface: src, mx: sx - dx, my: sy - dy });
      if (src?.textRuns.length && (rop === SRCCOPY || rop === SRCPAINT || rop === SRCINVERT)) this.copyRuns(src, dx, dy, w, h, sx, sy);
    }
    if (Surface.smoothStipple && src) {
      if (rop === SRCAND && this.stippleAnd(dx, dy, w, h, src, sx, sy)) return;
      if (rop === SRCPAINT && this.stipplePaint(dx, dy, w, h, src, sx, sy)) return;
    }
    if (pendingStipple?.surface === this) pendingStipple = null;
    const d = this.px, W = this.width;
    const s = src?.px, SW = src?.width ?? 0;
    for (let y = 0; y < h; y++) {
      let di = (dy + y) * W + dx;
      let si = (sy + y) * SW + sx;
      switch (rop) {
        case SRCCOPY: d.set(s!.subarray(si, si + w), di); break;
        case SRCPAINT: for (let x = 0; x < w; x++, di++, si++) d[di] |= s![si]; break;
        case SRCAND: for (let x = 0; x < w; x++, di++, si++) d[di] &= s![si]; break;
        case SRCINVERT: for (let x = 0; x < w; x++, di++, si++) d[di] = (d[di] ^ s![si]) & 0xffffff; break;
        case SRCERASE: for (let x = 0; x < w; x++, di++, si++) d[di] = s![si] & ~d[di] & 0xffffff; break;
        case NOTSRCCOPY: for (let x = 0; x < w; x++, di++, si++) d[di] = ~s![si] & 0xffffff; break;
        case NOTSRCERASE: for (let x = 0; x < w; x++, di++, si++) d[di] = ~(d[di] | s![si]) & 0xffffff; break;
        case MERGEPAINT: for (let x = 0; x < w; x++, di++, si++) d[di] = (d[di] | ~s![si]) & 0xffffff; break;
        case DSNA: for (let x = 0; x < w; x++, di++, si++) d[di] = d[di] & ~s![si] & 0xffffff; break;
        case DSTINVERT: for (let x = 0; x < w; x++, di++) d[di] = ~d[di] & 0xffffff; break;
        case BLACKNESS: d.fill(0, di, di + w); break;
        case WHITENESS: d.fill(0xffffff, di, di + w); break;
        default: throw new Error(`unsupported ROP 0x${rop.toString(16)}`);
      }
    }
  }

  /** SRCAND with a black/white mask containing stipple: blend instead. Returns false if not applicable. */
  private stippleAnd(dx: number, dy: number, w: number, h: number, mask: Surface, sx: number, sy: number): boolean {
    const M = mask.px, MW = mask.width, MH = mask.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0, i = (sy + y) * MW + sx; x < w; x++, i++) if (M[i] !== 0 && M[i] !== 0xffffff) return false;
    }
    const white = new Float32Array(w * h).fill(NaN);
    const at = (x: number, y: number) => {
      const xx = Math.min(MW - 1, Math.max(0, x)), yy = Math.min(MH - 1, Math.max(0, y));
      return M[yy * MW + xx] ? 1 : 0;
    };
    // per pixel: 3x3 white fraction and number of black/white transitions in the window
    // (a straight edge gives ~3, a checkerboard 12)
    const frac = new Float32Array(w * h), core = new Uint8Array(w * h);
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const mx = sx + x, my = sy + y;
        let trans = 0, sum = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const v = at(mx + i, my + j);
            sum += v;
            if (i < 1 && v !== at(mx + i + 1, my + j)) trans++;
            if (j < 1 && v !== at(mx + i, my + j + 1)) trans++;
          }
        }
        frac[y * w + x] = sum / 9;
        if (trans >= 6) { core[y * w + x] = 1; any = true; }
      }
    }
    if (!any) return false;
    // grow the stipple area by one pixel into mixed (not solid) neighbourhoods
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = frac[y * w + x];
        if (f <= 0 || f >= 1) continue;
        let near = false;
        for (let j = -1; j <= 1 && !near; j++) for (let i = -1; i <= 1; i++) {
          const xx = x + i, yy = y + j;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && core[yy * w + xx]) { near = true; break; }
        }
        if (near) white[y * w + x] = f;
      }
    }
    const D = this.px, W = this.width;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const di = (dy + y) * W + dx + x, m = white[y * w + x];
        if (Number.isNaN(m)) D[di] &= M[(sy + y) * MW + sx + x];
        else {
          const c = D[di];
          D[di] = rgb((c & 255) * m, ((c >> 8) & 255) * m, ((c >> 16) & 255) * m);
        }
      }
    }
    pendingStipple = { surface: this, dx, dy, w, h, white };
    return true;
  }

  /** SRCPAINT that completes a stippled SRCAND at the same rect: add the averaged sprite colour. */
  private stipplePaint(dx: number, dy: number, w: number, h: number, sprite: Surface, sx: number, sy: number): boolean {
    const p = pendingStipple;
    if (!p || p.surface !== this || p.dx !== dx || p.dy !== dy || p.w !== w || p.h !== h) return false;
    pendingStipple = null;
    const S = sprite.px, SW = sprite.width, SH = sprite.height, D = this.px, W = this.width;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const di = (dy + y) * W + dx + x, m = p.white[y * w + x];
        const si = (sy + y) * SW + sx + x;
        if (Number.isNaN(m)) { D[di] |= S[si]; continue; }
        // average of the sprite's coloured (non-black) pixels around: the stipple's "ink"
        let r = 0, g = 0, b = 0, n = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const xx = sx + x + i, yy = sy + y + j;
            if (xx < 0 || yy < 0 || xx >= SW || yy >= SH) continue;
            const c = S[yy * SW + xx];
            if (c === 0) continue;
            r += c & 255; g += (c >> 8) & 255; b += (c >> 16) & 255; n++;
          }
        }
        if (!n) continue;
        const k = (1 - m) / n, c = D[di];
        D[di] = rgb(Math.min(255, (c & 255) + r * k), Math.min(255, ((c >> 8) & 255) + g * k), Math.min(255, ((c >> 16) & 255) + b * k));
      }
    }
    return true;
  }

  /** Copy with a transparent colour key (TBitmap.Transparent / TransparentBlt). */
  blitKeyed(dx: number, dy: number, w: number, h: number, src: Surface, sx: number, sy: number, key: number) {
    dx |= 0; dy |= 0; w |= 0; h |= 0; sx |= 0; sy |= 0;
    if (dx < 0) { sx -= dx; w += dx; dx = 0; }
    if (dy < 0) { sy -= dy; h += dy; dy = 0; }
    if (sx < 0) { dx -= sx; w += sx; sx = 0; }
    if (sy < 0) { dy -= sy; h += sy; sy = 0; }
    w = Math.min(w, this.width - dx, src.width - sx);
    h = Math.min(h, this.height - dy, src.height - sy);
    if (w <= 0 || h <= 0) return;
    if (this.textRuns.length) this.coverRuns(dx, dy, dx + w, dy + h, { surface: src, mx: sx - dx, my: sy - dy, key: key & 0xffffff });
    key &= 0xffffff;
    for (let y = 0; y < h; y++) {
      let di = (dy + y) * this.width + dx, si = (sy + y) * src.width + sx;
      for (let x = 0; x < w; x++, di++, si++) {
        const c = src.px[si];
        if (c !== key) this.px[di] = c;
      }
    }
  }

  /** StretchBlt with nearest-neighbour sampling (COLORONCOLOR). */
  stretchBlt(dx: number, dy: number, dw: number, dh: number, src: Surface, sx: number, sy: number, sw: number, sh: number, rop: Rop = SRCCOPY) {
    if (dw === sw && dh === sh) return this.bitBlt(dx, dy, dw, dh, src, sx, sy, rop);
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    const tmp = new Surface(dw, dh);
    for (let y = 0; y < dh; y++) {
      const syy = sy + Math.floor((y * sh) / dh);
      for (let x = 0; x < dw; x++) {
        const v = src.getPixel(sx + Math.floor((x * sw) / dw), syy);
        tmp.px[y * dw + x] = v < 0 ? 0 : v;
      }
    }
    this.bitBlt(dx, dy, dw, dh, tmp, 0, 0, rop);
  }

  /** Draw text (TextOut). Antialiasing is thresholded away to mimic 1990s GDI rendering. */
  textOut(x: number, y: number, text: string, font: FontSpec, bgColor: number | null = null): { w: number; h: number } {
    if (Surface.hiResText) {
      const w = Surface.textWidth(text, font), h = Math.ceil(font.px * 1.2);
      if (bgColor !== null) this.fillRect(x, y, x + w, y + h, bgColor);
      this.textRuns = this.textRuns.filter((o) => !(o.x === x && o.y === y && o.text === text));
      if (text.trim()) this.textRuns.push({ x, y, text, font: { ...font }, clip: null, w });
      return { w, h };
    }
    const ctx = textCtx();
    ctx.font = cssFont(font);
    const m = ctx.measureText(text);
    const w = Math.ceil(m.width) + 2;
    const asc = Math.ceil(font.px * 0.9), h = Math.ceil(font.px * 1.2);
    if (bgColor !== null) this.fillRect(x, y, x + w - 2, y + h, bgColor);
    if (w <= 2) return { w: 0, h };
    if (ctx.canvas.width < w || ctx.canvas.height < h) {
      ctx.canvas.width = Math.max(ctx.canvas.width, w);
      ctx.canvas.height = Math.max(ctx.canvas.height, h);
      ctx.font = cssFont(font);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, 0, asc);
    if (font.underline) ctx.fillRect(0, asc + 1, w - 2, Math.max(1, Math.round(font.px / 14)));
    const data = ctx.getImageData(0, 0, w, h).data;
    const c = font.color & 0xffffff;
    for (let yy = 0; yy < h; yy++) {
      const py = y + yy;
      if (py < 0 || py >= this.height) continue;
      for (let xx = 0; xx < w; xx++) {
        if (data[(yy * w + xx) * 4 + 3] >= 110) {
          const px = x + xx;
          if (px >= 0 && px < this.width) this.px[py * this.width + px] = c;
        }
      }
    }
    return { w: Math.ceil(m.width), h };
  }

  static textWidth(text: string, font: FontSpec): number {
    const ctx = textCtx();
    ctx.font = cssFont(font);
    return Math.ceil(ctx.measureText(text).width);
  }

  /** Build a mask: pixels equal to `key` become white (0xFFFFFF), others black — like a monochrome TBitmap mask. */
  makeMask(key: number): Surface {
    const m = new Surface(this.width, this.height);
    key &= 0xffffff;
    for (let i = 0; i < this.px.length; i++) m.px[i] = this.px[i] === key ? 0xffffff : 0;
    return m;
  }

  /** Write into an RGBA ImageData buffer. */
  toImageData(out: ImageData, ox = 0, oy = 0) {
    const dst = new Uint32Array(out.data.buffer);
    const W = out.width, H = out.height;
    for (let y = 0; y < this.height; y++) {
      const py = oy + y;
      if (py < 0 || py >= H) continue;
      for (let x = 0; x < this.width; x++) {
        const px = ox + x;
        if (px < 0 || px >= W) continue;
        dst[py * W + px] = this.px[y * this.width + x] | 0xff000000;
      }
    }
  }
}

/** Decode a Windows BMP (1/4/8/24/32 bpp, uncompressed or RLE8/RLE4). */
export function decodeBmp(buf: ArrayBuffer): Surface {
  const v = new DataView(buf);
  if (v.getUint16(0, true) !== 0x4d42) throw new Error('not a BMP');
  const off = v.getUint32(10, true);
  const hdr = v.getUint32(14, true);
  let w: number, h: number, bpp: number, comp = 0, clrUsed = 0;
  if (hdr === 12) {
    w = v.getUint16(18, true); h = v.getInt16(20, true); bpp = v.getUint16(24, true);
  } else {
    w = v.getInt32(18, true); h = v.getInt32(22, true); bpp = v.getUint16(28, true);
    comp = v.getUint32(30, true); clrUsed = v.getUint32(46, true);
  }
  const topDown = h < 0;
  h = Math.abs(h);
  const s = new Surface(w, h);
  let pal: Uint32Array | undefined;
  if (bpp <= 8) {
    const n = clrUsed || 1 << bpp;
    pal = new Uint32Array(1 << bpp);
    const pe = hdr === 12 ? 3 : 4;
    for (let i = 0; i < n && i < pal.length; i++) {
      const p = 14 + hdr + i * pe;
      pal[i] = rgb(v.getUint8(p + 2), v.getUint8(p + 1), v.getUint8(p));
    }
    s.palette = pal;
    s.indices = new Uint8Array(w * h);
  }
  const bytes = new Uint8Array(buf);
  const put = (x: number, y: number, idx: number) => {
    if (x >= w || y >= h) return;
    const row = topDown ? y : h - 1 - y;
    s.indices![row * w + x] = idx;
    s.px[row * w + x] = pal![idx];
  };
  if (comp === 1 || comp === 2) {
    // RLE8 / RLE4
    let p = off, x = 0, y = 0;
    while (p < bytes.length) {
      const a = bytes[p++], b = bytes[p++];
      if (a > 0) {
        for (let i = 0; i < a; i++) put(x++, y, comp === 1 ? b : i & 1 ? b & 15 : b >> 4);
      } else if (b === 0) { x = 0; y++; }
      else if (b === 1) break;
      else if (b === 2) { x += bytes[p++]; y += bytes[p++]; }
      else {
        for (let i = 0; i < b; i++) {
          const val = comp === 1 ? bytes[p + i] : i & 1 ? bytes[p + (i >> 1)] & 15 : bytes[p + (i >> 1)] >> 4;
          put(x++, y, val);
        }
        const used = comp === 1 ? b : (b + 1) >> 1;
        p += used + (used & 1);
      }
    }
    return s;
  }
  const stride = (((w * bpp + 31) >> 5) << 2);
  for (let y = 0; y < h; y++) {
    const row = topDown ? y : h - 1 - y;
    const p0 = off + y * stride;
    for (let x = 0; x < w; x++) {
      let c: number;
      if (bpp === 8) { const i = bytes[p0 + x]; s.indices![row * w + x] = i; c = pal![i]; }
      else if (bpp === 4) { const i = (bytes[p0 + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15; s.indices![row * w + x] = i; c = pal![i]; }
      else if (bpp === 1) { const i = (bytes[p0 + (x >> 3)] >> (7 - (x & 7))) & 1; s.indices![row * w + x] = i; c = pal![i]; }
      else if (bpp === 24) { const q = p0 + x * 3; c = rgb(bytes[q + 2], bytes[q + 1], bytes[q]); }
      else if (bpp === 32) { const q = p0 + x * 4; c = rgb(bytes[q + 2], bytes[q + 1], bytes[q]); }
      else if (bpp === 16) { const q = v.getUint16(p0 + x * 2, true); c = rgb(((q >> 10) & 31) << 3, ((q >> 5) & 31) << 3, (q & 31) << 3); }
      else throw new Error(`unsupported bpp ${bpp}`);
      s.px[row * w + x] = c;
    }
  }
  return s;
}
