// Compare our CRAM decoder against ffmpeg for a few frames: node tools/test-avi.ts <file.avi>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Avi } from '../src/engine/avi.ts';
import { Surface } from '../src/engine/surface.ts';

const file = process.argv[2];
const buf = readFileSync(file);
const avi = new Avi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log(`${avi.width}x${avi.height} @${avi.fps}fps, ${avi.frames.length} frames, audio`, avi.audio && { ...avi.audio, chunks: avi.audio.chunks.length });
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
const fsz = avi.width * avi.height * 3;
const s = new Surface(avi.width, avi.height);
let bad = 0;
for (const n of [0, 1, 10, 100, Math.floor(avi.frames.length / 2), avi.frames.length - 1]) {
  avi.frame(n, s);
  let diff = 0;
  for (let i = 0; i < avi.width * avi.height; i++) {
    const o = n * fsz + i * 3, c = s.px[i];
    if ((c & 255) !== raw[o] || ((c >> 8) & 255) !== raw[o + 1] || ((c >> 16) & 255) !== raw[o + 2]) diff++;
  }
  console.log(`frame ${n}: ${diff} differing pixels`);
  bad += diff;
}
const a = avi.audioSamples();
console.log('audio samples', a?.data[0].length, 'rate', a?.rate, 'duration', a && a.data[0].length / a.rate);
process.exit(bad ? 1 : 0);
