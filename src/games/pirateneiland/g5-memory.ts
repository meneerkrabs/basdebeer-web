// MEMORYSPEL - Pirateneiland minigame 5 (TfrmG5): find the 8 pairs. Rendering/input around MemoryLogic.
//
// requestQuit(): no-op. The original game form is a borderless 640x480 stay-on-top window that covers the
// whole book, so the book's stop sign can never be clicked while it runs (spec 6.1/7.0); the only way out
// is the form closing itself (won = 2, 20 misses = 3).
import { audio, SND_NOSTOP } from '../../engine/audio.ts';
import { SRCCOPY, type Surface } from '../../engine/surface.ts';
import { Form, rnd } from '../../engine/vcl.ts';
import type { Minigame } from '../types.ts';
import { CELL, MemoryLogic, type SoundId } from './memory-logic.ts';

export const title = 'Memoryspel';

const SOUNDS: SoundId[] = [
  'GAME005A', 'GE005001', 'GE005002', 'GE005003', 'GE005004', 'GE005005', 'GE005006', 'GE005007', 'GE005008',
];

const memory: Minigame = ({ display, assets }) => {
  const form = new Form(display, 640, 480, 'frmG5'); // bsNone, 640x480, poScreenCenter (covers the screen)
  form.center();
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));

  (async () => {
    const [bg, ...rest] = (await Promise.all([
      assets.image('IG05.BMP'),
      ...Array.from({ length: 8 }, (_, i) => assets.image(`AG050${i + 1}.BMP`)),
      ...SOUNDS.map((n) => assets.sound(`${n}.WAV`)),
    ])) as [Surface, ...(Surface | AudioBuffer)[]];
    const strips = [null, ...(rest.slice(0, 8) as Surface[])];
    const snd = new Map<SoundId, AudioBuffer>(SOUNDS.map((n, i) => [n, rest[8 + i] as AudioBuffer]));
    const work = bg.clone(); // 0x1b8 working bitmap; `bg` (shared, untouched) is the clean 0x1b4 copy
    const cellRect = (x: number, y: number) => [CELL.left + (x - 1) * CELL.size, CELL.top + (y - 1) * CELL.size] as const;
    // FormCreate: all 16 cells show frame 0 (card back) of AG0501
    for (let x = 1; x <= 4; x++) for (let y = 1; y <= 4; y++) work.bitBlt(...cellRect(x, y), 100, 100, strips[1], 0, 0);

    // Synchronous sndPlaySound calls freeze the original's UI thread: input is queued meanwhile.
    let inTick = false;
    const deferred: (() => void)[] = [];
    const whenFree = (f: () => void) => (inTick ? deferred.push(f) : f());
    let px = 0, py = 0;

    const g = new MemoryLogic({
      playAsync: (id) => { audio.sndPlaySound(snd.get(id)!, 1); },
      playSync: async (id) => { await audio.sndPlaySoundSync(snd.get(id)!, SND_NOSTOP); },
      drawCard: (x, y, value, frame) => {
        work.bitBlt(...cellRect(x, y), 100, 100, strips[value], frame * 100, 0, SRCCOPY);
        form.invalidate();
      },
      clearCell: (x, y) => {
        work.bitBlt(...cellRect(x, y), 100, 100, bg, ...cellRect(x, y), SRCCOPY);
        form.invalidate();
      },
      random: (n) => rnd.random(n),
    });

    const timer = form.timer(50, async () => {
      inTick = true;
      try {
        await g.tick(px, py);
      } finally {
        inTick = false;
      }
      while (!inTick && deferred.length) deferred.shift()!();
      // The book polls the result byte and closes the form (FormClose then sees 2/3: no fail sound).
      if (g.result >= 2) form.close(g.result);
    }, false);

    form.onPaint = () => form.surface.bitBlt(0, 0, 640, 480, work, 0, 0);
    form.onMouseMove = (_s, x, y) => { px = x; py = y; };
    // The original evaluates the cell polled by the last 50 ms tick; we poll at the click itself
    // (touch screens have no hover, so the polled position would be stale).
    form.onMouseDown = (_b, _s, x, y) => {
      px = x; py = y;
      whenFree(() => { g.pollCursor(x, y); g.mouseDown(); });
    };

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

export default memory;
