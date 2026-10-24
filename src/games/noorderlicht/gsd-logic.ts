// GSD - Stoelendans (musical chairs; Noorderlicht PLAY_GAME 5, TGSDfrmMain in BASNOORD.EXE) - game logic.
//
// DOM-free port of the decompiled Delphi methods (addresses in comments, spec 7.2):
//   FormCreate 0x43b088, FormPaint 0x43b658, round setup FUN_0043b6ac (also FormShow 0x43be48),
//   walker drawing FUN_0043be50, nearest chair FUN_0043c010, GameTimerTimer 0x43c140 (150 ms),
//   FormMouseDown 0x43c724, hover FUN_0043c958 / 0x43ca18.
//
// Seven walkers (1 = Bas, 2..7 = the trolls) circle a path of 10-pixel waypoints around the chairs while a
// WAV music track plays. When it stops (probe: a NOSTOP sndPlaySound of the silent GSD000.WAV succeeds)
// the trolls each run to their nearest free chair and the player has to click a chair for Bas. Six rounds
// with 6, 5, .. 1 chairs; the troll left without a chair is out. Bas without a chair restarts the game at
// round 0. After the sixth round GSD010.WAV plays and the game ends with result 1.
//
// TGSDfrmMain fields: state 0x3c8, round 0x1f8, intro flag 0x3d4 (1 until the first music starts),
// result 0x3d5, running 0x3d6, music order 0x3be.., chair free flags 0x3b8.., chair x/y 0x384/0x388+8i
// (0x380 + 8i / 0x384 + 8i), waypoint list 0x1fc, walker i record at 0x1c8 + 0x38 i.

export const DISP = { x: 123, y: 85, w: 560, h: 280 } as const; // SysDispRect (800x600)
export const TEXT_RECT = { x: 205, y: 405 } as const; // SysTextRect top-left
export const PREV_RECT = [90, 410, 200, 470] as const;
export const STOP_RECT = [145, 495, 260, 600] as const;
export const inBox = (r: readonly number[], x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/** Walker sprite sheets: 8 headings x 2 phases of 57x57 (456x114), GSD006..GSD012 N/M for walker 1..7. */
export const SPRITE = 57;

/** GameTimer interval (ms). */
export const TICK_MS = 150;

type Pt = readonly [number, number];
/** 0x44cce0: per round, the 8 corners of the walking path, relative to the display rect. Round 6 (the win
 * scene, only Bas) reads past the table into the chair table: the same 8 words that follow it. */
export const PATHS: readonly (readonly Pt[])[] = [
  [[210, 10], [360, 10], [440, 90], [440, 170], [360, 260], [210, 260], [120, 170], [120, 90]],
  [[200, 10], [350, 10], [370, 30], [370, 210], [320, 260], [200, 260], [120, 180], [120, 90]],
  [[200, 10], [290, 10], [370, 90], [370, 180], [290, 260], [210, 260], [120, 170], [120, 90]],
  [[250, 10], [340, 10], [360, 30], [360, 240], [340, 260], [260, 260], [170, 170], [170, 90]],
  [[260, 30], [340, 30], [360, 50], [360, 200], [340, 220], [260, 220], [240, 200], [240, 50]],
  [[260, 100], [340, 100], [360, 120], [360, 200], [340, 220], [260, 220], [240, 200], [240, 120]],
  [[180, 130], [250, 70], [320, 70], [380, 130], [320, 200], [240, 200], [180, 130], [250, 70]],
];

/** 0x44ce60: per round, up to six chair centres relative to the display rect (unused slots are 0,0). */
export const CHAIRS: readonly (readonly Pt[])[] = [
  [[180, 130], [250, 70], [320, 70], [380, 130], [320, 200], [240, 200]],
  [[180, 130], [250, 70], [310, 90], [310, 170], [240, 200], [0, 0]],
  [[180, 130], [250, 70], [310, 130], [250, 200], [0, 0], [0, 0]],
  [[230, 130], [300, 70], [300, 200], [0, 0], [0, 0], [0, 0]],
  [[300, 90], [300, 160], [0, 0], [0, 0], [0, 0], [0, 0]],
  [[300, 160], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
  [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
];

/** Timer state (0x3c8). */
export const St = {
  Idle: 0, // inside a tick
  Music: 1, // music plays, walkers circle
  Stop: 2, // music over: trolls pick their chairs
  Run: 3, // running to the chairs, the player may click
  Intro: 4, // GSD007.WAV spoken introduction (first start only)
  Lost: 5, // GSD008.WAV, then restart at round 0
  Next: 6, // GSD009.WAV, then the next round
  Won: 7, // GSD010.WAV, then result 1
} as const;
export type St = (typeof St)[keyof typeof St];

export interface Walker {
  x: number; y: number; heading: number; // +4, +8, +0xc: current position, heading (= path segment, 0..7)
  px: number; py: number; pheading: number; // +0x10, +0x14, +0x18: previous (what to erase)
  phase: number; // +0x1c: leg animation 0/1
  active: boolean; // +0x1d: still in the game
  idx: number; // +0x20: waypoint index
  tx: number; ty: number; // +0x24, +0x28: target chair
  vx: number; vy: number; // +0x2c, +0x30: step towards the target (subtracted every tick)
  seated: boolean; // +0x34
  chair: number; // +0x35: chosen chair 1..6
  out: number; // +0x36: round in which the walker was eliminated
}

export interface GsdIO {
  random(n: number): number;
  /** Rebuild the picture for `round` (scene image, eliminated icons) and repaint. */
  newScene(round: number, walkers: readonly Walker[]): void;
  /** FUN_0043be50: erase the previous rects and draw every active walker (7 down to 1). */
  drawWalkers(walkers: readonly Walker[]): void;
  /** Full repaint (Form.Repaint). */
  repaint(): void;
  /** Play GSD00<n>.WAV (n = 1..6 music, 7 intro, 8 lost, 9 next, 10 won) on the replace-channel (TWave 0x3d0). */
  play(n: number): void;
  /** NOSTOP probe with GSD000.WAV (TWave 0x3cc, option 8): true = no sound was playing. */
  probe(): boolean;
}

/** Delphi Round(): half to even. */
export function delphiRound(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

const newWalker = (): Walker => ({
  x: 0, y: 0, heading: 0, px: 0, py: 0, pheading: 0, phase: 0, active: true, idx: 0, tx: 0, ty: 0, vx: 0, vy: 0,
  seated: false, chair: 0, out: 0,
});

export class GsdLogic {
  /** Walkers 1..7 (index 0 unused). */
  readonly walkers: Walker[] = [newWalker(), newWalker(), newWalker(), newWalker(), newWalker(), newWalker(), newWalker(), newWalker()];
  state: St = St.Idle;
  round = 0; // 0x1f8
  introFlag = true; // 0x3d4
  running = true; // 0x3d6
  result = 0; // 0x3d5
  /** Music track order (0x3be..): a rotation of 1..6 from a random start. */
  music = [0, 0, 0, 0, 0, 0, 0];
  /** Chair free flags 1..6 (0x3b8..) and centres (absolute screen coordinates). */
  chairFree = [false, false, false, false, false, false, false];
  chairX = [0, 0, 0, 0, 0, 0, 0];
  chairY = [0, 0, 0, 0, 0, 0, 0];
  private path: { x: number; y: number; seg: number }[] = [];
  private readonly io: GsdIO;

  constructor(io: GsdIO) {
    this.io = io;
  }

  get chairCount() { return 6 - this.round; }

  /** FUN_0043b6ac: set up the current round and start its sound. */
  newRound(): void {
    const io = this.io, w = this.walkers, round = this.round;
    if (round === 0) {
      for (let i = 1; i <= 7; i++) { w[i].active = true; w[i].out = 0; }
      this.music[1] = io.random(6) + 1;
      for (let k = 2; k <= 6; k++) {
        this.music[k] = this.music[k - 1] + 1;
        if (this.music[k] === 7) this.music[k] = 1;
      }
    }
    // path of 10-pixel steps around the 8 corners
    this.path = [];
    const P = PATHS[round];
    for (let k = 0; k < 8; k++) {
      const a = P[k], b = k < 7 ? P[k + 1] : P[0];
      const dx = Math.trunc((b[0] - a[0]) / 10), dy = Math.trunc((b[1] - a[1]) / 10);
      const sx = Math.sign(dx) * 10, sy = Math.sign(dy) * 10;
      const n = Math.max(Math.abs(dx), Math.abs(dy));
      for (let i = 0; i <= n; i++) this.path.push({ x: DISP.x + a[0] + i * sx, y: DISP.y + a[1] + i * sy, seg: k });
    }
    // spread the active walkers evenly along it
    const spacing = Math.trunc(this.path.length / (7 - round));
    let at = 0;
    for (let i = 1; i <= 7; i++) {
      const k = w[i];
      if (!k.active) continue;
      const p = this.path[at];
      k.x = p.x; k.y = p.y; k.heading = p.seg; k.idx = at;
      k.px = 0; k.py = 0; k.pheading = 0;
      k.seated = false;
      k.chair = 0;
      k.tx = 0; k.ty = 0; k.vx = 0; k.vy = 0;
      at += spacing;
      if (at > this.path.length - 1) at -= this.path.length - 1;
    }
    for (let i = 1; i <= 6; i++) {
      this.chairFree[i] = true;
      this.chairX[i] = DISP.x + CHAIRS[round][i - 1][0];
      this.chairY[i] = DISP.y + CHAIRS[round][i - 1][1];
    }
    io.newScene(round, w);
    if (round === 6) {
      io.play(10);
      this.state = St.Won;
    } else {
      if (!this.introFlag) {
        io.play(this.music[1 + round]);
        this.state = St.Music;
      } else {
        io.play(7);
        this.state = St.Intro;
      }
    }
  }

  /** GameTimerTimer 0x43c140. */
  tick(): void {
    const io = this.io, w = this.walkers;
    switch (this.state) {
      case St.Music: { // 1
        this.state = St.Idle;
        if (io.probe()) { this.state = St.Stop; break; }
        for (let i = 1; i <= 7; i++) {
          const k = w[i];
          if (!k.active) continue;
          k.px = k.x; k.py = k.y; k.pheading = k.heading;
          k.idx++;
          if (this.path.length - 1 < k.idx) k.idx -= this.path.length;
          const p = this.path[k.idx];
          k.x = p.x; k.y = p.y; k.heading = p.seg;
          k.phase = io.random(2);
        }
        io.drawWalkers(w);
        this.state = St.Music;
        break;
      }
      case St.Stop: { // 2
        this.state = St.Idle;
        for (let i = 7; i >= 1; i--) {
          const k = w[i];
          if (k.active) {
            k.seated = false;
            k.px = k.x; k.py = k.y; k.pheading = k.heading;
            k.heading += 2;
            if (k.heading > 7) k.heading -= 7;
            if (i > 1) this.chooseChair(k, 10);
          }
          io.drawWalkers(w);
        }
        for (let c = 1; c <= this.chairCount; c++) this.chairFree[c] = true;
        this.state = St.Run;
        break;
      }
      case St.Run: { // 3
        this.state = St.Idle;
        for (let i = 1; i <= 7; i++) {
          const k = w[i];
          if (!k.active || k.seated || !this.chairFree[k.chair]) continue;
          k.px = k.x; k.py = k.y; k.pheading = k.heading;
          k.x -= k.vx;
          k.y -= k.vy;
          // PtInRect(chair centre) in the 30x30 box around the walker
          if (this.chairX[k.chair] >= k.x - 15 && this.chairX[k.chair] < k.x + 15 &&
              this.chairY[k.chair] >= k.y - 15 && this.chairY[k.chair] < k.y + 15) {
            k.x = this.chairX[k.chair];
            k.y = this.chairY[k.chair];
            this.chairFree[k.chair] = false;
            k.seated = true;
          }
        }
        io.drawWalkers(w);
        let allTaken = true;
        for (let c = 1; c <= this.chairCount; c++) if (this.chairFree[c]) allTaken = false;
        if (!allTaken) { this.state = St.Run; break; }
        io.repaint();
        if (!w[1].seated) { // Bas without a chair
          io.play(8);
          this.state = St.Lost;
        } else {
          for (let i = 2; i <= 7; i++) {
            if (!w[i].seated && w[i].active) { w[i].active = false; w[i].out = this.round; }
          }
          this.round++;
          if (this.round < 2) this.newRound();
          else {
            io.play(9);
            this.state = St.Next;
          }
        }
        break;
      }
      case St.Intro: // 4
        if (this.introFlag) {
          io.drawWalkers(w);
          io.repaint();
          this.introFlag = false;
        }
        if (io.probe()) {
          io.play(this.music[1 + this.round]);
          this.state = St.Music;
        }
        break;
      case St.Lost: // 5
        if (io.probe()) { this.state = St.Idle; this.round = 0; this.newRound(); }
        break;
      case St.Next: // 6
        if (io.probe()) { this.state = St.Idle; this.newRound(); }
        break;
      case St.Won: // 7
        if (io.probe()) { this.state = St.Idle; this.result = 1; this.running = false; }
        break;
      default: break;
    }
  }

  /**
   * FUN_0043c010 + the code after it: nearest free chair (by rounded distance, first wins ties; a distance of 0
   * counts as "none yet"), mark it taken and aim at it, one step = dist/`step` px (min. 1 step). The trolls
   * use 10 (case 2), a click for Bas uses 15 (0x43c724).
   */
  private chooseChair(k: Walker, step: number): void {
    let best = 0, bestD = 0;
    for (let c = 1; c <= this.chairCount; c++) {
      if (!this.chairFree[c]) continue;
      const d = delphiRound(Math.sqrt((k.x - this.chairX[c]) ** 2 + (k.y - this.chairY[c]) ** 2));
      if (bestD === 0 || bestD > d) { best = c; bestD = d; }
    }
    this.chairFree[best] = false;
    k.chair = best;
    k.tx = this.chairX[best];
    k.ty = this.chairY[best];
    this.aim(k, bestD, step);
  }

  private aim(k: Walker, dist: number, step: number) {
    let steps = Math.trunc(dist / step);
    if (steps === 0) steps = 1;
    k.vx = Math.trunc((k.x - k.tx) / steps);
    k.vy = Math.trunc((k.y - k.ty) / steps);
  }

  /** FormMouseDown, chair part: only while the trolls run (states 2/3). Returns true when a chair was hit. */
  clickChair(x: number, y: number): boolean {
    if (this.state !== St.Stop && this.state !== St.Run) return false;
    if (!inBox([DISP.x, DISP.y, DISP.x + DISP.w, DISP.y + DISP.h], x, y)) return false;
    const bas = this.walkers[1];
    for (let c = 1; c <= this.chairCount; c++) {
      const cx = this.chairX[c], cy = this.chairY[c];
      if (x >= cx - 30 && x < cx + 30 && y >= cy - 30 && y < cy + 30) {
        bas.chair = c;
        bas.tx = cx;
        bas.ty = cy;
        this.aim(bas, delphiRound(Math.sqrt((bas.x - cx) ** 2 + (bas.y - cy) ** 2)), 15);
        return true;
      }
    }
    return false;
  }
}
