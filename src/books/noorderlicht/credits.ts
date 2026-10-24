// TfrmCredits (spec 1.8): CREDITS.BMP with a 35 px high strip (CREDITS1 + mask CREDITS2) scrolling through a band
// below the foreground frame (CREDITSV + mask CREDITSM) while CREDITS.WAV plays.

import { audio, MediaPlayer } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { SRCAND, SRCPAINT } from '../../engine/surface.ts';
import { Form, type Display } from '../../engine/vcl.ts';

const BAND_Y = 370;

export async function runCredits(display: Display, assets: Assets): Promise<void> {
  const [base, strip, stripMask, fg, fgMask, music] = await Promise.all([
    assets.image('CREDITS.BMP'), assets.image('CREDITS1.BMP'), assets.image('CREDITS2.BMP'),
    assets.image('CREDITSV.BMP'), assets.image('CREDITSM.BMP'), assets.sound('CREDITS.WAV').catch(() => null),
  ]);
  const f = new Form(display, 640, 480, 'frmCredits');
  f.center();
  const s = f.surface; // the buffer of the original
  s.bitBlt(0, 0, 640, 480, base, 0, 0);
  s.bitBlt(0, 0, 640, 480, fgMask, 0, 0, SRCAND);
  s.bitBlt(0, 0, 640, 480, fg, 0, 0, SRCPAINT);

  const player = new MediaPlayer();
  if (music) player.open(music);
  const stripW = strip.width, stripH = strip.height;
  let dx = 640; // the strip slides in from the right first,
  let sx = 0; // then its source window moves along
  let done = false;
  const stop = () => { player.close(); f.close(1); };
  f.cursor = 'default';
  f.onMouseDown = stop; // a click or key press stops the music and closes
  f.onKeyDown = stop;

  // CreditTimer (80 ms)
  f.timer(80, () => {
    // the original's "probe" (sndPlaySound NOSTOP) is true once the music has ended
    const running = audio.ctx.state === 'running'; // a locked AudioContext never finishes anything
    if (!player.playing || !running) {
      if (done) { stop(); return; }
      if (music && running) player.play(); // music over but the scroll is not: play again
    }
    if (stripW - sx < 350) { done = true; return; }
    const w = Math.min(640 - dx, stripW - sx);
    s.bitBlt(dx, BAND_Y, 640 - dx, stripH, base, dx, BAND_Y);
    s.bitBlt(dx, BAND_Y, w, stripH, stripMask, sx, 0, SRCAND);
    s.bitBlt(dx, BAND_Y, w, stripH, strip, sx, 0, SRCPAINT);
    s.bitBlt(dx, BAND_Y, 640 - dx, stripH, fgMask, dx, BAND_Y, SRCAND);
    s.bitBlt(dx, BAND_Y, 640 - dx, stripH, fg, dx, BAND_Y, SRCPAINT);
    if (dx < 1) sx += 10;
    else dx -= 10;
  });
  const closed = f.showModal();
  if (music) player.play();
  await closed;
  player.close();
}
