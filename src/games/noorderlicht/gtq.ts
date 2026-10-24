// GTQ Trollenquiz - Noorderlicht PLAY_GAME 2 (TGTQfrmMain). Rendering/input around GtqLogic.
//
// Mouse only (as in the original): click an answer, hover = yellow. Prev (left book) -> result 2, Stop -> JA/NEE
// dialog (JA -> result 0), 5 correct answers -> result 1. The Prev button is enabled unless the book passes
// params.prevEnabled = 0 (history empty). Sounds go through a TMediaPlayer (MCI) = audio.MediaPlayer.
import { MediaPlayer } from '../../engine/audio.ts';
import { SRCCOPY, type Surface } from '../../engine/surface.ts';
import { Form, rnd, sleep } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { GtqLogic, parseQuestions, RECTS, type Rect } from './gtq-logic.ts';
import { askQuit } from './quit-dialog.ts';

export const title = 'Trollenquiz';

const inRect = (r: Rect, x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

const gtq: Minigame = ({ display, assets, params }) => {
  const form = new Form(display, display.width, display.height, 'GTQfrmMain');
  form.center();
  const mode = params?.mode === 'D' ? 'D' : 'N';
  const prevEnabled = params?.prevEnabled === undefined || Number(params.prevEnabled) !== 0;
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let quitFlow: () => void = () => {};

  (async () => {
    const [back, keepN, keepH, keepG, qtext] = await Promise.all([
      assets.image('GTQBACKN.BMP'), assets.image('GTQKEEPN.BMP'), assets.image('GTQKEEPH.BMP'), assets.image('GTQKEEPG.BMP'),
      assets.text('GTQQUEST.TXT'),
    ]);
    const questions = parseQuestions(qtext);
    await assets.preload([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `GTQ00${n}.WAV`),
      ...questions.flatMap((q) => (q.wav ? [q.wav] : q.bmp ? [q.bmp] : [])),
    ]);

    const mp = new MediaPlayer();
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      g.closed = true;
      mp.close();
      form.close(code);
    };

    const g: GtqLogic = new GtqLogic({ back, keepN, keepH, keepG, questions }, {
      random: (n) => rnd.random(n),
      invalidate: () => form.invalidate(),
      playWav: async (name) => {
        mp.close();
        try {
          mp.open(await assets.sound(name));
          if (!g.closed) mp.play();
        } catch (e) { console.warn(e); }
      },
      closeWav: () => mp.close(),
      wavPlaying: () => mp.playing,
      waitWav: async () => { while (mp.playing && !g.closed) await sleep(20); },
      loadImage: (n): Promise<Surface> => assets.image(n),
    });

    const run = (p: Promise<void>) => p.then(() => { if (!g.running) finish(g.result); }, (e) => console.error(e));

    form.onPaint = () => form.surface.bitBlt(0, 0, display.width, display.height, g.work, 0, 0, SRCCOPY);

    let quitting = false;
    quitFlow = async () => {
      if (quitting || finished) return;
      quitting = true;
      const yes = await askQuit(display, assets, 0, mode);
      quitting = false;
      if (yes) { g.result = 0; g.running = false; finish(0); }
    };

    form.onMouseDown = (_b, _s, x, y) => {
      if (quitting || finished) return;
      const a = g.answerAt(x, y);
      if (a >= 0) { void run(g.checkAnswer(a)); return; }
      if (prevEnabled && inRect(RECTS.prev, x, y)) { g.result = 2; finish(2); return; }
      if (inRect(RECTS.stop, x, y)) { quitFlow(); return; }
      if (inRect(RECTS.read, x, y)) void run(g.readAgain());
    };
    form.onMouseMove = (_s, x, y) => {
      form.cursor = g.hover(x, y, prevEnabled) ? 'pointer' : 'default';
    };

    form.show();
    await run(g.nextQuestion()); // FormShow
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code));
  return { result, requestQuit: () => quitFlow() };
};

export default gtq;
