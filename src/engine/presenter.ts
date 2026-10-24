// Puts the 640x480 framebuffer on screen. Two looks:
//  - 'original': crisp pixels, nearest-neighbour scaling (what a 1996 monitor showed)
//  - 'smooth':   removes the 256-colour dithering grain with an edge-preserving
//                (bilateral) filter, then scales smoothly. Only the presentation changes;
//                the games keep working on the original pixels.
// WebGL2 when available, otherwise a plain 2D canvas (original look only).

export type DisplayMode = 'original' | 'smooth';

const VS = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() { uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`;

// Pass 1 (640x480 -> 640x480): bilateral filter. Dither noise = small colour differences
// between close pixels (averaged away); real edges = large differences (kept).
const FS_DEDITHER = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform float rangeSigma;
out vec4 o;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(src, p, 0).rgb;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec3 n = texelFetch(src, clamp(p + ivec2(dx, dy), ivec2(0), size - 1), 0).rgb;
      vec3 d = n - c;
      float w = exp(-float(dx * dx + dy * dy) / 3.0 - dot(d, d) / (2.0 * rangeSigma * rangeSigma));
      sum += n * w;
      wsum += w;
    }
  }
  o = vec4(sum / wsum, 1.0);
}`;

// Pass 2: scale to the canvas. Texture row 0 is the top of the image, so flip y.
const FS_SCALE = `#version 300 es
precision highp float;
uniform sampler2D src;
in vec2 uv;
out vec4 o;
void main() { o = vec4(texture(src, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0); }`;

export interface Presenter {
  mode: DisplayMode;
  /** Pixels as 0x00BBGGRR (Surface layout), w x h. */
  present(px: Uint32Array, w: number, h: number): void;
  /** Canvas element size in CSS px changed. */
  resize(cssW: number, cssH: number): void;
}

export function createPresenter(canvas: HTMLCanvasElement, mode: DisplayMode): Presenter {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  return gl ? new GlPresenter(canvas, gl, mode) : new CanvasPresenter(canvas);
}

class CanvasPresenter implements Presenter {
  mode: DisplayMode = 'original';
  private ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }
  resize() {}
  present(px: Uint32Array, w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.image = null; }
    this.image ??= this.ctx.createImageData(w, h);
    const dst = new Uint32Array(this.image.data.buffer);
    for (let i = 0; i < px.length; i++) dst[i] = px[i] | 0xff000000;
    this.ctx.putImageData(this.image, 0, 0);
  }
}

class GlPresenter implements Presenter {
  mode: DisplayMode;
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private srcTex: WebGLTexture;
  private fboTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private progDedither: WebGLProgram;
  private progScale: WebGLProgram;
  private texW = 0;
  private texH = 0;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, mode: DisplayMode) {
    this.canvas = canvas;
    this.gl = gl;
    this.mode = mode;
    this.progDedither = this.program(VS, FS_DEDITHER);
    this.progScale = this.program(VS, FS_SCALE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const p of [this.progDedither, this.progScale]) {
      const loc = gl.getAttribLocation(p, 'pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.srcTex = gl.createTexture()!;
    this.fboTex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    return p;
  }

  resize(cssW: number, cssH: number) {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
  }

  private setupTextures(w: number, h: number) {
    const gl = this.gl;
    for (const t of [this.srcTex, this.fboTex]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.texW = w;
    this.texH = h;
  }

  present(px: Uint32Array, w: number, h: number) {
    const gl = this.gl;
    if (w !== this.texW || h !== this.texH) this.setupTextures(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px.buffer, px.byteOffset, w * h * 4));
    let scaleSrc = this.srcTex;
    if (this.mode === 'smooth') {
      gl.viewport(0, 0, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.useProgram(this.progDedither);
      gl.uniform1f(gl.getUniformLocation(this.progDedither, 'rangeSigma'), 0.2);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      scaleSrc = this.fboTex;
    }
    // pass 1 renders with gl_FragCoord (y up) from a top-down texture, so the FBO is top-down too
    gl.bindTexture(gl.TEXTURE_2D, scaleSrc);
    const filter = this.mode === 'smooth' ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progScale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
