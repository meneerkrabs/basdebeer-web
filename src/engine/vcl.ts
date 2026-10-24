// A tiny stand-in for the Delphi VCL as used by the original games: top-level forms
// (each with its own retained backing surface), timers, modal forms, mouse/keyboard
// routing, Delphi's Random(), and an overlay for AVI playback (TMediaPlayer + Display).

import { Surface } from './surface.ts';
import { createPresenter, type DisplayMode, type Presenter } from './presenter.ts';

export const SCREEN_W = 640;
export const SCREEN_H = 480;

export type MouseButton = 'left' | 'right' | 'middle';
export interface ShiftState { shift: boolean; ctrl: boolean; alt: boolean; left: boolean; right: boolean }

export const mrNone = 0, mrOk = 1, mrCancel = 2, mrYes = 6, mrNo = 7;

export class Form {
  left = 0;
  top = 0;
  visible = false;
  surface: Surface;
  /** CSS cursor while the pointer is over this form. */
  cursor = 'default';
  modalResult = mrNone;
  /** Still receives clicks outside a modal form on top of it (the books stay usable under a game). */
  inputBehindModal = false;
  onPaint: (() => void) | null = null;
  onMouseDown: ((button: MouseButton, shift: ShiftState, x: number, y: number) => void) | null = null;
  onMouseUp: ((button: MouseButton, shift: ShiftState, x: number, y: number) => void) | null = null;
  onMouseMove: ((shift: ShiftState, x: number, y: number) => void) | null = null;
  onKeyDown: ((key: string, shift: ShiftState) => void) | null = null;
  onClose: (() => void) | null = null;
  private timers: Timer[] = [];
  private modalResolve: ((r: number) => void) | null = null;
  needsPaint = true;

  readonly display: Display;
  readonly name: string;

  constructor(display: Display, width = SCREEN_W, height = SCREEN_H, name = 'form') {
    this.display = display;
    this.name = name;
    this.surface = new Surface(width, height);
  }

  get width() { return this.surface.width; }
  get height() { return this.surface.height; }

  setBounds(left: number, top: number, width: number, height: number) {
    this.left = left;
    this.top = top;
    if (width !== this.surface.width || height !== this.surface.height) {
      this.surface = new Surface(width, height);
      this.needsPaint = true;
    }
  }

  /** Centre on the 640x480 screen (Position = poScreenCenter). */
  center() {
    this.left = Math.round((SCREEN_W - this.width) / 2);
    this.top = Math.round((SCREEN_H - this.height) / 2);
  }

  invalidate() {
    this.needsPaint = true;
  }

  /** Repaint synchronously (Form.Repaint / Refresh). */
  repaint() {
    this.needsPaint = false;
    this.onPaint?.();
  }

  timer(interval: number, onTimer: () => void | Promise<void>, enabled = true): Timer {
    const t = new Timer(interval, onTimer, enabled);
    this.timers.push(t);
    return t;
  }

  show() {
    this.visible = true;
    this.display.add(this);
    this.needsPaint = true;
  }

  hide() {
    this.visible = false;
    this.display.remove(this);
  }

  /** ShowModal: resolves with the modal result once close() is called. */
  showModal(): Promise<number> {
    this.modalResult = mrNone;
    this.show();
    this.display.pushModal(this);
    return new Promise((r) => (this.modalResolve = r));
  }

  close(result = this.modalResult || mrCancel) {
    this.modalResult = result;
    this.onClose?.();
    for (const t of this.timers) t.enabled = false;
    this.timers = [];
    this.hide();
    this.display.popModal(this);
    const r = this.modalResolve;
    this.modalResolve = null;
    r?.(result);
  }
}

/** TTimer. Handlers are never re-entered: the next tick is scheduled after an async handler settles. */
export class Timer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private _enabled = false;

  interval: number;
  onTimer: () => void | Promise<void>;

  constructor(interval: number, onTimer: () => void | Promise<void>, enabled = true) {
    this.interval = interval;
    this.onTimer = onTimer;
    this.enabled = enabled;
  }

  get enabled() { return this._enabled; }
  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    if (v) this.schedule();
    else if (this.handle !== null) { clearTimeout(this.handle); this.handle = null; }
  }

  /** Re-arm with a new interval (setting Interval on an enabled TTimer restarts it). */
  setInterval(ms: number) {
    this.interval = ms;
    if (this._enabled) {
      if (this.handle !== null) clearTimeout(this.handle);
      this.handle = null;
      this.schedule();
    }
  }

  private schedule() {
    if (this.handle !== null || this.running) return;
    this.handle = setTimeout(() => this.fire(), Math.max(Timer.MIN_INTERVAL, this.interval));
  }

  private async fire() {
    this.handle = null;
    if (!this._enabled) return;
    this.running = true;
    try {
      await this.onTimer();
    } catch (e) {
      console.error(e);
    } finally {
      this.running = false;
    }
    if (this._enabled) this.schedule();
  }

  /** Win9x timers ticked at ~55 ms; NT at ~10-16 ms. Games were tuned on Win95 hardware. */
  static MIN_INTERVAL = 10;
}

/** Delphi's System.Random (Delphi 2-7 linear congruential generator). */
export class DelphiRandom {
  seed = 0;
  randomize() {
    this.seed = (Date.now() * 1000 + Math.floor(Math.random() * 1000)) >>> 0;
  }
  private next() {
    this.seed = (Math.imul(this.seed, 0x08088405) + 1) >>> 0;
    return this.seed;
  }
  /** Random(n): integer in [0, n). */
  random(n: number): number {
    const s = this.next();
    // high dword of the unsigned 64-bit product seed * n
    return Math.floor((s * (n >>> 0)) / 4294967296);
  }
  /** Random without argument: float in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }
}
export const rnd = new DelphiRandom();
rnd.randomize();

export const getTickCount = () => Math.floor(performance.now());
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The 640x480 "monitor": composites forms and routes input. */
export class Display {
  readonly canvas: HTMLCanvasElement;
  private presenter: Presenter;
  readonly screen = new Surface(SCREEN_W, SCREEN_H);
  private forms: Form[] = [];
  private modal: Form[] = [];
  private captured: Form | null = null;
  readonly video: HTMLVideoElement;
  /** Extra overlay painter (e.g. debug), drawn after forms. */
  overlay: ((s: Surface) => void) | null = null;
  mouseX = 0;
  mouseY = 0;

  readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('bdb-root');
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_W;
    this.canvas.height = SCREEN_H;
    this.canvas.className = 'bdb-screen';
    root.appendChild(this.canvas);
    this.video = document.createElement('video');
    this.video.className = 'bdb-video';
    this.video.playsInline = true;
    this.video.hidden = true;
    root.appendChild(this.video);
    this.presenter = createPresenter(this.canvas, Display.savedMode());
    Surface.smoothStipple = this.presenter.mode === 'smooth';
    this.bindInput();
    this.layout();
    addEventListener('resize', () => this.layout());
    const loop = () => {
      this.present();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private layout() {
    const r = this.root.getBoundingClientRect();
    const scale = Math.min(r.width / SCREEN_W, r.height / SCREEN_H);
    const w = Math.floor(SCREEN_W * scale), h = Math.floor(SCREEN_H * scale);
    Object.assign(this.canvas.style, { width: `${w}px`, height: `${h}px` });
    this.presenter.resize(w, h);
    this.scale = scale;
    this.positionVideo();
    this.positionControls();
  }
  private scale = 1;
  private videoRect: [number, number, number, number] | null = null;

  /** 'smooth' (de-dithered, default) or 'original' (crisp 256-colour pixels); ?display=original overrides. */
  static savedMode(): DisplayMode {
    const q = new URLSearchParams(location.search).get('display');
    const v = q ?? localStorage.getItem('bdb-display');
    return v === 'original' ? 'original' : 'smooth';
  }

  get mode(): DisplayMode {
    return this.presenter.mode;
  }
  set mode(m: DisplayMode) {
    this.presenter.mode = m;
    Surface.smoothStipple = m === 'smooth';
    localStorage.setItem('bdb-display', m);
  }

  add(f: Form) {
    if (!this.forms.includes(f)) this.forms.push(f);
  }
  remove(f: Form) {
    this.forms = this.forms.filter((x) => x !== f);
    if (this.captured === f) this.captured = null;
    for (const g of this.forms) g.invalidate();
  }
  pushModal(f: Form) {
    this.modal.push(f);
  }
  popModal(f: Form) {
    this.modal = this.modal.filter((x) => x !== f);
  }
  bringToFront(f: Form) {
    this.forms = [...this.forms.filter((x) => x !== f), f];
  }

  private present() {
    for (const f of this.forms) if (f.visible && f.needsPaint) f.repaint();
    this.screen.px.fill(0);
    for (const f of this.forms) {
      if (f.visible) this.screen.bitBlt(f.left, f.top, f.width, f.height, f.surface, 0, 0);
    }
    this.overlay?.(this.screen);
    this.presenter.present(this.screen.px, SCREEN_W, SCREEN_H);
  }

  /** Topmost visible form under a screen point (respecting modal forms). */
  private target(x: number, y: number): Form | null {
    const inside = (f: Form) => f.visible && x >= f.left && y >= f.top && x < f.left + f.width && y < f.top + f.height;
    const modal = this.modal.at(-1);
    if (modal && inside(modal)) return modal;
    for (let i = this.forms.length - 1; i >= 0; i--) {
      const f = this.forms[i];
      if (inside(f)) return !modal || f.inputBehindModal ? f : modal;
    }
    return modal ?? null;
  }

  private bindInput() {
    const pos = (e: PointerEvent | MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return [Math.floor(((e.clientX - r.left) / r.width) * SCREEN_W), Math.floor(((e.clientY - r.top) / r.height) * SCREEN_H)];
    };
    const shift = (e: PointerEvent | MouseEvent | KeyboardEvent): ShiftState => ({
      shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey,
      left: 'buttons' in e ? (e.buttons & 1) !== 0 : false,
      right: 'buttons' in e ? (e.buttons & 2) !== 0 : false,
    });
    const btn = (b: number): MouseButton => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      this.mouseX = x; this.mouseY = y;
      const f = this.target(x, y);
      if (!f) return;
      this.captured = f;
      if (x >= f.left && y >= f.top && x < f.left + f.width && y < f.top + f.height)
        f.onMouseDown?.(btn(e.button), shift(e), x - f.left, y - f.top);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      this.mouseX = x; this.mouseY = y;
      const f = this.captured ?? this.target(x, y);
      this.canvas.style.cursor = f?.cursor ?? 'default';
      f?.onMouseMove?.(shift(e), x - (f?.left ?? 0), y - (f?.top ?? 0));
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const [x, y] = pos(e);
      const f = this.captured ?? this.target(x, y);
      this.captured = null;
      f?.onMouseUp?.(btn(e.button), shift(e), x - (f?.left ?? 0), y - (f?.top ?? 0));
    });
    addEventListener('keydown', (e) => {
      const f = this.modal.at(-1) ?? this.forms.at(-1);
      if (f?.onKeyDown) {
        f.onKeyDown(e.key, shift(e));
        if (['Escape', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
      }
    });
  }

  /** Play a video file at a screen rect; resolves when it ends (or is clicked/skipped). */
  playVideo(url: string, x: number, y: number, w: number, h: number, opts: { skippable?: boolean } = {}): Promise<void> {
    const v = this.video;
    v.src = url;
    v.hidden = false;
    this.videoRect = [x, y, w, h];
    this.positionVideo();
    return new Promise((resolve) => {
      const done = () => {
        v.onended = null;
        v.onclick = null;
        v.pause();
        v.hidden = true;
        v.removeAttribute('src');
        v.load();
        this.videoRect = null;
        resolve();
      };
      v.onended = done;
      v.onerror = done;
      v.onclick = opts.skippable ? done : null;
      v.play().catch(done);
    });
  }

  private controls: { el: HTMLElement; rect: [number, number, number, number] }[] = [];

  /** Overlay a native HTML control at a screen rect (scaled with the display); remove the element to detach. */
  attachControl(el: HTMLElement, x: number, y: number, w: number, h: number) {
    el.classList.add('bdb-control');
    this.root.appendChild(el);
    this.controls.push({ el, rect: [x, y, w, h] });
    this.positionControls();
  }

  private positionControls() {
    this.controls = this.controls.filter((c) => c.el.isConnected);
    const r = this.canvas.getBoundingClientRect(), pr = this.root.getBoundingClientRect();
    for (const { el, rect: [x, y, w, h] } of this.controls) {
      Object.assign(el.style, {
        left: `${r.left - pr.left + x * this.scale}px`, top: `${r.top - pr.top + y * this.scale}px`,
        width: `${w * this.scale}px`, height: `${h * this.scale}px`, fontSize: `${11 * this.scale}px`,
      });
    }
  }

  private positionVideo() {
    if (!this.videoRect) return;
    const [x, y, w, h] = this.videoRect;
    const r = this.canvas.getBoundingClientRect(), pr = this.root.getBoundingClientRect();
    Object.assign(this.video.style, {
      left: `${r.left - pr.left + x * this.scale}px`, top: `${r.top - pr.top + y * this.scale}px`,
      width: `${w * this.scale}px`, height: `${h * this.scale}px`,
    });
  }
}
