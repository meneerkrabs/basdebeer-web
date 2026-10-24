// The book's own animated mouse cursor (MouseTimerTimer_43b1a8, FUN_0043ad28; spec 5.7).
// The original composes a 32x32 sprite (SRCAND mask row y 32..64, SRCPAINT image row y 0..32) from the clean back buffer and
// draws it straight on the screen image at (pointer - (13, 9)), restoring the old spot from the back buffer.
// Here the Display recomposites the screen every frame, so the sprite is simply painted onto the finished screen by
// `Display.overlay` (no restore needed, and it follows the pointer at the display rate).
// The sheets (msMouse1 arrow, msMouth1 mouth, mstv1 bear head) are 64x64: frame A at x 0..32, frame B at x 32..64,
// alternating every 5 ticks of the MouseTimer.

import { SRCAND, SRCPAINT, type Surface } from '../../engine/surface.ts';

export class SpriteCursor {
  private sprites: Surface[] = [];
  private type = 1;
  /** +0x654: which frame is drawn (1 = A, 2 = B) and +0x658 the tick counter (starts at 5). */
  private frame = 1;
  private counter = 5;

  /** Order: 1 = arrow, 2 = mouth, 3 = bear head (SETMOUSETYPE). */
  setSprites(sheets: Surface[]) {
    this.sprites = sheets;
  }

  setType(n: number) {
    if (n >= 1 && n <= 3) this.type = n;
  }

  /** One MouseTimer tick: count down the A/B alternation. */
  tick() {
    this.counter--;
    if (this.counter === 0) {
      this.counter = 5;
      this.frame = this.frame === 1 ? 2 : 1;
    }
  }

  paint(screen: Surface, px: number, py: number) {
    const sheet = this.sprites[this.type - 1];
    if (!sheet) return;
    const x = px - 13, y = py - 9;
    const sx = this.frame === 1 ? 0 : 32;
    screen.bitBlt(x, y, 32, 32, sheet, sx, 32, SRCAND);
    screen.bitBlt(x, y, 32, 32, sheet, sx, 0, SRCPAINT);
  }
}
