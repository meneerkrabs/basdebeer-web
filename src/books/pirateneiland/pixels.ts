// Pixel-only helpers. Surface.bitBlt also moves the engine's text runs (hi-res text mode), which is wrong for things that are
// not meant to affect the text (the worm, the JA/NEE sign snapshot): these copy just the pixels.

import type { Surface } from '../../engine/surface.ts';

/** SRCCOPY of a rect, pixels only (clipped to both surfaces). */
export function copyPixels(dst: Surface, src: Surface, x: number, y: number, w: number, h: number, sx = x, sy = y) {
  let dx = x | 0, dy = y | 0;
  w |= 0; h |= 0; sx |= 0; sy |= 0;
  if (dx < 0) { sx -= dx; w += dx; dx = 0; }
  if (dy < 0) { sy -= dy; h += dy; dy = 0; }
  if (sx < 0) { dx -= sx; w += sx; sx = 0; }
  if (sy < 0) { dy -= sy; h += sy; sy = 0; }
  w = Math.min(w, dst.width - dx, src.width - sx);
  h = Math.min(h, dst.height - dy, src.height - sy);
  if (w <= 0 || h <= 0) return;
  for (let r = 0; r < h; r++) {
    const si = (sy + r) * src.width + sx;
    dst.px.set(src.px.subarray(si, si + w), (dy + r) * dst.width + dx);
  }
}
