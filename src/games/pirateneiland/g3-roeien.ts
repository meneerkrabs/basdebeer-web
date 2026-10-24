// Roeispel -- Pirateneiland minigame 3 (TfrmG3 of BBOEK32.EXE). Rendering/input around RoeiLogic.
//
// Stop sign: the original form has no stop handling (FormCloseQuery only allows closing during play) and the
// book is frozen while a game runs (spec 6.1), so requestQuit() is a no-op.
import type { Assets } from '../../engine/assets.ts';
import { audio, MediaPlayer } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, type Surface } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { INTRO_MS, RoeiLogic } from './roei-logic.ts';
import { Urm } from './urm.ts';

export const title = 'Roeispel';

/**
 * MidiPlayer (MCI sequencer) stand-in: plays the MIDI looped through its pre-rendered .M4A twin; silently does
 * nothing when that isn't available (production assets have only the .MID). Wire a real MIDI synth here.
 */
export async function playMidi(assets: Assets, name: string): Promise<{ stop(): void }> {
  try {
    const buf = await assets.sound(name.replace(/\.MID$/i, '.M4A'));
    const mp = new MediaPlayer();
    mp.loop = true; // original: OnNotify re-Plays when the player has stopped
    mp.open(buf);
    mp.play();
    return { stop: () => mp.close() };
  } catch {
    return { stop: () => {} };
  }
}

const roeien: Minigame = ({ display, assets }) => {
  // FormCreate: bsNone, 640x480, poScreenCenter
  const form = new Form(display, 640, 480, 'frmG3');
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: RoeiLogic | null = null;
  let urm: Urm | null = null;
  let midi: Promise<{ stop(): void }> | null = null;

  (async () => {
    const [clean, boat, boatMask, island, islandMask, ...snd] = await Promise.all([
      assets.image('IG03.BMP'), assets.image('AG0301.BMP'), assets.image('AG0302.BMP'),
      assets.image('AG0303.BMP'), assets.image('AG0304.BMP'),
      ...['GAME003A', 'GAME002B', 'GE003001'].map((n) => assets.sound(`${n}.WAV`)),
    ]) as [Surface, Surface, Surface, Surface, Surface, ...AudioBuffer[]];
    const [instr, won, wormSpeech] = snd;
    assets.sound('GE003002.M4A').catch(() => {}); // warm the cache so the music starts right on cue
    const work = clean.clone(); // 0x1b8: working bitmap (IG03 + island + boat)
    const img = clean.clone(); // gImage's picture: what the player sees
    urm = await Urm.create(assets, img, () => form.invalidate());

    // FUN_004311a4: redraw the island and the boat.
    const draw = (x: number, y: number, frame: number, h: number) => {
      // AG0303/4 are 640x200 but the source rect (1,0)-(640,h) grows to h = progress + 25 = 309: the original's
      // StretchBlt reads past the bitmap there (undefined). Clamp: the island simply stops rising once fully shown.
      const hc = Math.min(h, island.height);
      // dest (1, 235-h)-(640, 234) is one row shorter than the source: StretchBlt squeezes by one row
      for (let pass = 0; pass < 2; pass++) { // the original draws the island twice (second pass is idempotent)
        work.stretchBlt(1, 235 - hc, 639, hc - 1, islandMask, 1, 0, 639, hc, SRCAND);
        work.stretchBlt(1, 235 - hc, 639, hc - 1, island, 1, 0, 639, hc, SRCPAINT);
      }
      // restore the clean sea around the boat (note: starts 10 rows below the boat's top, leaving a faint trail)
      work.bitBlt(x - 10, y + 10, 330, 160, clean, x - 10, y + 10);
      // the boat: 320x150 cell of the strip, source starts at row 1
      work.bitBlt(x, y, 320, 150, boatMask, frame * 320, 1, SRCAND);
      work.bitBlt(x, y, 320, 150, boat, frame * 320, 1, SRCPAINT);
      // publish boat area (+10 px margins) and island to the visible image
      img.bitBlt(x - 10, y, 340, 160, work, x - 10, y);
      img.bitBlt(1, 235 - hc, 639, hc - 1, work, 1, 235 - hc);
      form.invalidate();
    };

    const timer = form.timer(INTRO_MS, () => g.tick(), false);
    const g = new RoeiLogic({
      playSync: async (slot) => { await audio.sndPlaySoundSync([instr, won][slot]); },
      draw,
      setTimerInterval: (ms) => timer.setInterval(ms),
      wormEnter: () => urm!.enter(4, 500, 200),
      wormTalk: () => urm!.talk(wormSpeech),
      startMidi: () => { midi = playMidi(assets, 'GE003002.MID'); },
      wormExit: () => urm!.exit(1),
      finish: (code) => form.close(code),
    });
    logic = g;

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 480, img, 0, 0);
    form.onMouseDown = () => { void g.mouseDown(); };
    form.onClose = () => {
      // FormClose: stop the MIDI
      g.onClose();
      urm?.dispose();
      void midi?.then((m) => m.stop());
    };

    form.show();
    g.show(); // FormShow: draws the first boat frame, state 1, GameTimer on
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code || logic?.result || 2));
  return { result, requestQuit: () => { /* no stop sign in the original */ } };
};

export default roeien;
