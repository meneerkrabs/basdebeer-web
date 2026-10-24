// TAftitelScherm (spec 9.4): the credits scroll inside the AT001 picture while AT001.WAV plays.
import { MediaPlayer } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { SRCAND, SRCPAINT, Surface } from '../../engine/surface.ts';
import { Form, type Display } from '../../engine/vcl.ts';

export async function runCredits(display: Display, assets: Assets): Promise<void> {
  const [bg, mask, strip, music] = await Promise.all([
    assets.image('AT001.BMP'), assets.image('AT002.BMP'), assets.image('AT003.BMP'),
    assets.sound('AT001.WAV').catch(() => null),
  ]);
  const f = new Form(display, 640, 480, 'aftiteling');
  const tmp = new Surface(320, 380);
  const player = new MediaPlayer();
  let pos = 0;
  f.surface.fillRect(0, 0, 640, 480, 0);
  f.cursor = 'pointer';
  f.onMouseDown = () => f.close(1);
  f.onClose = () => player.close();
  const done = f.showModal();
  if (music) { player.open(music); player.play(); }
  f.timer(50, () => {
    if (music && !player.playing) { f.close(1); return; }
    if (pos === 0) { f.surface.bitBlt(0, 0, 640, 480, bg, 0, 0); pos = 150; }
    tmp.bitBlt(0, 80, 320, 300, strip, 0, pos);
    tmp.bitBlt(0, 80, 320, 300, mask, 160, 80, SRCAND);
    tmp.bitBlt(0, 80, 320, 300, bg, 160, 80, SRCPAINT);
    f.surface.bitBlt(160, 80, 320, 300, tmp, 0, 80);
    pos = Math.min(pos + 3, strip.height - 300);
  });
  await done;
}
