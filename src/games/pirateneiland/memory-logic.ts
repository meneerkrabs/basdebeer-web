// MEMORYSPEL (Pirateneiland minigame 5, TfrmG5 in BBOEK32.EXE) - game logic, free of DOM code.
//
// 4x4 cards on IG05.BMP, 8 pairs. Click two cards: equal = both removed, different = both turn
// back. 20 misses = lost (result 3), 8 pairs = won (result 2). Addresses refer to BBOEK32.EXE:
// FormCreate @0x43264c, GameTimerTimer @0x432d68, FormMouseDown @0x433324, FormClose @0x4332b4,
// cell drawing @0x432c34 (restore background) and @0x432cbc (draw card frame).
// Offsets (obj+0x...) are fields of TfrmG5.

/** Sound objects of the form (FormCreate). Async ones use flags 1; all others flags 0x10
 * (SND_NOSTOP, synchronous: the original freezes until the WAV ends, and skips the sound when
 * another one is still playing). */
export type SoundId =
  | 'GAME005A' | 'GE005001' | 'GE005002' | 'GE005003' | 'GE005004'
  | 'GE005005' | 'GE005006' | 'GE005007' | 'GE005008';

export interface MemoryEffects {
  /** sndPlaySound(snd, SND_ASYNC|SND_MEMORY): GE005001 (click) and GE005002 (card closes). */
  playAsync(id: SoundId): void;
  /** sndPlaySound(snd, SND_NOSTOP|SND_MEMORY): blocks until the WAV ends (or returns at once if skipped). */
  playSync(id: SoundId): Promise<void>;
  /** @0x432cbc: copy frame `frame` (0 = back .. 10) of card strip `value` (1..8) into the cell (x,y = 1..4). */
  drawCard(x: number, y: number, value: number, frame: number): void;
  /** @0x432c34: copy the clean background over the cell (card removed). */
  clearCell(x: number, y: number): void;
  /** Delphi Random(n) (the original calls Randomize first each time). */
  random(n: number): number;
}

export const CELL = { left: 120, top: 40, size: 100 };

/** x87 FRNDINT/FISTP = round to nearest, ties to even (FUN_00402af8 = Round). */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v), d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Cursor -> cell as done at the end of every timer tick (@0x4331a0): outside
 * [120..520]x[40..440] gives (0,0); else Round((p-120)*0.01+0.5) per axis (banker's rounding, so
 * the pixel lines at offset 0/200/300/400 map oddly: offset 0 -> 0 (no cell), 200 -> 2, 300 -> 4).
 */
export function cellAt(px: number, py: number): [number, number] {
  if (px < 0x78 || px > 0x208 || py < 0x28 || py > 0x1b8) return [0, 0];
  return [roundHalfEven((px - 0x78) * 0.01 + 0.5), roundHalfEven((py - 0x28) * 0.01 + 0.5)];
}

export class MemoryLogic {
  /** obj+0x1b0: 1 = start countdown, 2 = playing (between ticks), 0 = inside a tick. */
  state = 0;
  private countdown = 10; // 0x1b1
  /** grid[x][y] (0x1f8): card value 1..8, 0 = removed. Index 0 is unused (0x2a / 0 in the original). */
  grid: number[][] = [];
  private anim: number[][] = []; // 0x278: 0 idle, 1 opening, 3 closing
  private frame: number[][] = []; // 0x238
  private phase = 0; // 0x2e4
  private c1: [number, number] = [0, 0]; // 0x2e8/0x2ec
  private c2: [number, number] = [0, 0]; // 0x2f0/0x2f4
  pairs = 0; // 0x2f8
  misses = 0; // 0x2fc
  private hinted = false; // 0x301
  /** 0x302: 0 creating, 1 playing, 2 won, 3 lost. */
  result = 0;
  /** 0x2d8/0x2dc: cell under the cursor as of the last tick. */
  private cx = 0;
  private cy = 0;

  private fx: MemoryEffects;

  constructor(fx: MemoryEffects) {
    this.fx = fx;
    // FormCreate: grid[x][y] = 1,1,2,2 / 3,3,4,4 / 5,5,6,6 / 7,7,8,8 (x = first index), then 100 random swaps.
    for (let i = 0; i < 5; i++) {
      this.grid.push([0, 0, 0, 0, 0]);
      this.anim.push([0, 0, 0, 0, 0]);
      this.frame.push([0, 0, 0, 0, 0]);
    }
    let v = 1;
    for (let x = 1; x <= 4; x++) for (let y = 1; y <= 4; y++) this.grid[x][y] = ((v++ - 1) >> 1) + 1;
    for (let n = 0; n < 100; n++) {
      const a = this.fx.random(4) + 1;
      const b = this.fx.random(4) + 1;
      const c = this.fx.random(4) + 1;
      const d = this.fx.random(4) + 1;
      const t = this.grid[a][b];
      this.grid[a][b] = this.grid[c][d];
      this.grid[c][d] = t;
    }
    this.result = 1;
  }

  /** FormShow @0x432c10: state 1 (the timer is switched on by the caller; interval 50 ms). */
  show() {
    this.state = 1;
  }

  /** Update the cell under the cursor (the original polls GetCursorPos at the end of every tick). */
  pollCursor(px: number, py: number) {
    [this.cx, this.cy] = cellAt(px, py);
  }

  /** FormMouseDown @0x433324 (any button; the position is the one polled by the last tick). */
  mouseDown() {
    const { cx, cy } = this;
    if (this.state !== 2 || cx <= 0 || cy <= 0) return;
    if (this.anim[cx][cy] === 0 && this.phase < 3 && this.grid[cx][cy] > 0) {
      if (this.phase === 0) {
        this.fx.playAsync('GE005001');
        this.c1 = [cx, cy];
        this.frame[cx][cy] = 1;
        this.anim[cx][cy] = 1;
        this.phase++;
      }
      if (this.phase === 2 && (cx !== this.c1[0] || cy !== this.c1[1])) {
        this.fx.playAsync('GE005001');
        this.c2 = [cx, cy];
        this.frame[cx][cy] = 1;
        this.anim[cx][cy] = 1;
        this.phase++;
      }
    }
  }

  /** GameTimerTimer @0x432d68 (50 ms). Awaits the synchronous sounds like the original blocks in them. */
  async tick(pointerX: number, pointerY: number) {
    const fx = this.fx;
    if (this.state === 1) {
      this.state = 0;
      if (--this.countdown === 0) {
        await fx.playSync('GAME005A'); // instructions, synchronous
        this.state = 2;
      } else this.state = 1;
    } else if (this.state === 2) {
      this.state = 0;
      const [x1, y1] = this.c1, [x2, y2] = this.c2;
      if (this.phase === 4 && this.grid[x1][y1] === this.grid[x2][y2]) {
        // match: optional comment GE005005/GE005006 (Random(3) < 2), cards vanish
        const r = fx.random(3);
        if (r < 2) await fx.playSync(r === 0 ? 'GE005005' : 'GE005006');
        this.grid[x1][y1] = 0;
        this.grid[x2][y2] = 0;
        fx.clearCell(x1, y1);
        fx.clearCell(x2, y2);
        this.phase = 0;
        this.pairs++;
        if (this.pairs > 7) this.result = 2; // no win sound; the book closes the form at its next tick
      }
      if (this.phase === 4) {
        // mismatch: optional GE005003/GE005004, then first card starts closing
        const r = fx.random(3);
        if (r < 2) await fx.playSync(r === 0 ? 'GE005003' : 'GE005004');
        this.anim[x1][y1] = 3;
        this.frame[x1][y1] = 10;
        this.phase = 5;
      }
      if (this.phase === 6) {
        this.anim[x2][y2] = 3;
        this.frame[x2][y2] = 10;
        this.phase = 7;
      }
      if (this.phase === 8) {
        this.phase = 0;
        this.misses++;
      }
      if (this.misses === 20) {
        await fx.playSync('GE005007');
        this.result = 3; // state stays 0: nothing happens any more
      } else {
        if (!this.hinted && (this.misses === 10 || this.pairs + this.misses === 15)) {
          await fx.playSync('GE005008'); // one-time hint
          this.hinted = true;
        }
        for (let x = 1; x <= 4; x++) {
          for (let y = 1; y <= 4; y++) {
            const a = this.anim[x][y];
            if ((this.grid[x][y] > 0 && a === 1) || a === 3) fx.drawCard(x, y, this.grid[x][y], this.frame[x][y]);
            if (this.anim[x][y] === 1 && ++this.frame[x][y] === 10) {
              // opening: frames 1..9 are drawn (frame 10 never is)
              this.anim[x][y] = 0;
              this.phase++;
            }
            if (this.anim[x][y] === 3) {
              if (this.frame[x][y] === 10) fx.playAsync('GE005002');
              if (--this.frame[x][y] === -1) {
                this.anim[x][y] = 0;
                this.phase++;
              }
            }
          }
        }
        this.pollCursor(pointerX, pointerY);
        this.state = 2;
      }
    }
  }
}
