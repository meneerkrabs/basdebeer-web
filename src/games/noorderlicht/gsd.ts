// GSD Stoelendans - Noorderlicht PLAY_GAME 5 (TGSDfrmMain). Rendering/input around GsdLogic.
//
// The form covers the whole 800x600 screen (GSDBACK.BMP is the book's page art with the 560x280 scene
// GSD00<round>.BMP at the display rect). Walk with the music; when it stops click a chair for Bas
// (mouse or touch, as in the original). Prev (left book, result 2) and Stop (JA/NEE dialog, result 0) are
// the book's own buttons; Prev is enabled unless the book passes params.prev = 0 (history empty).
// The game timer keeps running while the quit dialog is open, like the original's ShowModal.
//
// Deviation: the eliminated-player icons below the picture are visible from the start of a round (the
// original only invalidated the display rect, so they appeared at the next full repaint).
import { audio, SND_ASYNC, SND_NOSTOP } from '../../engine/audio.ts';
import { SRCAND, SRCCOPY, SRCPAINT, type Surface } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { DISP, GsdLogic, inBox, PREV_RECT, SPRITE, STOP_RECT, TEXT_RECT, TICK_MS, type GsdIO, type Walker } from './gsd-logic.ts';
import { loadWav } from './nl-sound.ts';
import { askQuit } from './quit-dialog.ts';

export const title = 'Stoelendans';

const gsd: Minigame = ({ display, assets, params }) => {
  const W = display.width, H = display.height;
  const form = new Form(display, W, H, 'GSDfrmMain'); // bsNone, poScreenCenter, 800x600
  form.center();
  const mode = params?.mode === 'D' ? 'D' : 'N';
  const prevEnabled = !params || (params.prev === undefined && params.prevEnabled === undefined) ||
    Number(params.prev ?? params.prevEnabled) !== 0;
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let quitFlow: () => void = () => {};

  (async () => {
    const img = (n: string) => assets.image(n);
    const [back, ...scenes] = await Promise.all([img('GSDBACK.BMP'), ...[0, 1, 2, 3, 4, 5, 6].map((n) => img(`GSD00${n}.BMP`))]);
    // walker i (1 = Bas) = sheet GSD0(05+i): GSD006 .. GSD012, colour (N) + mask (M)
    const sheet: Surface[] = [], mask: Surface[] = [];
    for (let i = 1; i <= 7; i++) {
      const id = String(5 + i).padStart(3, '0');
      sheet[i] = await img(`GSD${id}N.BMP`);
      mask[i] = await img(`GSD${id}M.BMP`);
    }
    const snd = await Promise.all(Array.from({ length: 11 }, (_, n) => loadWav(assets, `GSD${String(n).padStart(3, '0')}.WAV`)));

    const bg = back.clone(); // 0x1b4: clean background (GSDBACK + current scene)
    const work = back.clone(); // 0x1b8: what is shown (walkers, icons)
    let soundEnd = 0; // wall-clock end of the last sound, for when the audio context is still locked

    const io: GsdIO = {
      random: (n) => rnd.random(n),
      newScene: (round, walkers) => {
        bg.bitBlt(DISP.x, DISP.y, DISP.w, DISP.h, scenes[round], 0, 0, SRCCOPY);
        work.bitBlt(0, 0, W, H, bg, 0, 0, SRCCOPY);
        for (let slot = 0; slot <= round; slot++) {
          for (let i = 1; i <= 7; i++) {
            const k = walkers[i];
            if (k.active || k.out !== slot) continue;
            const dx = TEXT_RECT.x + 16 + slot * 60, dy = TEXT_RECT.y + 7;
            work.bitBlt(dx, dy, SPRITE, SPRITE, mask[i], 2 * SPRITE, 0, SRCAND);
            work.bitBlt(dx, dy, SPRITE, SPRITE, sheet[i], 2 * SPRITE, 0, SRCPAINT);
          }
        }
        form.invalidate();
      },
      drawWalkers: (walkers: readonly Walker[]) => {
        for (let i = 7; i >= 1; i--) {
          const k = walkers[i];
          if (!k.active) continue;
          work.bitBlt(k.px - 28, k.py - 28, SPRITE, SPRITE, bg, k.px - 28, k.py - 28, SRCCOPY);
          const sx = k.heading * SPRITE, sy = k.phase * SPRITE;
          work.bitBlt(k.x - 28, k.y - 28, SPRITE, SPRITE, mask[i], sx, sy, SRCAND);
          work.bitBlt(k.x - 28, k.y - 28, SPRITE, SPRITE, sheet[i], sx, sy, SRCPAINT);
        }
        form.invalidate();
      },
      repaint: () => form.repaint(),
      play: (n) => {
        audio.sndPlaySound(snd[n], SND_ASYNC);
        soundEnd = performance.now() + snd[n].duration * 1000;
      },
      probe: () => {
        // sndPlaySound(GSD000.WAV, SND_NOSTOP): succeeds (and plays the near-silent file) once nothing is playing
        if (audio.ctx.state !== 'running') return performance.now() >= soundEnd;
        return audio.sndPlaySound(snd[0], SND_ASYNC | SND_NOSTOP);
      },
    };
    const g = new GsdLogic(io);

    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      timer.enabled = false;
      audio.stopSystemSound();
      form.close(code);
    };

    const timer = form.timer(TICK_MS, () => {
      g.tick();
      if (!g.running) finish(g.result);
    }, false);

    form.onPaint = () => form.surface.bitBlt(0, 0, W, H, work, 0, 0, SRCCOPY);

    let quitting = false;
    quitFlow = () => {
      if (quitting || finished) return;
      quitting = true;
      void askQuit(display, assets, 0, mode).then((yes) => {
        quitting = false;
        if (yes) { g.result = 0; g.running = false; finish(0); }
      });
    };

    form.onMouseDown = (_b, _s, x, y) => {
      if (finished || quitting) return;
      if (prevEnabled && inBox(PREV_RECT, x, y)) { g.result = 2; finish(2); return; }
      if (inBox(STOP_RECT, x, y)) { quitFlow(); return; }
      g.clickChair(x, y);
    };
    form.onMouseMove = (_s, x, y) => {
      form.cursor = (prevEnabled && inBox(PREV_RECT, x, y)) || inBox(STOP_RECT, x, y) ? 'pointer' : 'default';
    };
    form.onClose = () => { finished = true; audio.stopSystemSound(); };

    form.show();
    g.newRound(); // FormShow
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code));
  return { result, requestQuit: () => quitFlow() };
};

export default gsd;
