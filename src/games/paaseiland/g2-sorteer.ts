// Sorteer machine — Paaseiland minigame 2 (TfrmG2). Rendering/input around SorteerLogic.
import { audio } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, Surface, type FontSpec } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { SorteerLogic } from './sorteer-logic.ts';

export const title = 'Sorteer machine';

const EGG = 90;
// FormPaint @0x4356f0
const BELT_Y = 75;
const TARGET = { x: 275, y: 200 }; // Rect(0x113, 0xc8, 0x16d, 0x122)
const SIGN = { x: 220, y: 165, w: 196, h: 155 }; // Rect(0xdc, 0xa5, 0x1a0, 0x140)
const BEGIN_FONT: FontSpec = { name: 'Arial', px: 21, bold: true, color: 0xffffff }; // Size 16 pt, fsBold

const sorteer: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 320, 'frmG2');
  form.center(); // Position = poScreenCenter
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: SorteerLogic | null = null;

  (async () => {
    const [bgOrig, sheet, mask, sign, signMask, ...sounds] = await Promise.all([
      assets.image('I013.BMP'), assets.image('A01301.BMP'), assets.image('A01302.BMP'),
      assets.image('YN1.BMP'), assets.image('YN1M.BMP'),
      ...['GE1304', 'GE1305', 'GE1306', 'GE1307', 'GE1301', 'GE1302', 'GE1303', 'YN001']
        .map((n) => assets.sound(`${n}.WAV`)),
    ]) as [Surface, Surface, Surface, Surface, Surface, ...AudioBuffer[]];
    const mem = sounds.slice(0, 4);
    const files: Record<string, AudioBuffer> = { GE1301: sounds[4], GE1302: sounds[5], GE1303: sounds[6], YN001: sounds[7] };
    const bg = bgOrig.clone(); // the original draws the stop sign into its background bitmap
    let saved = new Surface(SIGN.w, SIGN.h);

    const timer = form.timer(100, () => g.tick(), false);
    const g = new SorteerLogic({
      playMem: (i, flags) => audio.sndPlaySound(i === null ? null : mem[i], flags),
      playFile: (name) => void audio.sndPlaySound(files[name], 1),
      random: (n) => rnd.random(n),
      randomize: () => rnd.randomize(),
      repaint: () => form.invalidate(),
      setTimerInterval: (ms) => timer.setInterval(ms),
      saveSignBackground: () => {
        saved = new Surface(SIGN.w, SIGN.h);
        saved.bitBlt(0, 0, SIGN.w, SIGN.h, bg, SIGN.x, SIGN.y);
      },
      drawSign: (step) => {
        // @0x436878: restore the saved slice, overlay the sign (top `step*12` rows, bottom aligned),
        // then copy the slice straight to the form canvas (no full repaint, like the original).
        bg.bitBlt(SIGN.x, SIGN.y, SIGN.w, SIGN.h, saved, 0, 0);
        const h = step * 12;
        if (h > 0) {
          bg.bitBlt(SIGN.x, 320 - h, SIGN.w, h, signMask, 0, 0, SRCAND);
          bg.bitBlt(SIGN.x, 320 - h, SIGN.w, h, sign, 0, 0, SRCPAINT);
        }
        form.surface.bitBlt(SIGN.x, SIGN.y, SIGN.w, SIGN.h, bg, SIGN.x, SIGN.y);
      },
      close: () => form.close(g.exitCode || 2),
    });
    logic = g;

    const egg = (s: Surface, type: number, dx: number, dy: number) => {
      s.bitBlt(dx, dy, EGG, EGG, mask, 0, 0, SRCAND);
      s.bitBlt(dx, dy, EGG, EGG, sheet, type * EGG, 0, SRCPAINT);
    };

    form.onPaint = () => {
      const s = form.surface;
      s.bitBlt(0, 0, 640, 320, bg, 0, 0);
      // the belt: screen position p shows slot (p - rot) mod 8
      for (let p = 0; p < 8; p++) {
        let k = p - g.rot;
        if (k < 0) k += 8;
        const sl = g.slots[k];
        if (sl.type <= -1) continue;
        const x = p * EGG + g.off - 45;
        sl.l = x; sl.t = BELT_Y; sl.r = x + EGG; sl.b = BELT_Y + EGG;
        egg(s, sl.type, x, BELT_Y);
      }
      // clip the belt at both ends
      s.bitBlt(0, BELT_Y, 44, 90, bg, 0, BELT_Y);
      s.bitBlt(588, BELT_Y, 52, 90, bg, 588, BELT_Y);
      if (g.started) {
        for (let i = 0; i < g.score; i++) egg(s, g.collected[i + 1], i < 3 ? i * 50 : i * 50 + 310, 230);
        egg(s, g.target, TARGET.x, TARGET.y);
      } else {
        const w = Surface.textWidth('BEGINNEN', BEGIN_FONT);
        s.textOut(320 - (w >> 1), 230, 'BEGINNEN', BEGIN_FONT);
      }
    };

    form.onMouseDown = (_b, _s, x, y) => g.mouseDown(x, y);
    form.onClose = () => g.onClose();

    form.show();
    g.start();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then(() => resolveResult(logic?.exitCode || 2));
  return { result, requestQuit: () => void logic?.requestQuit() };
};

export default sorteer;
