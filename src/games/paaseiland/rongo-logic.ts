// Rongo Rongo (Paaseiland minigame 1, TfrmG1 in PAASBAAS.EXE) — game logic.
//
// A 3x3 sliding puzzle; the tiles carry the sentence "We spreken op het Eiland de Taal
// Rongo Rongo" in Symbol font. Rongo the rabbit reads the tiles aloud in their current
// order when clicked, and recites them automatically once they are solved.
//
// This is a straight port of the decompiled Delphi methods (addresses in comments) kept
// free of DOM code, so the state machine can be fuzz-tested headless. The original was
// compiled with range checking ({$R+}, BOUND instructions); `rangeCheck` marks exactly
// those spots. In strict mode a failing check throws like Delphi's ERangeError did.

export const SND_ASYNC = 1, SND_MEMORY = 4, SND_NOSTOP = 0x10;

/** Field 0x1c0 of TfrmG1: the AniTimer state machine. */
export const St = {
  Idle: 2,
  Speaking: 0x0c, // Rongo speaks (babble or a tile), mouth animates until the sound ends
  Intro: 0x0d, // countdown before the spoken instructions
  Instructions: 0x12, // replaying instructions (unused by the book)
  Won: 0x17, // countdown before the form closes after solving
  SignUp: 0x18, // "JA / NEE" sign slides up
  SignDown: 0x19, // sign slides down
  SignWait: 0x1a, // waiting for JA / NEE
} as const;
export type St = (typeof St)[keyof typeof St];

export interface RongoEffects {
  /** sndPlaySound(sounds[i], flags); returns false when SND_NOSTOP and busy. i = index into GE0701..GE0722. */
  playSound(i: number | null, flags: number): boolean;
  /** Play yn001.wav ("wil je stoppen?"). */
  playQuestion(): void;
  random(n: number): number;
  /** Copy mouth frame 1..5 of A00701.BMP into the background (@0x4344e0). */
  mouth(frame: number): void;
  repaint(): void;
  setTimerInterval(ms: number): void;
  close(): void;
}

export class RangeCheckError extends Error {
  constructor(where: string, v: number, lo: number, hi: number) {
    super(`Range check error at ${where}: ${v} not in ${lo}..${hi}`);
  }
}

export class RongoLogic {
  board = [0, 1, 2, 3, 4, 5, 6, 7, 8]; // 0x1e8: cell -> tile; tile 8 is the hole
  empty = 8; // 0x20c
  moves = 0; // 0x210
  playing = false; // 0x214
  speakIdx = -1; // 0x218: cell Rongo is reading (red frame)
  speaking = false; // 0x21c
  soundsOn = false; // 0x1c2: tile-move sounds (off while shuffling)
  state: St = St.Idle; // 0x1c0
  mouthFrame = 1; // 0x1c1 (1..5)
  mouthUp = false; // 0x1c3
  countdown = 0; // global byte at 0x4466b4
  exitCode = 0; // 0x2e4: 1 = solved, 2 = stopped (the book quits on 2)
  signStep = 0; // 0x2dc: sign height in 12px steps (0..15)
  signAnswerYes = false; // 0x2e0
  /** Set when a range check fails in lenient mode (what crashed the original). */
  rangeErrors: string[] = [];

  private fx: RongoEffects;
  private strict: boolean;

  constructor(fx: RongoEffects, strict = false) {
    this.fx = fx;
    this.strict = strict;
  }

  private rc(where: string, v: number, lo: number, hi: number): number {
    if (v >= lo && v <= hi) return v;
    const err = new RangeCheckError(where, v, lo, hi);
    if (this.strict) throw err;
    this.rangeErrors.push(err.message);
    console.warn(`[rongo] ${err.message} (original crashed here)`);
    return Math.min(hi, Math.max(lo, v));
  }

  /** FormShow @0x435234 -> shuffle @0x434e14: 501 random legal moves, then the intro countdown. */
  start() {
    this.fx.playSound(null, 1);
    for (let n = 0; n < 501; n++) {
      this.playing = true;
      let ok = false;
      while (!ok) {
        const row = this.fx.random(3);
        const col = this.fx.random(3);
        ok = this.selectCell(col, row);
      }
    }
    this.fx.repaint();
    this.moves = 0;
    this.soundsOn = true;
    this.countdown = 10;
    this.state = St.Intro;
  }

  /** dgPuzzleSelectCell @0x434bc0. Returns CanSelect (true when a tile moved). */
  selectCell(col: number, row: number): boolean {
    if (!this.playing) return false;
    const ec = this.empty % 3, er = Math.trunc(this.empty / 3);
    const target = row * 3 + col;
    const adjacent = (col === ec && (er === row - 1 || er === row + 1)) || (row === er && (ec === col - 1 || ec === col + 1));
    if (!adjacent) return false;
    const tile = this.board[this.rc('0x434c82', target, 0, 8)];
    this.board[this.rc('0x434ca5', target, 0, 8)] = this.board[this.rc('0x434c95', this.empty, 0, 8)];
    this.board[this.rc('0x434cb8', this.empty, 0, 8)] = tile;
    this.empty = target;
    if (this.soundsOn) {
      if (this.speaking) {
        // a move interrupts Rongo's reading
        this.speaking = false;
        if (this.speakIdx === -1) this.speakIdx = 0;
        this.rc('0x434d02', this.speakIdx, 0, 255);
        this.speakIdx = -1;
        this.state = St.Idle;
      }
      this.fx.playSound(this.rc('0x434d72', tile + 13, 0, 21), SND_ASYNC | SND_MEMORY);
    }
    this.moves++;
    let solved = true;
    for (let i = 0; i < 9; i++) if (this.board[i] !== i) solved = false;
    if (solved) {
      this.playing = false;
      this.speak(-1);
    }
    this.fx.repaint();
    return true;
  }

  /** @0x4342c4: speak cell `idx` (or -1 = random babble before reading starts). */
  speak(idx: number) {
    if (idx === -1) {
      const s = this.rc('0x4342f8', this.fx.random(2) + 3, 0, 255);
      this.fx.playSound(this.rc('0x434305', s & 0xff, 0, 21), SND_ASYNC | SND_MEMORY);
    } else {
      if (idx === this.empty) {
        idx++;
        this.speakIdx++;
      }
      if (idx === 9) {
        this.fx.repaint();
        if (this.playing) return;
        // solved and fully recited: close after 5 s
        this.countdown = 5;
        this.fx.setTimerInterval(1000);
        this.state = St.Won;
        return;
      }
      this.fx.repaint();
      const tile = this.board[this.rc('0x434422', idx, 0, 8)];
      this.fx.playSound(this.rc('0x434443', tile + 5, 0, 21), SND_ASYNC | SND_MEMORY);
    }
    this.state = St.Speaking;
  }

  /** @0x434484: next mouth frame, bouncing 2,3,4,5,4,3,2,1,2,... */
  nextMouthFrame(): number {
    if (!this.mouthUp) {
      this.mouthFrame--;
      if (this.mouthFrame === 0) { this.mouthUp = true; this.mouthFrame = 2; }
    } else {
      this.mouthFrame++;
      if (this.mouthFrame > 5) { this.mouthUp = false; this.mouthFrame = 4; }
    }
    return this.mouthFrame;
  }

  /** AniTimerTimer @0x434600 (100 ms). */
  tick() {
    switch (this.state) {
      case St.Speaking:
        this.state = St.Idle;
        // probe: sndPlaySound with SND_NOSTOP fails while the current word still plays
        if (!this.fx.playSound(21, SND_MEMORY | SND_NOSTOP)) {
          this.fx.mouth(this.nextMouthFrame());
          this.fx.repaint();
          this.state = St.Speaking;
        } else {
          this.state = St.Idle;
          this.speakIdx++;
          this.speak(this.speakIdx);
        }
        break;
      case St.Intro:
        this.state = St.Idle;
        if (--this.countdown === 0) this.fx.playSound(0, SND_ASYNC | SND_MEMORY);
        else this.state = St.Intro;
        break;
      case St.Instructions:
        this.state = this.fx.playSound(21, SND_MEMORY | SND_NOSTOP) ? St.Idle : St.Instructions;
        break;
      case St.Won:
        this.state = St.Idle;
        if (--this.countdown === 0) {
          this.exitCode = 1;
          this.fx.close();
        } else this.state = St.Won;
        break;
      case St.SignUp:
        this.signStep++;
        this.fx.repaint();
        if (this.signStep === 15) {
          this.fx.playQuestion();
          this.state = St.SignWait;
        }
        break;
      case St.SignDown:
        this.signStep--;
        this.fx.repaint();
        if (this.signStep === 0) this.signClosed();
        break;
    }
  }

  /** FormMouseDown @0x43490c (form coordinates). */
  mouseDown(x: number, y: number) {
    const s = this.state;
    if (s === St.SignUp || s === St.SignDown || s === St.SignWait) {
      if (s !== St.SignWait) return;
      if (y > 160 && y < 197 && x > 454 && x < 505) { this.signAnswerYes = true; this.state = St.SignDown; }
      if (y > 163 && y < 198 && x > 523 && x < 586) { this.signAnswerYes = false; this.state = St.SignDown; }
      return;
    }
    // Rongo himself (x 401..564): start / stop reading the tablet
    if (this.playing && x > 400 && x < 565) {
      if (!this.speaking) {
        this.speaking = true;
        this.speakIdx = -1;
        this.speak(-1);
      } else {
        this.speaking = false;
        this.speakIdx = -1;
        this.fx.repaint();
        this.state = St.Idle;
      }
    }
  }

  /** @0x434e8c: the book's HERHALEN button during the game replays the instructions (only when idle). */
  repeatInstructions() {
    if (this.state !== St.Idle) return;
    this.fx.playSound(0, SND_ASYNC | SND_MEMORY);
    this.state = St.Instructions;
  }

  /** @0x435058: the book's stop icon was clicked — raise the JA/NEE sign (only when idle). */
  requestQuit(): boolean {
    if (this.state !== St.Idle) return false;
    this.signStep = 0;
    this.fx.setTimerInterval(100);
    this.state = St.SignUp;
    return true;
  }

  /** @0x435010 */
  private signClosed() {
    if (!this.signAnswerYes) this.state = St.Idle;
    else {
      this.exitCode = 2;
      this.fx.close();
    }
  }

  /** FormClose @0x43520c */
  onClose() {
    this.state = St.Idle;
    this.fx.playSound(null, 1);
    if (this.exitCode === 0) this.exitCode = 2;
  }
}
