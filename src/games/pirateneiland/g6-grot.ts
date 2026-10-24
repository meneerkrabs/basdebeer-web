// GROTSPEL - Pirateneiland minigame 6 (TfrmG6): cave runner. Rendering/input around GrotLogic.
//
// Mouse: left button held = duck, right button = jump (original mapping). On touch-first devices
// (pointer: coarse) a right button does not exist, so there a quick tap (< 250 ms) = jump and a
// longer press = duck from the 250 ms mark on (addition, not in the original).
//
// requestQuit(): no-op. The original game form is a borderless 640x480 stay-on-top window that covers the
// whole book, so the book's stop sign can never be clicked while it runs (spec 6.1/7.0).
import { audio, SND_NOSTOP } from '../../engine/audio.ts';
import type { Surface } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { GrotLogic, SOUND_IDS, type SoundId } from './grot-logic.ts';

export const title = 'Grotspel';

const LONG_PRESS_MS = 250;

const grot: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 480, 'frmG6'); // bsNone, 640x480, poScreenCenter (covers the screen)
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));

  (async () => {
    const img = (n: string) => assets.image(n);
    const [title0, bas, basM, bee, beeM, boulder, boulderM, sparks, sparksM, ...rest] = (await Promise.all([
      img('IG0700.BMP'), img('ag0705.bmp'), img('ag0705m.bmp'),
      img('AG0703.bmp'), img('AG0703M.bmp'), img('AG0702.bmp'), img('AG0702M.bmp'), img('AG0704.bmp'), img('AG0704M.bmp'),
      ...[1, 2, 3, 4].flatMap((n) => ['A', 'B', 'C'].map((l) => img(`IG070${n}${l}.BMP`))),
      ...SOUND_IDS.map((s) => assets.sound(`${s}.WAV`)),
    ])) as Surface[];
    const layers: Record<number, { a: Surface; b: Surface; c: Surface }> = {};
    for (let n = 1; n <= 4; n++) layers[n] = { a: rest[(n - 1) * 3], b: rest[(n - 1) * 3 + 1], c: rest[(n - 1) * 3 + 2] };
    const snd = new Map<SoundId, AudioBuffer>(
      SOUND_IDS.map((s, i) => [s, rest[12 + i] as unknown as AudioBuffer]),
    );

    // Synchronous sndPlaySound calls freeze the original's UI thread: input is queued meanwhile.
    let inTick = false;
    const deferred: (() => void)[] = [];
    const whenFree = (f: () => void) => (inTick ? deferred.push(f) : f());

    const g = new GrotLogic(
      {
        title: title0,
        layers,
        bee: { sprite: bee, mask: beeM },
        boulder: { sprite: boulder, mask: boulderM },
        sparks: { sprite: sparks, mask: sparksM },
        bas: { sprite: bas, mask: basM },
      },
      {
        playSync: async (id) => { await audio.sndPlaySoundSync(snd.get(id)!, SND_NOSTOP); },
        invalidate: () => form.invalidate(),
        setTimerInterval: (ms) => timer.setInterval(ms),
      },
    );

    const timer = form.timer(50, async () => {
      inTick = true;
      try {
        await g.tick();
      } finally {
        inTick = false;
      }
      while (!inTick && deferred.length) deferred.shift()!();
      // The book polls the result byte and closes the form (FormClose then sees 2/3: no fail sound).
      if (g.result >= 2) form.close(g.result);
    }, false);

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 480, g.work, 0, 0);

    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let ducking = false;
    form.onMouseDown = (b) => {
      if (!coarse) {
        if (b === 'left' || b === 'right') whenFree(() => g.mouseDown(b === 'left' ? 0 : 1));
        return;
      }
      if (b !== 'left') return;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        ducking = true;
        whenFree(() => g.mouseDown(0));
      }, LONG_PRESS_MS);
    };
    form.onMouseUp = (b) => {
      if (!coarse) {
        if (b === 'left') whenFree(() => g.mouseUp(0));
        return;
      }
      if (b !== 'left') return;
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
        whenFree(() => g.mouseDown(1)); // short tap = jump
      } else if (ducking) {
        ducking = false;
        whenFree(() => g.mouseUp(0));
      }
    };
    form.onClose = () => { if (pressTimer) clearTimeout(pressTimer); };

    g.show();
    form.show();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code === 3 ? 3 : 2));
  return { result, requestQuit() { /* no stop sign in the original, see header */ } };
};

export default grot;
