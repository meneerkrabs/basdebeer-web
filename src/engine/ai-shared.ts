// Constants and message types shared by the AI upscaler (ai.ts) and its worker (ai.worker.ts).

/** Edge of a tile's core in screen pixels; the model upscales a tile by SCALE. */
export const TILE = 64;
/** Context around the core that the network sees, so neighbouring tiles blend seamlessly. */
export const MARGIN = 8;
/** Extra pixels around the model input that the (optional) CPU de-dither filter needs. */
export const DEDITHER_PAD = 3;
export const SCALE = 4;
export const MODEL_IN = TILE + 2 * MARGIN;
export const REGION = MODEL_IN + 2 * DEDITHER_PAD;
export const OUT_TILE = TILE * SCALE;

export interface AiOptions {
  /** Feed the network a de-dithered tile (bilateral filter, like the WebGL smooth mode) instead of raw pixels. */
  dedither: boolean;
  /** CRT colour correction strength baked into the result (same as Presenter.crt). */
  crt: number;
  /** Tiles per network run. */
  batch: number;
}

export interface AiJob {
  id: number;
  /** REGION x REGION RGBA pixels (edge-replicated outside the screen). */
  data: Uint8Array;
}

export type ToWorker =
  | { type: 'init'; options: AiOptions }
  | { type: 'run'; jobs: AiJob[] };

export type FromWorker =
  | { type: 'ready'; provider: string; fp16: boolean; warmupMs: number }
  | { type: 'fail'; error: string }
  /** Results in the same order as the jobs; each is OUT_TILE x OUT_TILE RGBA. */
  | { type: 'done'; ids: number[]; results: Uint8ClampedArray[]; ms: number };
