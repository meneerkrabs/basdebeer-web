// GIS IJsschotsspringen (variant 0, PLAY_GAME 7) / Bergklimmen (variant 1, PLAY_GAME 9) - TGISfrmMain.
// UI around GisLogic. Mouse only in the original, so no extra touch handling is needed (a tap is a click).
// Prev (left book) -> result 2, Stop -> JA/NEE dialog (JA -> result 0), reaching the goal -> result 1.
// The Prev button is enabled unless the book passes params.prevEnabled = 0 (history empty).
import { audio, SND_ASYNC } from '../../engine/audio.ts';
import { SRCCOPY } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { DISP, GisLogic, type GisSound } from './gis-logic.ts';
import { askQuit } from './quit-dialog.ts';

export const title = 'IJsschotsspringen / Bergklimmen';

const PREV_RECT = [90, 410, 200, 470];
const STOP_RECT = [145, 495, 260, 600];
const inRect = (r: number[], x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/** variant 0 = IJsschotsspringen (GISMAIN), 1 = Bergklimmen (GBKMAIN). */
export function gisGame(variant: 0 | 1): Minigame {
  return ({ display, assets, params }) => {
    const form = new Form(display, display.width, display.height, 'GISfrmMain');
    form.center();
    const mode = params?.mode === 'D' ? 'D' : 'N';
    const prevEnabled = params?.prevEnabled === undefined || Number(params.prevEnabled) !== 0;
    let resolveResult!: (code: number) => void;
    const result = new Promise<number>((r) => (resolveResult = r));
    let quitFlow: () => void = () => {};

    (async () => {
      const sounds: GisSound[] = ['GIS001', 'GIS002', 'GIS003', 'GIS004', 'GKS001'];
      const [back, main, bas, basMask, ...bufs] = await Promise.all([
        assets.image('GISBACK.BMP'), assets.image(variant === 0 ? 'GISMAIN.BMP' : 'GBKMAIN.BMP'),
        assets.image('GISB001.BMP'), assets.image('GISB002.BMP'),
        ...sounds.map((s) => assets.sound(`${s}.WAV`)),
      ]);
      const snd = new Map<GisSound, AudioBuffer>(sounds.map((s, i) => [s, bufs[i] as unknown as AudioBuffer]));

      let quitting = false, finished = false;
      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        form.close(code);
      };

      const g = new GisLogic(variant, { back, main, bas, basMask }, {
        playAsync: (id) => { audio.sndPlaySound(snd.get(id)!, SND_ASYNC); },
        playSync: (id) => audio.sndPlaySoundSync(snd.get(id)!, 0).then(() => undefined),
        update: () => form.repaint(),
        invalidate: () => form.invalidate(),
      });

      form.onPaint = () => form.surface.bitBlt(0, 0, display.width, display.height, g.work, 0, 0, SRCCOPY);

      quitFlow = async () => {
        if (quitting || g.busy || finished) return;
        quitting = true;
        const yes = await askQuit(display, assets, 0, mode);
        quitting = false;
        if (yes) { g.result = 0; g.running = false; finish(0); }
      };

      form.onMouseDown = async (_b, _s, x, y) => {
        if (g.busy || quitting) return;
        if (prevEnabled && inRect(PREV_RECT, x, y)) { g.result = 2; finish(2); return; }
        if (inRect(STOP_RECT, x, y)) { quitFlow(); return; }
        if (x >= DISP.left && x < DISP.right && y >= DISP.top && y < DISP.bottom) {
          await g.click(x - DISP.left, y - DISP.top);
          if (!g.running) finish(g.result);
        }
      };
      form.onMouseMove = (_s, x, y) => {
        const inDisp = x >= DISP.left && x < DISP.right && y >= DISP.top && y < DISP.bottom;
        form.cursor = inDisp
          ? (g.hover(x - DISP.left, y - DISP.top) ? 'pointer' : 'default')
          : (prevEnabled && inRect(PREV_RECT, x, y)) || inRect(STOP_RECT, x, y) ? 'pointer' : 'default';
      };

      g.show();
      form.show();
    })().catch((e) => {
      console.error(e);
      form.close(2);
    });

    form.showModal().then((code) => resolveResult(code));
    return { result, requestQuit: () => quitFlow() };
  };
}

export default gisGame(0);
