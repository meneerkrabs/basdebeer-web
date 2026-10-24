// "BerenBios" (BBIOS32.EXE, TMainForm): the bear cinema that plays the three book movies.
// Spec: docs/re/pirateneiland-engine.md section 9; details from decomp/BBIOS32.c
// (MainImageMouseDown_428914, Timer1Timer_428d5c, FUN_00428724 play movie, FUN_0042902c end of movie).
//
// State bytes of the original (+0x1b9): 0 idle, 0xb sign sliding up, 0xc sliding down, 0xd waiting for
// JA/NEE, 0xe input blocked while a WAV plays; +0x1ba = 1 while a movie plays.

import { audio, MediaPlayer, SND_ASYNC } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { Avi } from '../../engine/avi.ts';
import { Surface } from '../../engine/surface.ts';
import { onSkip, skipMedia } from '../../engine/skip.ts';
import { Form, type Display } from '../../engine/vcl.ts';
import { isMovieSeen, loadSign, ptInRect, QuitSign, type Rect } from './shared.ts';

const POSTERS: { movie: number; rect: Rect }[] = [
  { movie: 1, rect: [79, 9, 229, 212] },
  { movie: 2, rect: [253, 10, 399, 210] },
  { movie: 3, rect: [418, 8, 571, 210] },
];
const EXIT_ICON_CLICK: Rect = [570, 420, 621, 471];
const EXIT_ICON_HOVER: Rect = [570, 420, 620, 470];
const STOP_MOVIE: Rect = [573, 421, 602, 462];
const SIGN_RECTS = { ja: [255, 335, 305, 371] as Rect, nee: [324, 338, 386, 372] as Rect };
/** AVI display rectangle: native size at (200,100). */
const AVI_AT = [200, 100] as const;

export async function runBerenBios(display: Display, assets: Assets): Promise<void> {
  const [cinema, sign, startWav, endWav, notYetWav, hoverWav] = await Promise.all([
    assets.image('BB001.BMP'), loadSign(assets),
    assets.sound('BB001.WAV').catch(() => null), assets.sound('BB002.WAV').catch(() => null),
    assets.sound('BB003.WAV').catch(() => null), assets.sound('MNU002.WAV').catch(() => null),
  ]);
  const form = new Form(display, 640, 480, 'bios');
  form.center();
  const work = form.surface;
  const player = new MediaPlayer(); // TMediaPlayer for the WAVs (state 0xe waits for it to stop)
  const playWave = (b: AudioBuffer | null) => { player.stop(); if (b) { player.open(b); player.play(); } };
  const quit = new QuitSign(work, sign.yn, sign.mask, sign.question, SIGN_RECTS, playWave, () => player.stop());

  const drawBackdrop = (img: Surface) => work.bitBlt(0, 0, 640, 480, img, 0, 0);

  return new Promise<void>((resolve) => {
    let waiting = false; // state 0xe
    let hoverExit = false;
    let movie: { stop: () => void } | null = null; // +0x1ba
    let loading = false; // a movie file is being fetched
    let exitAsked = false;

    const finish = () => { display.skipProvider = null; player.close(); form.close(); resolve(); };

    // End of a movie (end of file, or the stop icon): "end" jingle, back to the cinema.
    const endMovie = () => {
      movie?.stop();
      movie = null;
      player.stop();
      playWave(endWav);
      waiting = true;
      drawBackdrop(cinema);
    };

    const startMovie = async (n: number) => {
      loading = true;
      work.fillRect(0, 0, 640, 480, 0);
      const backdrop = await assets.image(`BB00${n + 1}.BMP`).catch(() => null);
      if (backdrop) drawBackdrop(backdrop);
      form.cursor = 'wait';
      let avi: Avi | null = null;
      try { avi = new Avi(await assets.raw(`BB00${n}.AVI`)); } catch (e) { console.error(`BB00${n}.AVI kan niet worden afgespeeld`, e); }
      form.cursor = 'default';
      loading = false;
      if (!avi) { drawBackdrop(cinema); return; }
      movie = playAvi(avi, work, AVI_AT[0], AVI_AT[1], endMovie);
    };

    // Timer1: no Interval in the DFM, so it ticks at the VCL default of 1 s until the sign needs 50 ms.
    const timer = form.timer(1000, () => {
      if (waiting && !player.playing) { player.stop(); waiting = false; }
      if (quit.active) {
        const r = quit.tick();
        if (r === 'yes' && exitAsked) finish();
        else if (r) exitAsked = false;
      }
    });

    form.onMouseMove = (_s, x, y) => {
      if (quit.active || waiting || movie || loading) return;
      if (ptInRect(EXIT_ICON_HOVER, x, y)) {
        if (!hoverExit) { hoverExit = true; audio.sndPlaySound(hoverWav, SND_ASYNC); }
      } else if (hoverExit) {
        hoverExit = false;
        audio.sndPlaySound(null);
      }
    };

    form.onMouseDown = (_b, _s, x, y) => {
      if (movie) {
        if (ptInRect(STOP_MOVIE, x, y)) endMovie();
        return;
      }
      if (quit.phase === 'wait') { quit.click(x, y); return; }
      if (quit.active || waiting || loading) return;
      for (const p of POSTERS) {
        if (!ptInRect(p.rect, x, y)) continue;
        if (isMovieSeen(p.movie)) void startMovie(p.movie);
        else { playWave(notYetWav); waiting = true; } // "not yet": BB003.WAV, input blocked while it plays
        return;
      }
      if (ptInRect(EXIT_ICON_CLICK, x, y)) {
        exitAsked = true;
        quit.open();
        timer.setInterval(50);
      }
    };

    // "Sla over" (not in the original): a playing film can be ended early, like the stop icon
    display.skipProvider = () => (movie ? { label: 'Film overslaan ⏭', action: () => skipMedia() } : null);

    // start screen: the cinema plus BB001.WAV, input blocked until the WAV has finished
    drawBackdrop(cinema);
    playWave(startWav);
    waiting = true;
    form.show();
  });
}

/** Play an AVI into a surface at (x,y), native size, with its audio; frame timing follows the audio clock. */
function playAvi(avi: Avi, target: Surface, x: number, y: number, onEnd: () => void): { stop: () => void } {
  const frame = new Surface(avi.width, avi.height);
  const samples = avi.audioSamples();
  const ctx = audio.ctx;
  const useAudioClock = ctx.state === 'running';
  const now = () => (useAudioClock ? ctx.currentTime : performance.now() / 1000);
  const t0 = now() + 0.05;
  let src: AudioBufferSourceNode | null = null;
  if (samples && useAudioClock) {
    const buf = ctx.createBuffer(samples.data.length, samples.data[0].length, samples.rate);
    samples.data.forEach((d, i) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, i));
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.master);
    src.start(t0);
  }
  let playing = true, last = -1;
  const unskip = onSkip(() => { // "Sla over": the film ends as if it had played to its end
    if (!playing) return;
    playing = false;
    unskip();
    try { src?.stop(); } catch { /* not started */ }
    onEnd();
  });
  const step = () => {
    if (!playing) return;
    const n = Math.floor((now() - t0) * avi.fps);
    if (n >= avi.frames.length) { playing = false; unskip(); onEnd(); return; }
    if (n >= 0 && n !== last) {
      avi.frame(n, frame);
      target.bitBlt(x, y, avi.width, avi.height, frame, 0, 0);
      last = n;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return {
    stop() {
      playing = false;
      unskip();
      try { src?.stop(); } catch { /* not started */ }
    },
  };
}
