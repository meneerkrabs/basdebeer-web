// Shared bits of the "Bas de Beer naar het Noorderlicht" engine (BASNOORD.EXE).
// Spec: docs/re/noorderlicht-engine.md (section numbers in comments refer to it).
// Only the 800x600 layout ("mode 1") is implemented.

import type { Assets } from '../../engine/assets.ts';

export type Rect = [number, number, number, number]; // left, top, right, bottom
/** PtInRect: right and bottom edges are exclusive. */
export const inRect = (r: Rect, x: number, y: number) => x >= r[0] && y >= r[1] && x < r[2] && y < r[3];

/** The global D/N byte (DAT_0044e6af): 0 = N (normal art, "3D"), 1 = D (red/blue "3D-plus"). */
export interface Session {
  mode: 0 | 1;
}

/** The 56 page-overview slots (table at 0x44d554, spec 1.4). */
export const SLOT_NAMES = ['01', '02', '03', '04', '05', '05B', '05C', '06', '07', '08', '09', '10', '10B', '11', '12',
  '13', '13B', '14A', '14B', '15', '16', '17', '18', '19', '20', '21', '22', '22B', '23', '24', '25', '26', '27', '29',
  '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47', '47A',
  '48', '49', '50'];

const BOOKMARK_KEY = 'bdb-noorderlicht-bookmark';

/**
 * Slot index of a page ("05BN" or "05B"). Pages without a slot of their own (17A, 28) count as the slot before
 * them. Tutorial pages (51..54) have none: -1.
 */
export function slotIndex(page: string): number {
  const base = /[ND]$/i.test(page) ? page.slice(0, -1) : page;
  const exact = SLOT_NAMES.indexOf(base.toUpperCase());
  if (exact >= 0) return exact;
  const n = parseInt(base, 10);
  if (!(n < 51)) return -1;
  let found = -1;
  SLOT_NAMES.forEach((s, i) => { if (parseInt(s, 10) <= n) found = i; });
  return found;
}

/**
 * The bookmark as a slot index (default "01n" = slot 0). The original stored the full page name but only read back
 * its first two characters, so "14A"/"47A" never matched a slot and compared only the page number (quirk 8).
 * Here progress is tracked per slot instead, so 05B/05C/14A... unlock correctly.
 */
export function readBookmark(): number {
  const s = localStorage.getItem(BOOKMARK_KEY);
  const i = s ? SLOT_NAMES.indexOf(s) : 0;
  return i < 0 ? 0 : i;
}

/** WriteBookmark (FUN_0042aea4): called on every page load; only forward progress is stored, never the tutorial. */
export function writeBookmark(page: string) {
  const i = slotIndex(page);
  if (i > readBookmark() || (i >= 0 && localStorage.getItem(BOOKMARK_KEY) === null)) {
    localStorage.setItem(BOOKMARK_KEY, SLOT_NAMES[i]);
  }
}

/** Does SCRIPTS\<page>.BSB exist ("05BN")? */
export const pageExists = (assets: Assets, page: string) => assets.path(`${page}.BSB`) !== null;

/** The page name in the other mode: last character N or D. */
export const withMode = (page: string, mode: 0 | 1) => page.slice(0, -1) + (mode === 0 ? 'N' : 'D');
