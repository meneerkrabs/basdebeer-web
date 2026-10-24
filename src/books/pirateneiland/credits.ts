// The outro screen shown when the book closes (FormClose_437ea8 -> FUN_0042c688/42c974, timer 42c4cc; spec 1.2):
// AT001 (640x480 frame) with AT001.WAV, and the credits strip AT003 scrolling inside the window (160,80)-(480,380).
import { MediaPlayer } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { SRCAND, SRCPAINT, Surface } from '../../engine/surface.ts';
import { Form, type Display } from '../../engine/vcl.ts';

export async function runCredits(display: Display, assets: Assets): Promise<void> {
  const [frame, mask, strip, music] = await Promise.all([
    assets.image('AT001.BMP'), assets.image('AT002.BMP'), assets.image('AT003.BMP'),
    assets.sound('AT001.WAV').catch(() => null),
  ]).catch((e) => { console.error('aftiteling kan niet worden getoond', e); return [null, null, null, null] as const; });
  if (!frame || !mask || !strip) return;
  const f = new Form(display, 640, 480, 'frmAftiteling');
  const tmp = new Surface(320, 300);
  const player = new MediaPlayer();
  f.surface.bitBlt(0, 0, 640, 480, frame, 0, 0);
  f.cursor = 'pointer';
  f.onMouseDown = () => f.close(1); // a click anywhere ends it
  f.onClose = () => player.close();
  const done = f.showModal();
  if (music) { player.open(music); player.play(); }
  let pos = 150; // starts at 150, +3 per 50 ms tick, clamped to 2656-300
  let started = false;
  f.timer(50, () => {
    // ends when AT001.WAV is no longer playing
    if (started && music && !player.playing) { f.close(1); return; }
    started = true;
    tmp.bitBlt(0, 0, 320, 300, strip, 0, pos);
    tmp.bitBlt(0, 0, 320, 300, mask, 160, 80, SRCAND);
    tmp.bitBlt(0, 0, 320, 300, frame, 160, 80, SRCPAINT);
    f.surface.bitBlt(160, 80, 320, 300, tmp, 0, 0);
    pos = Math.min(pos + 3, strip.height - 300);
  });
  await done;
}
