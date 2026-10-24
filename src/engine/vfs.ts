// Virtual file systems for the game data. The original CD files are read directly from
// the user's ISO (or CD folder) in the browser; no game data is hosted with the app.
// Paths are normalised to upper case relative to the BASWIN directory ("IMAGES/I007.BMP").

export interface Vfs {
  /** All files, upper-case relative paths. */
  list(): string[];
  read(path: string): Promise<ArrayBuffer>;
}

/** Dev convenience: files extracted by tools/extract.mjs into public/data/<game>/ (with manifest.json). */
export class HttpVfs implements Vfs {
  private files: string[];
  private base: string;
  private constructor(base: string, files: string[]) {
    this.base = base;
    this.files = files;
  }
  static async open(base: string): Promise<HttpVfs | null> {
    const res = await fetch(base + 'manifest.json').catch(() => null);
    if (!res?.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return new HttpVfs(base, await res.json());
  }
  list() { return this.files; }
  async read(path: string) {
    const res = await fetch(this.base + path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }
}

/** Files picked from a CD (directory input / drag & drop of a folder). */
export class FileListVfs implements Vfs {
  private map = new Map<string, Blob>();
  constructor(files: Iterable<[string, Blob]>, root = 'BASWIN') {
    for (const [p, blob] of files) {
      const parts = p.replace(/\\/g, '/').toUpperCase().split('/');
      const i = parts.indexOf(root);
      if (i >= 0) this.map.set(parts.slice(i + 1).join('/'), blob);
    }
  }
  list() { return [...this.map.keys()]; }
  async read(path: string) {
    const b = this.map.get(path);
    if (!b) throw new Error(`not found: ${path}`);
    return b.arrayBuffer();
  }
}

/** Read-only ISO9660 reader over a Blob (File or OPFS file); reads lazily via slice(). */
export class IsoVfs implements Vfs {
  private entries = new Map<string, { lba: number; size: number }>();
  private blob: Blob;
  readonly volumeId: string;

  private constructor(blob: Blob, volumeId: string) {
    this.blob = blob;
    this.volumeId = volumeId;
  }

  static async open(blob: Blob, root = 'BASWIN'): Promise<IsoVfs> {
    const SECTOR = 2048;
    const read = async (lba: number, len: number) => new DataView(await blob.slice(lba * SECTOR, lba * SECTOR + len).arrayBuffer());
    const pvd = await read(16, SECTOR);
    const magic = String.fromCharCode(...new Uint8Array(pvd.buffer, 1, 5));
    if (pvd.getUint8(0) !== 1 || magic !== 'CD001') throw new Error('Dit is geen geldig ISO-bestand (ISO9660).');
    const volumeId = String.fromCharCode(...new Uint8Array(pvd.buffer, 40, 32)).trim();
    const iso = new IsoVfs(blob, volumeId);
    const walk = async (lba: number, size: number, prefix: string) => {
      const dir = await read(lba, size);
      let off = 0;
      while (off < size) {
        const len = dir.getUint8(off);
        if (len === 0) { off = (Math.floor(off / SECTOR) + 1) * SECTOR; continue; }
        const extent = dir.getUint32(off + 2, true);
        const dataLen = dir.getUint32(off + 10, true);
        const flags = dir.getUint8(off + 25);
        const nameLen = dir.getUint8(off + 32);
        const raw = String.fromCharCode(...new Uint8Array(dir.buffer, off + 33, nameLen));
        off += len;
        if (raw === '\0' || raw === '\x01') continue;
        const name = raw.replace(/;\d+$/, '').replace(/\.$/, '').toUpperCase();
        const path = prefix ? `${prefix}/${name}` : name;
        if (flags & 2) await walk(extent, dataLen, path);
        else iso.entries.set(path, { lba: extent, size: dataLen });
      }
    };
    await walk(pvd.getUint32(156 + 2, true), pvd.getUint32(156 + 10, true), '');
    // re-root at BASWIN/
    const rooted = new Map<string, { lba: number; size: number }>();
    for (const [p, e] of iso.entries) if (p.startsWith(root + '/')) rooted.set(p.slice(root.length + 1), e);
    if (!rooted.size) throw new Error(`Geen ${root}-map gevonden in deze ISO.`);
    iso.entries = rooted;
    return iso;
  }

  list() { return [...this.entries.keys()]; }

  async read(path: string) {
    const e = this.entries.get(path);
    if (!e) throw new Error(`not found: ${path}`);
    return this.blob.slice(e.lba * 2048, e.lba * 2048 + e.size).arrayBuffer();
  }
}

/** Identify which book an ISO/CD is, from its file list. */
export function detectBook(files: string[]): 'paaseiland' | 'pirateneiland' | 'noorderlicht' | null {
  const set = new Set(files);
  if (set.has('PAASBAAS.EXE')) return 'paaseiland';
  if (set.has('BBOEK32.EXE') || set.has('BBOEK.EXE')) return 'pirateneiland';
  if (set.has('BASNOORD.EXE')) return 'noorderlicht';
  return null;
}
