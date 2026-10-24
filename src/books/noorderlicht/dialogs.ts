// TdlgQuit (spec 1.6) and TfrmClickTip, the KlikTip help screen (spec 1.7).

import type { Assets } from '../../engine/assets.ts';
import { Form, type Display } from '../../engine/vcl.ts';
import { inRect, type Rect } from './common.ts';

/** 0 = quit, 1 = switch to 3D-plus, 2 = switch to normal, 3 = "no 3D-plus page" (info only, OK button). */
export type QuitType = 0 | 1 | 2 | 3;

const DIALOGS: Record<QuitType, { img: [string, string]; ja: Rect; nee: Rect | null }> = {
  0: { img: ['STOPN.BMP', 'STOPD.BMP'], ja: [50, 130, 110, 160], nee: [160, 130, 245, 160] },
  1: { img: ['CTO3D.BMP', 'CTO3D.BMP'], ja: [59, 135, 110, 165], nee: [160, 135, 236, 165] },
  2: { img: ['CTON.BMP', 'CTON.BMP'], ja: [65, 135, 117, 167], nee: [168, 137, 242, 166] },
  3: { img: ['NO3DN.BMP', 'NO3DD.BMP'], ja: [44, 106, 254, 170], nee: null },
};

/** Shows the modal 300x200 dialog; true = "Ja" (ModalResult mrOK), false = "Nee". */
export async function askDialog(display: Display, assets: Assets, type: QuitType, mode: 0 | 1): Promise<boolean> {
  const d = DIALOGS[type];
  const img = await assets.image(d.img[mode]);
  const f = new Form(display, 300, 200, 'dlgQuit');
  f.center();
  f.surface.bitBlt(0, 0, 300, 200, img, 0, 0);
  f.onMouseMove = (_s, x, y) => { f.cursor = inRect(d.ja, x, y) || (d.nee && inRect(d.nee, x, y)) ? 'pointer' : 'default'; };
  f.onMouseDown = (_b, _s, x, y) => {
    if (inRect(d.ja, x, y)) f.close(1);
    else if (d.nee && inRect(d.nee, x, y)) f.close(2);
  };
  // not in the original: keyboard shortcuts
  f.onKeyDown = (key) => {
    if (key === 'Enter' && type !== 0) f.close(1);
    else if (key === 'Escape') f.close(d.nee ? 2 : 1);
  };
  return (await f.showModal()) === 1;
}

/** KlikTip: CLICKTIP.BMP with a read-only memo showing CLICKTIP.TXT (plain cp1252, not encoded). */
export async function showKlikTip(display: Display, assets: Assets): Promise<void> {
  const bg = await assets.image('CLICKTIP.BMP');
  const text = await assets.text('CLICKTIP.TXT').catch(() => 'De helptekst staat niet in deze bron.');
  const f = new Form(display, 500, 400, 'frmClickTip');
  f.center();
  f.surface.bitBlt(0, 0, 500, 400, bg, 0, 0);
  // the TMemo (20,20,460x340) and the "Klaar met lezen" button (150,370,200x20) are native controls
  const memo = document.createElement('textarea');
  memo.readOnly = true;
  memo.value = text.replace(/\r\n/g, '\n');
  memo.className = 'bdb-help-memo';
  const ok = document.createElement('button');
  ok.textContent = 'Klaar met lezen';
  ok.className = 'bdb-help-ok';
  ok.onclick = () => f.close(1);
  f.onKeyDown = (key) => { if (key === 'Escape') f.close(1); };
  const done = f.showModal();
  display.attachControl(memo, f.left + 20, f.top + 20, 460, 340);
  display.attachControl(ok, f.left + 150, f.top + 370, 200, 20);
  ok.focus();
  await done;
  memo.remove();
  ok.remove();
}
