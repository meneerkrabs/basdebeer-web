// Geheugen trainer — Paaseiland minigame 3 (TfrmG3). Rendering/input around MemoryLogic.
import { audio } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, type Surface } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { MemoryLogic, SIGN_RECT, SPRITE_RECTS } from './memory-logic.ts';

export const title = 'Geheugen trainer';

const SIGN = { x: SIGN_RECT.l, bottom: SIGN_RECT.b, w: 196, h: 179 };

const geheugen: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 320, 'frmG3');
  form.center(); // Position = poScreenCenter
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: MemoryLogic | null = null;

  (async () => {
    const [bgOrig, sign, signMask, question, g1701, g1702, ...rest] = await Promise.all([
      assets.image('I017.BMP'), assets.image('YN1.BMP'), assets.image('YN1M.BMP'),
      assets.sound('YN001.WAV'), assets.sound('GE1701.WAV'), assets.sound('GE1702.WAV'),
      ...Array.from({ length: 4 }, (_, i) => assets.sound(`GE17${11 + i}.WAV`)),
      ...Array.from({ length: 26 }, (_, i) => assets.image(`A017${String(i + 1).padStart(2, '0')}.BMP`)),
    ]) as [Surface, Surface, Surface, AudioBuffer, AudioBuffer, AudioBuffer, ...(AudioBuffer | Surface)[]];
    const mem = rest.slice(0, 4) as AudioBuffer[];
    const sheets = rest.slice(4) as Surface[];
    const files: Record<string, AudioBuffer> = { GE1701: g1701, GE1702: g1702 };
    const bg = bgOrig.clone(); // the original draws sprite frames into its background bitmap

    const timer = form.timer(100, () => g.tick(), false);
    const g = new MemoryLogic({
      drawFrame: (idx, frame) => {
        const sheet = sheets[idx];
        const [l, t, r, b] = SPRITE_RECTS[idx];
        const w = r - l;
        // CopyRect(dest = sprite rect, src = ((frame-1)*w, 0, frame*w, sheet.height)); frames beyond
        // the sheet would read garbage in the original, so clamp.
        const f = Math.max(1, Math.min(frame, Math.floor(sheet.width / w)));
        bg.stretchBlt(l, t, w, b - t, sheet, (f - 1) * w, 0, w, sheet.height);
        form.invalidate();
      },
      playFile: (name) => audio.sndPlaySound(files[name]),
      playMem: (i, flags) => audio.sndPlaySound(mem[i], flags),
      stopSound: () => audio.sndPlaySound(null),
      whenSoundDone: () => audio.whenSystemSoundDone(),
      playQuestion: () => audio.sndPlaySound(question),
      random: (n) => rnd.random(n),
      repaint: () => form.invalidate(),
      setTimerInterval: (ms) => timer.setInterval(ms),
      close: () => form.close(g.exitCode || 2),
    });
    logic = g;

    form.onPaint = () => {
      const s = form.surface;
      s.bitBlt(0, 0, 640, 320, bg, 0, 0);
      const h = g.signDrawn * 12; // the sign slides up from the bottom of its rect, 12 px per tick
      if (h > 0) {
        s.bitBlt(SIGN.x, SIGN.bottom - h, SIGN.w, h, signMask, 0, 0, SRCAND);
        s.bitBlt(SIGN.x, SIGN.bottom - h, SIGN.w, h, sign, 0, 0, SRCPAINT);
      }
    };
    form.onMouseDown = (_b, _s, x, y) => { void g.mouseDown(x, y); };
    form.onClose = () => g.onClose();

    g.start();
    form.show();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then(() => resolveResult(logic?.exitCode || 2));
  return { result, requestQuit: () => logic?.requestQuit() };
};

export default geheugen;
