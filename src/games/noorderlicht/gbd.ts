// GBD Berendobbel - Noorderlicht PLAY_GAME 8 (TGBDfrmMain + TGBDfrmStartup + TGBDfrmSpelRegel).
// Rendering/input around GbdLogic. A 640x480 form (centred), mouse only: the hand with dice, the rules,
// Stop (press twice). All sounds go through one MCI-style queue (MediaPlayer), one after the other.
// The form always ends with result 1 (Stop or "Geen Berendobbel spelen"), like the original.
import { MediaPlayer } from '../../engine/audio.ts';
import { SRCCOPY, type Surface } from '../../engine/surface.ts';
import { Form, rnd, sleep } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { Aborted, faceImage, GbdLogic, RECTS, rollFrameImage, sndName, type Rect } from './gbd-logic.ts';
import { showRules } from './gbd-rules.ts';
import { newStartupMemory, showStartup } from './gbd-startup.ts';

export const title = 'Berendobbel';

const inRect = (r: Rect, x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

const gbd: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 480, 'GBDfrmMain');
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let quitFlow: () => void = () => {};

  (async () => {
    const wavs: string[] = [];
    for (let i = 1; i <= 33; i++) wavs.push(sndName(i));
    const imgNames = ['GBDBRD01.BMP', 'GBDBRD02.BMP', 'GBDAPWNS.BMP',
      ...Array.from({ length: 11 }, (_, i) => rollFrameImage(i)), ...Array.from({ length: 6 }, (_, i) => faceImage(i + 1))];
    await assets.preload([...imgNames, ...wavs]);
    const imgs = await Promise.all(imgNames.map((n) => assets.image(n))) as Surface[];
    const [board1, board2, sprites] = imgs;
    const roll = imgs.slice(3, 14);
    const faces = [imgs[0], ...imgs.slice(14, 20)]; // [0] unused

    // the sound queue (TMediaPlayer MediaPlayer1 + the list that Timer1 works through)
    const mp = new MediaPlayer();
    const memory = newStartupMemory();
    let closed = false;
    let chain: Promise<void> = Promise.resolve();
    let release: (() => void)[] = [];
    const soundStart = (name: string) => {
      let startedRes!: () => void;
      const started = new Promise<void>((r) => (startedRes = r));
      const done = chain.then(async () => {
        if (closed) { startedRes(); throw new Aborted(); }
        let buf: AudioBuffer | null = null;
        try { buf = await assets.sound(name); } catch (e) { console.warn(e); }
        if (!buf) { startedRes(); return; }
        await new Promise<void>((res) => {
          release.push(res);
          mp.onNotify = () => res();
          mp.open(buf!);
          mp.play();
          startedRes();
        });
        if (closed) throw new Aborted();
      });
      chain = done.catch(() => undefined);
      return { started, done };
    };

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      closed = true;
      mp.close();
      for (const r of release) r();
      release = [];
      form.close(1);
    };

    const g: GbdLogic = new GbdLogic({ board1, board2, sprites, roll, faces }, {
      random: (n) => rnd.random(n),
      randomize: () => rnd.randomize(),
      invalidate: () => form.invalidate(),
      sleep,
      sound: (name) => soundStart(name).done,
      soundStart,
      startup: () => showStartup(display, assets, memory),
      close: finish,
      get closed() { return closed; },
    });

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 480, g.view, 0, 0, SRCCOPY);
    form.onMouseDown = (_b, _s, x, y) => { void g.click(x, y, () => showRules(display, assets)); };
    form.onMouseMove = (_s, x, y) => {
      form.cursor = !g.busy && (inRect(RECTS.stop, x, y) || inRect(RECTS.rules, x, y) || (inRect(RECTS.hand, x, y))) ? 'pointer' : 'default';
    };
    quitFlow = () => { void g.pressStop(); };

    // FormShow: the board, then the player setup (modal); cancelling closes the game
    form.show();
    const settings = await showStartup(display, assets, memory);
    if (!settings || closed) { finish(); return; }
    g.initSettings(settings);
    g.redraw();
    // Timer1 (1 s): the first game step
    await sleep(1000);
    if (!closed) await g.run();
  })().catch((e) => {
    console.error(e);
    form.close(1);
  });

  form.showModal().then((code) => resolveResult(code));
  return { result, requestQuit: () => quitFlow() };
};

export default gbd;
