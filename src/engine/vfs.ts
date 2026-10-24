// Virtual file systems for the game data. The original CD files are read directly from
// the user's ISO (or CD folder) in the browser; no game data is hosted with the app.
// Paths are normalised to upper case relative to the BASWIN directory ("IMAGES/I007.BMP").

export interface Vfs {
  /** All files, upper-case relative paths. */
  list(): string[];
  /** Read a file; `onBytes` (optional) reports bytes received so far while downloading. */
  read(path: string, onBytes?: (received: number) => void): Promise<ArrayBuffer>;
  /** A file outside BASWIN, in the CD root (e.g. HELPBOEK.TXT). */
  readRoot?(name: string): Promise<ArrayBuffer>;
  /** Files come from the network one by one (prefetching pays off). */
  readonly remote?: boolean;
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
  private rootFiles = new Map<string, Blob>();
  constructor(files: Iterable<[string, Blob]>, root = 'BASWIN') {
    const all = [...files].map(([p, b]) => [p.replace(/\\/g, '/').toUpperCase().split('/'), b] as const);
    for (const [parts, blob] of all) {
      const i = parts.indexOf(root);
      if (i >= 0) this.map.set(parts.slice(i + 1).join('/'), blob);
    }
    // files next to BASWIN = CD root
    const depth = all.find(([parts]) => parts.includes(root))?.[0].indexOf(root);
    if (depth !== undefined) for (const [parts, blob] of all) if (parts.length === depth + 1) this.rootFiles.set(parts[depth], blob);
  }
  async readRoot(name: string) {
    const b = this.rootFiles.get(name.toUpperCase());
    if (!b) throw new Error(`not found: ${name}`);
    return b.arrayBuffer();
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
  private all = new Map<string, { lba: number; size: number }>();
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
    iso.all = iso.entries;
    iso.entries = rooted;
    return iso;
  }

  list() { return [...this.entries.keys()]; }

  async read(path: string) {
    const e = this.entries.get(path);
    if (!e) throw new Error(`not found: ${path}`);
    return this.blob.slice(e.lba * 2048, e.lba * 2048 + e.size).arrayBuffer();
  }

  async readRoot(name: string) {
    const e = this.all.get(name.toUpperCase());
    if (!e) throw new Error(`not found: ${name}`);
    return this.blob.slice(e.lba * 2048, e.lba * 2048 + e.size).arrayBuffer();
  }
}

/**
 * Files fetched one by one from the ISO on archive.org. archive.org's archive viewer
 * (…/download/<item>/<file.iso>/<path inside>) serves single files out of an ISO with CORS
 * headers, so no proxy and no full ISO download are needed. Fetched files are kept in
 * Cache Storage, so each file is downloaded only once.
 */
export class ArchiveVfs implements Vfs {
  private files: Record<string, number>;
  private url: string;
  private inflight = new Map<string, Promise<ArrayBuffer>>();
  private cache: Promise<Cache | null>;

  constructor(item: string, iso: string, files: Record<string, number>, root = 'BASWIN') {
    this.files = files;
    this.url = `https://archive.org/download/${item}/${encodeURIComponent(iso)}/${root}%2F`;
    this.cache = 'caches' in globalThis ? caches.open(`bdb-${item}`).catch(() => null) : Promise.resolve(null);
  }

  list() { return Object.keys(this.files); }
  size(path: string) { return this.files[path] ?? 0; }

  private urlFor(path: string) {
    return this.url + path.split('/').map(encodeURIComponent).join('%2F');
  }

  async readRoot(name: string) {
    // archive.org is case-sensitive and the CD root mixes cases (AUTORUN.INF next to Autorun.exe)
    const lower = name.toLowerCase();
    const variants = [...new Set([name, name.toUpperCase(), lower[0].toUpperCase() + lower.slice(1), lower])];
    for (const v of variants) {
      const res = await fetch(this.url.replace(/[^/]*%2F$/, '') + encodeURIComponent(v));
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) return buf; // a wrong-case name gives "200 OK" with an empty body
    }
    throw new Error(`archive.org: ${name} niet gevonden`);
  }

  private listeners = new Map<string, Set<(n: number) => void>>();

  read(path: string, onBytes?: (received: number) => void): Promise<ArrayBuffer> {
    if (onBytes) {
      const set = this.listeners.get(path) ?? new Set();
      set.add(onBytes);
      this.listeners.set(path, set);
    }
    let p = this.inflight.get(path);
    if (!p) {
      p = this.fetchCached(path).finally(() => {
        this.inflight.delete(path);
        this.listeners.delete(path);
      });
      this.inflight.set(path, p);
    }
    return p;
  }

  /** Read a response body, reporting progress to everyone waiting for this file. */
  private async readBody(res: Response, path: string): Promise<ArrayBuffer> {
    if (!res.body) return res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
      for (const f of this.listeners.get(path) ?? []) f(n);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out.buffer;
  }

  private async fetchCached(path: string): Promise<ArrayBuffer> {
    if (!(path in this.files)) throw new Error(`not found: ${path}`);
    const url = this.urlFor(path);
    const cache = await this.cache;
    const hit = await cache?.match(url);
    if (hit) return hit.arrayBuffer();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // archive.org/download/... redirects to the data server holding the ISO; once that
        // server is known, ask it directly (saves a round trip per file, ~0.6 s)
        const direct = this.directBase && attempt === 0 ? this.directBase + encodeURIComponent(`BASWIN/${path}`) : null;
        const res = await fetch(direct ?? url);
        if (!res.ok) {
          if (direct) this.directBase = null;
          throw new Error(`archive.org: HTTP ${res.status} voor ${path}`);
        }
        if (!direct) this.learnDirectBase(res.url);
        const buf = await this.readBody(res, path);
        if (buf.byteLength !== this.files[path]) throw new Error(`archive.org: onvolledig bestand ${path}`);
        await cache?.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
        return buf;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /** "https://iaNNN.us.archive.org/view_archive.php?archive=...&file=" (null until known). */
  private directBase: string | null = null;

  private learnDirectBase(finalUrl: string) {
    const i = finalUrl.indexOf('&file=');
    if (finalUrl.includes('view_archive.php') && i > 0) this.directBase = finalUrl.slice(0, i + 6);
  }

  /** Worth prefetching: files come from the network one by one. */
  readonly remote = true;

  /** True when a file is already in the local cache. */
  async cached(path: string): Promise<boolean> {
    return !!(await (await this.cache)?.match(this.urlFor(path)));
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
