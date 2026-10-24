// Asset access for one book on top of a Vfs (the user's ISO/CD, or dev-extracted files).
// File names on the original CD were case-insensitive (scripts mix "yn001.wav" and
// "YN001.WAV"), so all lookups go by upper-case base name.

import { decodeBmp, Surface } from './surface.ts';
import { audio } from './audio.ts';
import type { Vfs } from './vfs.ts';

/** Scripts (.BSB) are plain cp1252 text with every byte shifted by +1 (CR/LF untouched). */
export function decodeBsb(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i] === 10 || b[i] === 13 ? b[i] : b[i] - 1;
  return new TextDecoder('windows-1252').decode(out);
}

export type Book = 'paaseiland' | 'pirateneiland' | 'noorderlicht';

export class Assets {
  readonly book: Book;
  readonly vfs: Vfs;
  private byName = new Map<string, string>(); // UPPER base name -> vfs path
  private images = new Map<string, Promise<Surface>>();
  private sounds = new Map<string, Promise<AudioBuffer>>();

  constructor(book: Book, vfs: Vfs) {
    this.book = book;
    this.vfs = vfs;
    for (const p of vfs.list()) {
      const base = p.split('/').pop()!;
      if (!this.byName.has(base)) this.byName.set(base, p);
      this.byName.set(p, p);
    }
  }

  /** VFS path for a file name as written in the original program/scripts, or null. */
  path(name: string): string | null {
    const key = name.replace(/\\/g, '/').trim().toUpperCase();
    const base = key.split('/').pop()!;
    return this.byName.get(key) ?? this.byName.get(base) ?? null;
  }

  has(name: string) {
    return this.path(name) !== null || this.path(name + '.TXT') !== null;
  }

  /** Progress of files the game is waiting for (not background prefetches), in bytes; (0, 0) = idle. */
  onProgress: ((done: number, total: number) => void) | null = null;
  private fg = { done: 0, total: 0 };
  private fgGen = 0;

  async raw(name: string, quiet = false): Promise<ArrayBuffer> {
    const p = this.path(name);
    if (!p) throw new Error(`bestand niet gevonden: ${name}`);
    if (quiet || !this.vfs.remote) return this.vfs.read(p);
    const size = (this.vfs as { size?(path: string): number }).size?.(p) || 1;
    this.fg.total += size;
    this.onProgress?.(this.fg.done, this.fg.total);
    let seen = 0;
    const gen = this.fgGen;
    try {
      return await this.vfs.read(p, (n) => {
        if (gen !== this.fgGen) return;
        const d = Math.min(n, size) - seen;
        seen += d;
        this.fg.done += d;
        this.onProgress?.(this.fg.done, this.fg.total);
      });
    } finally {
      if (gen === this.fgGen) this.fg.done += size - seen;
      if (this.fg.done >= this.fg.total) { this.fg = { done: 0, total: 0 }; this.fgGen++; }
      this.onProgress?.(this.fg.done, this.fg.total);
    }
  }

  /** Load a BMP as a Surface (cached and shared: clone before drawing into it). */
  image(name: string): Promise<Surface> {
    const k = name.trim().toUpperCase();
    let p = this.images.get(k);
    if (!p) {
      p = this.raw(k).then(decodeBmp);
      this.images.set(k, p);
    }
    return p;
  }

  /** Load a WAV as an AudioBuffer (cached). */
  sound(name: string): Promise<AudioBuffer> {
    const k = name.trim().toUpperCase();
    let p = this.sounds.get(k);
    if (!p) {
      p = this.raw(k).then((b) => audio.decode(b));
      this.sounds.set(k, p);
    }
    return p;
  }

  /** A decoded script (.BSB). Dev extracts may already contain decoded "<name>.TXT". */
  async script(name: string): Promise<string> {
    const text = await this.scriptText(name);
    this.prefetchAround(name, text);
    return text;
  }

  private async scriptText(name: string, quiet = false): Promise<string> {
    const k = name.trim().toUpperCase();
    if (this.path(k)) return decodeBsb(await this.raw(k, quiet));
    return new TextDecoder('utf-8').decode(await this.raw(k + '.TXT', quiet));
  }

  // ---- prefetching (remote sources only): while a page plays, fetch the next page(s)

  private prefetched = new Set<string>();
  private queue: (() => Promise<unknown>)[] = [];
  private running = 0;

  private enqueue(key: string, job: () => Promise<unknown>) {
    if (this.prefetched.has(key)) return;
    this.prefetched.add(key);
    this.queue.push(job);
    this.pump();
  }

  private pump() {
    while (this.running < 4 && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      job().catch(() => {}).finally(() => { this.running--; this.pump(); });
    }
  }

  private static filesIn(text: string): string[] {
    return [...new Set([...text.matchAll(/[\w-]+\.(?:BMP|WAV|AVI|MID)/gi)].map((m) => m[0].toUpperCase()))];
  }

  /** Scripts a page can continue to ({NEXT_SCENE}), as file names that exist. */
  private nextScripts(name: string, text: string): string[] {
    const suffix = /\d[A-Z]*?([ND])\.BSB$/i.exec(name)?.[1]?.toUpperCase() ?? ''; // Noorderlicht N/D pages
    const out: string[] = [];
    for (const m of text.matchAll(/\{NEXT_SCENE\}([^~\r\n]+)~/g)) {
      const v = m[1].trim().toUpperCase();
      const candidates = /^\d+$/.test(v) ? [`${v.padStart(3, '0')}.BSB`, `${v}${suffix}.BSB`, `${v}N.BSB`] : [`${v}${suffix}.BSB`, `${v}.BSB`, `${v}N.BSB`];
      const hit = candidates.find((c) => this.has(c));
      if (hit) out.push(hit);
    }
    return [...new Set(out)];
  }

  private prefetchAround(name: string, text: string) {
    if (!this.vfs.remote) return;
    for (const f of Assets.filesIn(text)) if (this.path(f)) this.enqueue(f, () => this.raw(f, true));
    for (const next of this.nextScripts(name, text)) {
      this.enqueue(`script:${next}`, async () => {
        const t = await this.scriptText(next, true);
        for (const f of Assets.filesIn(t)) if (this.path(f)) this.enqueue(f, () => this.raw(f, true));
      });
    }
  }

  /** A cp1252 text file from the CD root (outside BASWIN). */
  async rootText(name: string): Promise<string> {
    if (!this.vfs.readRoot) throw new Error('no root access');
    return new TextDecoder('windows-1252').decode(await this.vfs.readRoot(name));
  }

  /** A plain cp1252 text/data file. */
  async text(name: string): Promise<string> {
    return new TextDecoder('windows-1252').decode(await this.raw(name));
  }

  /** Preload a batch (missing files are logged, not fatal). */
  async preload(names: string[]) {
    await Promise.all(
      names.filter(Boolean).map((n) => {
        const ext = n.split('.').pop()!.toUpperCase();
        const p: Promise<unknown> = ext === 'BMP' ? this.image(n) : ext === 'WAV' ? this.sound(n) : Promise.resolve();
        return p.catch((e) => console.warn(e.message));
      }),
    );
  }
}
