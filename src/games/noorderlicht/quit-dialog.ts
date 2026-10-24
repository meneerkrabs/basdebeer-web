// TdlgQuit of BASNOORD.EXE (spec 1.6): the 300x200 JA/NEE sign shown over the book or a minigame.
// SetType = FUN_00430eb0, FormCreate @0x431260, FormPaint @0x4312b4, FormMouseDown @0x4312e4,
// FormMouseMove @0x4313fc.
//
// Borderless, centred, shown modally. The picture is drawn at (0,0); the two rect records
// "SysJaRect" / "SysNeeRect" are hit-tested on mouse DOWN: Ja sets ModalResult 1, Nee sets 2.
// Hovering an enabled rect shows cursor 1 (a hand).
import type { Assets } from '../../engine/assets.ts';
import { SRCCOPY } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Display } from '../../engine/vcl.ts';

/** 0 = quit, 1 = switch to 3D-plus, 2 = switch to normal, 3 = "no 3D-plus page" (OK only). */
export type QuitType = 0 | 1 | 2 | 3;

type Rect = [number, number, number, number]; // l, t, r, b (right/bottom exclusive, like PtInRect)

interface TypeInfo { image: (mode: 'N' | 'D') => string; ja: Rect; nee: Rect | null }

const TYPES: Record<QuitType, TypeInfo> = {
  0: { image: (m) => (m === 'D' ? 'STOPD.BMP' : 'STOPN.BMP'), ja: [50, 130, 110, 160], nee: [160, 130, 245, 160] },
  1: { image: () => 'CTO3D.BMP', ja: [59, 135, 110, 165], nee: [160, 135, 236, 165] },
  2: { image: () => 'CTON.BMP', ja: [65, 135, 117, 167], nee: [168, 137, 242, 166] },
  3: { image: (m) => (m === 'D' ? 'NO3DD.BMP' : 'NO3DN.BMP'), ja: [44, 106, 254, 170], nee: null },
};

const inRect = (r: Rect | null, x: number, y: number) => !!r && x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/**
 * Show the dialog; resolves true for Ja (ModalResult 1, mrOK), false for Nee (2).
 * `mode` is the book's normal/3D-glasses mode (picks STOPN/STOPD and NO3DN/NO3DD).
 */
export async function askQuit(display: Display, assets: Assets, type: QuitType = 0, mode: 'N' | 'D' = 'N'): Promise<boolean> {
  const info = TYPES[type];
  const img = await assets.image(info.image(mode));
  const form = new Form(display, 300, 200, 'dlgQuit');
  form.center();
  form.onPaint = () => form.surface.bitBlt(0, 0, 300, 200, img, 0, 0, SRCCOPY);
  form.onMouseDown = (_b, _s, x, y) => {
    if (inRect(info.ja, x, y)) form.close(1);
    else if (inRect(info.nee, x, y)) form.close(2);
  };
  form.onMouseMove = (_s, x, y) => {
    form.cursor = inRect(info.ja, x, y) || inRect(info.nee, x, y) ? 'pointer' : 'default';
  };
  return (await form.showModal()) === 1;
}
