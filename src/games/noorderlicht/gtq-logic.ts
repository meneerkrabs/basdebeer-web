// GTQ "Trollenquiz" (Noorderlicht PLAY_GAME 2, TGTQfrmMain in BASNOORD.EXE), game logic, DOM-free.
//
// Multiple-choice quiz with a keeper troll. The game ends (result 1) after 5 correct answers; wrong answers
// only count ("Fout: n"). Questions come at random from a pool; every asked question leaves the pool, and when
// the pool runs empty it is refilled with the questions that were not yet answered correctly.
//
// Addresses: FormCreate @0x434460, ReadQuestionFile @0x434a00, BackImageMouseDown @0x435058,
// NextQuestion @0x435384, CheckAnswer @0x435abc, WriteStandings @0x4364ac, PutText @0x436708,
// BackImageMouseMove @0x4368d8, FormShow @0x437210, FormClose @0x437218. Rect tables at
// 0x44bd14 + mode*0x380 (800x600 = mode 1, values below).
// Question record (300 bytes): +4 text[60], +0x41/0x74/0xa7/0xda answers[50], +0x10d correct 0..3,
// +0x10e answered-correctly, +0x10f has WAV, +0x110 WAV name[12], +0x11d has BMP, +0x11e BMP name[12].
import { SRCCOPY, Surface, type FontSpec } from '../../engine/surface.ts';

export type Rect = [number, number, number, number]; // l, t, r, b (right/bottom exclusive, PtInRect)

/** GTQ rect table, mode 1 (800x600). */
export const RECTS = {
  answers: [[336, 270, 667, 288], [336, 290, 667, 308], [336, 310, 667, 328], [336, 330, 667, 348]] as Rect[],
  quest: [130, 290, 330, 348] as Rect,
  image: [336, 88, 667, 264] as Rect,
  goed: [130, 88, 228, 110] as Rect,
  fout: [230, 88, 330, 110] as Rect,
  troll: [130, 115, 330, 285] as Rect, // "SysHoofdRect"
  /** SysNextRect record (the left book "TERUG": result 2). Enabled when the history is non-empty. */
  prev: [90, 410, 200, 470] as Rect,
  stop: [145, 495, 260, 600] as Rect,
  read: [280, 495, 400, 600] as Rect,
};

export const WHITE = 0xffffff, YELLOW = 0x00ffff, LIME = 0x00ff00, RED = 0x0000ff; // COLORREF 0x00BBGGRR
/** Canvas font: Arial, Font.Height = 18 (cell height, em about 16 px), transparent brush. */
const FONT = { name: 'Arial', px: 16 };
const WIN_SCORE = 5;
const LINE_H = 20;

export interface Question {
  text: string;
  answers: string[]; // 4, '' = absent
  correct: number; // 0..3
  answered: boolean; // +0x10e
  wav: string; // '' = none
  bmp: string;
}

/** ReadQuestionFile: `nr~question~letter~media~ans1~ans2~ans3~ans4~` (max 70 lines; Pascal short-string limits). */
export function parseQuestions(text: string): Question[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: Question[] = [];
  for (const line of lines.slice(0, 70)) {
    let s = line;
    const field = () => {
      const p = s.indexOf('~') + 1; // Pos('~', s), 1-based, 0 = none
      const f = p > 0 ? s.slice(0, p - 1) : s.slice(0, Math.max(0, p - 1));
      s = s.slice(p);
      return f;
    };
    field(); // number
    const qtext = field().slice(0, 60);
    const letter = s.slice(0, 1);
    const correct = letter === 'A' ? 0 : letter === 'B' ? 1 : letter === 'C' ? 2 : 3;
    field();
    const p = s.indexOf('~') + 1;
    let wav = '', bmp = '';
    if (p >= 2) {
      const name = s.slice(0, p - 1).slice(0, 12);
      if (s.slice(p - 4, p - 1) === 'WAV') wav = name;
      else bmp = name;
    }
    s = s.slice(p);
    const answers = [0, 1, 2, 3].map(() => field().slice(0, 50));
    out.push({ text: qtext, answers, correct, answered: false, wav, bmp });
  }
  return out;
}

export interface GtqResources {
  back: Surface; // GTQBACKN.BMP, clean background (0x1b4)
  keepN: Surface; // neutral / happy / grumpy keeper
  keepH: Surface;
  keepG: Surface;
  questions: Question[];
}

export interface GtqEffects {
  random(n: number): number;
  invalidate(): void;
  /** MediaPlayer: Close, set FileName, Open, Play (does not wait). */
  playWav(name: string): Promise<void>;
  closeWav(): void;
  wavPlaying(): boolean;
  /** `while (MediaPlayer.Mode = mpPlaying) Application.ProcessMessages` */
  waitWav(): Promise<void>;
  loadImage(name: string): Promise<Surface>;
}

export class GtqLogic {
  /** 0x234: running; 0x235: result (0 quit, 1 won, 2 prev). */
  running = true;
  result = 0;
  /** Set by the UI when the form closed (stops the async flows). */
  closed = false;
  /** 0x1b8: the picture shown by the BackImage. */
  readonly work: Surface;
  /** 0x21c / 0x220 */
  goed = 0;
  fout = 0;
  /** Enabled flags of the rect records (answers A-D, read). */
  readonly answerEnabled = [false, false, false, false];
  readEnabled = false;
  /** 0x1c8..0x1cb: hover state of the answers. */
  private hov = [false, false, false, false];
  private pool: Question[] = []; // 0x1f4
  private cur = 0; // 0x218
  private res: GtqResources;
  private fx: GtqEffects;

  constructor(res: GtqResources, fx: GtqEffects) {
    this.res = res;
    this.fx = fx;
    this.work = res.back.clone();
    // FormCreate: neutral keeper, standings; every question starts in the pool
    this.drawKeeper(res.keepN);
    this.writeStandings();
    this.pool = res.questions.slice();
  }

  get question(): Question {
    return this.pool[this.cur];
  }

  private font(color: number): FontSpec {
    return { ...FONT, color };
  }

  private drawKeeper(k: Surface) {
    const [l, t] = RECTS.troll;
    this.work.bitBlt(l, t, k.width, k.height, k, 0, 0, SRCCOPY);
  }

  /** WriteStandings: restore the two counter rects from the clean background, write "Goed: n" / " Fout: n". */
  private writeStandings() {
    const { work, res } = this;
    for (const r of [RECTS.goed, RECTS.fout]) work.bitBlt(r[0], r[1], r[2] - r[0], r[3] - r[1], res.back, r[0], r[1], SRCCOPY);
    work.textOut(RECTS.goed[0], RECTS.goed[1], `Goed: ${this.goed}`, this.font(WHITE));
    work.textOut(RECTS.fout[0], RECTS.fout[1], ` Fout: ${this.fout}`, this.font(WHITE));
    this.fx.invalidate();
  }

  /** PutText: word-wrap into the rect, 20 px line pitch, at most 3 lines. */
  private putText(text: string, r: Rect, color: number) {
    const f = this.font(color), width = r[2] - r[0];
    let rest = text, y = 0;
    while (y < 0x3c && rest !== '') {
      let line = '', word = '';
      let w: number;
      do {
        line += word;
        rest = rest.slice(word.length);
        const sp = rest.indexOf(' ');
        word = sp < 0 ? rest : rest.slice(0, sp + 1);
        w = Surface.textWidth(line + word, f);
      } while (w <= width && rest !== '');
      if (line !== '') this.work.textOut(r[0], r[1] + y, line, f);
      y += LINE_H;
    }
  }

  private answerText(i: number): string {
    return `${'ABCD'[i]}: ${this.question.answers[i]}`.slice(0, 0x35);
  }

  private drawAnswer(i: number, color: number) {
    this.putText(this.answerText(i), RECTS.answers[i], color);
  }

  /** NextQuestion @0x435384. */
  async nextQuestion() {
    const { res, fx, work } = this;
    if (this.pool.length === 0) this.pool = res.questions.filter((q) => !q.answered);
    this.cur = fx.random(this.pool.length);
    const q = this.question;
    work.bitBlt(0, 0, work.width, work.height, res.back, 0, 0, SRCCOPY);
    this.writeStandings();
    this.drawKeeper(res.keepN);
    fx.invalidate();
    this.putText(q.text, RECTS.quest, WHITE);
    for (let i = 0; i < 4; i++) {
      if (q.answers[i] !== '') {
        this.drawAnswer(i, WHITE);
        this.answerEnabled[i] = true;
      }
    }
    fx.invalidate();
    if (!q.wav) {
      this.readEnabled = false;
      if (q.bmp) {
        const img = await fx.loadImage(q.bmp);
        if (this.closed) return;
        work.bitBlt(RECTS.image[0], RECTS.image[1], img.width, img.height, img, 0, 0, SRCCOPY);
        fx.invalidate();
      }
    } else {
      await fx.waitWav();
      if (this.closed) return;
      await fx.playWav(q.wav);
      this.readEnabled = true;
    }
  }

  /** CheckAnswer @0x435abc. */
  async checkAnswer(chosen: number) {
    const { fx, res } = this;
    fx.closeWav();
    this.answerEnabled.fill(false);
    const q = this.question;
    this.drawAnswer(q.correct, LIME);
    if (chosen === q.correct) {
      this.goed++;
      this.writeStandings();
      q.answered = true;
      this.drawKeeper(res.keepH);
      fx.invalidate();
      await fx.playWav(fx.random(2) === 0 ? 'GTQ002.WAV' : 'GTQ003.WAV');
    } else {
      this.fout++;
      this.writeStandings();
      const explain = `GTQ00${6 + q.correct}.WAV`;
      this.drawKeeper(res.keepG);
      this.drawAnswer(chosen, RED);
      fx.invalidate();
      await fx.playWav('GTQ004.WAV');
      await fx.waitWav();
      if (this.closed) return;
      fx.closeWav();
      await fx.playWav('GTQ005.WAV');
      await fx.waitWav();
      if (this.closed) return;
      fx.closeWav();
      await fx.playWav(explain);
    }
    if (this.closed) return;
    this.pool.splice(this.cur, 1);
    await fx.waitWav();
    if (this.closed) return;
    if (this.goed === WIN_SCORE) {
      fx.closeWav();
      await fx.playWav('GTQ001.WAV');
      await fx.waitWav();
      if (this.closed) return;
      fx.closeWav();
      this.result = 1;
      this.running = false;
    } else {
      await this.nextQuestion();
    }
  }

  /** Read button: replay the question's sound unless it is still playing. */
  async readAgain() {
    if (!this.readEnabled || this.pool.length === 0) return;
    const q = this.question;
    if (q.wav && !this.fx.wavPlaying()) {
      this.fx.closeWav();
      await this.fx.playWav(q.wav);
    }
  }

  /** BackImageMouseMove: yellow hover on answers. Returns true while over an enabled hot rect (cursor 1). */
  hover(x: number, y: number, prevEnabled: boolean): boolean {
    let changed = false;
    let over = false;
    for (let i = 0; i < 4; i++) {
      const r = RECTS.answers[i];
      const inside = x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
      if (inside && this.answerEnabled[i]) {
        over = true;
        if (!this.hov[i]) {
          this.drawAnswer(i, YELLOW);
          this.hov[i] = true;
          changed = true;
        }
      } else if (!inside && this.answerEnabled[i] && this.hov[i]) {
        this.drawAnswer(i, WHITE);
        this.hov[i] = false;
        changed = true;
      }
    }
    if (changed) this.fx.invalidate();
    const inR = (r: Rect) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
    if (inR(RECTS.stop) || (prevEnabled && inR(RECTS.prev)) || (this.readEnabled && inR(RECTS.read))) over = true;
    return over;
  }

  /** Index of the enabled answer rect under the point, or -1. */
  answerAt(x: number, y: number): number {
    for (let i = 0; i < 4; i++) {
      const r = RECTS.answers[i];
      if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3] && this.answerEnabled[i]) return i;
    }
    return -1;
  }
}
