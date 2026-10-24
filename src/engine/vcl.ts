// A tiny stand-in for the Delphi VCL as used by the original games: top-level forms
// (each with its own retained backing surface), timers, modal forms, mouse/keyboard
// routing, Delphi's Random(), and an overlay for AVI playback (TMediaPlayer + Display).

import { cssColor, cssFont, Surface } from './surface.ts';
import { AiUpscaler, aiSupported } from './ai.ts';
import { createPresenter, Presenter, type DisplayMode } from './presenter.ts';

/** Default "monitor" size; Display can be created larger (Noorderlicht is 800x600). */
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

  constructor(display: Display, width = display.width, height = display.height, name = 'form') {
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
    this.left = Math.round((this.display.width - this.width) / 2);
    this.top = Math.round((this.display.height - this.height) / 2);
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
  readonly width: number;
  readonly height: number;
  readonly screen: Surface;
  private forms: Form[] = [];
  private modal: Form[] = [];
  private captured: Form | null = null;
  readonly video: HTMLVideoElement;
  /** Extra overlay painter (e.g. debug), drawn after forms. */
  overlay: ((s: Surface) => void) | null = null;
  mouseX = 0;
  mouseY = 0;

  readonly root: HTMLElement;

  constructor(root: HTMLElement, width = SCREEN_W, height = SCREEN_H) {
    this.root = root;
    this.width = width;
    this.height = height;
    this.screen = new Surface(width, height);
    root.classList.add('bdb-root');
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.className = 'bdb-screen';
    this.canvas.dataset.logicalWidth = String(width);
    this.canvas.dataset.logicalHeight = String(height);
    root.appendChild(this.canvas);
    this.video = document.createElement('video');
    this.video.className = 'bdb-video';
    this.video.playsInline = true;
    this.video.hidden = true;
    root.appendChild(this.video);
    if (import.meta.env.DEV) (globalThis as { __display?: Display }).__display = this;
    this.presenter = createPresenter(this.canvas, Display.savedMode());
    Surface.smoothStipple = Surface.hiResText = this.presenter.mode !== 'original';
    if (this.presenter.mode === 'ai') this.startAi();
    this.textLayer = document.createElement('canvas');
    this.textLayer.className = 'bdb-text';
    root.appendChild(this.textLayer);
    this.bindInput();
    this.layout();
    addEventListener('resize', () => this.layout());
    const loop = () => {
      this.present();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private ai: AiUpscaler | null = null;
  /** AI tiles go on their own canvas right above the WebGL one (below the video and the text layer). */
  private startAi() {
    this.ai = new AiUpscaler(this.width, this.height, Presenter.crt);
    this.canvas.after(this.ai.canvas);
  }
  /** Time/throughput numbers of the AI layer (null unless the 'ai' look is active). */
  get aiStats() {
    return this.ai?.stats ?? null;
  }

  private layout() {
    const r = this.root.getBoundingClientRect();
    const scale = Math.min(r.width / this.width, r.height / this.height);
    const w = Math.floor(this.width * scale), h = Math.floor(this.height * scale);
    Object.assign(this.canvas.style, { width: `${w}px`, height: `${h}px` });
    this.presenter.resize(w, h);
    const dpr = devicePixelRatio || 1;
    this.textLayer.width = Math.round(w * dpr);
    this.textLayer.height = Math.round(h * dpr);
    const cr = this.canvas.getBoundingClientRect(), pr = this.root.getBoundingClientRect();
    Object.assign(this.textLayer.style, { width: `${w}px`, height: `${h}px`, left: `${cr.left - pr.left}px`, top: `${cr.top - pr.top}px` });
    this.ai?.place({ width: `${w}px`, height: `${h}px`, left: `${cr.left - pr.left}px`, top: `${cr.top - pr.top}px` });
    this.scale = scale;
    this.positionVideo();
    this.positionControls();
    this.positionSkip();
  }
  private scale = 1;
  private videoRect: [number, number, number, number] | null = null;

  /** 'smooth' (de-dithered, default), 'original' (crisp 256-colour pixels) or 'ai' (smooth + neural upscaling, needs WebGPU); ?display= overrides. */
  static savedMode(): DisplayMode {
    const q = new URLSearchParams(location.search).get('display');
    const v = q ?? localStorage.getItem('bdb-display');
    if (v === 'ai' && aiSupported()) return 'ai';
    return v === 'original' ? 'original' : 'smooth';
  }

  get mode(): DisplayMode {
    return this.presenter.mode;
  }
  set mode(m: DisplayMode) {
    this.presenter.mode = m;
    Surface.smoothStipple = Surface.hiResText = m !== 'original';
    if (m === 'ai' && !this.ai && aiSupported()) { this.startAi(); this.layout(); }
    if (this.ai) this.ai.canvas.style.display = m === 'ai' ? '' : 'none';
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

  /** Polled every frame by the skip button: what "Sla over" would do right now (null = hide). */
  skipProvider: (() => { label: string; action: () => void } | null) | null = null;
  private skipEl: HTMLButtonElement | null = null;
  private skipAction: (() => void) | null = null;

  private updateSkip() {
    const s = this.skipProvider?.() ?? null;
    if (!s) {
      this.skipEl?.remove();
      this.skipAction = null;
      return;
    }
    if (!this.skipEl) {
      const b = document.createElement('button');
      b.className = 'bdb-skip';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.skipAction?.();
      });
      this.skipEl = b;
    }
    if (this.skipEl.textContent !== s.label) {
      this.skipEl.textContent = s.label;
      if (this.skipEl.isConnected) this.positionSkip();
    }
    this.skipAction = s.action;
    if (!this.skipEl.isConnected) {
      this.root.appendChild(this.skipEl);
      this.positionSkip();
    }
  }

  /** Put the skip button beside the picture when there is room, else small at the bottom centre. */
  private positionSkip() {
    const b = this.skipEl;
    if (!b) return;
    const r = this.canvas.getBoundingClientRect(), pr = this.root.getBoundingClientRect();
    const side = r.left - pr.left, below = pr.bottom - r.bottom;
    const bw = b.offsetWidth || 170, bh = b.offsetHeight || 40;
    b.classList.toggle('bdb-skip-overlay', false);
    if (side >= bw + 24) Object.assign(b.style, { left: `${r.right - pr.left + 12}px`, top: `${r.top - pr.top + 12}px`, transform: '' });
    else if (below >= bh + 12) Object.assign(b.style, { left: `${r.left - pr.left + r.width / 2}px`, top: `${r.bottom - pr.top + 6}px`, transform: 'translateX(-50%)' });
    else {
      b.classList.toggle('bdb-skip-overlay', true);
      Object.assign(b.style, { left: `${r.left - pr.left + r.width / 2}px`, top: `${r.bottom - pr.top - bh - 6}px`, transform: 'translateX(-50%)' });
    }
  }

  /** Close the topmost modal form with a result code. */
  closeTopModal(code: number) {
    this.modal.at(-1)?.close(code);
  }

  /** Number of modal forms open (snapshot it before starting a minigame). */
  get modalDepth() {
    return this.modal.length;
  }

  /** Close every modal form opened since `depth` (a skipped minigame plus any dialog on top of it). */
  closeModalsFrom(depth: number, code: number) {
    while (this.modal.length > depth) this.modal.at(-1)!.close(code);
  }

  private present() {
    this.updateSkip();
    for (const f of this.forms) if (f.visible && f.needsPaint) f.repaint();
    this.screen.px.fill(0);
    this.screen.textRuns = [];
    // forms are composited bottom to top; a form on top covers the text runs beneath it
    for (const f of this.forms) {
      if (f.visible) this.screen.bitBlt(f.left, f.top, f.width, f.height, f.surface, 0, 0);
    }
    this.overlay?.(this.screen);
    this.presenter.present(this.screen.px, this.width, this.height);
    if (this.presenter.mode === 'ai' && this.root.isConnected) this.ai?.update(this.screen.px);
    this.drawText();
  }

  private readonly textLayer: HTMLCanvasElement;
  private lastTextKey = '';

  /** Draw the screen's text runs (Surface.hiResText) sharp, at device resolution. */
  private drawText() {
    const runs = this.screen.textRuns;
    const key = runs.map((r) => `${r.x},${r.y},${r.text},${r.font.color},${r.clip},${r.holes?.map((h) => `${h.rect}/${h.mask ? `${h.mask.mx},${h.mask.my}` : ''}`).join(';') ?? ''}`).join('|') + `@${this.textLayer.width}`;
    if (key === this.lastTextKey) return;
    this.lastTextKey = key;
    const ctx = this.textLayer.getContext('2d')!;
    ctx.clearRect(0, 0, this.textLayer.width, this.textLayer.height);
    const k = this.textLayer.width / this.width;
    for (const r of runs) {
      // glyphs may overhang their advance width (bold k, f, quotes): give each word a margin;
      // only a real clip (scroll window, partial copy) cuts it off
      const natural = Surface.runBox({ ...r, clip: null });
      const pad = Math.ceil(r.font.px * 0.35);
      let box: [number, number, number, number] = [natural[0] - pad, natural[1] - pad, natural[2] + pad, natural[3] + pad];
      if (r.clip) box = [Math.max(box[0], r.clip[0]), Math.max(box[1], r.clip[1]), Math.min(box[2], r.clip[2]), Math.min(box[3], r.clip[3])];
      if (box[2] <= box[0] || box[3] <= box[1]) continue;
      // render the run on its own so covered parts can be cut out
      const tw = Math.ceil((box[2] - box[0]) * k), th = Math.ceil((box[3] - box[1]) * k);
      // the scratch canvas is shared between runs: clear a margin too, because scaling reads
      // one pixel beyond the source rect and would pick up the previous (wider) word
      const tmp = this.runCanvas(tw + 2, th + 2);
      const t = tmp.getContext('2d')!;
      t.clearRect(0, 0, tw + 2, th + 2);
      t.textBaseline = 'alphabetic';
      t.font = cssFont({ ...r.font, px: r.font.px * k });
      t.fillStyle = cssColor(r.font.color);
      t.fillText(r.text, (r.x - box[0]) * k, (r.y - box[1] + Math.ceil(r.font.px * 0.9)) * k);
      if (r.font.underline) t.fillRect((r.x - box[0]) * k, (r.y - box[1] + Math.ceil(r.font.px * 0.9) + 1) * k, (r.w ?? 0) * k, Math.max(1, (r.font.px / 14) * k));
      for (const h of r.holes ?? []) {
        const x1 = Math.max(h.rect[0], box[0]), y1 = Math.max(h.rect[1], box[1]), x2 = Math.min(h.rect[2], box[2]), y2 = Math.min(h.rect[3], box[3]);
        if (x2 <= x1 || y2 <= y1) continue;
        if (!h.mask) { t.clearRect((x1 - box[0]) * k, (y1 - box[1]) * k, (x2 - x1) * k, (y2 - y1) * k); continue; }
        const m = h.mask;
        for (let y = y1; y < y2; y++) {
          for (let x = x1; x < x2; x++) {
            const v = m.surface.getPixel(x + m.mx, y + m.my);
            const covered = m.key === undefined ? v >= 0 && (v & 0x808080) === 0 : v >= 0 && v !== m.key;
            if (covered) t.clearRect(Math.floor((x - box[0]) * k), Math.floor((y - box[1]) * k), Math.ceil(k), Math.ceil(k));
          }
        }
      }
      ctx.drawImage(tmp, 0, 0, tw, th, Math.round(box[0] * k), Math.round(box[1] * k), tw, th);
    }
  }

  private runCanvasEl: HTMLCanvasElement | null = null;
  private runCanvas(w: number, h: number): HTMLCanvasElement {
    const c = (this.runCanvasEl ??= document.createElement('canvas'));
    if (c.width < w) c.width = w;
    if (c.height < h) c.height = h;
    return c;
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
      return [Math.floor(((e.clientX - r.left) / r.width) * this.width), Math.floor(((e.clientY - r.top) / r.height) * this.height)];
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
      f?.onMouseMove?.(shift(e), x - (f?.left ?? 0), y - (f?.top ?? 0));
      this.canvas.style.cursor = f?.cursor ?? 'default';
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

  private loadingEl: HTMLElement | null = null;
  private loadingTimer: ReturnType<typeof setTimeout> | null = null;

  /** Kept for the books: loading feedback now comes from `progress()` (driven by Assets.onProgress). */
  async whileLoading<T>(work: Promise<T>): Promise<T> {
    return work;
  }

  /** Show a loading bar while game files are being fetched; (0, 0) hides it. Appears only after 300 ms. */
  progress(done: number, total: number) {
    if (total <= 0) {
      if (this.loadingTimer !== null) clearTimeout(this.loadingTimer);
      this.loadingTimer = null;
      this.loadingEl?.remove();
      return;
    }
    if (!this.loadingEl) {
      const el = document.createElement('div');
      el.className = 'bdb-loading';
      el.innerHTML = '<span class="bdb-loading-label">Laden…</span><div class="bdb-loading-track"><div class="bdb-loading-bar"></div></div>';
      this.loadingEl = el;
    }
    const f = Math.max(0, Math.min(1, done / total));
    (this.loadingEl.querySelector('.bdb-loading-bar') as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
    (this.loadingEl.querySelector('.bdb-loading-label') as HTMLElement).textContent = `Laden… ${Math.floor(f * 100)}%`;
    if (!this.loadingEl.isConnected && this.loadingTimer === null) {
      this.loadingTimer = setTimeout(() => {
        this.loadingTimer = null;
        if (this.loadingEl) this.root.appendChild(this.loadingEl);
      }, 300);
    }
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
