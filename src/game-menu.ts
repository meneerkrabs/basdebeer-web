// Temporary launcher listing a book's ported minigames, until the story engine is done.
import type { Assets } from './engine/assets.ts';
import { Form, type Display } from './engine/vcl.ts';
import type { MinigameRegistry } from './games/types.ts';

export async function runGameMenu(display: Display, assets: Assets, games: MinigameRegistry) {
  const ids = Object.keys(games);
  const titles = await Promise.all(ids.map(async (id) => (await games[id]()).title ?? `Spel ${id}`));
  for (;;) {
    const menu = new Form(display, 640, 480, 'menu');
    const font = { name: 'Arial', px: 28, bold: true, color: 0x33ccff };
    const item = (i: number) => ({ x: 120, y: 120 + i * 50, w: 400, h: 40 });
    menu.onPaint = () => {
      const s = menu.surface;
      s.fillRect(0, 0, 640, 480, 0x301000);
      s.textOut(120, 40, `Bas de Beer ${assets.book} — spelletjes`, { ...font, px: 24, color: 0xffffff });
      titles.forEach((t, i) => {
        const r = item(i);
        s.fillRect(r.x, r.y, r.x + r.w, r.y + r.h, 0x603000);
        s.textOut(r.x + 12, r.y + 4, t, font);
      });
      const r = item(titles.length);
      s.textOut(r.x + 12, r.y + 4, 'Terug', { ...font, color: 0xaaaaaa });
    };
    menu.cursor = 'pointer';
    const choice = await new Promise<number>((resolve) => {
      menu.onMouseDown = (_b, _s, x, y) => {
        for (let i = 0; i <= titles.length; i++) {
          const r = item(i);
          if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) resolve(i);
        }
      };
      menu.show();
    });
    menu.hide();
    if (choice >= ids.length) { display.root.remove(); return; }
    const mod = await games[ids[choice]]();
    const bg = new Form(display, 640, 480, 'background');
    bg.onPaint = () => bg.surface.px.fill(0);
    bg.show();
    const session = mod.default({ display, assets });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && session.requestQuit?.();
    addEventListener('keydown', onKey);
    await session.result;
    removeEventListener('keydown', onKey);
    bg.hide();
  }
}
