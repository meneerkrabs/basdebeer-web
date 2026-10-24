// Roeispel (Pirateneiland minigame 3, TfrmG3 in BBOEK32.EXE) -- game logic.
//
// Row the boat to the island by clicking in an even rhythm: a stroke is "good" when the time since the previous
// click differs from the previous interval by at most 5 timer ticks. Every good stroke moves the boat and lets the
// island rise; 70 good strokes (plus the free one drawn by FormShow) win. There is no lose condition.
//
// Straight port of the decompiled Delphi methods, free of DOM code. Addresses refer to BBOEK32.EXE.
// Offsets are fields of TfrmG3: 0x1d0 intro countdown, 0x1d1 state, 0x1e0 ready flag, 0x1e4 frame, 0x1e8 frame
// direction, 0x1ec/0x1f0 boat x/y, 0x1f4 tick counter, 0x1f8 previous interval, 0x1fc |diff|, 0x200 progress,
// 0x204 bad strokes (unused), 0x208 island height, 0x210 result.

/** Sound slots of FormCreate (objects at 0x1d4..0x1dc), all synchronous (flags 0x10). */
export const Snd = {
  Instruction: 0, // GAME003a.WAV
  Won: 1, // GAME002b.WAV
  Lost: 2, // GAME001c.WAV: only played by FormClose when closed early
} as const;

/** DAT_0043c794 = 5: a stroke is bad when |previous interval - this interval| > 5 ticks. */
export const TOLERANCE = 5;
/** Win when progress reaches 0x119. */
export const WIN_PROGRESS = 0x119;
export const INTRO_TICKS = 10; // 0x1d0
export const INTRO_MS = 50; // FormCreate: GameTimer.Interval = 0x32
/**
 * GameTimer.Interval during play is 10 ms, which Windows 9x (the game's platform) rounds to its ~55 ms tick, so the
 * 5-tick tolerance is really ~275 ms. A modern browser timer would make it 50 ms, which no one can click that evenly.
 */
export const PLAY_TICK_MS = 55;

/** State byte 0x1d1. */
export const St = { Busy: 0, Intro: 1, Play: 2 } as const;

export interface RoeiEffects {
  /** sndPlaySound(slot, 0): blocks the original's UI thread until the WAV ends. */
  playSync(slot: number): Promise<void>;
  /** FUN_004311a4(x, y, frame) + island height from progress (0x208 = progress + 25). */
  draw(x: number, y: number, frame: number, islandHeight: number): void;
  /** GameTimer.Interval := ms. */
  setTimerInterval(ms: number): void;
  /** The worm pops up in place at (500,200) (mode 4). */
  wormEnter(): Promise<void>;
  /** The worm speaks ge003001.wav. */
  wormTalk(): Promise<void>;
  /** MidiPlayer.Open + Play (GE003002.MID; loops via OnNotify). */
  startMidi(): void;
  /** The worm crawls off to the right (exit mode 1). */
  wormExit(): Promise<void>;
  /** The form closes with this result (2 won). */
  finish(code: number): void;
}

export class RoeiLogic {
  state: number = St.Busy;
  introCount = INTRO_TICKS;
  ready = 1; // 0x1e0
  frame = 0; // 0x1e4: boat frame 0..2 good rowing, 3..5 bad (splash)
  dir = 1; // 0x1e8
  x = 1; // 0x1ec
  y = 300; // 0x1f0
  ticks = 0; // 0x1f4
  prev = 0; // 0x1f8
  diff = 0; // 0x1fc
  progress = 0; // 0x200
  bad = 0; // 0x204
  result = 0;
  closed = false;
  private readonly fx: RoeiEffects;

  constructor(fx: RoeiEffects) {
    this.fx = fx;
  }

  /** FormShow_431010: run the click handler once in state 2 (draws the boat and counts one good stroke), then state 1. */
  show() {
    this.state = St.Play;
    void this.mouseDown();
    this.state = St.Intro;
  }

  /** GameTimerTimer_43104c. */
  tick() {
    if (this.closed) return;
    if (this.state === St.Intro) {
      this.state = St.Busy;
      this.introCount--;
      if (this.introCount === 0) void this.endIntro();
      else this.state = St.Intro;
    } else if (this.state === St.Play && this.ready === 1) {
      this.ticks++;
    }
  }

  onClose() {
    this.closed = true;
  }

  private async endIntro() {
    await this.fx.playSync(Snd.Instruction);
    await this.fx.wormEnter();
    await this.fx.wormTalk();
    if (this.closed) return;
    this.fx.startMidi();
    await this.fx.wormExit();
    if (this.closed) return;
    this.fx.setTimerInterval(PLAY_TICK_MS);
    this.state = St.Play;
  }

  /** FormMouseDown_4313f4 (any button, anywhere). */
  async mouseDown() {
    if (this.state !== St.Play || this.ready <= 0) return;
    this.ready = 0;
    this.frame += this.dir;
    this.diff = Math.abs(this.prev - this.ticks);
    this.prev = this.ticks;
    this.ticks = 0;
    const good = this.diff <= TOLERANCE;
    if (!good) {
      this.bad++;
    } else {
      this.x += 4;
      this.y -= 2;
      this.progress += 4;
    }
    if (!good && this.frame < 3) this.frame += 3;
    if (good && this.frame > 2) this.frame -= 3;
    if (this.frame === 2) this.dir = -1;
    if (this.frame === 0) this.dir = 1;
    if (this.frame === 5) this.dir = -1;
    if (this.frame === 3) this.dir = 1;
    this.frame = Math.max(0, Math.min(5, this.frame)); // never out of range in the original, guard anyway
    this.fx.draw(this.x, this.y, this.frame, this.progress + 25);
    if (this.progress < WIN_PROGRESS) {
      this.ready = 1;
    } else {
      this.ready = 0;
      await this.fx.playSync(Snd.Won);
      this.result = 2;
      this.fx.finish(2);
    }
  }
}
