// TfrmStartup ("Hier was je gebleven", spec 9.2): resume at the bookmark or start over.
import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { Form, type Display } from '../../engine/vcl.ts';

/** Resolves 1 = "Verder gaan" (resume), 2 = "Opnieuw beginnen". */
export async function askResume(display: Display, assets: Assets, scene: number): Promise<number> {
  const [header, picture, menu2, voice] = await Promise.all([
    assets.image('HEADER.BMP'), assets.image(`I${String(scene).padStart(3, '0')}.BMP`),
    assets.image('MENU2.BMP'), assets.sound('S001.WAV').catch(() => null),
  ]);
  const f = new Form(display, 640, 480, 'frmStartup');
  const s = f.surface;
  s.bitBlt(0, 0, 640, 80, header, 0, 0);
  s.textOut(165, 25, 'Hier was je gebleven......', { name: 'Times New Roman', px: 24, bold: true, color: 0 });
  s.bitBlt(0, 80, 640, 320, picture, 0, 0);
  s.bitBlt(0, 400, 640, 80, menu2, 0, 0);
  f.cursor = 'pointer';
  f.onMouseDown = (_b, _s, x, y) => {
    if (y >= 400 && y < 480) f.close(x < 321 ? 1 : 2);
  };
  f.onClose = () => audio.sndPlaySound(null);
  const result = f.showModal();
  if (voice) audio.sndPlaySound(voice, SND_ASYNC);
  return result;
}
