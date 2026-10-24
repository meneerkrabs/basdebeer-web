// Optional AI super-resolution on top of the 'smooth' look: the 640x480 (or 800x600) framebuffer is
// cut into 64x64 tiles, every tile is hashed each frame, and tiles that have settled are upscaled 4x
// by a small Real-ESRGAN network (ai.worker.ts, WebGPU, off the main thread). The result lives on a
// 4x canvas that sits exactly over the WebGL canvas (under the text layer). A tile that changed and
// has no fresh AI result yet is cleared, so the smooth image shows through -- stale AI pixels are
// never visible. The games keep running on the original low-res pixels.

import { MARGIN, OUT_TILE, REGION, DEDITHER_PAD, SCALE, TILE, type AiJob, type AiOptions, type FromWorker, type ToWorker } from './ai-shared.ts';

/** WebGPU is the only supported runtime; without it 'ai' silently behaves like 'smooth'. */
export const aiSupported = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator;

const query = new URLSearchParams(globalThis.location?.search ?? '');
export const AiConfig = {
  /** ?aiin=raw feeds raw framebuffer pixels instead of the de-dithered tile (for comparing). */
  dedither: query.get('aiin') !== 'raw',
  /** Tiles per network run (?aibatch=). */
  batch: Number(query.get('aibatch') ?? 4),
  /** Frames a tile must stay unchanged before it is queued (animated tiles are never upscaled). */
  stableFrames: Number(query.get('aistable') ?? 4),
  /** Network runs in flight at once. */
  maxInflight: 2,
};

export interface AiStats { ready: boolean; failed: boolean; tilesDone: number; tileMs: number[]; warmupMs: number; firstFullMs: number | null }

/** One shared worker (and WebGPU session) for every Display. */
class AiEngine {
  private worker: Worker | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private handlers = new Map<number, (px: Uint8ClampedArray) => void>();
  private nextId = 0;
  private batchDone: ((ms: number, n: number) => void)[] = [];
  warmupMs = 0;
  ok = false;
  failed = false;

  start(crt: number): Promise<boolean> {
    this.readyPromise ??= new Promise<boolean>((resolve) => {
      if (!aiSupported()) { this.failed = true; resolve(false); return; }
      const w = (this.worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' }));
      w.onerror = (e) => { console.warn('AI worker error', e.message); this.fail(resolve); };
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'ready') { this.ok = true; this.warmupMs = m.warmupMs; resolve(true); }
        else if (m.type === 'fail') { console.warn('AI upscaling unavailable:', m.error); this.fail(resolve); }
        else {
          m.ids.forEach((id, i) => { this.handlers.get(id)?.(m.results[i]); this.handlers.delete(id); });
          this.batchDone.shift()?.(m.ms, m.ids.length);
        }
      };
      const options: AiOptions = { dedither: AiConfig.dedither, crt, batch: AiConfig.batch };
      w.postMessage({ type: 'init', options } satisfies ToWorker);
    });
    return this.readyPromise;
  }

  private fail(resolve: (ok: boolean) => void) {
    this.failed = true;
    this.ok = false;
    this.worker?.terminate();
    this.worker = null;
    resolve(false);
  }

  /** Queue a batch; results arrive through `onResult`. Returns the job ids. */
  run(datas: Uint8Array[], onResult: (index: number, px: Uint8ClampedArray) => void, onBatch: (ms: number, n: number) => void): void {
    if (!this.worker) return;
    const jobs: AiJob[] = datas.map((data, i) => {
      const id = this.nextId++;
      this.handlers.set(id, (px) => onResult(i, px));
      return { id, data };
    });
    this.batchDone.push(onBatch);
    this.worker.postMessage({ type: 'run', jobs } satisfies ToWorker, jobs.map((j) => j.data.buffer));
  }
}
export const aiEngine = new AiEngine();

const S = { Empty: 0, Queued: 1, Inflight: 2, Done: 3 } as const;

export class AiUpscaler {
  readonly canvas: HTMLCanvasElement;
  readonly stats: AiStats = { ready: false, failed: false, tilesDone: 0, tileMs: [], warmupMs: 0, firstFullMs: null };
  private ctx: CanvasRenderingContext2D;
  private cols: number;
  private rows: number;
  private hashA: Uint32Array;
  private hashB: Uint32Array;
  private stable: Uint8Array;
  private state: Uint8Array;
  private pending = new Set<number>();
  private inflight = 0;
  private active = false;
  private startedAt = performance.now();

  private w: number;
  private h: number;

  constructor(w: number, h: number, crt: number) {
    this.w = w;
    this.h = h;
    this.cols = Math.ceil(w / TILE);
    this.rows = Math.ceil(h / TILE);
    const n = this.cols * this.rows;
    this.hashA = new Uint32Array(n);
    this.hashB = new Uint32Array(n);
    this.stable = new Uint8Array(n);
    this.state = new Uint8Array(n);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bdb-ai';
    this.canvas.width = w * SCALE;
    this.canvas.height = h * SCALE;
    this.canvas.hidden = true;
    this.ctx = this.canvas.getContext('2d')!;
    aiEngine.start(crt).then((ok) => {
      this.active = ok;
      this.stats.ready = ok;
      this.stats.failed = !ok;
      this.stats.warmupMs = aiEngine.warmupMs;
      this.canvas.hidden = !ok;
    });
  }

  /** Called every frame with the composed framebuffer (0x00BBGGRR). */
  update(px: Uint32Array) {
    if (!this.active) return;
    const { cols, rows, w, h } = this;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const t = ty * cols + tx;
        // hash everything the network can see of this tile: core + margin + de-dither padding
        const x0 = tx * TILE - MARGIN - DEDITHER_PAD, y0 = ty * TILE - MARGIN - DEDITHER_PAD;
        let a = 0x811c9dc5, b = 0x9e3779b9;
        for (let y = 0; y < REGION; y++) {
          const yy = Math.min(h - 1, Math.max(0, y0 + y)) * w;
          for (let x = 0; x < REGION; x++) {
            const v = px[yy + Math.min(w - 1, Math.max(0, x0 + x))];
            a = Math.imul(a ^ v, 0x01000193);
            b = Math.imul(b + v, 0x85ebca6b) ^ (b >>> 13);
          }
        }
        a >>>= 0; b >>>= 0; // Uint32Array stores unsigned values
        if (a !== this.hashA[t] || b !== this.hashB[t]) {
          this.hashA[t] = a; this.hashB[t] = b; this.stable[t] = 0;
          if (this.state[t] !== S.Empty) { this.clearTile(tx, ty); this.state[t] = S.Empty; this.pending.delete(t); }
        } else if (this.stable[t] < 255) {
          this.stable[t]++;
        }
        if (this.stable[t] >= AiConfig.stableFrames && this.state[t] === S.Empty) { this.state[t] = S.Queued; this.pending.add(t) }
      }
    }
    this.dispatch(px);
  }

  private dispatch(px: Uint32Array) {
    if (this.inflight >= AiConfig.maxInflight || this.pending.size === 0) return;
    const tiles: number[] = [];
    for (const t of this.pending) { tiles.push(t); if (tiles.length >= AiConfig.batch) break; }
    const sent = tiles.map((t) => ({ t, a: this.hashA[t], b: this.hashB[t] }));
    const datas = tiles.map((t) => this.extract(px, t % this.cols, Math.floor(t / this.cols)));
    for (const t of tiles) { this.pending.delete(t); this.state[t] = S.Inflight; }
    this.inflight++;
    aiEngine.run(datas, (i, result) => {
      const { t, a, b } = sent[i];
      // only show a result that still matches what the tile looks like now
      if (a !== this.hashA[t] || b !== this.hashB[t]) return;
      this.draw(t, result);
      this.state[t] = S.Done;
      this.pending.delete(t);
      this.stats.tilesDone++;
      if (this.stats.firstFullMs === null && this.state.every((s) => s === S.Done)) this.stats.firstFullMs = performance.now() - this.startedAt;
    }, (ms, n) => {
      this.inflight--;
      this.stats.tileMs.push(ms / n);
    });
  }

  private extract(px: Uint32Array, tx: number, ty: number): Uint8Array {
    const { w, h } = this;
    const out = new Uint32Array(REGION * REGION);
    const x0 = tx * TILE - MARGIN - DEDITHER_PAD, y0 = ty * TILE - MARGIN - DEDITHER_PAD;
    for (let y = 0; y < REGION; y++) {
      const yy = Math.min(h - 1, Math.max(0, y0 + y)) * w;
      for (let x = 0; x < REGION; x++) out[y * REGION + x] = px[yy + Math.min(w - 1, Math.max(0, x0 + x))];
    }
    return new Uint8Array(out.buffer);
  }

  private draw(t: number, rgba: Uint8ClampedArray) {
    const tx = t % this.cols, ty = Math.floor(t / this.cols);
    const vw = Math.min(TILE, this.w - tx * TILE) * SCALE, vh = Math.min(TILE, this.h - ty * TILE) * SCALE;
    this.ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, OUT_TILE, OUT_TILE), tx * OUT_TILE, ty * OUT_TILE, 0, 0, vw, vh);
  }

  private clearTile(tx: number, ty: number) {
    this.ctx.clearRect(tx * OUT_TILE, ty * OUT_TILE, OUT_TILE, OUT_TILE);
  }

  /** Match the WebGL canvas exactly (CSS px). */
  place(style: Partial<CSSStyleDeclaration>) {
    Object.assign(this.canvas.style, style);
  }
}
