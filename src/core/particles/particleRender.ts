/**
 * Particle field rendering — the sim-to-renderable seam. Converts the pure,
 * deterministic simulation (particleSim.ts) into texture-space sprites and
 * rasterizes them into a Canvas2D "field" the GPU composites as ONE textured
 * layer — the same texture-provider seam shapes and text already use, so layer
 * blend modes, masks, track mattes, spatial effects and adjustment layers all
 * compose over the particle system with no special cases.
 *
 * Everything except the actual canvas painting is pure (sprites, geometry,
 * signatures), so the conversion is unit-testable with no DOM. Determinism is
 * inherited from simulateParticles: same (config, time) → identical field.
 */

import { simulateParticles, type ParticleBlend, type ParticleConfig, type ParticleShape } from './particleSim';

/** One particle placed in TEXTURE space (origin top-left, emitter at centre). */
export interface ParticleSprite {
  /** Centre position in field px. */
  x: number;
  y: number;
  /** Diameter / edge length in px. */
  size: number;
  /** Self-rotation in degrees. */
  rotation: number;
  /** Resolved `rgba(...)` colour (opacity baked in). */
  color: string;
  opacity: number;
  shape: ParticleShape;
}

/**
 * All live particles at `time`, mapped from emitter-local space into a
 * `fieldW × fieldH` texture with the emitter at the field centre — the layer's
 * transform then places/rotates/scales the whole field in the comp, so flying
 * the emitter is just keyframing the layer. Pure and deterministic.
 */
export function particleSprites(
  cfg: ParticleConfig,
  time: number,
  fieldW: number,
  fieldH: number,
): ParticleSprite[] {
  const cx = fieldW / 2;
  const cy = fieldH / 2;
  return simulateParticles(cfg, time).map((p) => ({
    x: cx + p.x,
    y: cy + p.y,
    size: p.size,
    rotation: p.rotation,
    color: p.color,
    opacity: p.opacity,
    shape: p.shape,
  }));
}

/** Canvas composite op for the intra-field transfer mode ('add' = glow). */
export function particleCompositeOp(blend: ParticleBlend): GlobalCompositeOperation {
  return blend === 'add' ? 'lighter' : 'source-over';
}

/** Outline of an n-point star centred at the origin, first point up. */
export function starPoints(
  outerR: number,
  innerR: number,
  points = 5,
  rotationDeg = 0,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const rot = (rotationDeg * Math.PI) / 180 - Math.PI / 2;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = rot + (i * Math.PI) / points;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

/**
 * Content signature for a rasterized field — covers EVERYTHING that changes
 * its pixels (full config, sim time, field box, raster scale), so a texture is
 * re-drawn exactly when the frame actually differs and a repeat render of the
 * same frame (paused playhead, scrub-back, re-render for media settle) is free.
 */
export function particleFieldSignature(
  cfg: ParticleConfig,
  time: number,
  fieldW: number,
  fieldH: number,
  scale: number,
): string {
  return `${JSON.stringify(cfg)}|t:${time.toFixed(5)}|${Math.round(fieldW)}x${Math.round(fieldH)}|s:${scale.toFixed(3)}`;
}

/**
 * Rasterize the field into a 2D context whose canvas is `fieldW·scale ×
 * fieldH·scale` device px. Clears first, honours the config's transfer mode
 * ('add' → additive glow between particles), and draws every sprite with its
 * simulated size/rotation/colour. No randomness, no clocks — pure paint of the
 * deterministic sprite list.
 */
export function drawParticleField(
  ctx: CanvasRenderingContext2D,
  cfg: ParticleConfig,
  time: number,
  fieldW: number,
  fieldH: number,
  scale = 1,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.globalCompositeOperation = particleCompositeOp(cfg.blend);
  for (const s of particleSprites(cfg, time, fieldW, fieldH)) {
    if (s.size <= 0 || s.opacity <= 0) continue;
    const r = s.size / 2;
    if (s.shape === 'circle') {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate((s.rotation * Math.PI) / 180);
    if (s.shape === 'square') {
      ctx.fillStyle = s.color;
      ctx.fillRect(-r, -r, s.size, s.size);
    } else if (s.shape === 'line') {
      // A streak through the centre — length 2·size, hairline-to-thin width.
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1, s.size / 6);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-s.size, 0);
      ctx.lineTo(s.size, 0);
      ctx.stroke();
    } else {
      // star
      ctx.fillStyle = s.color;
      const pts = starPoints(r, r * 0.45, 5);
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}
