// Kistenspel -- Pirateneiland minigame 2 (TfrmG2 of BBOEK32.EXE). Rendering/input around KistenLogic.
//
// Stop sign: the original form has no stop handling and the book is frozen while a game runs (spec 6.1),
// so requestQuit() is a no-op.
import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Surface } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { CHESTS, INTRO_MS, KistenLogic, STRIPS } from './kisten-logic.ts';
import { Urm } from './urm.ts';

export const title = 'Kistenspel';

const kisten: Minigame = ({ display, assets }) => {
  // FormCreate: bsNone, 640x480, poScreenCenter
  const form = new Form(display, 640, 480, 'frmG2');
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: KistenLogic | null = null;
  let urm: Urm | null = null;

  (async () => {
    const [ig02, ...rest] = await Promise.all([
      assets.image('IG02.BMP'),
      ...STRIPS.map((n) => assets.image(n)),
      ...['GAME002A', 'GAME002B', 'GE002001', 'GE002002', 'GAME001C', 'GAME002C'].map((n) => assets.sound(`${n}.WAV`)),
    ]) as [Surface, ...(Surface | AudioBuffer)[]];
    const strips = rest.slice(0, 4) as Surface[];
    // slot 2 of the original is never loaded; the array here is indexed like the original's
    const [instr, won, close, open, lost, wormSpeech] = rest.slice(4) as AudioBuffer[];
    const sounds: AudioBuffer[] = [instr, won, won, close, open, lost];
    const img = ig02.clone(); // the TImage picture everything is drawn into
    urm = await Urm.create(assets, img, () => form.invalidate());

    // The original blocks in sndPlaySound(sync): Windows keeps the mouse messages queued and delivers them
    // afterwards, so clicks made meanwhile are replayed once the sound has ended.
    let blocked = false;
    const deferred: (() => void)[] = [];
    const flush = () => { while (!blocked && deferred.length) deferred.shift()!(); };

    const timer = form.timer(INTRO_MS, () => g.tick(), false);
    const g = new KistenLogic({
      playSync: async (slot) => {
        blocked = true;
        try { await audio.sndPlaySoundSync(sounds[slot]); } finally {
          blocked = false;
          setTimeout(flush, 0); // after the caller's continuation (state := 2) has run
        }
      },
      playAsync: (slot) => { audio.sndPlaySound(sounds[slot], SND_ASYNC); },
      drawFrame: (chest, frame) => {
        const [l, t, r, b] = CHESTS[chest - 1];
        const w = r - l;
        img.bitBlt(l, t, w, b - t, strips[chest - 1], (frame - 1) * w, 0);
        form.invalidate();
      },
      setTimerInterval: (ms) => timer.setInterval(ms),
      wormEnter: () => urm!.enter(1, 350, 300),
      wormTalk: () => urm!.talk(wormSpeech),
      wormExit: async () => { await urm!.exit(1); urm!.dispose(); },
      finish: (code) => form.close(code),
    });
    logic = g;

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 480, img, 0, 0);
    form.onMouseDown = (_b, _s, x, y) => {
      if (blocked) deferred.push(() => g.mouseDown(x, y));
      else g.mouseDown(x, y);
    };
    form.onClose = () => { g.onClose(); urm?.dispose(); };

    form.show();
    g.show(); // FormShow: state 1, GameTimer on
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code || logic?.result || 2));
  return { result, requestQuit: () => { /* no stop sign in the original */ } };
};

export default kisten;
