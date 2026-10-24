// Kistenspel (Pirateneiland minigame 2, TfrmG2 in BBOEK32.EXE) -- game logic.
//
// Four treasure chests must all be opened. Clicking a chest toggles a fixed set of chests (a "lights out"
// puzzle), each animated one after another. After 1000 idle ticks (~2 minutes) the worm crawls in, says
// the solution is easy and opens the remaining chests itself; the game then counts as won.
//
// Straight port of the decompiled Delphi methods, free of DOM code. Addresses refer to BBOEK32.EXE.
// Offsets are fields of TfrmG2: 0x1bc state, 0x1bd intro countdown, 0x1c0 timeout counter, 0x1c0+i*0x18 chest
// state (1 = closed, 0 = open!), 0x240 frame, 0x241 chest, 0x242 direction, 0x243 "animation done",
// 0x244 "play sound on the next frame", 0x245 result.
//
// Original quirk kept: GameTimer is a state machine in which every handler sets state = 0 first and only
// restores it when it's done, so nested ticks (the original pumps messages inside the handler/click) do nothing
// while a blocking step is running.

/** Chest rects (FormCreate @0x42fd58, fields 0x1c4..): l, t, r, b. Index 0 = chest 1. */
export const CHESTS: readonly (readonly [number, number, number, number])[] = [
  [30, 185, 180, 275],
  [183, 185, 320, 275],
  [330, 185, 460, 275],
  [465, 185, 620, 275],
];
/** Strip bitmap per chest, 9 frames, frame stride = rect width (FUN_00430250). */
export const STRIPS = ['AG0201.BMP', 'AG0202.BMP', 'AG0203.BMP', 'AG0204.BMP'] as const;
export const FRAMES = 9;
/** Chests toggled by a click on chest i+1 (FUN_0043064c). */
export const TOGGLES: readonly (readonly number[])[] = [[1, 2, 3], [2, 3], [3, 1], [4, 1, 2]];

/** Sound slots of FormCreate (objects at 0x224..0x238). Slot 2 is created but never loaded. */
export const Snd = {
  Instruction: 0, // GAME002A.WAV, synchronous (flags 0x10)
  Won: 1, // GAME002B.WAV, synchronous
  Close: 3, // GE002001.WAV, ASYNC (flags 1): played when a chest closes
  Open: 4, // GE002002.WAV, ASYNC: played when a chest opens
  Lost: 5, // GAME001C.WAV, synchronous: played by FormClose when closed early (Alt+F4 only)
} as const;

export const INTRO_TICKS = 10; // 0x1bd
export const INTRO_MS = 50; // GameTimer.Interval set in FormCreate (FUN_00428218(timer, 0x32))
export const PLAY_MS = 120; // set after the instruction sound (0x78)
export const TIMEOUT_TICKS = 1000; // 0x1c0

/** State byte 0x1bc. */
export const St = { Busy: 0, Intro: 1, Play: 2, Anim: 3 } as const;

export interface KistenEffects {
  /** sndPlaySound(slot, 0): blocks the original's UI thread until the WAV ends. */
  playSync(slot: number): Promise<void>;
  /** sndPlaySound(slot, SND_ASYNC). */
  playAsync(slot: number): void;
  /** FUN_00430250: copy frame (1..9) of chest `chest` (1..4) from its strip to the picture. */
  drawFrame(chest: number, frame: number): void;
  /** GameTimer.Interval := ms. */
  setTimerInterval(ms: number): void;
  /** FUN_0043081c's worm: enter at (350,300) from the left (mode 1). */
  wormEnter(): Promise<void>;
  /** The worm speaks game002c.wav. */
  wormTalk(): Promise<void>;
  /** The worm crawls off (exit mode 1) and is freed. */
  wormExit(): Promise<void>;
  /** The form closes with this result (2 won). */
  finish(code: number): void;
}

export class KistenLogic {
  state: number = St.Busy;
  introCount = INTRO_TICKS;
  timeout = TIMEOUT_TICKS;
  /** 0x1c0 + i*0x18, index 1..4: 1 = closed (initial), 0 = open. */
  readonly chestState: number[] = [0, 1, 1, 1, 1];
  result = 0;
  closed = false;
  private frame = 0; // 0x240
  private chest = 0; // 0x241
  private dir = 0; // 0x242: 0 = closing (9 -> 1), 1 = opening (1 -> 9)
  private soundPending = false; // 0x244
  private animDone: (() => void) | null = null; // 0x243

  private readonly fx: KistenEffects;

  constructor(fx: KistenEffects) {
    this.fx = fx;
  }

  /** FormShow @0x430504: timer on, state 1. */
  show() {
    this.state = St.Intro;
  }

  /** GameTimerTimer_430388. */
  tick() {
    if (this.closed) return;
    switch (this.state) {
      case St.Intro:
        this.state = St.Busy;
        this.introCount--;
        if (this.introCount === 0) void this.endIntro();
        else this.state = St.Intro;
        break;
      case St.Play:
        this.state = St.Busy;
        this.timeout--;
        if (this.timeout === 0) void this.timeoutSequence();
        else this.state = St.Play;
        break;
      case St.Anim:
        this.state = St.Busy;
        this.animStep();
        break;
    }
  }

  /** FormMouseDown_43059c (state 2 only; first chest rect that contains the point). */
  mouseDown(x: number, y: number) {
    if (this.state !== St.Play) return;
    for (let i = 1; i <= 4; i++) {
      const [l, t, r, b] = CHESTS[i - 1];
      if (x >= l && x < r && y >= t && y < b) {
        void this.chain(i);
        return;
      }
    }
  }

  /** FormClose @0x430574 (Alt+F4 / forced close only): fail sound, result 3. */
  onClose() {
    this.closed = true;
  }

  private async endIntro() {
    await this.fx.playSync(Snd.Instruction);
    if (this.closed) return;
    this.fx.setTimerInterval(PLAY_MS);
    this.state = St.Play;
  }

  /** FUN_004305fc: start toggling one chest; resolves when its animation has finished (0x243). */
  private toggle(i: number): Promise<void> {
    if (this.chestState[i] === 0) {
      this.frame = FRAMES; // open -> close: frames 9..1
      this.dir = 0;
      this.chestState[i] = 1;
    } else {
      this.frame = 1; // closed -> open: frames 1..9
      this.dir = 1;
      this.chestState[i] = 0;
    }
    this.chest = i;
    this.soundPending = true;
    this.state = St.Anim;
    return new Promise((resolve) => (this.animDone = resolve));
  }

  /** State 3 of GameTimerTimer (state is already 0): FUN_00430250 then advance the frame counter. */
  private animStep() {
    this.fx.drawFrame(this.chest, this.frame);
    if (this.soundPending) {
      this.fx.playAsync(this.dir === 0 ? Snd.Close : Snd.Open);
      this.soundPending = false;
    }
    if (this.dir === 0) {
      this.frame--;
      if (this.frame === 0) return this.finishAnim();
    } else {
      this.frame++;
      if (this.frame === FRAMES + 1) return this.finishAnim();
    }
    this.state = St.Anim;
  }

  private finishAnim() {
    const done = this.animDone;
    this.animDone = null;
    done?.(); // state stays 0 until the caller decides what comes next
  }

  /** FUN_0043064c: a click on chest i. */
  private async chain(i: number) {
    for (const j of TOGGLES[i - 1]) {
      await this.toggle(j);
      if (this.closed) return;
    }
    if (this.chestState.some((s, k) => k > 0 && s === 1)) {
      this.state = St.Play;
      return;
    }
    await this.fx.playSync(Snd.Won);
    this.result = 2;
    this.fx.finish(2);
  }

  /** FUN_0043081c: the worm rescues the player after 1000 idle ticks. */
  private async timeoutSequence() {
    await this.fx.wormEnter();
    await this.fx.wormTalk();
    for (let i = 1; i <= 4; i++) {
      if (this.closed) return;
      if (this.chestState[i] !== 0) await this.toggle(i); // opens just this one chest
    }
    await this.fx.wormExit();
    await this.fx.playSync(Snd.Won);
    this.result = 2;
    this.fx.finish(2);
  }
}
