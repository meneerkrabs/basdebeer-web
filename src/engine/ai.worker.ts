// Runs the Real-ESRGAN "general-x4v3" network (SRVGGNetCompact) with onnxruntime-web on WebGPU,
// off the main thread. Receives raw framebuffer regions, answers with 4x upscaled RGBA tiles.

import * as ort from 'onnxruntime-web/webgpu';
import wasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import modelUrl from '../assets/realesr-general-x4v3.fp16.onnx?url';
import { DEDITHER_PAD, MARGIN, MODEL_IN, OUT_TILE, REGION, SCALE, type AiJob, type AiOptions, type FromWorker, type ToWorker } from './ai-shared.ts';

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let session: ort.InferenceSession;
let options: AiOptions;
const PLANE = MODEL_IN * MODEL_IN;

// ---- input: optional CPU port of the WebGL de-dither (3x3 gaussian guide -> joint bilateral) ----
const SPATIAL = new Float32Array(25);
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) SPATIAL[(dy + 2) * 5 + dx + 2] = Math.exp(-(dx * dx + dy * dy) / 3);
const RANGE_SIGMA = 0.1;
const RANGE_STEPS = 1024, RANGE_MAX = 0.35; // squared colour distance beyond which the weight is ~0
const RANGE = new Float32Array(RANGE_STEPS);
for (let i = 0; i < RANGE_STEPS; i++) RANGE[i] = Math.exp(-((i / RANGE_STEPS) * RANGE_MAX) / (2 * RANGE_SIGMA * RANGE_SIGMA));
const guide = new Float32Array(REGION * REGION * 3);
const rgb = new Float32Array(REGION * REGION * 3);

function fillInput(job: AiJob, dst: Float32Array, base: number) {
  const d = job.data;
  if (!options.dedither) {
    for (let y = 0; y < MODEL_IN; y++) {
      for (let x = 0; x < MODEL_IN; x++) {
        const s = ((y + DEDITHER_PAD) * REGION + x + DEDITHER_PAD) * 4;
        const o = base + y * MODEL_IN + x;
        dst[o] = d[s] / 255; dst[o + PLANE] = d[s + 1] / 255; dst[o + 2 * PLANE] = d[s + 2] / 255;
      }
    }
    return;
  }
  for (let i = 0, n = REGION * REGION; i < n; i++) { rgb[i * 3] = d[i * 4] / 255; rgb[i * 3 + 1] = d[i * 4 + 1] / 255; rgb[i * 3 + 2] = d[i * 4 + 2] / 255; }
  // guide: gaussian blur, clamped at the region edge
  const GW = [Math.exp(-2 / 2), Math.exp(-1 / 2), 1]; // weight by |dx|+|dy| class: d2 = 2, 1, 0
  for (let y = 0; y < REGION; y++) {
    for (let x = 0; x < REGION; x++) {
      let r = 0, g = 0, b = 0, ws = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(REGION - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(REGION - 1, Math.max(0, x + dx));
          const w = GW[2 - (dx * dx + dy * dy)];
          const s = (yy * REGION + xx) * 3;
          r += rgb[s] * w; g += rgb[s + 1] * w; b += rgb[s + 2] * w; ws += w;
        }
      }
      const o = (y * REGION + x) * 3;
      guide[o] = r / ws; guide[o + 1] = g / ws; guide[o + 2] = b / ws;
    }
  }
  const k = RANGE_STEPS / RANGE_MAX;
  for (let y = 0; y < MODEL_IN; y++) {
    for (let x = 0; x < MODEL_IN; x++) {
      const cy = y + DEDITHER_PAD, cx = x + DEDITHER_PAD;
      const gc = (cy * REGION + cx) * 3;
      const g0 = guide[gc], g1 = guide[gc + 1], g2 = guide[gc + 2];
      let r = 0, g = 0, b = 0, ws = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const q = ((cy + dy) * REGION + cx + dx) * 3;
          const e0 = guide[q] - g0, e1 = guide[q + 1] - g1, e2 = guide[q + 2] - g2;
          const idx = ((e0 * e0 + e1 * e1 + e2 * e2) * k) | 0;
          if (idx >= RANGE_STEPS) continue;
          const w = SPATIAL[(dy + 2) * 5 + dx + 2] * RANGE[idx];
          r += rgb[q] * w; g += rgb[q + 1] * w; b += rgb[q + 2] * w; ws += w;
        }
      }
      const o = base + y * MODEL_IN + x;
      dst[o] = r / ws; dst[o + PLANE] = g / ws; dst[o + 2 * PLANE] = b / ws;
    }
  }
}

// ---- output: crop the margin, CRT colour correction (same maths as the WebGL scale pass), RGBA ----
const GAMMA_STEPS = 4096;
let gammaLut: Float32Array;
let sat = 1;
function setupColour(crt: number) {
  const e = 1 + 0.14 * crt;
  gammaLut = new Float32Array(GAMMA_STEPS + 1);
  for (let i = 0; i <= GAMMA_STEPS; i++) gammaLut[i] = Math.pow(i / GAMMA_STEPS, e);
  sat = 1 + 0.18 * crt;
}

function toRgba(out: Float32Array, base: number, dst: Uint8ClampedArray) {
  const W = MODEL_IN * SCALE, plane = W * W, m = MARGIN * SCALE;
  for (let y = 0; y < OUT_TILE; y++) {
    let s = base + (y + m) * W + m;
    let o = y * OUT_TILE * 4;
    for (let x = 0; x < OUT_TILE; x++, s++, o += 4) {
      let r = out[s], g = out[s + plane], b = out[s + 2 * plane];
      r = r < 0 ? 0 : r > 1 ? 1 : r; g = g < 0 ? 0 : g > 1 ? 1 : g; b = b < 0 ? 0 : b > 1 ? 1 : b;
      r = gammaLut[(r * GAMMA_STEPS + 0.5) | 0]; g = gammaLut[(g * GAMMA_STEPS + 0.5) | 0]; b = gammaLut[(b * GAMMA_STEPS + 0.5) | 0];
      const l = r * 0.299 + g * 0.587 + b * 0.114;
      dst[o] = (l + (r - l) * sat) * 255 + 0.5;
      dst[o + 1] = (l + (g - l) * sat) * 255 + 0.5;
      dst[o + 2] = (l + (b - l) * sat) * 255 + 0.5;
      dst[o + 3] = 255;
    }
  }
}

async function infer(jobs: AiJob[]): Promise<Uint8ClampedArray[]> {
  const n = jobs.length;
  const input = new Float32Array(n * 3 * PLANE);
  jobs.forEach((j, i) => fillInput(j, input, i * 3 * PLANE));
  const res = await session.run({ input: new ort.Tensor('float32', input, [n, 3, MODEL_IN, MODEL_IN]) });
  const out = (await res.output.getData()) as Float32Array;
  res.output.dispose();
  const per = 3 * (MODEL_IN * SCALE) ** 2;
  return jobs.map((_, i) => {
    const px = new Uint8ClampedArray(OUT_TILE * OUT_TILE * 4);
    toRgba(out, i * per, px);
    return px;
  });
}

async function init(opts: AiOptions) {
  options = opts;
  setupColour(opts.crt);
  ort.env.wasm.wasmPaths = { mjs: wasmMjsUrl, wasm: wasmUrl };
  ort.env.wasm.numThreads = 1; // WebGPU does the work; no SharedArrayBuffer / cross-origin isolation needed
  if (!('gpu' in navigator) || !(await navigator.gpu.requestAdapter())) throw new Error('no WebGPU adapter');
  const model = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
  session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
  // compile the shaders now (a throwaway run), so the first real tile is fast
  const t0 = performance.now();
  const blank = { id: -1, data: new Uint8Array(REGION * REGION * 4).fill(128) };
  await infer(Array.from({ length: opts.batch }, () => blank));
  post({ type: 'ready', provider: 'webgpu', fp16: true, warmupMs: performance.now() - t0 });
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') {
    init(m.options).catch((err) => post({ type: 'fail', error: String(err?.stack ?? err) }));
  } else {
    chain = chain.then(async () => {
      const t0 = performance.now();
      const results = await infer(m.jobs);
      post({ type: 'done', ids: m.jobs.map((j) => j.id), results, ms: performance.now() - t0 }, results.map((r) => r.buffer));
    }).catch((err) => post({ type: 'fail', error: String(err?.stack ?? err) }));
  }
};
