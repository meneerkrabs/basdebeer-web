// TfrmWelcome (spec 1.3): WCSMAIN.BMP with three hover-highlighted hotspots.

import { audio, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { SRCAND, SRCPAINT, type Surface } from '../../engine/surface.ts';
import { Form, type Display } from '../../engine/vcl.ts';
import { inRect, type Rect } from './common.ts';

export type WelcomeChoice = 'begin' | 'choose' | 'explain' | 'quit';

const SPOTS: { choice: WelcomeChoice; rect: Rect; n: string; m: string; h: string }[] = [
  { choice: 'begin', rect: [224, 406, 430, 441], n: 'WCSSTRTN.BMP', m: 'WCSSTRTM.BMP', h: 'WCSSTRTH.BMP' }, // SysBegin
  { choice: 'choose', rect: [447, 369, 621, 455], n: 'WCSCHSEN.BMP', m: 'WCSCHSEM.BMP', h: 'WCSCHSEH.BMP' }, // SysKies
  { choice: 'explain', rect: [20, 406, 220, 441], n: 'WCSEXPLN.BMP', m: 'WCSEXPLM.BMP', h: 'WCSEXPLH.BMP' }, // SysUitleg
];

export class Welcome {
  private form!: Form;
  private imgs: { n: Surface; m: Surface; h: Surface }[] = [];
  private lit = -1;
  private wav: AudioBuffer | null = null;
  private background!: Surface;

  private display: Display;
  private assets: Assets;

  constructor(display: Display, assets: Assets) {
    this.display = display;
    this.assets = assets;
  }

  async load() {
    const a = this.assets;
    this.background = await a.image('WCSMAIN.BMP');
    this.imgs = await Promise.all(SPOTS.map(async (s) => ({ n: await a.image(s.n), m: await a.image(s.m), h: await a.image(s.h) })));
    this.wav = await a.sound('WCS001.WAV').catch(() => null);
  }

  /** Show the screen (FormActivate plays WCS001) and resolve with the chosen action; the form is hidden again. */
  show(): Promise<WelcomeChoice> {
    return new Promise((resolve) => {
      const f = (this.form = new Form(this.display, 640, 480, 'frmWelcome'));
      f.center();
      f.surface.bitBlt(0, 0, 640, 480, this.background, 0, 0);
      this.lit = -1;
      this.paintNormal(); // FormActivate resets the hover state: all three buttons in their normal look
      const pick = (c: WelcomeChoice) => {
        audio.sndPlaySound(null);
        f.close(1);
        resolve(c);
      };
      f.onMouseMove = (_s, x, y) => this.hover(x, y);
      f.onMouseDown = (_b, _s, x, y) => {
        const s = SPOTS.find((s) => inRect(s.rect, x, y));
        if (s) pick(s.choice);
      };
      f.onKeyDown = (key) => { if (key === 'Escape') pick('quit'); }; // not in the original (Alt+F4 there)
      f.show();
      if (this.wav) audio.sndPlaySound(this.wav, SND_ASYNC);
    });
  }

  private paintNormal() {
    const s = this.form.surface;
    SPOTS.forEach((p, k) => {
      const [l, t, r, b] = p.rect;
      s.bitBlt(l, t, r - l, b - t, this.imgs[k].m, 0, 0, SRCAND);
      s.bitBlt(l, t, r - l, b - t, this.imgs[k].n, 0, 0, SRCPAINT);
    });
  }

  /** FUN_00449ed0: entering a hotspot paints mask (SRCAND) + highlight (SRCPAINT); leaving all restores them all. */
  private hover(x: number, y: number) {
    const s = this.form.surface;
    const i = SPOTS.findIndex((p) => inRect(p.rect, x, y));
    if (i >= 0) {
      if (i !== this.lit) {
        const [l, t, r, b] = SPOTS[i].rect;
        s.bitBlt(l, t, r - l, b - t, this.imgs[i].m, 0, 0, SRCAND);
        s.bitBlt(l, t, r - l, b - t, this.imgs[i].h, 0, 0, SRCPAINT);
        this.lit = i;
      }
      this.form.cursor = 'pointer';
    } else if (this.lit >= 0) {
      this.paintNormal();
      this.lit = -1;
      this.form.cursor = 'default';
    } else this.form.cursor = 'default';
  }
}
