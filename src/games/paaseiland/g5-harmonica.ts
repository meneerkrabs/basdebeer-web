// Mondharmonica — Paaseiland minigame 5 (TfrmG5). Rendering/input around HarmonicaLogic.
import { audio } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, Surface } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { HARE, HarmonicaLogic, RECTS, SIGN } from './harmonica-logic.ts';

export const title = 'Mondharmonica';

const harmonica: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 320, 'frmG5');
  form.center(); // Position = poScreenCenter
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: HarmonicaLogic | null = null;
  let quitPending = false;
  let doQuit: (() => void) | null = null;

  (async () => {
    const names = Array.from({ length: 15 }, (_, i) => `A024${String(i + 1).padStart(2, '0')}.BMP`);
    const [bgOrig, sign, signMask, q1, q2, ge2401, ge2402, ...rest] = await Promise.all([
      assets.image('I024.BMP'), assets.image('YN1.BMP'), assets.image('YN1M.BMP'),
      assets.sound('YN001.WAV'), assets.sound('YN002.WAV'), assets.sound('GE2401.WAV'), assets.sound('GE2402.WAV'),
      ...Array.from({ length: 8 }, (_, i) => assets.sound(`GE24${11 + i}.WAV`)),
      ...names.map((n) => assets.image(n)),
    ]) as [Surface, Surface, Surface, AudioBuffer, AudioBuffer, AudioBuffer, AudioBuffer, ...(AudioBuffer | Surface)[]];
    const sounds = rest.slice(0, 8) as AudioBuffer[];
    const sprites = rest.slice(8) as Surface[];
    const bg = bgOrig.clone(); // the original draws keys, lamps and sign into its background bitmap
    let saved = new Surface(SIGN.w, SIGN.h);

    // Synchronous sndPlaySound calls block the original's UI thread: queue input meanwhile.
    let blocked = false;
    const syncQueue: AudioBuffer[] = [];
    const deferred: (() => void)[] = [];
    const pump = () => {
      audio.whenSystemSoundDone().then(() => {
        const next = syncQueue.shift();
        if (next) {
          audio.sndPlaySound(next, 0);
          pump();
        } else {
          blocked = false;
          while (!blocked && deferred.length) deferred.shift()!();
        }
      });
    };
    const whenFree = (f: () => void) => (blocked ? deferred.push(f) : f());

    const timer = form.timer(100, () => { if (!blocked) g.tick(); }, false);
    const g = new HarmonicaLogic({
      playSound: (i, flags) => audio.sndPlaySound(i === null ? null : sounds[i], flags),
      playSoundSync: (i, flags) => {
        if (blocked) { syncQueue.push(sounds[i]); return true; }
        const ok = audio.sndPlaySound(sounds[i], flags & ~1);
        if (ok) { blocked = true; pump(); }
        return ok;
      },
      playFile: (n) => audio.sndPlaySound(n === 'GE2401' ? ge2401 : ge2402, 1),
      playQuestion: (w) => audio.sndPlaySound(w === 1 ? q1 : q2, 1),
      drawFrame: (rec, frame) => {
        const [l, t, r, b] = RECTS[rec];
        bg.bitBlt(l, t, r - l, b - t, sprites[rec], frame * (r - l), 0);
      },
      saveSignBackground: () => {
        saved = new Surface(SIGN.w, SIGN.h);
        saved.bitBlt(0, 0, SIGN.w, SIGN.h, bg, SIGN.x, SIGN.y);
      },
      drawSign: (step) => {
        bg.bitBlt(SIGN.x, SIGN.y, SIGN.w, SIGN.h, saved, 0, 0);
        const h = step * 12;
        if (h > 0) {
          bg.bitBlt(SIGN.x, 320 - h, SIGN.w, h, signMask, 0, 0, SRCAND);
          bg.bitBlt(SIGN.x, 320 - h, SIGN.w, h, sign, 0, 0, SRCPAINT);
        }
        form.invalidate();
      },
      repaint: () => form.invalidate(),
      setTimerInterval: (ms) => timer.setInterval(ms),
      close: () => form.close(g.exitCode || 2),
    });
    logic = g;
    doQuit = () => whenFree(() => g.requestQuit());
    if (quitPending) doQuit();

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 320, bg, 0, 0);
    form.onMouseDown = (_b, _s, x, y) => whenFree(() => g.mouseDown(x, y));
    form.onMouseUp = () => whenFree(() => g.mouseUp());
    form.onMouseMove = (_s, x, y) => {
      const inR = (r: readonly number[]) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
      form.cursor = RECTS.slice(0, 5).some(inR) || inR(HARE) ? 'pointer' : 'default';
    };
    form.onClose = () => g.onClose();

    form.show();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then(() => resolveResult(logic?.exitCode || 2));
  return {
    result,
    requestQuit: () => {
      if (doQuit) doQuit();
      else quitPending = true;
    },
  };
};

export default harmonica;
