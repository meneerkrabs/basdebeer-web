// The user's game library: ISOs (or CD folders) they supplied, kept in the browser's
// Origin Private File System so they only have to be loaded once.

import { Assets, type Book } from './engine/assets.ts';
import { detectBook, FileListVfs, HttpVfs, IsoVfs, type Vfs } from './engine/vfs.ts';

export const BOOKS: { id: Book; title: string; iso: string }[] = [
  { id: 'paaseiland', title: 'Naar Paaseiland', iso: 'BAS DE BEER - COLLECTIE - NAAR PAASEILAND.ISO' },
  { id: 'pirateneiland', title: 'Naar Pirateneiland', iso: 'BAS DE BEER - COLLECTIE - NAAR PIRATENEILAND.ISO' },
  { id: 'noorderlicht', title: 'Naar het Noorderlicht', iso: 'BAS DE BEER - COLLECTIE - NAAR HET NOORDERLICHT.ISO' },
];

export const ARCHIVE_ITEM = 'https://archive.org/details/bas-de-beer-collectie';
/** Optional CORS proxy for archive.org downloads (archive.org itself sends no CORS headers). */
export const ARCHIVE_PROXY: string | undefined = import.meta.env.VITE_ARCHIVE_PROXY;

const opfsDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('isos', { create: true });

/** Books available in this browser (OPFS-stored ISO, or dev-extracted files). */
export async function availableBooks(): Promise<Map<Book, () => Promise<Assets>>> {
  const out = new Map<Book, () => Promise<Assets>>();
  try {
    const dir = await opfsDir();
    for (const b of BOOKS) {
      const h = await dir.getFileHandle(`${b.id}.iso`).catch(() => null);
      if (h) out.set(b.id, async () => new Assets(b.id, await IsoVfs.open(await h.getFile())));
    }
  } catch (e) {
    console.warn('OPFS niet beschikbaar', e);
  }
  if (import.meta.env.DEV) {
    for (const b of BOOKS) {
      if (out.has(b.id)) continue;
      const vfs = await HttpVfs.open(`${import.meta.env.BASE_URL}data/${b.id}/`);
      if (vfs) out.set(b.id, async () => new Assets(b.id, vfs));
    }
  }
  return out;
}

/** Store an ISO the user picked (after checking it is one of the three books). */
export async function addIso(file: Blob, onProgress?: (f: number) => void): Promise<Book> {
  const vfs = await IsoVfs.open(file);
  const book = detectBook(vfs.list());
  if (!book) throw new Error('Deze ISO is geen Bas de Beer-boek (Paaseiland, Pirateneiland of Noorderlicht).');
  const dir = await opfsDir();
  const h = await dir.getFileHandle(`${book}.iso`, { create: true });
  const w = await h.createWritable();
  const CHUNK = 8 << 20;
  for (let o = 0; o < file.size; o += CHUNK) {
    await w.write(await file.slice(o, o + CHUNK).arrayBuffer());
    onProgress?.(Math.min(1, (o + CHUNK) / file.size));
  }
  await w.close();
  return book;
}

/** Download an ISO from archive.org through the configured proxy, then store it. */
export async function downloadIso(book: Book, onProgress?: (f: number) => void): Promise<Book> {
  if (!ARCHIVE_PROXY) throw new Error('Geen download-proxy ingesteld.');
  const b = BOOKS.find((x) => x.id === book)!;
  const res = await fetch(`${ARCHIVE_PROXY}/${encodeURIComponent(b.iso)}`);
  if (!res.ok || !res.body) throw new Error(`Download mislukt (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  // stream straight into OPFS (the ISOs are 150-380 MB), validate afterwards
  const dir = await opfsDir();
  const h = await dir.getFileHandle(`${book}.iso`, { create: true });
  const w = await h.createWritable();
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value as Uint8Array<ArrayBuffer>);
      got += value.length;
      if (total) onProgress?.(got / total);
    }
    await w.close();
    const found = detectBook((await IsoVfs.open(await h.getFile())).list());
    if (found !== book) throw new Error('De gedownloade ISO is niet het verwachte boek.');
  } catch (e) {
    await w.abort().catch(() => {});
    await dir.removeEntry(`${book}.iso`).catch(() => {});
    throw e;
  }
  return book;
}

/** A CD folder picked with <input webkitdirectory> or dropped: used in-session (not stored). */
export function cdFolder(files: Iterable<[string, Blob]>): { book: Book; assets: Assets } {
  const vfs: Vfs = new FileListVfs(files);
  const book = detectBook(vfs.list());
  if (!book) throw new Error('Geen Bas de Beer-CD gevonden in deze map (verwacht een BASWIN-map).');
  return { book, assets: new Assets(book, vfs) };
}

export async function removeIso(book: Book) {
  const dir = await opfsDir();
  await dir.removeEntry(`${book}.iso`).catch(() => {});
}
