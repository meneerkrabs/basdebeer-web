// AVI playback straight from the CD files: RIFF/AVI demuxer, Microsoft Video 1 (CRAM)
// 8-bit decoder and unsigned 8/16-bit PCM audio. The Bas de Beer movies are all
// msvideo1 pal8 at 15 fps with 22 kHz mono u8 PCM.

import { audio } from './audio.ts';
import { rgb, Surface } from './surface.ts';
import { onSkip } from './skip.ts';

interface Chunk { off: number; size: number }

export class Avi {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: Chunk[] = []; // video frame chunks ('00dc'/'00db'); palette changes interleaved
  private palChanges = new Map<number, Chunk[]>(); // frame index -> '00pc' chunks before it
  readonly audio: { rate: number; channels: number; bits: number; chunks: Chunk[] } | null;
  private bytes: Uint8Array;
  private view: DataView;
  private palette = new Uint32Array(256);
  private indices: Uint8Array;
  private decoded = -1;
  private compression: string;

  constructor(buf: ArrayBuffer) {
    this.bytes = new Uint8Array(buf);
    this.view = new DataView(buf);
    const fourcc = (o: number) => String.fromCharCode(this.bytes[o], this.bytes[o + 1], this.bytes[o + 2], this.bytes[o + 3]);
    if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'AVI ') throw new Error('not an AVI');
    let width = 0, height = 0, fps = 15, compression = '';
    let audioFmt: { rate: number; channels: number; bits: number } | null = null;
    const audioChunks: Chunk[] = [];
    let streamType = '';
    let streamIndex = -1;
    const walk = (start: number, end: number) => {
      let o = start;
      while (o + 8 <= end) {
        const id = fourcc(o), size = this.view.getUint32(o + 4, true);
        const body = o + 8;
        if (id === 'LIST') {
          const kind = fourcc(body);
          if (kind === 'strl') streamIndex++;
          walk(body + 4, body + size);
        } else if (id === 'avih') {
          const usPerFrame = this.view.getUint32(body, true);
          if (usPerFrame) fps = 1e6 / usPerFrame;
        } else if (id === 'strh') {
          streamType = fourcc(body);
          if (streamType === 'vids') {
            const scale = this.view.getUint32(body + 20, true), rate = this.view.getUint32(body + 24, true);
            if (scale && rate) fps = rate / scale;
          }
        } else if (id === 'strf') {
          if (streamType === 'vids') {
            width = this.view.getInt32(body + 4, true);
            height = Math.abs(this.view.getInt32(body + 8, true));
            compression = fourcc(body + 16);
            const hdr = this.view.getUint32(body, true);
            const used = this.view.getUint32(body + 32, true) || 256;
            for (let i = 0; i < used && body + hdr + i * 4 + 3 < body + size; i++) {
              const p = body + hdr + i * 4;
              this.palette[i] = rgb(this.bytes[p + 2], this.bytes[p + 1], this.bytes[p]);
            }
          } else if (streamType === 'auds') {
            audioFmt = { channels: this.view.getUint16(body + 2, true), rate: this.view.getUint32(body + 4, true), bits: this.view.getUint16(body + 14, true) };
          }
        } else if (/^\d\d(dc|db)$/.test(id)) {
          this.frames.push({ off: body, size });
        } else if (/^\d\dpc$/.test(id)) {
          const k = this.frames.length;
          if (!this.palChanges.has(k)) this.palChanges.set(k, []);
          this.palChanges.get(k)!.push({ off: body, size });
        } else if (/^\d\dwb$/.test(id)) {
          audioChunks.push({ off: body, size });
        }
        o = body + size + (size & 1);
      }
    };
    walk(12, this.bytes.length);
    void streamIndex;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.compression = compression.toUpperCase();
    this.audio = audioFmt ? { ...(audioFmt as { rate: number; channels: number; bits: number }), chunks: audioChunks } : null;
    this.indices = new Uint8Array(width * height);
  }

  get duration() {
    return this.frames.length / this.fps;
  }

  /** Decode the audio track into Float32 channels. */
  audioSamples(): { rate: number; data: Float32Array[] } | null {
    const a = this.audio;
    if (!a || !a.chunks.length) return null;
    const bytesPer = (a.bits / 8) * a.channels;
    const total = a.chunks.reduce((n, c) => n + Math.floor(c.size / bytesPer), 0);
    const data = Array.from({ length: a.channels }, () => new Float32Array(total));
    let i = 0;
    for (const c of a.chunks) {
      const n = Math.floor(c.size / bytesPer);
      for (let s = 0; s < n; s++, i++) {
        for (let ch = 0; ch < a.channels; ch++) {
          const p = c.off + s * bytesPer + ch * (a.bits / 8);
          data[ch][i] = a.bits === 8 ? (this.bytes[p] - 128) / 128 : this.view.getInt16(p, true) / 32768;
        }
      }
    }
    return { rate: a.rate, data };
  }

  /** Decode up to frame `n` (frames are deltas) and draw it into `out` (width x height). */
  frame(n: number, out: Surface) {
    n = Math.max(0, Math.min(this.frames.length - 1, n));
    if (n < this.decoded) { this.decoded = -1; this.indices.fill(0); }
    while (this.decoded < n) {
      this.decoded++;
      for (const pc of this.palChanges.get(this.decoded) ?? []) this.applyPalChange(pc);
      const f = this.frames[this.decoded];
      if (f.size) this.decodeCram8(f.off, f.size);
    }
    const w = this.width;
    for (let i = 0; i < this.indices.length && i < out.px.length; i++) out.px[i] = this.palette[this.indices[i]];
    void w;
  }

  private applyPalChange(c: Chunk) {
    const first = this.bytes[c.off], count = this.bytes[c.off + 1] || 256;
    for (let i = 0; i < count; i++) {
      const p = c.off + 4 + i * 4;
      if (p + 2 >= c.off + c.size) break;
      this.palette[(first + i) & 255] = rgb(this.bytes[p], this.bytes[p + 1], this.bytes[p + 2]);
    }
  }

  /** Microsoft Video 1, 8-bit (after FFmpeg's msvideo1_decode_8bit). Image is top-down here. */
  private decodeCram8(off: number, size: number) {
    if (this.compression !== 'CRAM' && this.compression !== 'MSVC' && this.compression !== 'WHAM') {
      throw new Error(`unsupported AVI codec ${this.compression}`);
    }
    const b = this.bytes, px = this.indices, stride = this.width;
    const end = off + size;
    let sp = off;
    const blocksWide = this.width >> 2, blocksHigh = this.height >> 2;
    let total = blocksWide * blocksHigh, skip = 0;
    const colors = new Uint8Array(8);
    for (let by = blocksHigh; by > 0; by--) {
      let blockPtr = (by * 4 - 1) * stride;
      for (let bx = blocksWide; bx > 0; bx--) {
        if (skip) { blockPtr += 4; skip--; total--; continue; }
        if (sp + 2 > end) return;
        let p = blockPtr;
        const a = b[sp++], c = b[sp++];
        if (a === 0 && c === 0 && total === 0) return;
        if ((c & 0xfc) === 0x84) {
          skip = ((c - 0x84) << 8) + a - 1;
        } else if (c < 0x80) {
          let flags = (c << 8) | a;
          colors[0] = b[sp++]; colors[1] = b[sp++];
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++, flags >>= 1) px[p++] = colors[(flags & 1) ^ 1];
            p -= stride + 4;
          }
        } else if (c >= 0x90) {
          let flags = (c << 8) | a;
          for (let i = 0; i < 8; i++) colors[i] = b[sp++];
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++, flags >>= 1) px[p++] = colors[((y & 2) << 1) + (x & 2) + ((flags & 1) ^ 1)];
            p -= stride + 4;
          }
        } else {
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) px[p++] = a;
            p -= stride + 4;
          }
        }
        blockPtr += 4;
        total--;
      }
    }
  }
}

/** Play an AVI into a surface at (x,y), native size, with its audio; frame timing follows the audio clock. */
export function playAvi(avi: Avi, target: Surface, x: number, y: number): { stop: () => void; playing: boolean } {
  const frame = new Surface(avi.width, avi.height);
  const samples = avi.audioSamples();
  let src: AudioBufferSourceNode | null = null;
  const t0 = audio.ctx.currentTime + 0.05;
  if (samples) {
    const buf = audio.ctx.createBuffer(samples.data.length, samples.data[0].length, samples.rate);
    samples.data.forEach((d, i) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, i));
    src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.master);
    src.start(t0);
  }
  const state = { playing: true, stop: () => {} };
  let last = -1;
  const step = () => {
    if (!state.playing) return;
    const t = audio.ctx.currentTime - t0;
    const n = Math.floor(t * avi.fps);
    if (n >= avi.frames.length) { state.stop(); return; }
    if (n >= 0 && n !== last) {
      avi.frame(n, frame);
      target.bitBlt(x, y, avi.width, avi.height, frame, 0, 0);
      last = n;
    }
    requestAnimationFrame(step);
  };
  const unregister = onSkip(() => state.stop());
  state.stop = () => {
    unregister();
    state.playing = false;
    try { src?.stop(); } catch { /* not started */ }
  };
  requestAnimationFrame(step);
  return state;
}
