// Puts the 640x480 framebuffer on screen. Three looks:
//  - 'original': crisp pixels, nearest-neighbour scaling (what a 1996 monitor showed)
//  - 'smooth':   removes the 256-colour dithering grain with an edge-preserving
//                (bilateral) filter, then scales smoothly. Only the presentation changes;
//                the games keep working on the original pixels.
//  - 'ai':       'smooth' underneath, plus tiles upscaled by a neural network on top (ai.ts).
// WebGL2 when available, otherwise a plain 2D canvas (original look only).

export type DisplayMode = 'original' | 'smooth' | 'ai';

const VS = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() { uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`;

// Pass 1a: a light 3x3 blur, used only as the *guide* for pass 1b.
const FS_GUIDE = `#version 300 es
precision highp float;
uniform sampler2D src;
out vec4 o;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float w = exp(-float(dx * dx + dy * dy) / 2.0);
      sum += texelFetch(src, clamp(p + ivec2(dx, dy), ivec2(0), size - 1), 0).rgb * w;
      wsum += w;
    }
  }
  o = vec4(sum / wsum, 1.0);
}`;

// Pass 1b: joint ("cross") bilateral filter. The original pixels are averaged, but whether
// two pixels belong together is judged on the blurred guide: in the blurred image 256-colour
// dither (even stray magenta or purple dots used to fake a pink sky) is flat and gets
// averaged into the intended tint, while real edges stay large and are kept sharp.
const FS_DEDITHER = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform sampler2D guide;
uniform float rangeSigma;
out vec4 o;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 g = texelFetch(guide, p, 0).rgb;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 q = clamp(p + ivec2(dx, dy), ivec2(0), size - 1);
      vec3 d = texelFetch(guide, q, 0).rgb - g;
      float w = exp(-float(dx * dx + dy * dy) / 3.0 - dot(d, d) / (2.0 * rangeSigma * rangeSigma));
      sum += texelFetch(src, q, 0).rgb * w;
      wsum += w;
    }
  }
  o = vec4(sum / wsum, 1.0);
}`;

// Pass 1c: contrast-adaptive sharpening (after AMD CAS) at source resolution: restores
// the crispness the de-dither smoothed away, limited by the local min/max so no halos.
const FS_CAS = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform float sharpness;
out vec4 o;
vec3 at(ivec2 p, ivec2 size) { return texelFetch(src, clamp(p, ivec2(0), size - 1), 0).rgb; }
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 e = at(p, size);
  vec3 b = at(p + ivec2(0, -1), size), d = at(p + ivec2(-1, 0), size), f = at(p + ivec2(1, 0), size), h = at(p + ivec2(0, 1), size);
  vec3 mn = min(e, min(min(b, d), min(f, h)));
  vec3 mx = max(e, max(max(b, d), max(f, h)));
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
  vec3 w = amp * (-1.0 / mix(8.0, 5.0, sharpness));
  o = vec4(clamp((e + w * (b + d + f + h)) / (1.0 + 4.0 * w), 0.0, 1.0), 1.0);
}`;

// Pass 2: scale to the canvas. Texture row 0 is the top of the image, so flip y.
// Smooth mode upscales with a Catmull-Rom bicubic (sharper than bilinear), clamped to the
// 2x2 neighbourhood so it can't ring; original mode samples the nearest pixel.
// The art was made on CRTs (gamma ~2.5): on today's sRGB screens (2.2) it looks pale.
// `crt` darkens the midtones to match and adds a little saturation (0 = untouched).
const FS_SCALE = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform float crt;
uniform int bicubic;
in vec2 uv;
out vec4 o;
vec3 tx(ivec2 p) { ivec2 s = textureSize(src, 0); return texelFetch(src, clamp(p, ivec2(0), s - 1), 0).rgb; }
vec4 cr(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
void main() {
  vec2 st = vec2(uv.x, 1.0 - uv.y);
  vec3 c;
  if (bicubic == 1) {
    vec2 size = vec2(textureSize(src, 0));
    vec2 pos = st * size - 0.5;
    vec2 f = fract(pos);
    ivec2 base = ivec2(floor(pos));
    vec4 wx = cr(f.x), wy = cr(f.y);
    c = vec3(0.0);
    for (int j = 0; j < 4; j++) {
      vec3 row = wx.x * tx(base + ivec2(-1, j - 1)) + wx.y * tx(base + ivec2(0, j - 1)) + wx.z * tx(base + ivec2(1, j - 1)) + wx.w * tx(base + ivec2(2, j - 1));
      c += wy[j] * row;
    }
    vec3 a = tx(base), b = tx(base + ivec2(1, 0)), d = tx(base + ivec2(0, 1)), e = tx(base + ivec2(1, 1));
    c = clamp(c, min(min(a, b), min(d, e)), max(max(a, b), max(d, e)));
  } else {
    c = texture(src, st).rgb;
  }
  c = pow(c, vec3(1.0 + 0.14 * crt));
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = clamp(mix(vec3(l), c, 1.0 + 0.18 * crt), 0.0, 1.0);
  o = vec4(c, 1.0);
}`;

/** Strength of the CRT colour correction in smooth mode (0..1); ?crt=0.5 overrides for testing. */
export const Presenter = {
  crt: Number(new URLSearchParams(globalThis.location?.search ?? '').get('crt') ?? 1),
  /** CAS sharpening 0..1 in smooth mode (?sharp= to try other values; 0 = off). */
  sharp: Number(new URLSearchParams(globalThis.location?.search ?? '').get('sharp') ?? 0.6),
  /** Bicubic upscaling in smooth mode (?bicubic=0 for bilinear). */
  bicubic: new URLSearchParams(globalThis.location?.search ?? '').get('bicubic') !== '0',
};

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
  private guideTex: WebGLTexture;
  private guideFbo: WebGLFramebuffer;
  private casTex: WebGLTexture;
  private casFbo: WebGLFramebuffer;
  private progGuide: WebGLProgram;
  private progCas: WebGLProgram;
  private progDedither: WebGLProgram;
  private progScale: WebGLProgram;
  private texW = 0;
  private texH = 0;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, mode: DisplayMode) {
    this.canvas = canvas;
    this.gl = gl;
    this.mode = mode;
    this.progGuide = this.program(VS, FS_GUIDE);
    this.progCas = this.program(VS, FS_CAS);
    this.progDedither = this.program(VS, FS_DEDITHER);
    this.progScale = this.program(VS, FS_SCALE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const p of [this.progGuide, this.progDedither, this.progCas, this.progScale]) {
      const loc = gl.getAttribLocation(p, 'pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.srcTex = gl.createTexture()!;
    this.fboTex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
    this.guideTex = gl.createTexture()!;
    this.guideFbo = gl.createFramebuffer()!;
    this.casTex = gl.createTexture()!;
    this.casFbo = gl.createFramebuffer()!;
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
    for (const t of [this.srcTex, this.fboTex, this.guideTex, this.casTex]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.guideFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.guideTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.casFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.casTex, 0);
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
    if (this.mode !== 'original') {
      gl.viewport(0, 0, w, h);
      const nearest = (t: WebGLTexture, unit: number) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      };
      // 1a: guide = blurred source
      nearest(this.srcTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.guideFbo);
      gl.useProgram(this.progGuide);
      gl.uniform1i(gl.getUniformLocation(this.progGuide, 'src'), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // 1b: joint bilateral of the source, guided by 1a
      nearest(this.guideTex, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.useProgram(this.progDedither);
      gl.uniform1i(gl.getUniformLocation(this.progDedither, 'src'), 0);
      gl.uniform1i(gl.getUniformLocation(this.progDedither, 'guide'), 1);
      gl.uniform1f(gl.getUniformLocation(this.progDedither, 'rangeSigma'), 0.1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      scaleSrc = this.fboTex;
      // 1c: sharpening
      if (Presenter.sharp > 0) {
        nearest(this.fboTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.casFbo);
        gl.useProgram(this.progCas);
        gl.uniform1i(gl.getUniformLocation(this.progCas, 'src'), 0);
        gl.uniform1f(gl.getUniformLocation(this.progCas, 'sharpness'), Presenter.sharp);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        scaleSrc = this.casTex;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
    }
    // pass 1 renders with gl_FragCoord (y up) from a top-down texture, so the FBO is top-down too
    gl.bindTexture(gl.TEXTURE_2D, scaleSrc);
    const filter = this.mode !== 'original' ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progScale);
    gl.uniform1f(gl.getUniformLocation(this.progScale, 'crt'), this.mode !== 'original' ? Presenter.crt : 0);
    gl.uniform1i(gl.getUniformLocation(this.progScale, 'bicubic'), this.mode !== 'original' && Presenter.bicubic ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
