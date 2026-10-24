// GSB Sneeuwballengevecht - Noorderlicht PLAY_GAME 1 (TGSBfrmMain). Rendering/input around GsbLogic.
//
// Keys: Up = jump (hold = higher), Down = duck, like the original. Touch addition (coarse pointers only,
// not in the original): press in the upper half of the picture = Up, lower half = Down, release = key up.
// Prev (left book) -> result 2, Stop -> JA/NEE dialog (JA -> result 0), reaching Tim -> result 1.
// The Prev button is enabled unless the book passes params.prevEnabled = 0 (history empty).
import { audio, SND_ASYNC, SND_NOSTOP } from '../../engine/audio.ts';
import { playMidi, type MidiHandle } from '../../engine/midi.ts';
import { SRCCOPY, type Surface } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { GSB_SOUNDS, GsbLogic, type GsbSound, type SpriteSet } from './gsb-logic.ts';
import { askQuit } from './quit-dialog.ts';

export const title = 'Sneeuwballengevecht';

// SysPrevRect / SysStopRect of the 800x600 layout (spec 4.1)
const PREV_RECT = [90, 410, 200, 470];
const STOP_RECT = [145, 495, 260, 600];
const inRect = (r: number[], x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

const gsb: Minigame = ({ display, assets, params }) => {
  const form = new Form(display, display.width, display.height, 'GSBfrmMain');
  form.center();
  const mode = params?.mode === 'D' ? 'D' : 'N';
  const prevEnabled = params?.prevEnabled === undefined || Number(params.prevEnabled) !== 0;
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let quitFlow: () => void = () => {};

  (async () => {
    const img = (n: string) => assets.image(n);
    const pair = async (n: string): Promise<SpriteSet> => ({ sprite: await img(`${n}N.BMP`), mask: await img(`${n}M.BMP`) });
    const [back, sky, ground, trees1, trees2, ball, check, ...rest] = await Promise.all([
      img('GSBBACK.BMP'), img('GSB009.BMP'), img('GSB010.BMP'), pair('GSB001'), pair('GSB002'), pair('GSB011'), pair('CHECK'),
      ...['GSB003', 'GSB004', 'GSB005', 'GSB006', 'GSB007', 'GSB008'].map(pair),
      ...GSB_SOUNDS.map((s) => assets.sound(`${s}.WAV`)),
    ]) as [Surface, Surface, Surface, SpriteSet, SpriteSet, SpriteSet, SpriteSet, ...(SpriteSet | AudioBuffer)[]];
    const bas = rest.slice(0, 3) as SpriteSet[], tim = rest.slice(3, 6) as SpriteSet[];
    const snd = new Map<GsbSound, AudioBuffer>(GSB_SOUNDS.map((s, i) => [s, rest[6 + i] as AudioBuffer]));
    let midiData: ArrayBuffer | null = null;
    try { midiData = await assets.raw('GSB001.MID'); } catch (e) { console.warn(e); }
    let midi: MidiHandle | null = null;

    // Synchronous sndPlaySound calls freeze the original's UI thread: input waits until the tick is done.
    let inTick = false;
    const deferred: (() => void)[] = [];
    const whenFree = (f: () => void) => (inTick ? deferred.push(f) : f());
    let quitting = false;

    const g = new GsbLogic(
      { back, sky, ground, trees1, trees2, bas, tim, ball, check },
      {
        playSync: (id) => audio.sndPlaySoundSync(snd.get(id)!, 0).then(() => undefined),
        playAsyncNoStop: (id) => { audio.sndPlaySound(snd.get(id)!, SND_ASYNC | SND_NOSTOP); },
        update: () => form.repaint(),
        startMusic: () => {
          if (!midiData) return;
          void playMidi(midiData.slice(0), { loop: true }).then((h) => {
            if (!form.visible) h.stop();
            else midi = h;
          });
        },
        stopMusic: () => { midi?.stop(); midi = null; },
        random: (n) => rnd.random(n),
        randomize: () => rnd.randomize(),
        invalidate: () => form.invalidate(),
      },
    );

    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      timer.enabled = false;
      audio.stopSystemSound(); // cut a narration that is still playing
      form.close(code);
    };

    const timer = form.timer(75, async () => {
      inTick = true;
      try {
        await g.tick();
      } finally {
        inTick = false;
      }
      if (!g.running) { finish(g.result); return; }
      while (!inTick && deferred.length) deferred.shift()!();
    }, false);

    form.onPaint = () => form.surface.bitBlt(0, 0, display.width, display.height, g.work, 0, 0, SRCCOPY);

    quitFlow = async () => {
      if (quitting || finished) return;
      quitting = true;
      timer.enabled = false;
      const yes = await askQuit(display, assets, 0, mode);
      quitting = false;
      if (yes) { g.result = 0; g.running = false; finish(0); } else if (!finished) timer.enabled = true;
    };

    const keyOf = (k: string) => (k === 'ArrowUp' ? 'Up' : k === 'ArrowDown' ? 'Down' : null);
    form.onKeyDown = (k) => {
      const key = keyOf(k);
      if (key && !quitting) whenFree(() => g.keyDown(key));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = keyOf(e.key);
      if (key && !quitting) whenFree(() => g.keyUp(key));
    };
    addEventListener('keyup', onKeyUp);

    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    let touchKey: 'Up' | 'Down' | null = null;
    form.onMouseDown = (_b, _s, x, y) => {
      // Prev/Stop also work during the intro narration (the original froze for its 30 s: deliberate deviation)
      if (prevEnabled && inRect(PREV_RECT, x, y)) { finish(2); return; }
      if (inRect(STOP_RECT, x, y)) { quitFlow(); return; }
      if (coarse && x >= 123 && x < 683 && y >= 85 && y < 365 && !quitting) {
        touchKey = y < 225 ? 'Up' : 'Down';
        const k = touchKey;
        whenFree(() => g.keyDown(k));
      }
    };
    form.onMouseUp = () => {
      if (touchKey) {
        const k = touchKey;
        touchKey = null;
        whenFree(() => g.keyUp(k));
      }
    };
    form.onMouseMove = (_s, x, y) => {
      form.cursor = (prevEnabled && inRect(PREV_RECT, x, y)) || inRect(STOP_RECT, x, y) ? 'pointer' : 'default';
    };
    form.onClose = () => {
      removeEventListener('keyup', onKeyUp);
      midi?.stop();
      midi = null;
    };

    g.show();
    form.show();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code));
  return { result, requestQuit: () => quitFlow() };
};

export default gsb;
