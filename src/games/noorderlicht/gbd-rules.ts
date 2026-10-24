// GBDfrmSpelRegel of BASNOORD.EXE (FormCreate @0x43e084, FormMouseDown @0x43e078): the Berendobbel rules.
// A borderless 620x460 form, centred; a read-only memo (MS Sans Serif 16 px) with GBDRULES.TXT above a panel
// with the button "Spelregels gelezen" (ModalResult 1, 113x25, centred in the 30 px panel).
import type { Assets } from '../../engine/assets.ts';
import { Form } from '../../engine/vcl.ts';
import type { Display } from '../../engine/vcl.ts';

const FONT = '"MS Sans Serif", Tahoma, Arial, sans-serif';
const BTN_FACE = 0xc0c0c0; // clBtnFace

export async function showRules(display: Display, assets: Assets): Promise<void> {
  const text = await assets.text('GBDRULES.TXT').catch(() => 'De spelregels staan niet in deze bron.');
  const f = new Form(display, 620, 460, 'GBDfrmSpelRegel');
  f.center();
  f.surface.fillRect(0, 0, 620, 460, BTN_FACE);
  f.onPaint = () => f.surface.fillRect(0, 430, 620, 460, BTN_FACE);

  // the memo: a wrapper takes the (scaled) font size, the textarea inside uses 16 px of the 11 px base
  const wrap = document.createElement('div');
  wrap.style.background = '#fff';
  const memo = document.createElement('textarea');
  memo.readOnly = true;
  memo.value = text.replace(/\r\n/g, '\n');
  Object.assign(memo.style, {
    width: '100%', height: '100%', boxSizing: 'border-box', resize: 'none', border: '2px inset #ccc', padding: '2px',
    fontFamily: FONT, fontSize: `${16 / 11}em`, background: '#fff', color: '#000', margin: '0', display: 'block',
  });
  wrap.appendChild(memo);
  const ok = document.createElement('button');
  ok.textContent = 'Spelregels gelezen';
  Object.assign(ok.style, { font: 'inherit', fontFamily: FONT, background: '#c0c0c0', border: '2px outset #eee', color: '#000', padding: '0', cursor: 'pointer' });
  ok.onclick = () => f.close(1);
  f.onMouseDown = () => f.close(1); // FormMouseDown closes the form
  f.onKeyDown = (key) => { if (key === 'Escape' || key === 'Enter') f.close(1); };

  const done = f.showModal();
  display.attachControl(wrap, f.left, f.top, 620, 430);
  display.attachControl(ok, f.left + 254, f.top + 430, 113, 25);
  ok.focus();
  await done;
  wrap.remove();
  ok.remove();
}
