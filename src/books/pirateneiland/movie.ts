// The movie window (TMovieForm, FUN_0042caf0/42ce98/42ca58/42ca7c; spec 6.2): a borderless 640x480 black form with a background
// picture and the AVI (native 240x180) at a fixed spot. A 100 ms timer closes it when the AVI has ended, a click on the
// "verder gaan" hot-spot closes it at once.

import type { Assets } from '../../engine/assets.ts';
import { Avi, playAvi } from '../../engine/avi.ts';
import { onSkip } from '../../engine/skip.ts';
import { Form, type Display } from '../../engine/vcl.ts';
import type { Rect } from './textbox.ts';

interface MovieDef { background: string; avi: string; at: [number, number]; /** strict inequalities of the original */ skip: Rect }

const MOVIES: Record<number, MovieDef> = {
  1: { background: 'BM001.BMP', avi: 'BB001.AVI', at: [200, 170], skip: [515, 218, 565, 256] }, // intro
  2: { background: 'BM002.BMP', avi: 'BB002.AVI', at: [200, 150], skip: [570, 415, 610, 460] }, // 042, the party
  3: { background: 'BM003.BMP', avi: 'BB003.AVI', at: [200, 150], skip: [570, 415, 610, 460] }, // 069, the end
};

/** Plays movie `n` (1 = intro, 2, 3). Resolves when it ended or was skipped. */
export async function playMovieWindow(display: Display, assets: Assets, n: number): Promise<void> {
  const def = MOVIES[n];
  if (!def) return;
  // "Sla over" (not in the original): ends the movie like the "verder gaan" hot-spot, also while it is still loading
  let skipped = false, endNow = () => { skipped = true; };
  const unskip = onSkip(() => endNow());
  try {
    await run(display, assets, def, () => skipped, (f) => { endNow = () => f.close(1); });
  } finally {
    unskip();
  }
}

async function run(display: Display, assets: Assets, def: MovieDef, wasSkipped: () => boolean, setEnd: (f: Form) => void): Promise<void> {
  const [bg, avi] = await Promise.all([
    assets.image(def.background),
    assets.raw(def.avi).then((b) => new Avi(b)),
  ]).catch((e) => { console.error('Het filmpje kan niet worden afgespeeld', e); return [null, null] as const; });
  if (!bg || !avi || wasSkipped()) return;
  const f = new Form(display, 640, 480, 'frmMovie');
  setEnd(f);
  f.surface.bitBlt(0, 0, 640, 480, bg, 0, 0);
  const hot = (x: number, y: number) => x > def.skip[0] && x < def.skip[2] && y > def.skip[1] && y < def.skip[3];
  const done = f.showModal();
  const player = playAvi(avi, f.surface, def.at[0], def.at[1]);
  f.onMouseDown = (_b, _s, x, y) => { if (hot(x, y)) f.close(1); };
  f.onMouseMove = (_s, x, y) => { f.cursor = hot(x, y) ? 'pointer' : 'default'; };
  f.onClose = () => player.stop();
  f.timer(100, () => { if (!player.playing) f.close(1); });
  await done;
}
