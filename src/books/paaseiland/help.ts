// TfrmHelp (spec 9.3): H001.BMP with a scrollable memo showing HELPBOEK.TXT from the CD root.
import type { Assets } from '../../engine/assets.ts';
import { Form, type Display } from '../../engine/vcl.ts';

export async function showHelp(display: Display, assets: Assets): Promise<void> {
  const bg = await assets.image('H001.BMP');
  const text = await assets.rootText('HELPBOEK.TXT').catch(() => 'De helptekst staat niet in deze bron.');
  const f = new Form(display, 400, 250, 'frmHelp');
  f.center();
  f.surface.bitBlt(0, 0, 400, 250, bg, 0, 0);
  // the memo and the OK button are native controls in the original; use HTML for them
  const memo = document.createElement('textarea');
  memo.readOnly = true;
  memo.value = text;
  memo.className = 'bdb-help-memo';
  const ok = document.createElement('button');
  ok.textContent = 'OK';
  ok.className = 'bdb-help-ok';
  const done = f.showModal();
  display.attachControl(memo, f.left + 5, f.top + 20, 390, 200);
  display.attachControl(ok, f.left + 150, f.top + 225, 100, 20);
  ok.onclick = () => f.close(1);
  ok.focus();
  await done;
  memo.remove();
  ok.remove();
}
