// Geheugen trainer (Paaseiland minigame 3, TfrmG3 in PAASBAAS.EXE) — game logic.
//
// 16 switch-panel buttons hide 8 pairs of pictures (shuffled with 401 random swaps). Clicking a
// button flips it and shows its picture on one of two TV screens; the second pick is compared
// with the first. A match removes one of the 8 laser beams (random pick among those left),
// a mismatch flips both buttons back. When all 8 pairs are found the lasers are gone: the
// victory sound plays and the player clicks the magic egg (or waits 12 s) to finish.
//
// Port of the decompiled Delphi methods (addresses in comments), DOM-free. The original blocks
// inside its event handlers with `while state = 5 do Application.ProcessMessages` while the
// 100 ms AniTimer plays a frame sequence; here those loops are `await this.runSeq()`.
// Field offsets in comments refer to the TfrmG3 instance.

export const SND_ASYNC = 1, SND_MEMORY = 4, SND_NOSTOP = 0x10;

/** Field 0x4f9 of TfrmG3: the AniTimer state machine. */
export const St = {
  Intro: 0, // countdown before GE1701.WAV
  Idle1: 1, // "idle" after the player answered NEE on the stop sign
  Idle: 2,
  Seq: 5, // a frame sequence is playing (event handler is waiting for it)
  IntroSound: 0x11, // wait for GE1701 to end, then GE1711 (synchronous)
  EggWait: 0x13, // all pairs found: waiting for a click on the egg / 12 s
  SignUp: 0x18,
  SignDown: 0x19,
  SignWait: 0x1a,
} as const;
export type St = (typeof St)[keyof typeof St];

/** Sprite index (0..25) -> rectangle [l, t, r, b] on the 640x320 scene (FormCreate @0x436d9c). */
export const SPRITE_RECTS: readonly (readonly [number, number, number, number])[] = [
  [0, 3, 29, 315], [28, 3, 63, 316], [66, 0, 102, 317], [104, 0, 145, 319],
  [152, 2, 188, 319], [197, 3, 241, 318], [248, 1, 295, 317], [306, 2, 353, 314],
  // 8..23: the 16 buttons (4 rows of 4), 4 frames each
  [425, 113, 463, 151], [467, 111, 507, 149], [512, 108, 553, 145], [558, 105, 599, 144],
  [429, 154, 465, 190], [473, 152, 509, 189], [516, 151, 555, 188], [562, 149, 603, 187],
  [431, 195, 466, 229], [475, 193, 510, 229], [519, 194, 558, 229], [566, 193, 609, 228],
  [435, 236, 469, 271], [477, 237, 512, 271], [523, 237, 561, 272], [571, 237, 613, 273],
  // 24, 25: the two TV screens (12 frames: 1-3 noise, 4 black, 5-12 the 8 pictures)
  [405, 23, 505, 100], [513, 17, 616, 91],
];
export const EGG = { l: 249, t: 108, r: 341, b: 167 }; // @0x437cc4: clicking it ends the game
export const SIGN_RECT = { l: 420, t: 141, r: 616, b: 320 }; // @0x438558

export interface MemoryEffects {
  /** Draw frame (1-based) of sprite `idx` into the scene bitmap + invalidate its rect (@0x437790). */
  drawFrame(idx: number, frame: number): void;
  /** sndPlaySound(GE17<name>.WAV file, SND_ASYNC). name: 'GE1701' | 'GE1702'. */
  playFile(name: string): void;
  /** sndPlaySound(memorySound[i], flags); i = 0..3 for GE1711..GE1714. Returns false if NOSTOP and busy. */
  playMem(i: number, flags: number): boolean;
  /** sndPlaySound(NULL, SND_ASYNC) */
  stopSound(): void;
  /** Resolves when the system sound channel is idle. */
  whenSoundDone(): Promise<void>;
  /** Play yn001.wav ("wil je stoppen?"). */
  playQuestion(): void;
  random(n: number): number;
  repaint(): void;
  setTimerInterval(ms: number): void;
  close(): void;
}

const inRect = (x: number, y: number, r: readonly [number, number, number, number]) =>
  x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

export class MemoryLogic {
  exitCode = 0; // 0x664: 1 = solved, 2 = stopped (the book quits on 2)
  state: St = St.Intro; // 0x4f9
  countdown = 10; // 0x4f8
  // 0x51c: 16 x {state, picture}: state 0 = face down, 1 = flipped, 2 = matched; picture 0..7
  btnState = new Uint8Array(16);
  btnPic = new Uint8Array(16);
  lasers = new Uint8Array(8).fill(1); // 0x641: 1 = still on
  pairs = 0; // 0x64b
  firstPick = true; // 0x649: next click is the first of a pair
  evalPending = false; // 0x64a: second screen shown -> evaluate
  firstBtn = 0; // 0x64c
  secondBtn = 0; // 0x64d
  busy = false; // 0x64e: comparing a pair
  inputOn = false; // 0x64f
  // frame sequence player (0x63c..0x640, seq at 0x53c)
  private spriteIdx = 0; // 0x63e
  private step = 0; // 0x63d
  private seqLast = 0; // 0x63c
  private seq = new Uint8Array(16);
  private sndIdx = 0; // 0x63f
  private sndPending = false; // 0x640
  private seqDone: (() => void) | null = null;
  // stop sign
  signCounter = 0; // 0x65c: sign height in 12 px steps
  /** The step last drawn (what the original had blitted into the scene). */
  signDrawn = 0;
  private signYes = false; // 0x660
  private signKind = 0; // 0x661
  /** True while a synchronous sndPlaySound would block the original's message loop. */
  blocked = false;
  closed = false;

  private fx: MemoryEffects;
  constructor(fx: MemoryEffects) {
    this.fx = fx;
  }

  /** FormCreate tail (@0x437500..0x437ca8). */
  start() {
    for (let i = 0; i < 8; i++) { this.btnPic[2 * i] = i; this.btnPic[2 * i + 1] = i; }
    // Randomize; 401 times swap two random buttons' pictures (indices from Random(16): in range)
    for (let n = 0x191; n > 0; n--) {
      const a = this.fx.random(16), b = this.fx.random(16);
      const t = this.btnPic[a]; this.btnPic[a] = this.btnPic[b]; this.btnPic[b] = t;
    }
    this.inputOn = true; // @0x437ca8
    this.state = St.Intro;
  }

  /** The sprite sequence: frames seq[1..last] of sprite idx (steps start at 1). */
  private setSeq(idx: number, frames: number[], snd: number | null) {
    this.spriteIdx = idx;
    this.step = 1;
    this.seq.fill(0);
    frames.forEach((f, i) => (this.seq[i + 1] = f));
    this.seqLast = frames.length;
    if (snd !== null) { this.sndIdx = snd; this.sndPending = true; } else this.sndPending = false;
  }

  private runSeq(): Promise<void> {
    this.state = St.Seq;
    return new Promise((res) => (this.seqDone = res));
  }

  /** @0x437790: draw the current frame of the sequence. */
  private drawStep() {
    this.fx.drawFrame(this.spriteIdx, this.seq[this.step]);
    if (this.sndPending) { this.fx.playMem(this.sndIdx, SND_ASYNC | SND_MEMORY); this.sndPending = false; }
  }

  /** AniTimerTimer @0x43797c. */
  tick() {
    if (this.closed || this.blocked) return;
    switch (this.state) {
      case St.Intro:
        this.countdown--;
        if (this.countdown < 1) {
          this.fx.playFile('GE1701');
          this.state = St.IntroSound;
        }
        break;
      case St.Seq:
        this.state = St.Idle;
        this.drawStep();
        this.step++;
        if (this.seqLast < this.step) this.state = St.Idle; else this.state = St.Seq;
        if (this.state !== St.Seq) { const r = this.seqDone; this.seqDone = null; r?.(); }
        break;
      case St.IntroSound: {
        this.state = St.Idle;
        // sndPlaySound(GE1711, SND_NOSTOP|SND_MEMORY) is *synchronous* in the original:
        // it blocks the message loop until the sound has ended.
        if (!this.fx.playMem(0, SND_NOSTOP | SND_MEMORY)) this.state = St.IntroSound;
        else {
          this.blocked = true;
          this.fx.whenSoundDone().then(() => (this.blocked = false));
        }
        break;
      }
      case St.EggWait:
        this.countdown--;
        if (this.countdown === 0) { this.exitCode = 1; this.fx.close(); }
        break;
      case St.SignUp:
        this.state = St.Idle;
        this.drawSign();
        this.signCounter++;
        if (this.signCounter === 0xf) {
          if (this.signKind === 1 || this.signKind === 2) this.fx.playQuestion(); // yn001 / yn002 (kind is always 1)
          this.state = St.SignWait;
        } else this.state = St.SignUp;
        break;
      case St.SignDown:
        this.state = St.Idle;
        this.signCounter--;
        this.drawSign();
        if (this.signCounter === 0) this.endSign();
        else this.state = St.SignDown;
        break;
      case St.SignWait:
        break;
    }
  }

  private drawSign() {
    this.signDrawn = this.signCounter; // @0x438558 (the UI overlays the sign slice of this height)
    this.fx.repaint();
  }

  /** FUN_004386b8 */
  private endSign() {
    this.signDrawn = 0;
    this.fx.repaint();
    if (!this.signYes) this.state = St.Idle1;
    else if (this.signKind === 1) { this.exitCode = 2; this.fx.close(); }
  }

  /** The book's stop icon / quit-sign starter @0x438700. */
  requestQuit() {
    const s = this.state;
    if (this.closed || this.blocked) return;
    if (this.inputOn && s !== St.EggWait && s !== St.SignUp && s !== St.SignDown && s !== St.SignWait) {
      this.signCounter = 1;
      this.signKind = 1;
      this.signDrawn = 0;
      this.fx.setTimerInterval(100);
      this.state = St.SignUp;
    }
  }

  /** FormMouseDown @0x437cc4 */
  async mouseDown(x: number, y: number) {
    if (this.closed || this.blocked) return;
    const s = this.state;
    if (s === St.SignUp || s === St.SignDown || s === St.SignWait) {
      if (s === St.SignWait) {
        if (x > 0x1c6 && x < 0x1f9 && y > 0xa0 && y < 0xc5) { this.signYes = true; this.state = St.SignDown; }
        if (x > 0x20b && x < 0x24a && y > 0xa3 && y < 0xc6) { this.signYes = false; this.state = St.SignDown; }
      }
      return;
    }
    if (!this.inputOn || this.busy) return;
    if (s === St.EggWait && x >= EGG.l && x < EGG.r && y >= EGG.t && y < EGG.b) {
      this.exitCode = 1;
      this.fx.close();
    }
    for (let sp = 8; sp < 24; sp++) {
      if (!inRect(x, y, SPRITE_RECTS[sp])) continue;
      const b = sp - 8;
      if (this.btnState[b] !== 0) return;
      this.inputOn = false;
      this.fx.stopSound();
      this.btnState[b] = 1;
      this.setSeq(sp, [2, 3], 2); // flip the button open, sound GE1713
      await this.runSeq();
      if (this.closed) return;
      if (this.firstPick) {
        this.firstBtn = b;
        this.firstPick = false;
        this.evalPending = false;
        await this.showPicture(1, true, this.btnPic[b]);
        this.inputOn = true;
      } else {
        this.secondBtn = b;
        this.firstPick = true;
        this.busy = true;
        this.evalPending = true;
        await this.showPicture(2, true, this.btnPic[b]);
      }
      return;
    }
  }

  /** @0x437f68: remove a random laser that is still on. */
  private async removeLaser() {
    // (original: infinite loop if none is left; 8 pairs vs 8 lasers makes that unreachable)
    if (!this.lasers.some((v) => v)) return;
    let r = this.fx.random(8);
    while (this.lasers[r] === 0) r = this.fx.random(8);
    this.lasers[r] = 0;
    this.setSeq(r, [2, 1, 2, 3, 2, 3, 1, 3], 1); // flicker, then off; sound GE1712
    await this.runSeq();
  }

  /** @0x438024: TV `which` (1|2) shows static, then (if showPic) the picture. */
  private async showPicture(which: 1 | 2, showPic: boolean, pic: number) {
    const sprite = which + 0x17;
    this.setSeq(sprite, [2, 1, 3, 1, 2, 3, 4], 3); // static, sound GE1714, ends black
    await this.runSeq();
    if (this.closed) return;
    // (the original also computes a source/dest Rect for A01730.BMP here but never draws with it)
    if (showPic) {
      this.setSeq(sprite, [pic + 5], null); // frame 5..12 = the picture
      this.sndPending = false;
      await this.runSeq();
      if (this.closed) return;
    }
    if (this.evalPending) await this.evaluate();
  }

  /** @0x4381b0: compare the two picked buttons. */
  private async evaluate() {
    this.evalPending = false;
    this.firstPick = true;
    const a = this.firstBtn, b = this.secondBtn;
    if (this.btnPic[a] === this.btnPic[b]) {
      this.pairs++;
      this.btnState[a] = 2;
      this.btnState[b] = 2;
      for (const k of [a, b]) {
        this.setSeq(k + 8, [4], null); // matched: lit frame
        await this.runSeq();
        if (this.closed) return;
      }
      await this.removeLaser();
      if (this.closed) return;
      await this.showPicture(1, false, this.btnPic[a]);
      await this.showPicture(2, false, this.btnPic[b]);
      if (this.closed) return;
      this.busy = false;
      this.inputOn = true;
    } else {
      await this.showPicture(1, false, this.btnPic[a]);
      await this.showPicture(2, false, this.btnPic[b]);
      if (this.closed) return;
      this.btnState[a] = 0;
      this.btnState[b] = 0;
      for (const k of [a, b]) {
        this.setSeq(k + 8, [2, 1], null); // flip the button closed
        await this.runSeq();
        if (this.closed) return;
      }
      this.busy = false;
      this.inputOn = true;
    }
    if (this.pairs === 8) {
      this.fx.playFile('GE1702');
      this.countdown = 12;
      this.fx.setTimerInterval(1000);
      this.state = St.EggWait;
    }
  }

  /** FormClose @0x4388c0 */
  onClose() {
    this.closed = true;
    this.fx.stopSound();
    if (this.exitCode === 0) this.exitCode = 2;
  }
}
