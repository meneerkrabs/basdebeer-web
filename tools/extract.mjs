#!/usr/bin/env node
// Extract game data from the original "Bas de Beer Collectie" ISOs into public/data/<game>/.
// Usage: node tools/extract.mjs <iso-or-dir> [...]   (needs bsdtar + ffmpeg; fluidsynth optional for MIDI)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public', 'data');
const GAMES = [
  { id: 'paaseiland', match: /PAASEILAND/i },
  { id: 'pirateneiland', match: /PIRATENEILAND/i },
  { id: 'noorderlicht', match: /NOORDERLICHT/i },
];
const SOUNDFONT = process.env.SOUNDFONT || path.join(ROOT, 'tools', 'soundfont.sf2');

const has = (cmd) => spawnSync('which', [cmd]).status === 0;
if (!has('bsdtar')) throw new Error('bsdtar is required (macOS has it; on Linux: apt install libarchive-tools)');
if (!has('ffmpeg')) throw new Error('ffmpeg is required');
const canMidi = has('fluidsynth') && fs.existsSync(SOUNDFONT);
if (!canMidi) console.warn('! fluidsynth or soundfont missing: MIDI files are copied as-is (no music in browser)');

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('Usage: node tools/extract.mjs <iso-or-directory> [...]');
  process.exit(1);
}
const isos = inputs.flatMap((p) =>
  fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter((f) => /\.iso$/i.test(f)).map((f) => path.join(p, f))
    : [p],
);

// Scripts (.BSB) are plain text with every byte shifted by +1 (CR/LF untouched).
const decodeBsb = (buf) => Buffer.from(buf.map((c) => (c === 10 || c === 13 ? c : c - 1)));
const latin1ToUtf8 = (buf) => Buffer.from(buf.toString('latin1'), 'utf8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

for (const iso of isos) {
  const game = GAMES.find((g) => g.match.test(path.basename(iso)));
  if (!game) { console.warn(`skip ${iso} (unknown game)`); continue; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdb-'));
  console.log(`> ${game.id}: extracting ${path.basename(iso)}`);
  execFileSync('bsdtar', ['-xf', iso, '-C', tmp]);
  const src = path.join(tmp, 'BASWIN');
  const dst = path.join(OUT, game.id);
  fs.rmSync(dst, { recursive: true, force: true });
  const manifest = [];
  for (const file of walk(src)) {
    const rel = path.relative(src, file).split(path.sep);
    const ext = path.extname(file).toUpperCase();
    if (ext === '.EXE' || ext === '.DLL') continue;
    const name = rel.map((s) => s.toUpperCase());
    const sub = name.slice(0, -1);
    const base = name.at(-1);
    fs.mkdirSync(path.join(dst, ...sub), { recursive: true });
    const out = (n) => path.join(dst, ...sub, n);
    const buf = fs.readFileSync(file);
    let written;
    if (ext === '.BSB') {
      written = base + '.TXT';
      fs.writeFileSync(out(written), latin1ToUtf8(decodeBsb(buf)));
    } else if (ext === '.TXT') {
      written = base;
      fs.writeFileSync(out(written), latin1ToUtf8(buf));
    } else if (ext === '.AVI') {
      written = base.replace(/\.AVI$/, '.MP4');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-crf', '20', '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart', out(written)]);
    } else if (ext === '.MID' && canMidi) {
      written = base.replace(/\.MID$/, '.M4A');
      const wav = path.join(tmp, 'midi.wav');
      execFileSync('fluidsynth', ['-ni', '-g', '0.8', '-F', wav, '-r', '44100', SOUNDFONT, file]);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '128k', out(written)]);
    } else {
      written = base;
      fs.writeFileSync(out(written), buf);
    }
    manifest.push([...sub, written].join('/'));
  }
  manifest.sort();
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 0));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  ${manifest.length} files -> ${path.relative(ROOT, dst)}`);
}
