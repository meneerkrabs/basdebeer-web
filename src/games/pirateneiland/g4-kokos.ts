// Kokosspel -- Pirateneiland minigame 4 (TfrmG4 of BBOEK32.EXE). Rendering/input around KokosLogic.
//
// Stop sign: the original form has no stop handling and the book is frozen while a game runs
// (spec 6.1), so requestQuit() is a no-op.
import { audio } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, SRCCOPY, type Surface } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { KokosLogic } from './kokos-logic.ts';

export const title = 'Kokosspel';

const BASKET_W = 120, BASKET_H = 110, BASKET_Y = 370, COCO = 40;

const kokos: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 480, 'frmG4');
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: KokosLogic | null = null;
  let mouseX = 320;

  (async () => {
    const [bgOrig, coco, cocoMask, miss, missMask, bas, basMask, ...sounds] = await Promise.all([
      assets.image('IG04.BMP'), assets.image('AG0401.BMP'), assets.image('AG0401A.BMP'),
      assets.image('AG0403.BMP'), assets.image('AG0403A.BMP'), assets.image('AG0404.BMP'), assets.image('AG0404A.BMP'),
      ...['GAME004A', 'GAME004B', 'GAME001C', 'GE001003'].map((n) => assets.sound(`${n}.WAV`)),
    ]) as [Surface, Surface, Surface, Surface, Surface, Surface, Surface, ...AudioBuffer[]];
    const bg = bgOrig.clone(); // 0x1b4 clean background (icons are stamped into it)
    const buf = bgOrig.clone(); // 0x1b8 working buffer shown by FormPaint

    const stamp = (img: Surface, mask: Surface, x: number, y: number, frame: number) => {
      bg.bitBlt(x, y, COCO, COCO, mask, frame * COCO, 0, SRCAND);
      bg.bitBlt(x, y, COCO, COCO, img, frame * COCO, 0, SRCPAINT);
      buf.bitBlt(x, y, COCO, COCO, bg, x, y, SRCCOPY);
      form.invalidate();
    };

    const g = new KokosLogic({
      random: (n) => rnd.random(n),
      playSync: (slot) => audio.sndPlaySoundSync(sounds[slot]).then(() => undefined),
      mouseX: () => mouseX,
      draw: (x, y, frame, oldX, oldY, bx, oldBx, bframe) => {
        buf.bitBlt(oldX, oldY, COCO, COCO, bg, oldX, oldY, SRCCOPY);
        buf.bitBlt(x, y, COCO, COCO, cocoMask, frame * COCO, 0, SRCAND);
        buf.bitBlt(x, y, COCO, COCO, coco, frame * COCO, 0, SRCPAINT);
        buf.bitBlt(oldBx, BASKET_Y, BASKET_W, 480 - BASKET_Y, bg, oldBx, BASKET_Y, SRCCOPY);
        buf.bitBlt(bx, BASKET_Y, BASKET_W, BASKET_H, basMask, bframe * BASKET_W, 0, SRCAND);
        buf.bitBlt(bx, BASKET_Y, BASKET_W, BASKET_H, bas, bframe * BASKET_W, 0, SRCPAINT);
        form.invalidate();
      },
      stampCaught: (x, y, frame) => stamp(coco, cocoMask, x, y, frame),
      stampMissed: (x, y, frame) => stamp(miss, missMask, x, y, frame),
      finish: (code) => form.close(code),
    });
    logic = g;

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 480, buf, 0, 0, SRCCOPY);
    form.onMouseMove = (_s, x) => { mouseX = x; };
    form.onClose = () => { void g.onClose(); };

    form.show();
    form.repaint(); // FormShow: Repaint
    g.show();
    form.timer(50, () => g.tick());
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code || logic?.result || 2));
  return { result, requestQuit: () => { /* no stop sign in the original */ } };
};

export default kokos;
