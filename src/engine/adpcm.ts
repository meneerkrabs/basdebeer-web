// WAV files with ADPCM compression (format tags 0x0011 IMA/DVI and 0x0002 Microsoft). The Noorderlicht CD stores
// most of its sound that way and browsers' decodeAudioData cannot read it, so it is decoded here.

const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

interface Pcm { channels: number; rate: number; data: Float32Array[] }

/** Decode an ADPCM WAV to float PCM, or null when `buf` is not an ADPCM WAV. */
export function decodeAdpcmWav(buf: ArrayBuffer): Pcm | null {
  const v = new DataView(buf);
  if (buf.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return null;
  let fmt = 0, channels = 0, rate = 0, align = 0, perBlock = 0, coefs: number[] = [], dataAt = -1, dataLen = 0;
  for (let p = 12; p + 8 <= buf.byteLength;) {
    const id = v.getUint32(p, false), len = v.getUint32(p + 4, true);
    if (id === 0x666d7420) { // "fmt "
      fmt = v.getUint16(p + 8, true);
      channels = v.getUint16(p + 10, true);
      rate = v.getUint32(p + 12, true);
      align = v.getUint16(p + 20, true);
      if (len >= 22) perBlock = v.getUint16(p + 26, true);
      if (fmt === 2 && len >= 26) {
        const n = v.getUint16(p + 28, true);
        for (let i = 0; i < n * 2; i++) coefs.push(v.getInt16(p + 30 + i * 2, true));
      }
    } else if (id === 0x64617461) { // "data"
      dataAt = p + 8;
      dataLen = Math.min(len, buf.byteLength - dataAt);
      break;
    }
    p += 8 + len + (len & 1);
  }
  if ((fmt !== 0x11 && fmt !== 2) || dataAt < 0 || channels < 1 || channels > 2 || align < 4 * channels) return null;
  if (fmt === 2 && coefs.length === 0) coefs = [256, 0, 512, -256, 0, 0, 192, 64, 240, 0, 460, -208, 392, -232];
  const out: number[][] = Array.from({ length: channels }, () => []);
  for (let b = 0; b < dataLen; b += align) {
    const end = Math.min(b + align, dataLen);
    if (fmt === 0x11) decodeImaBlock(v, dataAt + b, dataAt + end, channels, out);
    else decodeMsBlock(v, dataAt + b, dataAt + end, channels, coefs, out);
  }
  void perBlock;
  return { channels, rate, data: out.map((c) => Float32Array.from(c, (s) => s / 32768)) };
}

function decodeImaBlock(v: DataView, at: number, end: number, ch: number, out: number[][]) {
  const pred: number[] = [], idx: number[] = [];
  for (let c = 0; c < ch; c++) {
    pred[c] = v.getInt16(at + c * 4, true);
    idx[c] = Math.min(88, v.getUint8(at + c * 4 + 2));
    out[c].push(pred[c]);
  }
  for (let p = at + 4 * ch; p + 4 * ch <= end; p += 4 * ch) {
    for (let c = 0; c < ch; c++) {
      for (let i = 0; i < 4; i++) {
        const byte = v.getUint8(p + c * 4 + i);
        for (const nib of [byte & 15, byte >> 4]) {
          const step = STEP[idx[c]];
          let diff = step >> 3;
          if (nib & 1) diff += step >> 2;
          if (nib & 2) diff += step >> 1;
          if (nib & 4) diff += step;
          pred[c] = clamp16(pred[c] + (nib & 8 ? -diff : diff));
          idx[c] = Math.max(0, Math.min(88, idx[c] + INDEX[nib & 7]));
          out[c].push(pred[c]);
        }
      }
    }
  }
}

function decodeMsBlock(v: DataView, at: number, end: number, ch: number, coefs: number[], out: number[][]) {
  if (end - at < 7 * ch) return;
  const bp: number[] = [], delta: number[] = [], s1: number[] = [], s2: number[] = [];
  let p = at;
  for (let c = 0; c < ch; c++) bp[c] = Math.min(coefs.length / 2 - 1, v.getUint8(p++));
  for (let c = 0; c < ch; c++, p += 2) delta[c] = v.getInt16(p, true);
  for (let c = 0; c < ch; c++, p += 2) s1[c] = v.getInt16(p, true);
  for (let c = 0; c < ch; c++, p += 2) s2[c] = v.getInt16(p, true);
  for (let c = 0; c < ch; c++) out[c].push(s2[c]);
  for (let c = 0; c < ch; c++) out[c].push(s1[c]);
  let c = 0;
  const nibble = (nib: number) => {
    const signed = nib & 8 ? nib - 16 : nib;
    const q = ((s1[c] * coefs[bp[c] * 2] + s2[c] * coefs[bp[c] * 2 + 1]) >> 8) + signed * delta[c];
    const s = clamp16(q);
    s2[c] = s1[c];
    s1[c] = s;
    delta[c] = Math.max(16, (MS_ADAPT[nib] * delta[c]) >> 8);
    out[c].push(s);
    c = (c + 1) % ch;
  };
  for (; p < end; p++) {
    const byte = v.getUint8(p);
    nibble(byte >> 4);
    nibble(byte & 15);
  }
}
