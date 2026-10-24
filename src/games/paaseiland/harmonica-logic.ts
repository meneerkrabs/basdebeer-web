// Mondharmonica (Paaseiland minigame 5, TfrmG5 in PAASBAAS.EXE) — game logic.
//
// A harmonica melody (GE2412.WAV, 10 notes) must be replayed on a 5-key harmonica. Every
// correct note lights a green lamp; one wrong note switches all lamps off again. After 10
// correct notes the lock opens (GE2402.WAV) and the form closes. Clicking the purple hare
// replays the melody.
//
// Straight port of the decompiled Delphi methods, free of DOM code. Addresses in comments
// refer to PAASBAAS.EXE. Offsets are fields of TfrmG5.

export const SND_ASYNC = 1, SND_MEMORY = 4, SND_NOSTOP = 0x10;

/** Field 0x395 of TfrmG5: the AniTimer state machine. */
export const St = {
  Idle1: 1, // after answering NEE on the sign (does nothing, game keeps running)
  Idle: 2,
  Animate: 5, // key press / release animation tick
  Intro: 0, // countdown (5 ticks) before the spoken instructions GE2401
  WaitIntro: 0x11, // GE2401 playing; afterwards the melody GE2412 plays (synchronously)
  WaitUnused: 0x12, // never entered by the original
  WaitWin: 0x13, // GE2402 (lock opens) playing
  WonCount: 0x17, // countdown before the form closes
  SignUp: 0x18,
  SignDown: 0x19,
  SignWait: 0x1a,
  WaitMelody: 0x16, // melody replay (hare clicked) playing
} as const;
export type St = number;

/** Melody @0x445888 (note = key index + 1). */
export const MELODY = [5, 5, 4, 3, 1, 1, 2, 3, 2, 1];

/** Key rects (FormCreate @0x43ae68: records 0..4) and lamp rects (records 5..14): l, t, r, b. */
export const RECTS: readonly (readonly [number, number, number, number])[] = [
  [199, 56, 244, 228], [245, 56, 295, 226], [296, 57, 344, 223], [345, 57, 392, 223], [392, 55, 442, 224],
  [216, 34, 238, 55], [240, 34, 260, 56], [261, 34, 281, 55], [284, 34, 304, 55], [305, 34, 326, 55],
  [327, 33, 347, 55], [349, 34, 369, 54], [371, 33, 391, 55], [392, 34, 412, 55], [413, 34, 435, 54],
];
/** Hare, the "play melody again" hot spot: Rect(0x1ed, 0x43, 0x250, 200). */
export const HARE: readonly [number, number, number, number] = [493, 67, 592, 200];
/** Sign area (saved background + draw target): Rect(0x1a4, 0x8d, 0x268, 0x140). */
export const SIGN = { x: 420, y: 141, w: 196, h: 179 };

export interface HarmonicaEffects {
  /** sndPlaySound(sounds[i], flags) with i = 0..7 for GE2411..GE2418 (null stops). Async or probe. */
  playSound(i: number | null, flags: number): boolean;
  /**
   * sndPlaySound(sounds[i], flags) WITHOUT SND_ASYNC: the original blocks (UI frozen) until the
   * sound ends. Returns false (immediately) when SND_NOSTOP is set and a sound is playing.
   */
  playSoundSync(i: number, flags: number): boolean;
  /** sndPlaySound(file, SND_ASYNC) for GE2401.WAV / GE2402.WAV. */
  playFile(name: 'GE2401' | 'GE2402'): void;
  /** yn001.wav / yn002.wav ("wil je stoppen?"). */
  playQuestion(which: number): void;
  /** Draw 2-frame sprite strip `rec` (0..14) frame 0|1 into the background @0x43b528/0x43be78/0x43bf68. */
  drawFrame(rec: number, frame: number): void;
  /** @0x43c0fc: restore background under the sign, draw sign with `step` * 12 rows. */
  drawSign(step: number): void;
  /** @0x43c2a4: copy the form's sign area into the saved bitmap. */
  saveSignBackground(): void;
  repaint(): void;
  setTimerInterval(ms: number): void;
  close(): void;
}

export class HarmonicaLogic {
  state: St = St.Intro; // 0x395
  countdown = 5; // 0x394 (initialised to 5 in FormCreate)
  count = 0; // 0x4e7: notes entered so far (aliases notes[11])
  private notes = new Uint8Array(12); // 0x4dc..0x4e7 (0x4dc = "play note sound" flag)
  keyIdx = 0; // 0x4da: key being animated
  noteSound = 0; // 0x4db: sound index of the note (key + 2)
  frameIdx = 1; // 0x4d9
  frameMax = 1; // 0x4d8
  frameMap = [1, 2]; // 0x3d8,0x3d9: sprite frame (1-based) per animation step
  held = false; // 0x397: a key is held down
  exitCode = 0; // 0x4fc
  signStep = 0; // 0x4f4
  signWhich = 1; // 0x4f9
  signAnswerYes = false; // 0x4f8

  private fx: HarmonicaEffects;

  constructor(fx: HarmonicaEffects) {
    this.fx = fx;
  }

  /** AniTimerTimer @0x43b714 (100 ms). */
  tick() {
    const fx = this.fx;
    switch (this.state) {
      case St.Intro: // @0x43b7a6
        if (--this.countdown === 0) {
          fx.playFile('GE2401');
          this.state = St.WaitIntro;
        } else this.state = St.Intro;
        break;
      case St.WaitIntro: // @0x43b81c: probe; when idle play the melody synchronously
        if (fx.playSoundSync(0, SND_MEMORY | SND_NOSTOP)) {
          fx.playSoundSync(1, SND_MEMORY);
          this.state = St.WaitMelody;
        } else this.state = St.WaitIntro;
        break;
      case St.WaitUnused: // @0x43b86a
        this.state = fx.playSoundSync(0, SND_MEMORY | SND_NOSTOP) ? St.Idle : St.WaitUnused;
        break;
      case St.WaitMelody: // @0x43b8a7: melody done -> short jingle GE2418
        if (fx.playSoundSync(0, SND_MEMORY | SND_NOSTOP)) {
          fx.playSound(7, SND_ASYNC | SND_MEMORY);
          this.state = St.Idle;
        } else this.state = St.WaitMelody;
        break;
      case St.WaitWin: // @0x43b8f5
        if (fx.playSoundSync(0, SND_MEMORY | SND_NOSTOP)) {
          this.state = St.WonCount;
          this.countdown = 5;
        } else this.state = St.WaitWin;
        break;
      case St.Animate: // @0x43b93c
        this.animateKey();
        this.frameIdx++;
        this.state = this.frameIdx > this.frameMax ? St.Idle : St.Animate;
        break;
      case St.WonCount: // @0x43b990
        if (--this.countdown === 0) {
          this.state = St.Idle;
          this.exitCode = 1; // original: Close() first, then store 1 (OnClose runs after)
          fx.close();
        } else this.state = St.WonCount;
        break;
      case St.SignUp: // @0x43b9dd
        fx.drawSign(this.signStep);
        this.signStep++;
        if (this.signStep === 15) {
          fx.playQuestion(this.signWhich);
          this.state = St.SignWait;
        } else this.state = St.SignUp;
        break;
      case St.SignDown: // @0x43ba8b
        this.signStep--;
        fx.drawSign(this.signStep);
        if (this.signStep === 0) this.signClosed();
        else this.state = St.SignDown;
        break;
    }
  }

  /** @0x43b528: draw the key sprite (+ note sound the first time). */
  private animateKey() {
    const fx = this.fx;
    const m = this.frameMap[this.frameIdx] ?? this.frameMap[1]; // [0x3d8 + [0x4d9]]; only index 1 is ever read
    fx.drawFrame(this.keyIdx, m - 1);
    fx.repaint();
    if (this.notes[0] !== 0) {
      fx.playSound(this.noteSound, SND_ASYNC | SND_MEMORY);
      this.notes[0] = 0;
    }
  }

  /** FormMouseDown @0x43bb60 (form coordinates). */
  mouseDown(x: number, y: number) {
    const s = this.state;
    if (s === St.SignUp || s === St.SignDown || s === St.SignWait) {
      if (s !== St.SignWait) return;
      if (y > 0xa0 && y < 0xc5 && x > 0x1c6 && x < 0x1f9) { this.signAnswerYes = true; this.state = St.SignDown; }
      if (y > 0xa3 && y < 0xc6 && x > 0x20b && x < 0x24a) { this.signAnswerYes = false; this.state = St.SignDown; }
      return;
    }
    if (s === St.WaitWin || s === St.WonCount) return;
    if (inRect(HARE, x, y)) {
      this.fx.playSound(1, SND_ASYNC | SND_MEMORY); // melody again
      this.held = false;
      this.state = St.WaitMelody;
    }
    for (let i = 0; i < 5; i++) {
      if (!inRect(RECTS[i], x, y)) continue;
      this.count = (this.count + 1) & 0xff; // original: range-checked Byte inc
      // notes[count] aliases the count byte itself when count == 11 (only reachable when the hare
      // was clicked with the 10th key held; the original then corrupts count). Reproduced.
      if (this.count <= 11) this.notes[this.count] = i + 1;
      if (this.count === 11) this.count = this.notes[11];
      this.keyIdx = i;
      this.frameMap = [1, 2];
      this.frameMax = 1;
      this.frameIdx = 1;
      this.noteSound = i + 2;
      this.notes[0] = 1;
      this.state = St.Animate;
      this.held = true;
    }
  }

  /** FormMouseUp @0x43bd48. */
  mouseUp() {
    if (this.state === St.WaitWin || this.state === St.WonCount || !this.held) return;
    this.held = false;
    const c = this.count;
    // melody index c-1: range-guard (c is 1..10 in all reachable cases except the corruption above)
    if (c >= 1 && c <= 10 && MELODY[c - 1] === this.notes[c]) this.lampOn(c);
    else {
      this.lampsOff();
      this.count = 0;
    }
    this.frameIdx = 1;
    this.frameMap = [2, 1];
    this.frameMax = 1;
    this.state = St.Animate;
    if (this.count === 10) {
      this.fx.playFile('GE2402');
      this.state = St.WaitWin;
    }
  }

  /** @0x43be78: lamp `count` (record count+4) on = frame 2. */
  private lampOn(c: number) {
    this.fx.drawFrame(c + 4, 1);
    this.fx.repaint();
  }

  /** @0x43bf68: lamps 1..count off = frame 1. */
  private lampsOff() {
    for (let i = 1; i <= this.count && i <= 10; i++) this.fx.drawFrame(i + 4, 0);
    this.fx.repaint();
  }

  /** @0x43c2a4: the book's stop icon was clicked — raise the JA/NEE sign. */
  requestQuit(): boolean {
    const s = this.state;
    if (s === St.WaitWin || s === St.SignUp || s === St.SignDown || s === St.SignWait) return false;
    this.fx.saveSignBackground();
    this.signStep = 1;
    this.signWhich = 1;
    this.fx.setTimerInterval(100);
    this.state = St.SignUp;
    return true;
  }

  /** @0x43c25c */
  private signClosed() {
    if (!this.signAnswerYes) this.state = St.Idle1;
    else {
      // state stays 0x19 (timer handler sets it back to 2 first, so effectively idle) while closing
      this.state = St.Idle;
      if (this.signWhich === 1) {
        this.exitCode = 2;
        this.fx.close();
      }
    }
  }

  /** FormClose @0x43c458 */
  onClose() {
    this.fx.playSound(null, SND_ASYNC);
    if (this.exitCode === 0) this.exitCode = 2;
  }
}

function inRect(r: readonly [number, number, number, number], x: number, y: number) {
  return x >= r[0] && x < r[2] && y >= r[1] && y < r[3]; // PtInRect
}
