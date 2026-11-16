"use client";

import { useEffect, useRef, useState } from "react";

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision mediump float;
uniform vec2 uRes; uniform float uT; uniform vec2 uMouse; uniform float uAmt;
uniform vec3 uBg; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.02 + vec2(17.3, 9.1); a *= 0.5; } return v; }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  vec2 m = vec2(uMouse.x * asp, uMouse.y);
  float d = length(p - m);
  p += (p - m) * 0.22 * exp(-d * d * 5.0);
  float t = uT * 0.05;
  vec2 q = vec2(fbm(p * 1.25 + vec2(0.0, t)), fbm(p * 1.25 + vec2(5.2, -t * 1.1)));
  vec2 r = vec2(fbm(p * 1.1 + 3.4 * q + vec2(1.7, 9.2) + t * 0.7), fbm(p * 1.1 + 3.4 * q + vec2(8.3, 2.8) - t * 0.6));
  float f = fbm(p * 1.15 + 3.0 * r);
  vec3 col = uBg;
  col = mix(col, uA, uAmt * smoothstep(0.30, 0.85, f));
  col = mix(col, uB, uAmt * 0.85 * smoothstep(0.35, 0.90, r.x) * (1.0 - smoothstep(0.3, 0.8, f) * 0.6));
  col = mix(col, uC, uAmt * 0.55 * pow(smoothstep(0.45, 0.85, q.y * r.y * 2.2), 2.0));
  // thin bright filaments where the flow folds over itself
  float fil = smoothstep(0.012, 0.0, abs(f - 0.5)) * smoothstep(0.4, 0.7, r.y);
  col = mix(col, uC, fil * uAmt * 0.35);
  float g = hash(gl_FragCoord.xy + uT) - 0.5;
  col += g * 0.012;
  gl_FragColor = vec4(col, 1.0);
}`;

function cssColor(name: string): [number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace("#", "");
  const h = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  const n = parseInt(h, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The background fluid: slow domain-warped flow in the vault's own colours. It stands for the
 * liquidity itself, which moves freely and never leaves the frame.
 */
export function FluidField({ className, fade = "bottom", intensity = 1 }: { className?: string; fade?: "bottom" | "both"; intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) {
      setFailed(true);
      return;
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setFailed(true);
      return;
    }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const u = { res: U("uRes"), t: U("uT"), mouse: U("uMouse"), amt: U("uAmt"), bg: U("uBg"), a: U("uA"), b: U("uB"), c: U("uC") };

    const paint = () => {
      const light = document.documentElement.dataset.theme === "light";
      gl.uniform3fv(u.bg, cssColor("--bg"));
      gl.uniform3fv(u.a, cssColor("--support"));
      gl.uniform3fv(u.b, cssColor("--ask"));
      gl.uniform3fv(u.c, cssColor("--accent"));
      gl.uniform1f(u.amt, (light ? 0.3 : 0.34) * intensity);
    };
    paint();
    const themeWatch = new MutationObserver(() => {
      paint();
      draw();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
      const w = Math.max(2, Math.round(canvas.clientWidth * scale));
      const h = Math.max(2, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(u.res, canvas.width, canvas.height);
    };
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);

    const mouse = { x: 0.5, y: 0.6, tx: 0.5, ty: 0.6 };
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      mouse.tx = (e.clientX - r.left) / r.width;
      mouse.ty = 1 - (e.clientY - r.top) / r.height;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    let visible = true;
    function draw() {
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      gl!.uniform1f(u.t, still ? 40 : 40 + (performance.now() - t0) / 1000);
      gl!.uniform2f(u.mouse, mouse.x, mouse.y);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    }
    const loop = () => {
      draw();
      if (visible && !still && !document.hidden) raf = requestAnimationFrame(loop);
      else raf = 0;
    };
    const wake = () => {
      if (!raf && visible && !still && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      wake();
    });
    io.observe(canvas);
    document.addEventListener("visibilitychange", wake);
    resize();
    loop();

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      themeWatch.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [intensity]);

  const mask = fade === "both" ? "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)" : "linear-gradient(to bottom, black 45%, transparent)";
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ""}`} style={{ maskImage: mask, WebkitMaskImage: mask }}>
      {failed ? <div className="fluid-fallback absolute inset-0" /> : <canvas ref={ref} className="absolute inset-0 h-full w-full" />}
    </div>
  );
}

/** A quieter band of the same fluid, bleeding edge to edge behind a page header. */
export function Backdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute left-1/2 -top-28 -z-10 w-screen -translate-x-1/2 ${className ?? "h-[calc(100%+7rem)]"}`}>
      <FluidField intensity={0.6} />
    </div>
  );
}
