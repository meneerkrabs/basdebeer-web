// GSO Proeverij "Sjaak-o-maat" - Noorderlicht PLAY_GAME 4 (TGSOfrmMain). Rendering/input around GsoLogic.
//
// Mouse only (as in the original): click ingredient buttons (one per row), click the troll to taste.
// Next (right book) -> result 1, Prev (left book) -> result 2, Stop -> JA/NEE dialog (JA -> result 0).
// The Prev button is enabled unless the book passes params.prevEnabled = 0 (history empty).
// The original's synchronous sndPlaySound calls block its UI thread: clicks on the picture that arrive
// meanwhile are held back until the sound is done (the book buttons act at once, a small deviation).
import { audio, SND_NOSTOP } from '../../engine/audio.ts';
import { SRCCOPY, type Surface } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { allSounds, BOOK_RECTS, buttonImage, DISP, GsoLogic, trollImage, type Rect } from './gso-logic.ts';
import { askQuit } from './quit-dialog.ts';

export const title = 'Proeverij Sjaak-o-maat';

const inRect = (r: Rect, x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

const gso: Minigame = ({ display, assets, params }) => {
  const form = new Form(display, display.width, display.height, 'GSOfrmMain');
  form.center();
  const mode = params?.mode === 'D' ? 'D' : 'N';
  const prevEnabled = params?.prevEnabled === undefined || Number(params.prevEnabled) !== 0;
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let quitFlow: () => void = () => {};

  (async () => {
    const numbers = Array.from({ length: 24 }, (_, i) => i + 1);
    const names = ['GSONBACK.BMP', ...numbers.map(buttonImage), ...[1, 2, 3, 4].map(trollImage)];
    await assets.preload([...names, ...allSounds()]);
    const [back, ...rest] = await Promise.all(names.map((n) => assets.image(n))) as Surface[];
    const buttons = rest.slice(0, 24), trolls = rest.slice(24, 28);
    // decoded sounds up front: the sound calls must start at once (GSO001 vs. the GSO004 probe)
    const snd = new Map<string, AudioBuffer>();
    await Promise.all(allSounds().map((n) => assets.sound(n).then((b) => snd.set(n, b), (e) => console.warn(e))));

    let finished = false;
    let quitting = false;
    // synchronous sounds: UI-thread block emulation
    let blocked = 0;
    const deferred: (() => void)[] = [];
    const whenFree = (f: () => void) => (blocked > 0 ? deferred.push(f) : f());
    const flush = () => { while (blocked === 0 && deferred.length) deferred.shift()!(); };
    const sync = async (name: string, flags = 0): Promise<boolean> => {
      blocked++;
      try {
        return await audio.sndPlaySoundSync(snd.get(name) ?? null, flags);
      } finally {
        blocked--;
        flush();
      }
    };

    const timer = form.timer(10, () => g.tick(), false);
    const g: GsoLogic = new GsoLogic({ back, buttons, trolls }, {
      playAsync: (name) => { if (!finished) audio.sndPlaySound(snd.get(name) ?? null); },
      playSync: (name) => sync(name).then(() => undefined),
      playSyncNoStop: (name) => sync(name, SND_NOSTOP),
      setInterval: (ms) => timer.setInterval(ms),
      invalidate: () => form.invalidate(),
    });

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      timer.enabled = false;
      audio.stopSystemSound();
      form.close(code);
    };

    form.onPaint = () => form.surface.bitBlt(0, 0, display.width, display.height, g.work, 0, 0, SRCCOPY);

    quitFlow = async () => {
      if (quitting || finished) return;
      quitting = true;
      const yes = await askQuit(display, assets, 0, mode);
      quitting = false;
      if (yes) finish(0);
    };

    form.onMouseDown = (_b, _s, x, y) => {
      if (quitting || finished) return;
      if (prevEnabled && inRect(BOOK_RECTS.prev, x, y)) { finish(2); return; }
      if (inRect(BOOK_RECTS.next, x, y)) { finish(1); return; }
      if (inRect(BOOK_RECTS.stop, x, y)) { void quitFlow(); return; }
      if (inRect(DISP, x, y)) whenFree(() => { void g.click(x - DISP[0], y - DISP[1]); });
    };
    form.onMouseMove = (_s, x, y) => {
      form.cursor = (prevEnabled && inRect(BOOK_RECTS.prev, x, y)) || inRect(BOOK_RECTS.next, x, y) || inRect(BOOK_RECTS.stop, x, y)
        ? 'pointer' : 'default';
    };

    form.show();
    g.show();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code));
  return { result, requestQuit: () => quitFlow() };
};

export default gso;
