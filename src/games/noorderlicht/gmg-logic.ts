// GMG - Mijnwagenrace / Skispel (Noorderlicht PLAY_GAME 3 and 6, TGMGfrmMain in BASNOORD.EXE) - game logic.
//
// DOM-free port of the decompiled Delphi methods; addresses in comments (spec 7.2):
//   FormCreate 0x4382b0, FormClose 0x4382f0, SwitchLights 0x4383a0, GameTimerTimer 0x4385a8 (jump table
//   0x4385fd), score helper 0x438ee8, FormKeyDown 0x438f20, FormShow 0x43964c, FormPaint 0x43965c,
//   FormMouseDown 0x439684, init(variant) 0x437e9c.
//
// The game is an interlaced "video": every GameTimer tick (70 ms) reads one 560x140 field of raw 8-bit
// palette indices from <variant>.SCR and weaves it into alternate rows of a 560x280 picture. A script of
// triples (field#, light, window) from <variant>KEYS.DAT lights one of four lights (Up/Left/Down/Right,
// or all four = Space); the player must press it within `window` ticks, otherwise the cart crashes.
//
// Form fields (TGMGfrmMain): state 0x26a04, variant 0x26e29, variant class 0x26e31, run list 0x2689c,
// key index 0x268a0, light on 0x268a4, light counter 0x268a8, weave parity 0x26a08, field no. 0x26a0c,
// score digits 0x26a1c..0x26a20, keys 0x26638 + 12*i (time +0, light +4, window +8, i is 1-based),
// intro-not-yet-played 0x26e2a, closing 0x26e30, running 0x26e32, result 0x26e33, file open 0x26e28.

/** Variant (init argument) -> file prefix: 0 GSKN, 1 GSKD (ski), 2 GMSN, 3 GMSD (mine cart). 0x44c414 + v*0x100. */
export const VARIANT_PREFIX = ['GSKN', 'GSKD', 'GMSN', 'GMSD'] as const;
export const isMine = (variant: number) => variant === 2 || variant === 3;

/** The 800x600 book layout is irrelevant here: the form is a borderless 640x480 window (FormCreate). */
export const FORM_W = 640, FORM_H = 480;
/** Field geometry: 560x140 bytes per field, written as every second row of the 560x280 picture at (40,60). */
export const FIELD_W = 560, FIELD_H = 140, FIELD_BYTES = FIELD_W * FIELD_H; // 0x13240
export const VIDEO_X = 40, VIDEO_Y = 60, VIDEO_W = 560, VIDEO_H = 280;

/** Light positions (SwitchLights): 1 Up, 2 Left, 3 Down, 4 Right; 5 = all four. Lights are 40x40. */
export const LIGHT_POS: Record<number, [number, number]> = {
  1: [0x127, 0x14],
  2: [1, 0xb9],
  3: [0x127, 0x154],
  4: [600, 0xb9],
};
export const LIGHT_SIZE = 40;

/** Score digits: SCOR.BMP is 600x55 (ten 60-wide digits); digit i (1..5) is drawn at x = 108 + 60 i. */
export const DIGIT_W = 60;
export const SCORE_X0 = 108;
/** Score row while playing (timer state 1): y = 0x190 for every variant. */
export const SCORE_Y_PLAY = 0x190;
/** Score row on the title/retry picture (timer state 4): 0x17c for the mine cart, 0x195 for the ski game. */
export const scoreYMain = (variant: number) => (isMine(variant) ? 0x17c : 0x195);

export type Rect = readonly [number, number, number, number];
/**
 * Button rect records (class = variant class 0x26e31: 1 ski, 0 mine cart), 0x44c814 + class*0x70:
 * "SysStopRect" (the alarm clock / quit) and "SysModeRect" (the 3-D head). Left/top/right/bottom,
 * right/bottom exclusive (PtInRect). Both are enabled only while the game waits for Space.
 */
export const BUTTONS = {
  mine: { stop: [10, 406, 83, 474] as Rect, mode: [560, 386, 640, 480] as Rect },
  ski: { stop: [0, 0, 70, 60] as Rect, mode: [552, 13, 631, 111] as Rect },
};
export const buttonRects = (variant: number) => (isMine(variant) ? BUTTONS.mine : BUTTONS.ski);
export const inRect = (r: Rect, x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/** Timer state machine (field 0x26a04, jump table 0x4385fd). */
export const St = {
  Idle: 0, // set by Space/skip: (re)start the run; also "nothing" in the timer
  Playing: 1,
  Crash: 2, // draw BOTS.BMP, crash music + 003.WAV
  CrashWait: 3, // wait for 003.WAV to end (Space skips)
  Retry: 4, // back to the title picture with the last score, 002.WAV, buttons on
  Ready: 5, // waiting for Space
  Win: 6, // draw END.BMP, end music + 004.WAV
  WinWait: 7, // wait for END.MID to end, then result 1
  Busy: 8, // timer state 4 is running (blocking intro sound etc.)
} as const;
export type St = (typeof St)[keyof typeof St];

/** The 19 lines of <variant>RUN.DAT (spec 7.2): indices into the run list. */
export interface RunFiles {
  main: string; // 0
  bots: string; // 2
  botsMid: string; // 3
  back: string; // 4
  mainMid: string; // 5
  scr: string; // 6
  lgh1: string; // 7 (light off)
  lgh2: string; // 8 (light on)
  lgh2Palette: string; // 9
  pop: string; // 10
  scor: string; // 11
  keys: string; // 12
  end: string; // 13
  endMid: string; // 14
  wav: [string, string, string, string]; // 15..18: 001..004
}

export function parseRun(text: string): RunFiles {
  const l = text.split(/\r?\n/).map((s) => s.trim());
  return {
    main: l[0], bots: l[2], botsMid: l[3], back: l[4], mainMid: l[5], scr: l[6], lgh1: l[7], lgh2: l[8],
    lgh2Palette: l[9], pop: l[10], scor: l[11], keys: l[12], end: l[13], endMid: l[14],
    wav: [l[15], l[16], l[17], l[18]],
  };
}

export interface KeyRec { time: number; light: number; window: number }

/** KEYS.DAT: plain integers, one per line, in triples (field#, light, window ticks). */
export function parseKeys(text: string): KeyRec[] {
  const nums = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '').map((s) => parseInt(s, 10));
  const out: KeyRec[] = [];
  for (let i = 0; i + 2 < nums.length; i += 3) out.push({ time: nums[i], light: nums[i + 1], window: nums[i + 2] });
  return out;
}

/** Delphi Round(): round half to even (FPU default rounding). */
export function delphiRound(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Five decimal digits, index 1..5 (index 0 unused), like bytes 0x26a1c..0x26a20. */
export class Score {
  digits = [0, 0, 0, 0, 0, 0];
  reset() { this.digits.fill(0); }
  /** Increment the digit at `pos` with carry towards digit 1 (loop at 0x438ee8 starts at 3, the timer's at 5). */
  inc(pos: number) {
    while (pos > 0) {
      if (++this.digits[pos] === 10) { this.digits[pos] = 0; pos--; } else break;
    }
  }
  get value() { return this.digits.slice(1).reduce((a, d) => a * 10 + d, 0); }
}

export interface GmgIO {
  /** Reset() of the .SCR file. */
  openField(): void;
  closeField(): void;
  /** BlockRead of one field (78 400 bytes); null at end of file. */
  readField(): Uint8Array | null;
  /** Weave `field` into the rows of the given parity, blit the picture to (40,60). */
  drawField(parity: number, field: Uint8Array): void;
  showImage(which: 'main' | 'back' | 'bots' | 'end'): void;
  /** Draw the five score digits at row y. */
  drawScore(digits: readonly number[], y: number): void;
  /** SwitchLights: light 1..4, or 5 = all four. */
  light(n: number, on: boolean): void;
  /** MediaPlayer2.Play with POP.WAV open. */
  pop(): void;
  /** MediaPlayer1: close, open the file, play. MAIN loops (restarted when it stops). */
  music(which: 'main' | 'bots' | 'end'): void;
  /** MediaPlayer2: close, open 001..004.WAV (n = 1..4) and play; `popOnly` opens POP.WAV without playing. */
  speech(n: 1 | 2 | 3 | 4): void;
  openPop(): void;
  /** TWave 001.WAV played synchronously (blocks the original's UI thread). */
  speechSync(n: 1): Promise<void>;
  speechDone(): boolean;
  musicDone(): boolean;
  /** Stop + Mode buttons (rect records 0x44c848 / 0x44c880 enabled bytes). */
  setButtons(enabled: boolean): void;
  closing(): boolean;
}

export class GmgLogic {
  readonly variant: number;
  readonly keys: KeyRec[];
  readonly score = new Score();
  state: St = St.Retry; // init() ends with state 4
  keyIdx = 1; // 0x268a0 (1-based)
  lightOn = false; // 0x268a4
  counter = 0; // 0x268a8
  parity = 0; // 0x26a08
  fieldNo = 0; // 0x26a0c
  introPending: boolean; // 0x26e2a: the first Retry screen plays 001.WAV synchronously
  running = true; // 0x26e32
  result = 5; // 0x26e33 (5 = form closed by the book without a verdict -> 0)

  private readonly io: GmgIO;

  constructor(variant: number, keys: KeyRec[], io: GmgIO, introPending = true) {
    this.io = io;
    this.variant = variant;
    this.keys = keys;
    this.introPending = introPending;
  }

  private rec(i: number): KeyRec | undefined { return this.keys[i - 1]; }

  /** GameTimerTimer 0x4385a8, every 70 ms. */
  async tick(): Promise<void> {
    const io = this.io;
    switch (this.state) {
      case St.Playing: this.playTick(); break;
      case St.Crash: // 0x43893e
        io.showImage('bots');
        io.music('bots');
        io.speech(3);
        this.state = St.CrashWait;
        break;
      case St.CrashWait: // 0x438a92: 003.WAV stopped
        if (io.speechDone()) this.state = St.Retry;
        break;
      case St.Retry: await this.retry(); break; // 0x438ab1
      case St.Win: // 0x438d3b
        io.showImage('end');
        io.music('end');
        io.speech(4);
        this.state = St.WinWait;
        break;
      case St.WinWait: // 0x438e8c: END.MID has stopped (we also wait for 004.WAV, the original does not)
        if (io.musicDone() && io.speechDone()) { this.result = 1; this.running = false; }
        break;
      default: break; // 0, 5, 8: nothing
    }
  }

  /** Timer state 1 (0x438622). */
  private playTick() {
    const io = this.io;
    this.fieldNo++;
    if (!this.lightOn) {
      const r = this.rec(this.keyIdx);
      if (r && r.time === this.fieldNo) {
        io.pop();
        io.light(r.light, true);
        this.lightOn = true;
        this.counter = 0;
      }
    }
    if (this.lightOn) this.counter++;
    // `window <= counter` is a crash. The original reads zeros past the last record (window 0), which
    // would crash after answering the very last light of the ski script (800, Space, 50): treat a missing
    // record as "no deadline" instead (knowing fix, see report).
    const r = this.rec(this.keyIdx);
    if (r && r.window <= this.counter) {
      this.state = St.Crash;
      io.closeField();
      return;
    }
    const field = io.readField();
    if (!field) { // fewer than 0x13240 bytes read: the run is over
      io.closeField();
      this.state = St.Win;
      return;
    }
    io.drawField(this.parity, field);
    this.parity ^= 1;
    io.drawScore(this.score.digits, SCORE_Y_PLAY);
    this.score.inc(5); // +1 per tick, after drawing
  }

  /** Timer state 4 (0x438ab1): title picture with the last score, speech, buttons on. */
  private async retry() {
    const io = this.io;
    this.state = St.Busy;
    io.showImage('main');
    io.drawScore(this.score.digits, scoreYMain(this.variant));
    if (this.introPending) {
      await io.speechSync(1);
      if (io.closing()) return; // FormClose set 0x26e30: stay in state 8
      this.introPending = false;
    }
    io.speech(2);
    io.setButtons(true);
    this.state = St.Ready;
  }

  /** Space (FormKeyDown case 0x20). */
  space() {
    if (this.state === St.CrashWait) this.state = St.Retry; // skip the crash sound
    if (this.state === St.Ready) this.state = St.Idle;
    if (this.state === St.Idle) this.start();
    if (this.state === St.Playing && this.lightOn && this.rec(this.keyIdx)?.light === 5) this.hit(5);
  }

  /** Arrow keys: light 1 Up, 2 Left, 3 Down, 4 Right. */
  arrow(light: 1 | 2 | 3 | 4) {
    // (the original has no state check here; outside the playing state it only played a stray pop)
    if (this.state === St.Playing && this.lightOn && this.rec(this.keyIdx)?.light === light) this.hit(light);
  }

  /** Space in state 0: begin a run (all the init in 0x438f20). */
  private start() {
    const io = this.io;
    io.setButtons(false);
    io.openField();
    this.fieldNo = 0;
    this.parity = 0;
    this.keyIdx = 1;
    this.lightOn = false;
    this.counter = 0;
    io.music('main');
    io.openPop();
    io.showImage('back');
    // (SwitchLights(5, off) is called here too, but state is still 0 so it draws nothing)
    this.score.reset();
    this.state = St.Playing;
  }

  /** A right key in time: light off, pop, next record, +100 and up to two time bonuses. */
  private hit(light: number) {
    const io = this.io;
    io.light(light, false);
    this.lightOn = false;
    io.pop();
    this.keyIdx++;
    this.score.inc(3);
    // The bonus tests read the window of the *next* record (index already incremented), as in the original.
    const w = this.rec(this.keyIdx)?.window ?? 0;
    if (delphiRound(w * 0.5) > this.counter) this.score.inc(3);
    if (delphiRound(w * (2 / 3)) > this.counter) this.score.inc(3);
  }
}
