import './style.css';
import { audio } from './engine/audio.ts';
import type { Assets, Book } from './engine/assets.ts';
import { Display } from './engine/vcl.ts';
import { addIso, ARCHIVE_PAGE, availableBooks, BOOKS, cdFolder, removeIso } from './library.ts';
import { paaseilandGames } from './games/paaseiland/index.ts';
import { pirateneilandGames } from './games/pirateneiland/index.ts';
import { noorderlichtGames } from './games/noorderlicht/index.ts';
import type { MinigameRegistry } from './games/types.ts';

const app = document.getElementById('app')!;
const GAMES: Partial<Record<Book, MinigameRegistry>> = { paaseiland: paaseilandGames, pirateneiland: pirateneilandGames, noorderlicht: noorderlichtGames };

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
    const entry = books.get(b.id)!;
    return el('button', {
      textContent: b.title,
      title: entry.source === 'iso' ? 'Van je eigen ISO' : entry.source === 'dev' ? 'Uit public/data (dev)' : 'Van archive.org',
      onclick: async () => {
        await audio.unlock();
        play(b.id, await entry.open());
      },
    });
  });
  const ownIsos = BOOKS.filter((b) => books.get(b.id)?.source === 'iso');

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

  const look = el('select', { onchange: () => localStorage.setItem('bdb-display', look.value) },
    el('option', { value: 'smooth', textContent: 'Glad (korrel van 256 kleuren weggefilterd)' }),
    el('option', { value: 'original', textContent: 'Origineel (scherpe pixels)' }));
  look.value = Display.savedMode();

  const screen = el('div', { className: 'bdb-start' },
    el('h1', { textContent: 'Bas de Beer' }),
    el('div', { className: 'books' }, ...bookButtons),
    el('label', { className: 'note' }, 'Beeld: ', look),
    status,
    el('div', { className: 'note', innerHTML: `De spelbestanden worden geladen uit de ISO's op <a href="${ARCHIVE_PAGE}" target="_blank" rel="noopener" style="color:#fc3">archive.org</a> en in je browser bewaard.` }),
    el('details', { className: 'note' },
      el('summary', { textContent: 'Eigen CD of ISO gebruiken' }),
      el('div', { className: 'books' },
        el('button', { textContent: 'ISO-bestand kiezen…', onclick: () => isoInput.click() }),
        el('button', { textContent: 'CD-map kiezen…', onclick: () => dirInput.click() }),
        ...ownIsos.map((b) => el('button', { textContent: `${b.title}: eigen ISO verwijderen`, onclick: async () => { await removeIso(b.id); startScreen(); } }))),
      'Je kunt een ISO ook hierheen slepen.'),
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
  const host = el('div');
  app.appendChild(host);
  // Noorderlicht was designed for 800x600, the other books for 640x480
  const display = book === 'noorderlicht' ? new Display(host, 800, 600) : new Display(host);
  const params = new URLSearchParams(location.search);
  const registry = GAMES[book] ?? {};
  const game = params.get('game');
  if (game && registry[game]) {
    // dev route: run one minigame directly (?game=1)
    const mod = await registry[game]();
    const session = mod.default({ display, assets });
    addEventListener('keydown', (e) => (e.key === 'q' || e.key === 'Escape') && session.requestQuit?.());
    const code = await session.result;
    console.log(`minigame ${game} ended with code ${code}`);
    return;
  }
  if (book === 'paaseiland' && !params.has('spellen')) {
    const { runPaaseiland } = await import('./books/paaseiland/book.ts');
    await runPaaseiland(display, assets);
  } else if (book === 'pirateneiland' && !params.has('spellen')) {
    // the CD menu (Autorun.exe) leads to the book, BerenSpellen and BerenBios
    const { runPirateneilandMenu } = await import('./books/pirateneiland/launcher.ts');
    await runPirateneilandMenu(display, assets);
  } else {
    // story engines still being ported (or ?spellen): offer the minigames directly
    const { runGameMenu } = await import('./game-menu.ts');
    await runGameMenu(display, assets, registry);
  }
  display.root.remove();
  startScreen();
}

async function boot() {
  // ?book=paaseiland (&game=2) opens a book / minigame directly (click once to enable sound)
  const params = new URLSearchParams(location.search);
  const book = params.get('book') as Book | null;
  const entry = book && (await availableBooks()).get(book);
  if (book && entry) {
    addEventListener('pointerdown', () => audio.unlock(), { once: true });
    return play(book, await entry.open());
  }
  return startScreen();
}

boot().catch(showError);
