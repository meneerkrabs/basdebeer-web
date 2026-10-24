// Shared by the GMG and GSD ports: load a WAV for a minigame without ever failing.
import type { Assets } from '../../engine/assets.ts';
import { audio } from '../../engine/audio.ts';

/** Duration in seconds of a RIFF/WAVE file from its header (0 when unknown). */
export function wavSeconds(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  let p = 12, avg = 0, data = 0;
  while (p + 8 <= buf.byteLength) {
    const id = v.getUint32(p, false), size = v.getUint32(p + 4, true);
    if (id === 0x666d7420 && p + 20 <= buf.byteLength) avg = v.getUint32(p + 16, true); // "fmt " avg bytes/s
    if (id === 0x64617461) { data = size; break; } // "data"
    p += 8 + size + (size & 1);
  }
  return avg > 0 ? data / avg : 0;
}

/**
 * A decoded WAV. When the browser cannot decode it (old IMA-ADPCM files in some browsers), silence of the same
 * length stands in, so the game's timing (which waits for sounds to end) still works.
 */
export async function loadWav(assets: Assets, name: string): Promise<AudioBuffer> {
  try {
    return await assets.sound(name);
  } catch (e) {
    console.warn(`${name}: cannot decode, using silence`, e);
    let secs = 0;
    try { secs = wavSeconds(await assets.raw(name)); } catch { /* missing file */ }
    return audio.ctx.createBuffer(1, Math.max(1, Math.round(secs * 22050)), 22050);
  }
}
