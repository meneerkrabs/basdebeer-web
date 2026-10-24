// Sorteer machine (Paaseiland minigame 2, TfrmG2 in PAASBAAS.EXE) — game logic.
//
// Eggs ride a conveyor belt (8 slots, 90 px each, moving 9 px per tick). The machine shows
// one "target" egg; click that egg on the belt. Six hits (all different targets) win the
// game; a final special sprite (cell 23) rides in and stops mid-belt, then the form closes.
//
// Straight port of the decompiled Delphi methods (addresses in comments), DOM-free.
// Field offsets (hex) refer to TfrmG2 instance fields. The original was compiled with range
// checking; no index in this form can leave its range in normal play, the few `bound`
// spots are guarded with `bound()` anyway.

export const SND_ASYNC = 1, SND_MEMORY = 4, SND_LOOP = 8, SND_NOSTOP = 0x10;

/** Field 0x1b8 of TfrmG2: the AniTimer state machine. */
export const St = {
  Intro: 0x00, // countdown (10 x 50 ms) before the spoken introduction
  Idle: 0x02,
  Belt: 0x0f, // advance the belt 9 px
  Intro1: 0x11, // GE1301 playing (waits for its end, belt keeps moving)
  Intro2: 0x12, // GE1302 playing; afterwards the game starts
  Win: 0x14, // belt keeps rolling; emptied, then the special sprite enters
  AfterClick: 0x15, // waits for the click sound to end, then restarts the belt hum
  WonWait: 0x17, // 10 s countdown (or click) before the form closes
  SignUp: 0x18,
  SignDown: 0x19,
  SignWait: 0x1a,
} as const;
export type St = (typeof St)[keyof typeof St];

export interface Slot {
  type: number; // 0..21 egg, 23 final sprite, -1 empty (field 0x218 + 20*k)
  l: number; t: number; r: number; b: number; // last painted dest rect (0x21c + 20*k), used for hit tests
}

export interface SorteerEffects {
  /**
   * sndPlaySound of one of the four in-memory sounds: 0 = GE1304 (silent probe), 1 = GE1305 (hit),
   * 2 = GE1306 (miss), 3 = GE1307 (belt hum, looped); null stops. Returns false when SND_NOSTOP and busy.
   */
  playMem(i: number | null, flags: number): boolean;
  /** sndPlaySound of a file: GE1301 / GE1302 (spoken instructions), GE1303 (win), YN001 (stop?). */
  playFile(name: string): void;
  random(n: number): number;
  randomize(): void;
  repaint(): void;
  setTimerInterval(ms: number): void;
  /** Copy the 196x155 region of the background under the stop sign (@0x436a38). */
  saveSignBackground(): void;
  /** @0x436878: draw the sign `step*12` px high into the background and show that region. */
  drawSign(step: number): void;
  close(): void;
}

export class SorteerLogic {
  slots: Slot[] = Array.from({ length: 8 }, () => ({ type: 0, l: 0, t: 0, r: 0, b: 0 }));
  state: St = St.Idle; // 0x1b8
  off = 0; // 0x1f0: belt scroll 0..90 step 9
  rot = 0; // 0x1f4: which slot sits at screen position 0 (0..7)
  revs = 0; // 0x2c7: completed belt revolutions since the last target insertion
  introCount = 0; // 0x2c3
  winRefresh = 0; // 0x2c2
  winSlot = -1; // 0x2d4: slot holding the final sprite
  nextState: St = St.Idle; // 0x2c6: state restored after a Belt step
  won = false; // 0x2c4: click anywhere closes the form
  winFlag = false; // 0x2c5
  started = false; // 0x2d8
  playing = false; // 0x2c0
  score = 0; // 0x2c8: eggs found so far (0..6)
  collected: number[] = [0, 0, 0, 0, 0, 0, 0]; // 0x2cc..: 1-based list of found eggs
  target = 0; // 0x2d3
  exitCode = 0; // 0x2f0: 1 = won, 2 = stopped (the book quits on 2)
  signStep = 0; // 0x2e8
  signAnswerYes = false; // 0x2ec
  winCountdown = 0; // 0x2d9

  private fx: SorteerEffects;
  constructor(fx: SorteerEffects) {
    this.fx = fx;
    // FormCreate @0x4353c8
    this.state = St.Idle;
    this.fx.randomize();
    for (let i = 0; i < 8; i++) this.slots[i].type = this.fx.random(22);
  }

  private bound(where: string, v: number, lo: number, hi: number): number {
    if (v >= lo && v <= hi) return v;
    console.warn(`[sorteer] range check at ${where}: ${v} not in ${lo}..${hi} (original crashed here)`);
    return Math.min(hi, Math.max(lo, v));
  }

  /** FormShow @0x436758 */
  start() {
    this.fx.randomize();
    this.target = this.fx.random(22);
    this.revs = 0;
    this.introCount = 10;
    this.fx.setTimerInterval(50);
    this.state = St.Intro;
  }

  /** FUN_004366d8: the game proper begins (BEGINNEN clicked, or the instructions ended). */
  private begin() {
    this.started = true;
    this.exitCode = 0;
    this.fx.repaint();
    this.fx.playMem(3, SND_ASYNC | SND_MEMORY | SND_LOOP);
    this.fx.setTimerInterval(50);
    this.playing = true;
    this.nextState = St.Belt;
    this.state = St.Belt;
  }

  /** FUN_004367a8: replay the instructions (not reachable from the book; kept for completeness). */
  repeatInstructions() {
    if (!this.winFlag && this.playing && this.started) {
      this.fx.playFile('GE1302');
      this.nextState = St.Intro2;
      this.state = St.Intro2;
    }
  }

  /** The "is the sound over?" probe: sndPlaySound(GE1304, MEMORY|NOSTOP). true = channel was free. */
  private probe(): boolean {
    return this.fx.playMem(0, SND_MEMORY | SND_NOSTOP);
  }

  /** AniTimerTimer @0x435c94 */
  tick() {
    switch (this.state) {
      case St.Intro: // 0
        this.state = St.Idle;
        if (--this.introCount === 0) {
          this.fx.playFile('GE1301');
          this.nextState = St.Intro1;
          this.state = St.Intro1;
        } else this.state = St.Intro;
        break;
      case St.Belt: { // 0xf
        this.state = St.Idle;
        this.off += 9;
        if (this.off === 90) {
          this.fx.randomize();
          const s = this.bound('0x435d4b', 7 - this.rot, 0, 7);
          this.slots[s].type = this.fx.random(22);
          if (this.revs === 2) {
            this.revs = 0;
            this.slots[s].type = this.target; // the target egg rides in
          }
          if (++this.rot === 8) {
            this.rot = 0;
            this.revs++;
          }
          this.off = 0;
        }
        this.fx.repaint();
        this.state = this.nextState;
        break;
      }
      case St.Intro1: // 0x11
        this.state = St.Idle;
        if (!this.probe()) this.state = St.Belt;
        else {
          this.fx.playFile('GE1302');
          this.nextState = St.Intro2;
          this.state = St.Intro2;
        }
        break;
      case St.Intro2: // 0x12
        this.state = St.Idle;
        if (!this.probe()) this.state = St.Belt;
        else this.begin();
        break;
      case St.Win: { // 0x14
        this.state = St.Idle;
        this.off += 9;
        if (this.winSlot >= 0 && this.slots[this.winSlot].l > 270) {
          // the final sprite reached the middle: stop, close after 10 s (or on click)
          this.fx.setTimerInterval(1000);
          this.winCountdown = 10;
          this.state = St.WonWait;
          this.won = true;
          break;
        }
        if (this.off === 90) {
          this.fx.randomize();
          this.winRefresh++;
          const s = this.bound('0x435e8e', 7 - this.rot, 0, 7);
          if (this.winRefresh === 5) {
            this.slots[s].type = 23;
            this.winSlot = s;
          } else this.slots[s].type = -1;
          if (++this.rot === 8) this.rot = 0;
          this.off = 0;
        }
        this.fx.repaint();
        this.state = this.nextState;
        break;
      }
      case St.AfterClick: // 0x15
        this.state = St.Idle;
        if (!this.probe()) this.state = St.Belt;
        else {
          this.fx.playMem(3, SND_ASYNC | SND_MEMORY | SND_LOOP);
          this.fx.setTimerInterval(50);
          this.nextState = St.Belt;
          this.state = St.Belt;
        }
        break;
      case St.WonWait: // 0x17
        this.state = St.Idle;
        if (--this.winCountdown === 0) {
          this.exitCode = 1;
          this.fx.close();
        }
        this.state = St.WonWait;
        break;
      case St.SignUp: // 0x18
        this.state = St.Idle;
        this.fx.drawSign(this.signStep);
        if (++this.signStep === 13) {
          this.fx.playFile('YN001');
          this.state = St.SignWait;
        } else this.state = St.SignUp;
        break;
      case St.SignDown: // 0x19
        this.state = St.Idle;
        this.signStep--;
        this.fx.drawSign(this.signStep);
        if (this.signStep === 0) this.signClosed();
        else this.state = St.SignDown;
        break;
      case St.SignWait:
        break;
    }
  }

  /** FUN_004369d8 */
  private signClosed() {
    if (!this.signAnswerYes) {
      this.state = this.nextState;
      this.fx.playMem(3, SND_ASYNC | SND_MEMORY | SND_LOOP);
      this.fx.repaint(); // vmt+0x44 (Refresh): the sign slice was drawn straight onto the canvas
    } else {
      this.exitCode = 2;
      this.fx.close();
    }
  }

  /** FormMouseDown @0x436294 (form coordinates). */
  mouseDown(x: number, y: number) {
    const s = this.state;
    if (s === St.SignUp || s === St.SignDown || s === St.SignWait) {
      if (s !== St.SignWait) return;
      if (x >= 255 && x <= 304 && y >= 185 && y <= 220) { this.signAnswerYes = true; this.state = St.SignDown; }
      if (x >= 324 && x <= 385 && y >= 188 && y <= 221) { this.signAnswerYes = false; this.state = St.SignDown; }
      return;
    }
    if (this.won) {
      this.exitCode = 1;
      this.fx.close();
      return;
    }
    if (!this.started && x >= 240 && x < 415 && y >= 195 && y < 310) this.begin(); // BEGINNEN
    if (this.playing && this.started) {
      for (let k = 0; k < 8; k++) {
        const sl = this.slots[k];
        // InflateRect(r, 20, 0) + PtInRect
        if (x >= sl.l - 20 && x < sl.r + 20 && y >= sl.t && y < sl.b) {
          if (sl.type === this.target) {
            this.correct();
            return;
          }
          this.fx.playMem(2, SND_ASYNC | SND_MEMORY);
          this.fx.setTimerInterval(100);
          this.nextState = St.AfterClick;
          this.state = St.Belt;
        }
      }
    }
  }

  /** FUN_00436460: the right egg was clicked. */
  private correct() {
    this.fx.randomize();
    this.score++;
    this.fx.playMem(1, SND_ASYNC | SND_MEMORY);
    this.fx.setTimerInterval(100);
    this.nextState = St.AfterClick;
    this.state = St.Belt;
    this.collected[this.bound('0x436490', this.score, 0, 6)] = this.target;
    this.fx.repaint();
    if (this.score < 6) {
      // new target, different from every egg found so far
      for (;;) {
        const v = this.fx.random(22);
        let dup = false;
        for (let i = 1; i <= this.score; i++) if (this.collected[i] === v) dup = true;
        if (!dup) { this.target = v; break; }
      }
      this.revs = 0;
    } else {
      this.fx.playFile('GE1303');
      this.winRefresh = 0;
      this.playing = false;
      this.winSlot = -1;
      this.nextState = St.Win;
      this.state = St.Win;
      this.winFlag = true;
    }
  }

  /** @0x436a38: the book's stop icon was clicked — raise the JA/NEE sign. */
  requestQuit(): boolean {
    const s = this.state;
    if (!this.playing || !this.started || s === St.SignUp || s === St.SignDown || s === St.SignWait) return false;
    this.fx.saveSignBackground();
    this.signStep = 1;
    this.fx.setTimerInterval(100);
    this.state = St.SignUp;
    return true;
  }

  /** FormClose @0x436858 */
  onClose() {
    this.fx.playMem(null, SND_ASYNC);
    if (this.exitCode === 0) this.exitCode = 2;
  }
}
