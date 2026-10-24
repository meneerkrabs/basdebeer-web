// GMG Mijnwagenrace / Skispel - Noorderlicht PLAY_GAME 3 (mine cart: variant 2 N / 3 D) and 6 (ski: 0 N / 1 D),
// TGMGfrmMain. Rendering/input around GmgLogic (see gmg-logic.ts for the original's behaviour).
//
// The game form is a borderless 640x480 window centred on the 800x600 screen (FormCreate 0x4382b0).
// Keys: arrows = the four lights, Space = start / all four lights / skip the crash sound.
// The two button rects (Stop = alarm clock / quit dialog, 3-D head = switch N <-> D, which re-inits the game
// with the other variant and also changes the book's mode) are active while the game waits for Space.
// Touch/mouse addition (not in the original): tap the edge strip where a light shows (above = Up, left = Left,
// below = Down, right = Right) and tap the picture itself for Space.
// Esc while waiting for Space opens the quit dialog (the original closed the form straight away, which
// quits the whole book without asking).
//
// The book's mode: `params.mode` ('N' | 'D') and `params.variant` are updated in place when the 3-D head is
// used, and the returned session carries `mode` too, so the book can fix its page suffix/background.
import { audio, MediaPlayer } from '../../engine/audio.ts';
import { playMidi, type MidiHandle } from '../../engine/midi.ts';
import { Surface } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Minigame, MinigameSession } from '../types.ts';
import {
  buttonRects, DIGIT_W, FIELD_BYTES, FIELD_W, FORM_H, FORM_W, GmgLogic, inRect, LIGHT_POS, LIGHT_SIZE, parseKeys, parseRun,
  SCORE_X0, St, VARIANT_PREFIX, VIDEO_H, VIDEO_W, VIDEO_X, VIDEO_Y, type GmgIO, type KeyRec, type RunFiles,
} from './gmg-logic.ts';
import { loadWav } from './nl-sound.ts';
import { askQuit } from './quit-dialog.ts';

export const title = 'Mijnwagenrace / Skispel';

export interface GmgSession extends MinigameSession {
  /** Current N/D mode (changes when the player uses the 3-D head in the game). */
  readonly mode: 'N' | 'D';
}

interface Bundle {
  variant: number;
  run: RunFiles;
  keys: KeyRec[];
  img: Record<'main' | 'bots' | 'back' | 'end', Surface>;
  lgh1: Surface;
  lgh2: Surface;
  scor: Surface;
  scr: Uint8Array;
  wav: AudioBuffer[]; // 001..004
  pop: AudioBuffer;
  midi: Record<'main' | 'bots' | 'end', ArrayBuffer | null>;
}

const gmg: Minigame = ({ display, assets, params }) => {
  const form = new Form(display, FORM_W, FORM_H, 'GMGfrmMain');
  form.center();
  const p = params ?? {};
  let variant = Number.isInteger(Number(p.variant)) && p.variant !== undefined ? Number(p.variant) : p.mode === 'D' ? 3 : 2;
  variant = Math.max(0, Math.min(3, variant));
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((r) => (resolveResult = r));
  let quitFlow: () => void = () => {};
  const session: GmgSession = {
    result,
    requestQuit: () => quitFlow(),
    get mode() { return variant & 1 ? 'D' : 'N'; },
  };

  (async () => {
    const load = async (v: number): Promise<Bundle> => {
      const prefix = VARIANT_PREFIX[v];
      const run = parseRun(await assets.text(`${prefix}RUN.DAT`));
      const img = (n: string) => assets.image(n);
      const wavOf = (n: string) => loadWav(assets, n);
      const midi = async (n: string) => { try { return await assets.raw(n); } catch (e) { console.warn(e); return null; } };
      const [main, bots, back, end, lgh1, lgh2, scor] = await Promise.all(
        [run.main, run.bots, run.back, run.end, run.lgh1, run.lgh2, run.scor].map(img),
      );
      const [scrBuf, keysText, pop] = await Promise.all([assets.raw(run.scr), assets.text(run.keys), wavOf(run.pop)]);
      const wav = await Promise.all(run.wav.map(wavOf));
      const [mMain, mBots, mEnd] = await Promise.all([midi(run.mainMid), midi(run.botsMid), midi(run.endMid)]);
      return {
        variant: v, run, keys: parseKeys(keysText), img: { main, bots, back, end }, lgh1, lgh2, scor,
        scr: new Uint8Array(scrBuf), wav, pop, midi: { main: mMain, bots: mBots, end: mEnd },
      };
    };

    let b = await load(variant);
    const canvas = b.img.main.clone(); // 0x26e2c: the form's bitmap, starts as MAIN.BMP
    const video = new Surface(VIDEO_W, VIDEO_H); // the 560x280 DIB
    let scrPos = 0;
    let buttonsOn = true;
    let closed = false;

    // MediaPlayer1 (MIDI) and MediaPlayer2 (WAV)
    const mp2 = new MediaPlayer();
    let midi: MidiHandle | null = null;
    let midiLoading = false;
    let midiToken = 0;
    const stopMusic = () => {
      midiToken++;
      midi?.stop();
      midi = null;
      midiLoading = false;
    };

    const io: GmgIO = {
      openField: () => { scrPos = 0; },
      closeField: () => {},
      readField: () => {
        if (scrPos + FIELD_BYTES > b.scr.length) return null;
        const f = b.scr.subarray(scrPos, scrPos + FIELD_BYTES);
        scrPos += FIELD_BYTES;
        return f;
      },
      drawField: (parity, field) => {
        // Weave: field row i -> picture row parity + 2i; indices go through LGH2.BMP's palette.
        const pal = b.lgh2.palette!, px = video.px;
        for (let i = 0; i < field.length / FIELD_W; i++) {
          const dst = (parity + 2 * i) * VIDEO_W, src = i * FIELD_W;
          for (let x = 0; x < FIELD_W; x++) px[dst + x] = pal[field[src + x]];
        }
        canvas.bitBlt(VIDEO_X, VIDEO_Y, VIDEO_W, VIDEO_H, video, 0, 0);
        form.invalidate();
      },
      showImage: (which) => {
        canvas.bitBlt(0, 0, FORM_W, FORM_H, b.img[which], 0, 0);
        form.invalidate();
      },
      drawScore: (digits, y) => {
        for (let i = 1; i <= 5; i++) canvas.bitBlt(SCORE_X0 + i * DIGIT_W, y, DIGIT_W, b.scor.height, b.scor, digits[i] * DIGIT_W, 0);
        form.invalidate();
      },
      light: (n, on) => {
        const bmp = on ? b.lgh2 : b.lgh1;
        for (const k of n === 5 ? [1, 2, 3, 4] : [n]) {
          const [x, y] = LIGHT_POS[k];
          canvas.bitBlt(x, y, LIGHT_SIZE, LIGHT_SIZE, bmp, 0, 0);
        }
        form.invalidate();
      },
      pop: () => mp2.play(),
      openPop: () => { mp2.stop(); mp2.open(b.pop); },
      speech: (n) => { mp2.stop(); mp2.open(b.wav[n - 1]); mp2.play(); },
      speechSync: async (n) => {
        const buf = b.wav[n - 1];
        // sndPlaySound(SND_SYNC) froze the original's UI thread; never hang when the audio context is locked
        await Promise.race([
          audio.sndPlaySoundSync(buf, 0),
          new Promise<void>((r) => setTimeout(r, buf.duration * 1000 + 300)),
        ]);
      },
      speechDone: () => !mp2.playing || audio.ctx.state !== 'running',
      music: (which) => {
        stopMusic();
        const data = b.midi[which];
        if (!data) return;
        const token = midiToken;
        midiLoading = true;
        void playMidi(data.slice(0), { loop: which === 'main' }).then((h) => {
          if (token !== midiToken || closed) { h.stop(); return; }
          midi = h;
          midiLoading = false;
        });
      },
      musicDone: () => !midiLoading && !midi?.playing,
      setButtons: (on) => { buttonsOn = on; },
      closing: () => closed,
    };

    let logic = new GmgLogic(variant, b.keys, io);

    const finish = (code: number) => {
      if (closed) return;
      closed = true;
      timer.enabled = false;
      form.close(code);
    };

    let busyLoading = false;
    const timer = form.timer(70, async () => {
      if (busyLoading) return;
      await logic.tick();
      if (!logic.running) finish(logic.result);
    }, false);

    form.onPaint = () => form.surface.bitBlt(0, 0, FORM_W, FORM_H, canvas, 0, 0);

    // --- input -----------------------------------------------------------------------------------------------
    let quitting = false;
    quitFlow = () => {
      if (quitting || closed || !buttonsOn) return;
      quitting = true;
      void askQuit(display, assets, 0, session.mode).then((yes) => {
        quitting = false;
        if (yes) { logic.result = 0; logic.running = false; finish(0); }
      });
    };

    /** The 3-D head: free everything, init(other variant) (0x439684). */
    const toggleMode = async () => {
      const nv = variant ^ 1;
      busyLoading = true;
      buttonsOn = false;
      stopMusic();
      mp2.stop();
      const nb = await load(nv);
      if (closed) return;
      b = nb;
      variant = nv;
      p.mode = nv & 1 ? 'D' : 'N';
      p.variant = nv;
      scrPos = 0;
      canvas.bitBlt(0, 0, FORM_W, FORM_H, b.img.main, 0, 0);
      form.invalidate();
      logic = new GmgLogic(nv, b.keys, io, false); // init() ends in state 4; the 001.WAV intro only plays once
      busyLoading = false;
    };

    const press = (key: 'space' | 1 | 2 | 3 | 4) => {
      if (closed || busyLoading || quitting) return;
      if (key === 'space') logic.space();
      else logic.arrow(key);
    };

    form.onKeyDown = (k) => {
      if (k === ' ') press('space');
      else if (k === 'ArrowUp') press(1);
      else if (k === 'ArrowLeft') press(2);
      else if (k === 'ArrowDown') press(3);
      else if (k === 'ArrowRight') press(4);
      else if (k === 'Escape' && logic.state === St.Ready) quitFlow();
    };

    form.onMouseDown = (_b, _s, x, y) => {
      if (busyLoading) return;
      const r = buttonRects(variant);
      if (buttonsOn && inRect(r.mode, x, y)) { void toggleMode(); return; }
      if (buttonsOn && inRect(r.stop, x, y)) { quitFlow(); return; }
      // touch alternative: the lights sit around the picture, the picture itself is Space
      if (x >= VIDEO_X && x < VIDEO_X + VIDEO_W && y >= VIDEO_Y && y < VIDEO_Y + VIDEO_H) press('space');
      else if (y < VIDEO_Y) press(1);
      else if (y >= VIDEO_Y + VIDEO_H) press(3);
      else if (x < VIDEO_X) press(2);
      else press(4);
    };
    form.onMouseMove = (_s, x, y) => {
      const r = buttonRects(variant);
      form.cursor = buttonsOn && (inRect(r.mode, x, y) || inRect(r.stop, x, y)) ? 'pointer' : 'default';
    };
    form.onClose = () => {
      closed = true;
      stopMusic();
      mp2.close();
      audio.stopSystemSound();
    };

    form.show();
    timer.enabled = true;
  })().catch((e) => {
    console.error(e);
    form.close(2);
  });

  form.showModal().then((code) => resolveResult(code));
  return session;
};

/** PLAY_GAME 3 (mine cart: variant 2 N / 3 D) and 6 (ski: 0 N / 1 D): picks the variant from params.mode. */
export const gmgGame = (kind: 'mine' | 'ski'): Minigame => (host) => {
  const params = host.params ?? {};
  params.variant = (kind === 'mine' ? 2 : 0) + (params.mode === 'D' ? 1 : 0);
  return gmg({ ...host, params });
};

export default gmg;
