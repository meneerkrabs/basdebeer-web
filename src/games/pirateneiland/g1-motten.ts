// Mottenspel -- Pirateneiland minigame 1 (TfrmG1 of BBOEK32.EXE). Rendering/input around MottenLogic.
//
// Stop sign: the original form has no OnKeyDown/stop handling and the book is frozen while a game runs
// (spec 6.1), so requestQuit() is a no-op.
import { audio, SND_ASYNC as A_ASYNC, SND_LOOP } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, SRCCOPY, type Surface } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { MOTH, MottenLogic, Snd, type Rect } from './motten-logic.ts';

export const title = 'Mottenspel';

const motten: Minigame = ({ display, assets }) => {
  // FormCreate: bsNone, 640x480, poScreenCenter
  const form = new Form(display, 640, 480, 'frmG1');
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: MottenLogic | null = null;

  (async () => {
    const [sheet, ...rest] = await Promise.all([
      assets.image('MOTTEN.BMP'),
      ...[0, 1, 2, 3, 4].map((i) => assets.image(`KAARS${i}.BMP`)),
      ...['GE001001', 'GE001002', 'GE001003', 'GAME001A', 'GAME001B', 'GAME001C'].map((n) => assets.sound(`${n}.WAV`)),
    ]) as [Surface, ...(Surface | AudioBuffer)[]];
    const kaars = rest.slice(0, 5) as Surface[];
    const sounds = rest.slice(5) as AudioBuffer[];

    let bg: Surface = kaars[0].clone(); // 0x1b0: clean background (icons are stamped into it)
    const buf = bg.clone(); // 0x1b4: working buffer shown by FormPaint

    const g = new MottenLogic({
      random: (n) => rnd.random(n),
      playLoop: () => audio.sndPlaySound(sounds[Snd.Loop], A_ASYNC | SND_LOOP),
      playSync: (slot) => audio.sndPlaySoundSync(sounds[slot]).then(() => undefined),
      drawBackground: (burned, caught) => {
        // FUN_0042e434. Burned icons (cell 4) from x=0 rightwards at y 439..479, caught icons (cell 5)
        // from x=600 leftwards at y 440..480. The loops run n+1 times; the first pass is off-screen.
        bg = kaars[Math.min(burned, 4)].clone();
        for (let i = 1; i <= burned; i++) {
          const x = (i - 1) * MOTH;
          bg.bitBlt(x, 439, MOTH, 40, sheet, 120, 40, SRCAND);
          bg.bitBlt(x, 439, MOTH, 40, sheet, 120, 0, SRCPAINT);
        }
        for (let i = 1; i <= caught; i++) {
          const x = 640 - i * MOTH;
          bg.bitBlt(x, 440, MOTH, 40, sheet, 160, 40, SRCAND);
          bg.bitBlt(x, 440, MOTH, 40, sheet, 160, 0, SRCPAINT);
        }
        buf.bitBlt(0, 0, 640, 480, bg, 0, 0, SRCCOPY);
        form.repaint();
      },
      drawMoth: (old: Rect, cur: Rect, frame: number) => {
        buf.bitBlt(old.l, old.t, MOTH, MOTH, bg, old.l, old.t, SRCCOPY);
        buf.bitBlt(cur.l, cur.t, MOTH, MOTH, sheet, (frame - 1) * MOTH, 40, SRCAND);
        buf.bitBlt(cur.l, cur.t, MOTH, MOTH, sheet, (frame - 1) * MOTH, 0, SRCPAINT);
        form.invalidate();
      },
      finish: (code) => form.close(code),
    });
    logic = g;

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 480, buf, 0, 0, SRCCOPY);
    form.onMouseDown = (_b, _s, x, y) => g.mouseDown(x, y);
    form.onClose = () => { void g.onClose(); };

    form.show();
    g.show();
    form.timer(50, () => g.tick());
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code || logic?.result || 2));
  return { result, requestQuit: () => { /* no stop sign in the original */ } };
};

export default motten;
