// Voetballen — Paaseiland minigame 4 (TfrmG4). Rendering/input around FootballLogic.
import { audio } from '../../engine/audio.ts';
import type { Surface } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { FootballLogic } from './voetbal-logic.ts';

export const title = 'Voetballen';

const voetballen: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 320, 'frmG4');
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: FootballLogic | null = null;

  (async () => {
    const [bg, ...rest] = (await Promise.all([
      assets.image('I022.BMP'),
      ...Array.from({ length: 8 }, (_, i) => assets.image(`A0220${i + 1}.BMP`)),
      assets.image('YN1.BMP'), assets.image('YN1M.BMP'),
      assets.sound('GE2201.WAV'), assets.sound('yn001.wav'),
      ...[1, 2, 3, 4, 5].map((i) => assets.sound(`GE221${i}.WAV`)),
    ])) as [Surface, ...(Surface | AudioBuffer)[]];
    const sprites = rest.slice(0, 8) as Surface[];
    const [sign, signMask] = rest.slice(8, 10) as Surface[];
    const [intro, question, ...sounds] = rest.slice(10) as AudioBuffer[];

    const bgCopy = bg.clone(); // the stop sign is drawn into the background bitmap
    const g = new FootballLogic(
      {
        playSound: (i, flags) => audio.sndPlaySound(i === null ? null : sounds[i], flags),
        playIntro: () => void audio.sndPlaySound(intro, 1),
        playQuestion: () => void audio.sndPlaySound(question, 1),
        cursorX: () => display.mouseX - form.left,
        close: () => form.close(g.exitCode || 2),
        repaintAll: () => g.paint(),
      },
      { bg: bgCopy, work: bg.clone(), screen: form.surface, sprites, sign, signMask },
    );
    logic = g;

    form.onPaint = () => g.paint();
    form.onMouseDown = (_b, _s, x, y) => g.mouseDown(x, y);
    form.onClose = () => g.onClose();

    g.create();
    form.show();
    g.show();
    // AniTimer and BongoTimer: both Interval = 100 in the DFM
    form.timer(100, () => g.aniTick());
    form.timer(100, () => g.bongoTick());
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then(() => resolveResult(logic?.exitCode || 2));
  return { result, requestQuit: () => logic?.requestQuit() };
};

export default voetballen;
