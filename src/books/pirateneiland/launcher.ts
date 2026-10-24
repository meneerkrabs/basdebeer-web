// The CD menu: Autorun.exe (TfrmAutorun) on the "Naar Pirateneiland" disc.
// A 596x305 panel with the "Distributed by ToYou" bitmap, the label "Maak Uw Keuze:", an "X" close
// button at (8,8) and four flat 146x23 buttons at y=280 (x = 5 / 151 / 297 / 443):
// Berenboek (BBOEK32), PrintStudio (BPRINT32, out of scope here: disabled), BerenSpellen (BSPEL32)
// and BerenBios (BBIOS32). The originals are separate processes; here each program takes over the
// display and returns to this menu when it ends.
//
// The bitmap is embedded in AUTORUN.EXE (a Delphi form resource) in the CD root, i.e. outside BASWIN:
// it is read through `vfs.readRoot` (archive.org / ISO / CD folder) and cut out of the exe.

import type { Assets } from '../../engine/assets.ts';
import { decodeBmp, rgb, Surface, type FontSpec } from '../../engine/surface.ts';
import { Form, type Display } from '../../engine/vcl.ts';
import { runBerenBios } from './bios.ts';
import { messageBox, ptInRect, SYS_FONT, type Rect } from './shared.ts';
import { runBerenSpellen } from './spellen.ts';

/** The book module is written separately; Vite resolves this at build time and yields {} while it is missing. */
const bookModule = import.meta.glob<{ runPirateneiland: (display: Display, assets: Assets) => Promise<void> }>('./book.ts');

const PANEL_W = 596, PANEL_H = 305;
const BTN_W = (PANEL_W - 10) >> 2; // 146
const BTN_Y = PANEL_H - 25;
const BTN_H = 23;

interface Button { id: 'boek' | 'print' | 'spellen' | 'bios' | 'close'; caption: string; rect: Rect; enabled: boolean }
const BUTTONS: Button[] = [
  { id: 'boek', caption: 'Berenboek', rect: [5, BTN_Y, 5 + BTN_W, BTN_Y + BTN_H], enabled: true },
  { id: 'print', caption: 'PrintStudio', rect: [BTN_W + 5, BTN_Y, BTN_W * 2 + 5, BTN_Y + BTN_H], enabled: false },
  { id: 'spellen', caption: 'BerenSpellen', rect: [BTN_W * 2 + 5, BTN_Y, BTN_W * 3 + 5, BTN_Y + BTN_H], enabled: true },
  { id: 'bios', caption: 'BerenBios', rect: [BTN_W * 3 + 5, BTN_Y, BTN_W * 4 + 5, BTN_Y + BTN_H], enabled: true },
  { id: 'close', caption: 'X', rect: [8, 8, 33, 33], enabled: true },
];

const BOLD: FontSpec = { ...SYS_FONT, bold: true, color: 0x000000 };

/** Cut the embedded TBitmap (Picture.Data of Image1) out of AUTORUN.EXE: "\x07TBitmap" + size32 + "BM...". */
function extractAutorunBitmap(exe: ArrayBuffer): Surface | null {
  const b = new Uint8Array(exe), v = new DataView(exe);
  const tag = [0x07, 0x54, 0x42, 0x69, 0x74, 0x6d, 0x61, 0x70]; // "\x07TBitmap"
  for (let i = 0; i + 14 < b.length; i++) {
    if (b[i] !== tag[0] || !tag.every((t, k) => b[i + k] === t)) continue;
    const size = v.getUint32(i + 8, true);
    if (b[i + 12] === 0x42 && b[i + 13] === 0x4d && size > 1000 && i + 12 + size <= b.length) {
      try { return decodeBmp(exe.slice(i + 12, i + 12 + size)); } catch { /* try the next one */ }
    }
  }
  return null;
}

async function loadPanel(assets: Assets): Promise<Surface | null> {
  const sources: (() => Promise<ArrayBuffer>)[] = [];
  if (assets.vfs.readRoot) sources.push(() => assets.vfs.readRoot!('AUTORUN.EXE'));
  // dev copy (public/data/pirateneiland/ROOT/AUTORUN.EXE); the dev Vfs has no root access
  sources.push(async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${assets.book}/ROOT/AUTORUN.EXE`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  });
  for (const src of sources) {
    try {
      const exe = await src();
      if (new Uint8Array(exe, 0, 2).join() !== '77,90') continue; // not an MZ executable (SPA fallback page)
      const bmp = extractAutorunBitmap(exe);
      if (bmp) return bmp;
    } catch (e) {
      console.warn('AUTORUN.EXE niet beschikbaar', e);
    }
  }
  return null;
}

export async function runPirateneilandMenu(display: Display, assets: Assets): Promise<void> {
  const panel = await loadPanel(assets);
  const form = new Form(display, PANEL_W, PANEL_H, 'autorun');
  form.center();

  return new Promise<void>((resolve) => {
    let hot = -1, pressed = -1, busy = false;
    const gray = rgb(128, 128, 128), white = 0xffffff;

    form.onPaint = () => {
      const s = form.surface;
      if (panel) s.bitBlt(0, 0, PANEL_W, PANEL_H, panel, 0, 0);
      else {
        s.fillRect(0, 0, PANEL_W, PANEL_H, rgb(176, 196, 214)); // the bitmap could not be read from the disc
        s.textOut(220, 120, 'Bas de Beer - Pirateneiland', { ...BOLD, px: 16 });
      }
      s.textOut(16, 256, 'Maak Uw Keuze:', BOLD);
      BUTTONS.forEach((b, i) => {
        const [l, t, r, bt] = b.rect;
        const down = pressed === i && hot === i;
        if (b.enabled && hot === i) { // flat speed button: bevel only under the mouse
          s.fillRect(l, t, r - 1, t + 1, down ? gray : white); s.fillRect(l, t, l + 1, bt - 1, down ? gray : white);
          s.fillRect(l, bt - 1, r, bt, down ? white : gray); s.fillRect(r - 1, t, r, bt, down ? white : gray);
        }
        const tw = Surface.textWidth(b.caption, BOLD);
        const x = l + Math.floor((r - l - tw) / 2) + (down ? 1 : 0), y = t + Math.floor((bt - t - 14) / 2) + (down ? 1 : 0);
        if (b.enabled) s.textOut(x, y, b.caption, BOLD);
        else {
          s.textOut(x + 1, y + 1, b.caption, { ...BOLD, color: white }); // disabled: embossed gray
          s.textOut(x, y, b.caption, { ...BOLD, color: gray });
        }
      });
    };

    const at = (x: number, y: number) => BUTTONS.findIndex((b) => ptInRect(b.rect, x, y));
    form.onMouseMove = (_s, x, y) => {
      const i = at(x, y);
      if (i !== hot) { hot = i; form.invalidate(); }
      display.canvas.title = i >= 0 && BUTTONS[i].id === 'close' ? 'Aflsuiten' : '';
    };

    /** CreateProcess of the original: the program takes over the display; we come back when it ends. */
    const launch = async (run: () => Promise<void>) => {
      busy = true;
      form.hide();
      try { await run(); } catch (e) { console.error(e); } finally { form.show(); busy = false; hot = -1; form.invalidate(); }
    };

    form.onMouseDown = (_b, _s, x, y) => {
      if (busy) return;
      const i = at(x, y);
      hot = i;
      pressed = i >= 0 && BUTTONS[i].enabled ? i : -1;
      form.invalidate();
    };

    form.onMouseUp = (_b, _s, x, y) => {
      const i = at(x, y), p = pressed;
      pressed = -1;
      form.invalidate();
      if (busy || p < 0 || i !== p) return; // TSpeedButton fires on release inside the button
      switch (BUTTONS[p].id) {
        case 'close':
          form.close();
          resolve();
          break;
        case 'boek': {
          const load = bookModule['./book.ts'];
          if (!load) { void messageBox(display, 'Berenboek', 'Het Berenboek is in deze versie nog niet beschikbaar.'); break; }
          void launch(async () => (await load()).runPirateneiland(display, assets));
          break;
        }
        case 'spellen':
          void launch(() => runBerenSpellen(display, assets));
          break;
        case 'bios':
          void launch(() => runBerenBios(display, assets));
          break;
        default:
          break;
      }
    };

    form.show();
  });
}
