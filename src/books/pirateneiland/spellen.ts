// "BerenSpellen" (BSPEL32.EXE, TfrmMain + TfrmBackGround): a standalone menu for the six Pirateneiland
// minigames. The games are the same six forms as in the book (TfrmG1..G6; compared against BBOEK32,
// every method has the same size), so the ports in src/games/pirateneiland are reused.
// Spec: docs/re/pirateneiland-engine.md section 9; layout reverse-engineered from decomp/BSPEL32.c
// (FormCreate_431098, GameTimerTimer_4304c0, FUN_0043011c bears, FUN_00430258 highlight,
// FUN_00430a98 start game, FormMouseDown_430db0).

import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { skipMedia, somethingToSkip } from '../../engine/skip.ts';
import { SRCAND, SRCPAINT, Surface } from '../../engine/surface.ts';
import { Form, type Display } from '../../engine/vcl.ts';
import { pirateneilandGames } from '../../games/pirateneiland/index.ts';
import type { MinigameRegistry } from '../../games/types.ts';
import { isGameSeen, loadSign, messageBox, ptInRect, QuitSign, type Rect } from './shared.ts';

/** Menu item n (1..6) -> {PLAY_GAME} name, which is also the key of the game registry. */
export const GAME_NAMES = ['MOTTENSPEL', 'KISTENSPEL', 'ROEISPEL', 'KOKOSSPEL', 'MEMORYSPEL', 'GROTSPEL'] as const;

/** Highlight rectangles of the six items (FUN_00430258): x 190..440. */
const BANDS: Rect[] = [
  [190, 123, 440, 166], [190, 178, 440, 221], [190, 234, 440, 275],
  [190, 283, 440, 325], [190, 332, 440, 375], [190, 386, 440, 431],
];
const EXIT_ICON: Rect = [600, 425, 630, 472];
/** JA / NEE of the sign (PtInRect semantics, FormMouseDown_430db0). */
const SIGN_RECTS = { ja: [255, 335, 304, 370] as Rect, nee: [324, 338, 385, 371] as Rect };
const BEAR_LEFT_X = 130, BEAR_RIGHT_X = 460;

/** The item under the cursor, by form-relative Y (GameTimerTimer_4304c0); undefined = keep the old one. */
function itemAtY(y: number): number | undefined {
  if (y < 0 || y >= 641) return undefined;
  if (y < 171) return 1;
  if (y < 226) return 2;
  if (y < 281) return 3;
  if (y < 328) return 4;
  if (y < 381) return 5;
  return 6;
}

export async function runBerenSpellen(display: Display, assets: Assets, registry: MinigameRegistry = pirateneilandGames): Promise<void> {
  const [bg, hi, bears, bearMask, sign, hover] = await Promise.all([
    assets.image('BG001.BMP'), assets.image('BG004.BMP'), assets.image('BG002.BMP'), assets.image('BG003.BMP'),
    loadSign(assets), assets.sound('MNU002.WAV').catch(() => null),
  ]);

  // TfrmBackGround: the 800x600 BORD frame, only visible on a screen larger than 640x480
  let frame: Form | null = null;
  let gameModalDepth = 0;
  if (display.width >= 800 && display.height >= 600) {
    const pieces = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((i) => assets.image(`BORD${i}S.BMP`).catch(() => null)));
    const [p1, p2, p3, p4, p5, p6, p7] = pieces;
    frame = new Form(display, 800, 600, 'background');
    frame.left = Math.round((display.width - 800) / 2);
    frame.top = Math.round((display.height - 600) / 2);
    const put = (p: Surface | null, x: number, y: number) => p && frame!.surface.bitBlt(x, y, p.width, p.height, p, 0, 0);
    put(p1, 0, 0); put(p2, 80, 0); put(p3, 720, 0); put(p4, 0, 60); put(p4, 720, 60);
    put(p5, 0, 540); put(p6, 80, 540); put(p7, 720, 540);
    frame.show();
  }

  const form = new Form(display, 640, 480, 'spellen');
  form.center();
  const work = form.surface; // the original's second 640x480 bitmap (1b4); BG001 itself stays clean
  work.bitBlt(0, 0, 640, 480, bg, 0, 0);

  return new Promise<void>((resolve) => {
    const state = { item: 1, shown: 0, count: 0, prevY: 100, hoverExit: false, busy: false, exitAsked: false };
    const quit = new QuitSign(work, sign.yn, sign.mask, sign.question, SIGN_RECTS);

    const drawBear = (x: number, y: number, frame: number) => {
      const sx = (frame - 1) * 50;
      work.bitBlt(x, state.prevY, 50, 50, bg, x, state.prevY);
      work.bitBlt(x, y, 50, 50, bearMask, sx, 0, SRCAND);
      work.bitBlt(x, y, 50, 50, bears, sx, 0, SRCPAINT);
    };

    const setHighlight = (item: number, old: number) => {
      if (old >= 1) { const r = BANDS[old - 1]; work.bitBlt(r[0], r[1], r[2] - r[0], r[3] - r[1], bg, r[0], r[1]); }
      if (item >= 1) { const r = BANDS[item - 1]; work.bitBlt(r[0], r[1], r[2] - r[0], r[3] - r[1], hi, r[0], r[1]); }
    };

    const tick = () => {
      if (state.busy) return;
      const y = display.mouseY - form.top;
      const it = itemAtY(y);
      if (it !== undefined) state.item = it;
      // the two spinning bear heads follow the cursor (FUN_0043011c)
      const by = Math.min(385, Math.max(110, y - 25));
      state.count = state.count + 1 > 19 ? 1 : state.count + 1;
      drawBear(BEAR_LEFT_X, by, state.count);
      drawBear(BEAR_RIGHT_X, by, Math.abs(state.count - 20));
      state.prevY = by;
      if (!quit.active) {
        if (state.item !== state.shown) { setHighlight(state.item, state.shown); state.shown = state.item; }
        return;
      }
      const r = quit.tick();
      if (r === 'yes' && state.exitAsked) { form.close(); frame?.hide(); resolve(); }
      else if (r) state.exitAsked = false;
    };
    form.timer(50, tick);

    const startGame = async (n: number) => {
      if (!isGameSeen(n)) {
        await messageBox(display, 'BerenSpellen', 'Je mag dit spel nog niet spelen. Je moet het eerst in het BerenBoek gespeeld hebben');
        return;
      }
      const load = registry[GAME_NAMES[n - 1]];
      let mod: Awaited<ReturnType<NonNullable<typeof load>>> | null = null;
      try { mod = load ? await load() : null; } catch (e) { console.warn(`spel ${GAME_NAMES[n - 1]} kan niet worden geladen`, e); }
      if (!mod) {
        await messageBox(display, 'BerenSpellen', 'Dit spel is in deze versie nog niet beschikbaar.');
        return;
      }
      state.busy = true; // the original disables its timer while the game runs
      form.hide();
      gameModalDepth = display.modalDepth;
      const session = mod.default({ display, assets });
      // "Sla over" (not in the original): spoken instructions first, then the game itself (back to the menu)
      let introHeard = false, introDone = false;
      const gameStart = performance.now();
      display.skipProvider = () => {
        if (!introDone) {
          if (somethingToSkip()) introHeard = true;
          else if (introHeard || performance.now() - gameStart > 4000) introDone = true;
          if (!introDone) return { label: 'Uitleg overslaan ⏭', action: () => { skipMedia(); introDone = true; } };
        }
        return { label: 'Spel overslaan ⏭', action: () => { skipMedia(); display.closeModalsFrom(gameModalDepth, 2); } };
      };
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && session.requestQuit?.();
      addEventListener('keydown', onKey);
      try { await session.result; } finally { removeEventListener('keydown', onKey); display.skipProvider = null; }
      // the result (won, lost, closed) is ignored: back to the menu
      form.show();
      state.busy = false;
    };

    form.onMouseMove = (_s, x, y) => {
      if (quit.active || state.busy) return;
      if (ptInRect(EXIT_ICON, x, y)) {
        if (!state.hoverExit) { state.hoverExit = true; audio.sndPlaySound(hover, SND_ASYNC); }
      } else if (state.hoverExit) {
        audio.sndPlaySound(null);
        state.hoverExit = false;
      }
    };

    form.onMouseDown = (_b, _s, x, y) => {
      if (state.busy) return;
      if (quit.click(x, y)) return; // JA / NEE: the sign slides away, then 'yes' ends the program
      if (quit.active) return;
      if (x > 190 && x < 440) void startGame(state.item);
      if (ptInRect(EXIT_ICON, x, y)) {
        state.exitAsked = true;
        quit.open();
      }
    };

    form.show();
  });
}
