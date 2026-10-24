import './style.css';
import { audio } from './engine/audio.ts';
import type { Assets, Book } from './engine/assets.ts';
import { Display } from './engine/vcl.ts';
import { addIso, ARCHIVE_ITEM, ARCHIVE_PROXY, availableBooks, BOOKS, cdFolder, downloadIso } from './library.ts';
import { paaseilandGames } from './games/paaseiland/index.ts';
import type { MinigameRegistry } from './games/types.ts';

const app = document.getElementById('app')!;
const GAMES: Partial<Record<Book, MinigameRegistry>> = { paaseiland: paaseilandGames };

function showError(e: unknown) {
  console.error(e);
  const div = document.createElement('div');
  div.className = 'bdb-error';
  div.textContent = e instanceof Error ? e.message : String(e);
  div.onclick = () => div.remove();
  document.body.appendChild(div);
}
addEventListener('unhandledrejection', (e) => showError(e.reason));

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  n.append(...kids);
  return n;
};

async function startScreen() {
  app.replaceChildren();
  const books = await availableBooks();
  const status = el('div', { className: 'note' });
  const progress = (label: string) => (f: number) => (status.textContent = `${label} ${Math.round(f * 100)}%`);

  const bookButtons = BOOKS.map((b) => {
    const open = books.get(b.id);
    return el('button', {
      textContent: b.title,
      disabled: !open,
      title: open ? '' : 'Voeg eerst de ISO of CD van dit boek toe',
      onclick: async () => {
        await audio.unlock();
        play(b.id, await open!());
      },
    });
  });

  const isoInput = el('input', { type: 'file', accept: '.iso,.ISO', multiple: true, hidden: true });
  isoInput.onchange = async () => {
    for (const f of isoInput.files ?? []) {
      try { await addIso(f, progress(f.name)); } catch (e) { showError(e); }
    }
    startScreen();
  };
  const dirInput = el('input', { type: 'file', hidden: true });
  dirInput.webkitdirectory = true;
  dirInput.onchange = async () => {
    try {
      const { book, assets } = cdFolder([...(dirInput.files ?? [])].map((f) => [f.webkitRelativePath, f] as [string, Blob]));
      await audio.unlock();
      play(book, assets);
    } catch (e) { showError(e); }
  };

  const archiveButtons = BOOKS.filter((b) => !books.has(b.id)).map((b) =>
    el('button', {
      textContent: `${b.title} downloaden`,
      disabled: !ARCHIVE_PROXY,
      title: ARCHIVE_PROXY ? '' : 'Geen download-proxy ingesteld (archive.org staat directe downloads vanuit de browser niet toe)',
      onclick: async () => {
        if (!confirm(`De ISO van "${b.title}" wordt gedownload van archive.org (${ARCHIVE_ITEM}) en in deze browser bewaard. Doorgaan?`)) return;
        try { await downloadIso(b.id, progress(b.title)); } catch (e) { showError(e); }
        startScreen();
      },
    }),
  );

  const screen = el('div', { className: 'bdb-start' },
    el('h1', { textContent: 'Bas de Beer' }),
    el('div', { className: 'books' }, ...bookButtons),
    el('div', { className: 'books' },
      el('button', { textContent: 'ISO-bestand kiezen…', onclick: () => isoInput.click() }),
      el('button', { textContent: 'CD-map kiezen…', onclick: () => dirInput.click() }),
      ...archiveButtons),
    status,
    el('div', { className: 'note', innerHTML: `Je hebt de originele CD-ROM's nodig (of de ISO's van <a href="${ARCHIVE_ITEM}" target="_blank" rel="noopener" style="color:#fc3">archive.org</a>). Je kunt een ISO ook hierheen slepen. De bestanden blijven in je eigen browser.` }),
    isoInput, dirInput,
  );
  screen.ondragover = (e) => e.preventDefault();
  screen.ondrop = async (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer?.files ?? []) {
      try { await addIso(f, progress(f.name)); } catch (err) { showError(err); }
    }
    startScreen();
  };
  app.appendChild(screen);
}

async function play(book: Book, assets: Assets) {
  app.replaceChildren();
  const display = new Display(app);
  const params = new URLSearchParams(location.search);
  const registry = GAMES[book] ?? {};
  const game = params.get('game');
  if (game && registry[game]) {
    // dev route: run one minigame directly (?game=1)
    const mod = await registry[game]();
    const session = mod.default({ display, assets });
    const code = await session.result;
    console.log(`minigame ${game} ended with code ${code}`);
    addEventListener('keydown', (e) => e.key === 'q' && session.requestQuit?.());
    return;
  }
  // The story engines are being ported; until then offer the minigames directly.
  const { runGameMenu } = await import('./game-menu.ts');
  await runGameMenu(display, assets, registry);
  startScreen();
}

startScreen().catch(showError);
