// Rongo Rongo — Paaseiland minigame 1 (TfrmG1). Rendering/input around RongoLogic.
import { audio } from '../../engine/audio.ts';
import { SRCAND, SRCPAINT, type Surface } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { RongoLogic, St } from './rongo-logic.ts';

export const title = 'Rongo Rongo';

// dgPuzzle: Left 47, Top 24, 3x3 cells of 96x89 with a 1px black gap (FormCreate @0x433e58)
const GX = 47, GY = 24, CW = 96, CH = 89, GAP = 1;
const MOUTH = { x: 421, y: 1, w: 135, h: 207 }; // Rect(0x1a5, 1, 0x22c, 0xd0)
const SIGN = { x: 420, bottom: 320, w: 196, h: 179 };

const rongoRongo: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 320, 'frmG1');
  form.center(); // Position = poScreenCenter
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let logic: RongoLogic | null = null;

  (async () => {
    const [bgOrig, tiles, mouth, sign, signMask, question, ...sounds] = await Promise.all([
      assets.image('I007.BMP'), assets.image('G00701.BMP'), assets.image('A00701.BMP'),
      assets.image('YN1.BMP'), assets.image('YN1M.BMP'), assets.sound('YN001.WAV'),
      ...Array.from({ length: 22 }, (_, i) => assets.sound(`GE07${String(i + 1).padStart(2, '0')}.WAV`)),
    ]) as [Surface, Surface, Surface, Surface, Surface, AudioBuffer, ...AudioBuffer[]];
    const bg = bgOrig.clone(); // the original draws Rongo's mouth frames into its background bitmap
    let current = { col: 0, row: 0 }; // the grid's focused cell (for keyboard play)

    const timer = form.timer(100, () => g.tick(), false);
    const g = new RongoLogic({
      playSound: (i, flags) => audio.sndPlaySound(i === null ? null : sounds[i], flags),
      playQuestion: () => audio.sndPlaySound(question),
      random: (n) => rnd.random(n),
      mouth: (f) => bg.bitBlt(MOUTH.x, MOUTH.y, MOUTH.w, MOUTH.h, mouth, (f - 1) * MOUTH.w, 0),
      repaint: () => form.invalidate(),
      setTimerInterval: (ms) => timer.setInterval(ms),
      close: () => form.close(g.exitCode || 2),
    });
    logic = g;

    form.onPaint = () => {
      const s = form.surface;
      s.bitBlt(0, 0, 640, 320, bg, 0, 0);
      if (g.signStep > 0) {
        const h = g.signStep * 12;
        s.bitBlt(SIGN.x, SIGN.bottom - h, SIGN.w, h, signMask, 0, 0, SRCAND);
        s.bitBlt(SIGN.x, SIGN.bottom - h, SIGN.w, h, sign, 0, 0, SRCPAINT);
      }
      s.fillRect(GX, GY, GX + 3 * CW + 2 * GAP, GY + 3 * CH + 2 * GAP, 0);
      for (let idx = 0; idx < 9; idx++) {
        const x = GX + (idx % 3) * (CW + GAP), y = GY + Math.floor(idx / 3) * (CH + GAP);
        if (idx === g.empty) continue;
        const t = g.board[idx];
        s.bitBlt(x, y, CW, CH, tiles, (t % 3) * (CW + GAP), Math.floor(t / 3) * (CH + GAP));
        if (idx === g.speakIdx) s.frameRect(x, y, x + CW, y + CH, 0x0000ff);
      }
    };

    const clickCell = (col: number, row: number) => {
      if (g.selectCell(col, row)) current = { col, row };
    };
    form.onMouseDown = (_b, _s, x, y) => {
      const gx = x - GX, gy = y - GY;
      if (gx >= 0 && gy >= 0 && gx < 3 * (CW + GAP) - GAP && gy < 3 * (CH + GAP) - GAP) {
        // the grid control takes the click; the form's OnMouseDown doesn't see it
        clickCell(Math.floor(gx / (CW + GAP)), Math.floor(gy / (CH + GAP)));
      } else g.mouseDown(x, y);
    };
    form.onMouseMove = (_s, x, y) => {
      form.cursor = (g.playing && x > 400 && x < 565 && g.state !== St.SignWait) || (x >= GX && x < GX + 290 && y >= GY && y < GY + 269) ? 'pointer' : 'default';
    };
    form.onKeyDown = (key) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
      if (!d) return;
      const col = current.col + d[0], row = current.row + d[1];
      if (col >= 0 && col < 3 && row >= 0 && row < 3) clickCell(col, row);
    };
    form.onClose = () => g.onClose();

    form.show();
    g.start();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then(() => resolveResult(logic?.exitCode || 2));
  return { result, requestQuit: () => logic?.requestQuit() };
};

export default rongoRongo;
