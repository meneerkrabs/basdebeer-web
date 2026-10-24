// The user's game library: ISOs (or CD folders) they supplied, kept in the browser's
// Origin Private File System so they only have to be loaded once.

import { Assets, type Book } from './engine/assets.ts';
import { ArchiveVfs, detectBook, FileListVfs, HttpVfs, IsoVfs, type Vfs } from './engine/vfs.ts';

export const BOOKS: { id: Book; title: string; iso: string }[] = [
  { id: 'paaseiland', title: 'Naar Paaseiland', iso: 'BAS DE BEER - COLLECTIE - NAAR PAASEILAND.ISO' },
  { id: 'pirateneiland', title: 'Naar Pirateneiland', iso: 'BAS DE BEER - COLLECTIE - NAAR PIRATENEILAND.ISO' },
  { id: 'noorderlicht', title: 'Naar het Noorderlicht', iso: 'BAS DE BEER - COLLECTIE - NAAR HET NOORDERLICHT.ISO' },
];

export const ARCHIVE_ITEM = 'bas-de-beer-collectie';
export const ARCHIVE_PAGE = `https://archive.org/details/${ARCHIVE_ITEM}`;

const MANIFESTS: Record<Book, () => Promise<{ default: Record<string, number> }>> = {
  paaseiland: () => import('./data/paaseiland.files.json'),
  pirateneiland: () => import('./data/pirateneiland.files.json'),
  noorderlicht: () => import('./data/noorderlicht.files.json'),
};

export type BookSource = 'iso' | 'dev' | 'archive';

const opfsDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('isos', { create: true });

/** Books available in this browser (OPFS-stored ISO, or dev-extracted files). */
export async function availableBooks(): Promise<Map<Book, { source: BookSource; open: () => Promise<Assets> }>> {
  const out = new Map<Book, { source: BookSource; open: () => Promise<Assets> }>();
  try {
    const dir = await opfsDir();
    for (const b of BOOKS) {
      const h = await dir.getFileHandle(`${b.id}.iso`).catch(() => null);
      if (h) out.set(b.id, { source: 'iso', open: async () => new Assets(b.id, await IsoVfs.open(await h.getFile())) });
    }
  } catch (e) {
    console.warn('OPFS niet beschikbaar', e);
  }
  // dev: prefer files from public/data (tools/extract.mjs) unless ?source=archive
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('source') !== 'archive') {
    for (const b of BOOKS) {
      if (out.has(b.id)) continue;
      const vfs = await HttpVfs.open(`${import.meta.env.BASE_URL}data/${b.id}/`);
      if (vfs) out.set(b.id, { source: 'dev', open: async () => new Assets(b.id, vfs) });
    }
  }
  // default: stream the files from the ISO on archive.org
  for (const b of BOOKS) {
    if (out.has(b.id)) continue;
    out.set(b.id, {
      source: 'archive',
      open: async () => new Assets(b.id, new ArchiveVfs(ARCHIVE_ITEM, b.iso, (await MANIFESTS[b.id]()).default)),
    });
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
