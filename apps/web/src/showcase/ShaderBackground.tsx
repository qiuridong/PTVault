import { Mesh, Program, Renderer, Triangle } from 'ogl';
import { useEffect, useRef } from 'react';

import { useReducedMotion } from './useReducedMotion.js';

type ShaderBackgroundProps = {
  /** Extra class for positioning/scoping the canvas within a stage. */
  className?: string;
};

const VERTEX = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

/*
 * Iridescent flow field.
 *
 * Three layers of domain-warped fbm fold the field through itself, then the
 * ribbon term is sampled three times at slightly offset positions — one per
 * channel — so the bright edges break into colour the way light does through a
 * prism rather than glowing a single flat hue. The pointer only bends the warp;
 * it never moves the composition, so the background stays a background.
 */
const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uPointer;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uGlow;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      total += noise(p) * amplitude;
      p = p * 2.03 + vec2(37.1, 11.7);
      amplitude *= 0.5;
    }
    return total;
  }

  // The warped field value at a point, plus the ribbon term it produces.
  float field(vec2 p, float t, out float ribbon) {
    vec2 q = vec2(fbm(p * 1.5 + t), fbm(p * 1.5 + vec2(5.2, 1.3) - t));
    vec2 r = vec2(
      fbm(p * 1.8 + 2.0 * q + vec2(1.7, 9.2) + t * 0.7),
      fbm(p * 1.8 + 2.0 * q + vec2(8.3, 2.8) - t * 0.6)
    );
    float flow = fbm(p * 2.1 + 3.0 * r + t * 0.4);
    float bands = sin((r.x - r.y) * 3.14159 + flow * 6.0 + t * 1.8);
    ribbon = smoothstep(0.80, 1.0, abs(bands));
    return flow;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2(uv.x * aspect, uv.y);

    float t = uTime * 0.045;
    // Parallax: a gentle shear of the sampling plane, not a camera move.
    p += (uPointer - 0.5) * vec2(0.16, 0.10);

    float ribbonR;
    float ribbonG;
    float ribbonB;
    float flow = field(p, t, ribbonG);
    field(p + vec2(0.012, 0.006), t, ribbonR);
    field(p - vec2(0.012, 0.006), t, ribbonB);

    vec3 base = mix(uColorA, uColorB, smoothstep(0.05, 0.95, flow + uv.y * 0.28));

    // Dispersed ribbons.
    vec3 ribbon = vec3(ribbonR, ribbonG, ribbonB);
    base += uGlow * ribbon * (0.34 + 0.46 * flow);

    // A drifting lobe keeps the field from reading as a flat texture.
    vec2 centre = vec2(0.30 + 0.14 * sin(t * 0.7), 0.42 + 0.12 * cos(t * 0.9));
    float d = distance(vec2(uv.x * aspect, uv.y), vec2(centre.x * aspect, centre.y));
    base += uGlow * smoothstep(0.62, 0.0, d) * (0.26 + 0.44 * flow);

    // Vignette so panel content stays legible over the field.
    float vig = smoothstep(1.18, 0.32, distance(uv, vec2(0.5)));
    base *= 0.80 + 0.20 * vig;

    gl_FragColor = vec4(base, 1.0);
  }
`;

function readColorVar(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: [number, number, number],
) {
  const raw = styles.getPropertyValue(name).trim();
  const rgb = parseColor(raw);
  return rgb ?? fallback;
}

// Accepts #rgb, #rrggbb, or rgb()/rgba(); returns 0..1 triplet.
function parseColor(value: string): [number, number, number] | null {
  if (!value) return null;
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (hex.length !== 6) return null;
    const int = Number.parseInt(hex, 16);
    if (Number.isNaN(int)) return null;
    return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
  }
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match?.[1]) return null;
  const parts = match[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .slice(0, 3);
  if (parts.length < 3) return null;
  const nums = parts.map((part) => {
    const n = Number.parseFloat(part);
    return part.includes('%') ? n / 100 : n / 255;
  });
  const [r, g, b] = nums;
  if (r === undefined || g === undefined || b === undefined) return null;
  return [r, g, b];
}

/**
 * Full-screen GLSL flow-field background for the Showcase track.
 *
 * Safety contract:
 * - Renders nothing but a decorative canvas; always `aria-hidden`.
 * - When the user prefers reduced motion, the render loop never starts — a
 *   static CSS gradient fallback shows instead.
 * - WebGL creation is wrapped in try/catch, so jsdom (tests) and unsupported
 *   browsers degrade to the static fallback rather than throwing.
 * - Colors are read from theme CSS custom properties, so it honors light/dark.
 * - The loop stops while the tab is hidden and while the element is scrolled out
 *   of view: an operator watching a multi-hour transfer should not be paying for
 *   a shader they cannot see.
 */
export function ShaderBackground({ className }: ShaderBackgroundProps) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    const container = containerRef.current;
    if (!container) return;

    let renderer: Renderer | null = null;
    let frame = 0;
    let disposed = false;

    try {
      renderer = new Renderer({ alpha: false, depth: false, stencil: false, dpr: 1 });
    } catch {
      return; // WebGL unavailable — the CSS fallback layer stays visible.
    }

    const gl = renderer.gl;
    const canvas = gl.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.append(canvas);

    const styles = getComputedStyle(document.documentElement);
    // Own the uniform objects so `.value` writes are typed, not through ogl's `any`.
    const uTime: { value: number } = { value: 0 };
    const uResolution: { value: [number, number] } = { value: [1, 1] };
    const uPointer: { value: [number, number] } = { value: [0.5, 0.5] };
    const uColorA: { value: [number, number, number] } = {
      value: readColorVar(styles, '--showcase-a', [0.02, 0.04, 0.05]),
    };
    const uColorB: { value: [number, number, number] } = {
      value: readColorVar(styles, '--showcase-b', [0.04, 0.17, 0.17]),
    };
    const uGlow: { value: [number, number, number] } = {
      value: readColorVar(styles, '--showcase-glow', [0.12, 0.66, 0.59]),
    };

    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: VERTEX,
      fragment: FRAGMENT,
      uniforms: { uTime, uResolution, uPointer, uColorA, uColorB, uGlow },
    });
    const mesh = new Mesh(gl, { geometry, program });

    const resize = (): void => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      // Capped at 1.75: the field is low-frequency, and the extra pixels of a 3x
      // panel buy nothing an operator can see while costing every frame.
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      renderer?.setSize(width, height);
      if (renderer) renderer.dpr = dpr;
      uResolution.value = [width * dpr, height * dpr];
    };
    resize();
    window.addEventListener('resize', resize);

    // Pointer target, eased toward in the loop so a fast flick does not snap.
    let targetX = 0.5;
    let targetY = 0.5;
    const onPointerMove = (event: PointerEvent): void => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      targetX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      targetY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    // Re-read theme colors when the document theme flips.
    const themeObserver = new MutationObserver(() => {
      const next = getComputedStyle(document.documentElement);
      uColorA.value = readColorVar(next, '--showcase-a', [0.02, 0.04, 0.05]);
      uColorB.value = readColorVar(next, '--showcase-b', [0.04, 0.17, 0.17]);
      uGlow.value = readColorVar(next, '--showcase-glow', [0.12, 0.66, 0.59]);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const start = performance.now();
    let hidden = document.hidden;
    let offscreen = false;
    const resume = (): void => {
      if (!disposed && !hidden && !offscreen) frame = requestAnimationFrame(loop);
    };
    const onVisibility = (): void => {
      hidden = document.hidden;
      resume();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Not every browser under test has IntersectionObserver; without it the loop
    // simply keeps its previous behaviour of running while the tab is visible.
    let viewObserver: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      viewObserver = new IntersectionObserver((entries) => {
        offscreen = !entries.some((entry) => entry.isIntersecting);
        resume();
      });
      viewObserver.observe(container);
    }

    function loop(now: number): void {
      if (disposed || hidden || offscreen) return;
      uTime.value = (now - start) / 1000;
      const [px, py] = uPointer.value;
      uPointer.value = [px + (targetX - px) * 0.045, py + (targetY - py) * 0.045];
      renderer?.render({ scene: mesh });
      frame = requestAnimationFrame(loop);
    }
    resume();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
      themeObserver.disconnect();
      viewObserver?.disconnect();
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext && typeof (ext as { loseContext?: () => void }).loseContext === 'function') {
        (ext as { loseContext: () => void }).loseContext();
      }
      canvas.remove();
    };
  }, [reduced]);

  return (
    <div
      ref={containerRef}
      className={`showcase-background${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      <div className="showcase-fallback" aria-hidden="true" />
    </div>
  );
}
