// GBD "Berendobbel" (Noorderlicht PLAY_GAME 8: TGBDfrmMain + TGBDfrmStartup + TGBDfrmSpelRegel in BASNOORD.EXE),
// game logic, DOM-free.
//
// A goose-style race over 64 squares for 2-4 players, optionally against the computer ("de Witte Beer", always
// player 2). The board is two 640x480 pictures: GBDBRD01 shows squares 0..31, GBDBRD02 squares 32..63 (the view
// follows the player whose turn it is). Pawns are drawn with the 30x30 mask (SRCAND) + sprite (SRCPAINT) from
// GBDAPWNS. Everything is click-driven: the hand with dice rolls, "<Klik hier>" messages advance.
//
// Addresses (main form): FormCreate @0x43f6d4, Image1MouseDown @0x43f9e4, FormShow @0x43fc68, game step
// FUN_0043fdd4, redraw pawns FUN_00442eec / draw one FUN_004413f8 / pawn rect FUN_00441590, move FUN_00441640,
// ranking list FUN_00441a34, message FUN_00441da0, square effects FUN_00442038, dice FUN_004430d4,
// Timer1 @0x4434e4 (sound queue), square table FUN_0043e704, pawn bitmaps FUN_0043e474. Rect table
// 0x44d4e4..0x44d554, board half flag +0x400, won +0x401, new-game +0x402, positions +0x1e3+i.
// Sound queue records (0x8c bytes) are played one after another by Timer1 (MediaPlayer1); every use waits
// for its record to finish; clicks are ignored while the queue is not empty (= `busy` here).
import { SRCAND, SRCCOPY, SRCPAINT, Surface, type FontSpec } from '../../engine/surface.ts';

export type Rect = [number, number, number, number]; // l, t, r, b (right/bottom exclusive)

export const RECTS = {
  hand: [147, 327, 226, 398] as Rect, // 0x44d4e4: the hand with dice
  rules: [252, 327, 329, 398] as Rect, // 0x44d4f4: spelregels
  stop: [363, 327, 436, 398] as Rect, // 0x44d504
  message: [155, 412, 434, 480] as Rect, // 0x44d514: 3 lines of 20 px
  names: [20, 360, 130, 465] as Rect, // 0x44d524: "stand" list, 20 px per line
  board: [0, 0, 640, 320] as Rect, // 0x44d534
  diceClear: [517, 408, 625, 477] as Rect, // 0x44d544
};
const DIE_DEST: Rect = [489, 346, 599, 456];
const DIE_SRC: Rect = [45, 45, 155, 155];

/** Colour codes of a pawn: 0 blue, 1 green, 2 white, 3 yellow. Sprite row (y) in GBDAPWNS per code. */
export const PAWN_SPRITE_Y = [30, 90, 60, 0];
/** COLORREF (0x00BBGGRR) of the names list per colour code. */
export const NAME_COLORS = [0xff0000, 0x008000, 0xffffff, 0x00ffff];
export const COLOR_NAMES = ['blauw', 'groen', 'wit', 'geel'];

export const BEAR_SQUARES = [1, 5, 10, 23, 26, 32, 41, 45, 54, 59];
/** Squares with a special flag (+0x204): the bear squares plus these. */
export const SPECIAL_SQUARES = [1, 3, 5, 6, 10, 15, 19, 23, 26, 31, 32, 39, 41, 42, 45, 52, 54, 58, 59, 63];

export interface Square { x: number; y: number; special: boolean; bear: boolean }

/** FUN_0043e704: pawn top-left (x, y) per square 0..63, serpentine over the two boards. */
export function buildSquares(): Square[] {
  const sq: Square[] = Array.from({ length: 64 }, () => ({ x: 0, y: 0, special: false, bear: false }));
  for (let i = 0; i < 8; i++) {
    const a = 75 * i + 21, b = 75 * i + 62;
    for (const k of [7 - i, 8 + i, 23 - i, 24 + i]) sq[k].x = a;
    for (const k of [63 - i, 48 + i, 47 - i, 32 + i]) sq[k].x = b;
  }
  for (let k = 0; k < 64; k++) {
    if (k < 8 || k > 0x37) sq[k].y = 0x19;
    else if (k < 0x18 || k > 0x27) sq[k].y = (k < 8 || k > 15) && (k < 0x30 || k > 0x37) ? 0xb9 : 0x69;
    else sq[k].y = 0x109;
    sq[k].special = SPECIAL_SQUARES.includes(k);
    sq[k].bear = BEAR_SQUARES.includes(k);
  }
  return sq;
}

/** What GBDfrmStartup hands over (FUN_0043e474): players are 1..4, index 0 unused. */
export interface GbdSettings {
  count: number; // 2..4
  names: string[]; // [0] unused
  colors: number[]; // [0] unused; colour code per player (always a permutation of 0..3)
  computer: boolean; // player 2 is "de Witte Beer"
}

export class Aborted extends Error {}

const pad3 = (n: number) => String(n).padStart(3, '0');
export const sndName = (n: number) => `GBD${pad3(n)}.WAV`;
export const rollFrameImage = (i: number) => `GBDRD${pad3(i)}.BMP`; // 0..10
export const faceImage = (n: number) => `GBDFD${pad3(n)}.BMP`; // 1..6
/** The spoken die value / counting step (GBD010-015). */
const numberSound = (i: number) => sndName(10 + i);

export interface GbdImages {
  board1: Surface; // GBDBRD01 (squares 0..31)
  board2: Surface; // GBDBRD02 (squares 32..63)
  sprites: Surface; // GBDAPWNS 60x120
  roll: Surface[]; // GBDRD000..010
  faces: Surface[]; // [1..6] (index 0 unused)
}

export interface GbdHost {
  random(n: number): number;
  randomize(): void;
  invalidate(): void;
  sleep(ms: number): Promise<void>;
  /** Queue a sound and resolve when it has played (rejects with Aborted when the form closed). */
  sound(name: string): Promise<void>;
  /** Queue a sound: `started` resolves when it plays, `done` when it is over. */
  soundStart(name: string): { started: Promise<void>; done: Promise<void> };
  /** The modal player setup. null = "Geen Berendobbel spelen". */
  startup(): Promise<GbdSettings | null>;
  /** Close the form (result 1). */
  close(): void;
  readonly closed: boolean;
}

export class GbdLogic {
  private readonly img: GbdImages;
  private readonly host: GbdHost;
  readonly squares = buildSquares();
  /** Working pictures (the "copies" +0x41c / +0x420) and the pristine boards (+0x414 / +0x418). */
  readonly work1: Surface;
  readonly work2: Surface;
  private pawns: Surface[] = []; // [1..4]
  private mask: Surface;
  private s: GbdSettings = { count: 2, names: ['', '', ''], colors: [0, 0, 2, 1, 3], computer: true };

  /** +0x400: 1 = board 1 (squares 0..31) is shown. */
  half = 1;
  won = false; // +0x401
  newGame = true; // +0x402
  readonly pos = [0, 0, 0, 0, 0]; // +0x1e3+i
  private readonly skip1 = [0, 0, 0, 0, 0]; // +0x1e7+i: skip one turn
  private readonly skip2 = [0, 0, 0, 0, 0]; // +0x1eb+i: skip two turns
  private readonly cave = [0, 0, 0, 0, 0]; // +0x1ef+i: needs a 6
  readonly order = [0, 1, 2, 3, 4]; // +0x1f3+slot: turn order
  slot = 1; // +0x1f8
  private readonly occ = new Array<number>(64).fill(0); // +0x206+sq*8: pawns on a square
  private waitRoll = false; // DAT_0044e70c: the next click on the hand rolls
  private rolled = false; // DAT_0044e704
  private nextTurn = false; // DAT_0044e70d
  private die = 0; // DAT_0044e705
  private stopPending = false; // DAT_0044e706
  private savedMessage = ''; // DAT_0044e708
  message = ''; // +0x468
  busy = false;

  constructor(img: GbdImages, host: GbdHost) {
    this.img = img;
    this.host = host;
    this.work1 = img.board1.clone();
    this.work2 = img.board2.clone();
    this.mask = new Surface(30, 30);
    this.mask.bitBlt(0, 0, 30, 30, img.sprites, 30, 0, SRCCOPY);
  }

  /** The picture shown in Image1 (FormPaint). */
  get view(): Surface { return this.half === 0 ? this.work2 : this.work1; }

  private font(color: number): FontSpec { return { name: 'Arial', px: 16, bold: true, color }; }
  private readonly both = () => [this.work1, this.work2];
  private pristine(w: Surface) { return w === this.work1 ? this.img.board1 : this.img.board2; }

  private restore(r: Rect) {
    for (const w of this.both()) w.bitBlt(r[0], r[1], r[2] - r[0], r[3] - r[1], this.pristine(w), r[0], r[1], SRCCOPY);
  }

  private check() { if (this.host.closed) throw new Aborted(); }
  private async say(n: number | string) {
    this.check();
    await this.host.sound(typeof n === 'number' ? sndName(n) : n);
    this.check();
  }

  /** FormShow, first part: the pictures are in place, the settings come from the startup form. */
  initSettings(s: GbdSettings) {
    this.s = s;
    this.buildPawns();
    this.pos.fill(0); this.skip1.fill(0); this.skip2.fill(0); this.cave.fill(0);
    for (let i = 1; i <= 4; i++) this.order[i] = i;
    this.occ.fill(0);
    this.occ[0] = s.count;
    this.half = 1;
    this.won = false;
  }

  /** FUN_0043e474: a 30x30 sprite per player in the chosen colour. */
  private buildPawns() {
    this.pawns = [new Surface(30, 30)];
    for (let i = 1; i <= this.s.count; i++) {
      const p = new Surface(30, 30);
      p.bitBlt(0, 0, 30, 30, this.img.sprites, 0, PAWN_SPRITE_Y[this.s.colors[i]], SRCCOPY);
      this.pawns[i] = p;
    }
  }

  private name(p: number) { return this.s.names[p]; }
  private get cur() { return this.order[this.slot]; }
  private isComputer(p: number) { return this.s.computer && p === 2; }

  // ---- drawing ----

  /** FUN_00441590: where a pawn is drawn (offset per colour while sharing a square or on the start). */
  private pawnRect(p: number): Rect {
    const sq = this.pos[p], q = this.squares[sq];
    let x = q.x, y = q.y;
    if (sq === 0 || this.occ[sq] > 1) {
      const c = this.s.colors[p];
      if (c === 0) { x += 10; y -= 10; } else if (c === 1) { x -= 10; y += 10; } else if (c === 2) { x += 10; y += 10; } else { x -= 10; y -= 10; }
    }
    return [x, y, x + 30, y + 30];
  }

  /** FUN_00442eec: restore the board area of both pictures and draw the pawns on the current half. */
  redraw() {
    this.restore(RECTS.board);
    const w = this.view;
    for (let p = 1; p <= this.s.count; p++) {
      if (this.half === 0 ? this.pos[p] >= 0x20 : this.pos[p] < 0x20) {
        const r = this.pawnRect(p);
        w.bitBlt(r[0], r[1], 30, 30, this.mask, 0, 0, SRCAND);
        w.bitBlt(r[0], r[1], 30, 30, this.pawns[p], 0, 0, SRCPAINT);
      }
    }
    this.host.invalidate();
  }

  /** FUN_00441a34: the standings (names by position, in the pawn's colour). */
  drawRanking() {
    this.restore(RECTS.names);
    const used = [false, false, false, false, false];
    let prev = 63, best = 1, line = 0;
    for (let k = 0; k < this.s.count; k++) {
      let top = -1;
      for (let slot = 1; slot <= this.s.count; slot++) {
        const p = this.order[slot];
        if (!used[p] && top < this.pos[p] && this.pos[p] <= prev) { top = this.pos[p]; best = p; }
      }
      let name = this.name(best);
      const f = this.font(NAME_COLORS[this.s.colors[best]]);
      while (name.length > 0 && Surface.textWidth(name, f) > RECTS.names[2] - RECTS.names[0]) name = name.slice(0, -1);
      for (const w of this.both()) w.textOut(RECTS.names[0], RECTS.names[1] + line * 20, name, f);
      used[best] = true;
      prev = this.pos[best];
      line++;
    }
    this.host.invalidate();
  }

  /** FUN_00441da0: the message in the text box, wrapped at words, at most 3 lines of 20 px. */
  showMessage(text: string) {
    this.message = text;
    this.restore(RECTS.message);
    const f = this.font(0xffffff);
    const maxW = RECTS.message[2] - RECTS.message[0];
    let msg = text;
    for (let y = 0; y < 60 && msg !== ''; y += 20) {
      let line = '', word = '';
      do {
        line += word;
        msg = msg.slice(word.length);
        const p = msg.indexOf(' ') + 1;
        word = p < 1 ? msg : msg.slice(0, p);
      } while (Surface.textWidth(line + word, f) <= maxW && msg !== '');
      for (const w of this.both()) w.textOut(RECTS.message[0], RECTS.message[1] + y, line, f);
    }
    this.host.invalidate();
  }

  // ---- input ----

  /** Image1MouseDown. `rules` shows the rules form. */
  async click(x: number, y: number, rules: () => Promise<void>) {
    if (this.busy || this.host.closed) return;
    const inR = (r: Rect) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
    if (inR(RECTS.stop)) { await this.pressStop(); return; }
    if (this.stopPending) {
      this.stopPending = false;
      this.showMessage(this.savedMessage);
      return;
    }
    if (inR(RECTS.hand)) { if (this.waitRoll) await this.run(); return; }
    if (inR(RECTS.rules)) { await rules(); return; }
    if (!this.waitRoll) await this.run();
  }

  /** The Stop button: the first press asks, the second ends the game (result 1). */
  async pressStop() {
    if (this.busy || this.host.closed) return;
    if (!this.stopPending) {
      this.savedMessage = this.message;
      this.showMessage('Druk nog een keer op Stop als je echt wilt stoppen!');
      this.stopPending = true;
    } else {
      this.host.close();
    }
  }

  /** Run one game step as the top-level handler (clicks are ignored meanwhile). */
  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    } finally {
      this.busy = false;
    }
  }

  // ---- game ----

  /** FUN_0043fdd4 */
  private async step(): Promise<void> {
    if (this.newGame) { await this.setup(); return; }
    if (this.won) {
      this.showMessage('Klik op de hand met dobbelstenen om NOG eens berendobbel te spelen.');
      this.newGame = true;
      this.waitRoll = true;
      return;
    }
    const cur = this.cur;
    if (this.nextTurn) {
      this.nextTurn = false;
      this.slot = this.slot === this.s.count ? 1 : this.slot + 1;
      const c = this.cur;
      if (this.skip1[c] === 0) {
        if (this.skip2[c] !== 0) {
          this.nextTurn = true;
          this.skip1[c] = 1;
          this.skip2[c] = 0;
          this.showMessage(`Helaas! Je moet twee beurten overslaan, ${this.name(c)}. <Klik hier>`);
        }
      } else {
        this.nextTurn = true;
        this.skip1[c] = 0;
        this.showMessage(`Helaas! Je moet een beurt overslaan, ${this.name(c)}. <Klik hier>`);
      }
      // follow the player's pawn: show the half it is on
      if ((this.pos[c] > 0x1f && this.half !== 0) || (this.pos[c] < 0x20 && this.half === 0)) {
        this.half ^= 1;
        this.redraw();
      }
      if (!this.nextTurn) await this.step();
      return;
    }
    if (!this.rolled) {
      if (!this.isComputer(cur)) {
        if (!this.waitRoll) {
          this.showMessage(`Het is de beurt van ${this.name(cur)}. Klik op de hand met dobbelstenen.`);
          this.rolled = false;
        } else {
          this.rolled = true;
          this.die = this.host.random(6) + 1;
          await this.rollDice();
          this.showMessage(`Je hebt ${this.die} gegooid, ${this.name(cur)}. <Klik hier>`);
          await this.say(numberSound(this.die - 1));
        }
        this.waitRoll = !this.waitRoll;
      } else {
        this.rolled = true;
        this.die = this.host.random(6) + 1;
        await this.rollDice();
        this.showMessage(`De Witte Beer heeft ${this.die} gegooid.     <Klik hier>`);
        await this.say(numberSound(this.die - 1));
      }
      return;
    }
    // the die is rolled: move
    this.rolled = false;
    this.waitRoll = false;
    if (this.cave[cur] === 0 || this.die === 6) {
      this.cave[cur] = 0;
      await this.move();
      if (!this.won && this.cave[cur] === 0) await this.squareEffect();
      if (!this.won) {
        this.nextTurn = true;
        await this.step();
      } else {
        this.showMessage(`${this.name(cur)} heeft gewonnen! Gefeliciteerd! <Klik hier>`);
        if (!this.isComputer(cur)) await this.say(2);
        await this.say(this.isComputer(cur) ? 26 : 25);
      }
    } else {
      this.showMessage(`Je hebt geen 6 gegooid, ${this.name(cur)}. Je moet blijven staan. <klik>`);
      this.nextTurn = true;
    }
  }

  /** The new-game branch of FUN_0043fdd4 (also the restart after a win: the startup form comes back). */
  private async setup() {
    if (this.waitRoll) {
      const s = await this.host.startup();
      this.check();
      if (!s) { this.host.close(); return; }
      this.initSettings(s);
    }
    this.host.randomize();
    this.restore(RECTS.board);
    this.host.invalidate();
    // random turn order
    const n = this.s.count;
    for (let i = 1; i <= n; i++) {
      let dup: boolean;
      do {
        this.order[i] = this.host.random(n) + 1;
        dup = false;
        for (let j = 1; j < i; j++) if (this.order[i] === this.order[j]) dup = true;
      } while (dup);
    }
    this.occ[0] = n;
    this.redraw();
    this.drawRanking();
    this.slot = 1;
    const first = this.order[1];
    await this.say([7, 8, 6, 9][this.s.colors[first]]);
    if (!this.s.computer || first !== 2) {
      this.showMessage(`${this.name(first)} mag beginnen! Klik op de hand met dobbelstenen, ${this.name(first)}.`);
      this.rolled = false;
      this.waitRoll = true;
    } else {
      this.die = this.host.random(6) + 1;
      await this.rollDice();
      this.showMessage(`De Witte Beer mag beginnen. Hij heeft ${this.die} gegooid. <Klik hier>`);
      await this.say(numberSound(this.die - 1));
      this.rolled = true;
      this.waitRoll = false;
    }
    this.newGame = false;
  }

  /** FUN_004430d4: rattle (GBD001) while the die tumbles, then the face. */
  private async rollDice() {
    const w = this.view;
    const r = RECTS.diceClear;
    w.bitBlt(r[0], r[1], r[2] - r[0], r[3] - r[1], this.pristine(w), r[0], r[1], SRCCOPY);
    const snd = this.host.soundStart(sndName(1));
    await snd.started;
    let over = false;
    void snd.done.then(() => { over = true; }, () => { over = true; });
    do {
      for (let i = 0; i < 11; i++) {
        this.check();
        this.view.bitBlt(DIE_DEST[0], DIE_DEST[1], 110, 110, this.img.roll[i], DIE_SRC[0], DIE_SRC[1], SRCCOPY);
        this.host.invalidate();
        await this.host.sleep(40);
      }
    } while (!over);
    await snd.done;
    this.check();
    this.view.bitBlt(DIE_DEST[0], DIE_DEST[1], 110, 110, this.img.faces[this.die], DIE_SRC[0], DIE_SRC[1], SRCCOPY);
    this.host.invalidate();
  }

  /** Move the pawn of the current player one square at a time (FUN_00441640). */
  private async move() {
    const c = this.cur;
    let i = 0;
    while (i < this.die && this.pos[c] !== 63) {
      if (this.pos[c] < 0x20 || this.half === 0) {
        if (this.pos[c] < 0x20 && this.half === 0) this.half = 1;
      } else this.half = 0;
      this.occ[this.pos[c]]--;
      this.pos[c]++;
      this.occ[this.pos[c]]++;
      if (this.pos[c] > 0x1f && this.half !== 0) this.half = 0;
      this.redraw();
      await this.say(numberSound(i));
      i++;
    }
    this.drawRanking();
    if (this.pos[c] === 63) this.won = true;
  }

  private teleport(c: number, to: number) {
    this.occ[this.pos[c]]--;
    this.pos[c] = to;
    this.occ[to]++;
    this.redraw();
  }

  /** FUN_00442038: what the square you landed on does. */
  private async squareEffect() {
    const c = this.cur, sq = this.pos[c], q = this.squares[sq];
    if (!q.special) return;
    if (!q.bear) {
      switch (sq) {
        case 39:
          this.showMessage('Van de berg gevallen. Terug naar 33.');
          await this.say(21);
          this.teleport(c, 33);
          break;
        case 15:
          this.showMessage("Je ski's glijden weg en je moet ze ophalen. Terug naar 10!");
          await this.say(18);
          this.teleport(c, 10);
          break;
        case 3: {
          this.showMessage('Berensprong! Je komt op het eerste vakje voor de eerste speler.');
          await this.say(16);
          let lead = 0;
          for (let p = 1; p <= this.s.count; p++) if (lead < this.pos[p]) lead = this.pos[p];
          this.teleport(c, lead + 1);
          break;
        }
        case 6:
          this.showMessage('Je glijdt van de gletcher door naar nummer 12!');
          await this.say(17);
          this.teleport(c, 12);
          break;
        case 19:
          this.showMessage('Je blijft een nachtje slapen in een iglo. Sla een beurt over.');
          await this.say(19);
          this.skip1[c] = 1;
          break;
        case 31:
          this.showMessage('Je bent in een spelonk gevallen. Je kunt er pas uit als je zes gooit.');
          await this.say(20);
          this.cave[c] = 1;
          break;
        case 42:
          this.showMessage('Je bent in het ijsdoolhof en je zoekt naar een uitgang. Terug naar 30.');
          await this.say(22);
          this.teleport(c, 30);
          break;
        case 52:
          this.showMessage('Je bent in nat ijs terecht gekomen. Sla twee beurten over.');
          await this.say(23);
          this.skip2[c] = 1;
          break;
        case 58:
          this.showMessage('Een sneeuwstorm verhindert iedere voortgang. Begin opnieuw.');
          await this.say(24);
          await this.say(33);
          this.teleport(c, 0);
          break;
        case 63:
          this.won = true;
          break;
      }
      this.drawRanking();
    } else {
      this.showMessage(`Een berenvakje! Je gaat nog eens ${this.die} plaats${this.die > 1 ? 'en' : ''} vooruit!`);
      await this.say(26 + this.die);
      await this.move();
    }
  }
}
