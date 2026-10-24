// TfrmSplash (spec 1.2): MWSPLASH.BMP (286x412) with MWSPLASH.WAV until the sound has ended or the user clicks.

import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { Form, type Display } from '../../engine/vcl.ts';

export async function runSplash(display: Display, assets: Assets): Promise<void> {
  const [img, wav] = await Promise.all([assets.image('MWSPLASH.BMP'), assets.sound('MWSPLASH.WAV').catch(() => null)]);
  const f = new Form(display, img.width, img.height, 'frmSplash');
  f.center();
  f.surface.bitBlt(0, 0, img.width, img.height, img, 0, 0);
  // a press stops the sound; the next SplashTimer tick then finds the channel free and ends the splash
  const stop = () => audio.sndPlaySound(null);
  f.onMouseDown = stop;
  f.onKeyDown = stop;
  let ticks = 0;
  // SplashTimer (100 ms): the splash ends once no sound is playing (sndPlaySound(SE000000, NOSTOP) succeeds)
  f.timer(100, () => {
    ticks++;
    // an AudioContext that was never unlocked would keep the sound "playing" forever
    if (!audio.busy || (audio.ctx.state !== 'running' && ticks > 20)) f.close(1);
  });
  const done = f.showModal();
  if (wav) audio.sndPlaySound(wav, SND_ASYNC);
  await done;
  audio.sndPlaySound(null);
}
