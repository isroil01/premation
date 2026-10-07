/**
 * Liquify's painted distortion field (AE parity 5.5) — AE's Liquify brushes
 * over a displacement mesh. The field is a grid of (cols + 1) × (rows + 1)
 * vertices over the layer box, each holding the offset its pixel is read FROM
 * (output p shows the source at p − offset × Distortion Percentage); the
 * effect's `fieldGrid` param stores [cols, rows] and `field` the offsets,
 * flat [x0, y0, x1, y1, …] in layer px (the engine's liquify kernel reads
 * them, bilinear between vertices).
 *
 * Brushes, as in AE's Liquify Tools: Warp (push along the drag), Turbulence,
 * Twirl Clockwise / Counterclockwise, Pucker, Bloat, Shift Pixels (sideways to
 * the drag) and Reconstruction (relaxes the field back toward none). Pure.
 */

export type LiquifyTool = 'warp' | 'turbulence' | 'twirlCW' | 'twirlCCW' | 'pucker' | 'bloat' | 'shiftPixels' | 'reconstruction';

export const LIQUIFY_TOOLS: ReadonlyArray<{ tool: LiquifyTool; label: string }> = [
  { tool: 'warp', label: 'Warp' },
  { tool: 'turbulence', label: 'Turbulence' },
  { tool: 'twirlCW', label: 'Twirl Clockwise' },
  { tool: 'twirlCCW', label: 'Twirl Counterclockwise' },
  { tool: 'pucker', label: 'Pucker' },
  { tool: 'bloat', label: 'Bloat' },
  { tool: 'shiftPixels', label: 'Shift Pixels' },
  { tool: 'reconstruction', label: 'Reconstruction' },
];

export interface LiquifyGrid {
  cols: number;
  rows: number;
}

/** The longest side of the field, in cells. */
export const LIQUIFY_FIELD_CELLS = 64;

/** The grid for a layer box: square-ish cells, the long side LIQUIFY_FIELD_CELLS. */
export function liquifyGridFor(w: number, h: number): LiquifyGrid {
  const long = Math.max(1, w, h);
  return {
    cols: Math.max(4, Math.round((LIQUIFY_FIELD_CELLS * Math.max(1, w)) / long)),
    rows: Math.max(4, Math.round((LIQUIFY_FIELD_CELLS * Math.max(1, h)) / long)),
  };
}

/** The stored field when it matches `grid`, else a fresh (all-zero) one. */
export function liquifyFieldOf(stored: unknown, storedGrid: unknown, grid: LiquifyGrid): number[] {
  const n = (grid.cols + 1) * (grid.rows + 1) * 2;
  const g = Array.isArray(storedGrid) ? storedGrid : [];
  if (Array.isArray(stored) && stored.length === n && g[0] === grid.cols && g[1] === grid.rows) {
    return stored.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
  }
  return new Array<number>(n).fill(0);
}

export interface LiquifyDab {
  tool: LiquifyTool;
  /** Brush centre, layer px from the box's top-left. */
  x: number;
  y: number;
  /** Brush radius, layer px. */
  radius: number;
  /** 0…1. */
  pressure: number;
  /** The pointer's travel since the previous dab, layer px (Warp / Shift Pixels). */
  dx: number;
  dy: number;
  /** Turbulence's seed (deterministic per stroke). */
  seed: number;
}

/** A deterministic value in −1…1 for a vertex and seed. */
function hash2(i: number, j: number, seed: number): number {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** `field` after one brush dab (in place; also returned). */
export function liquifyDabInto(field: number[], grid: LiquifyGrid, w: number, h: number, dab: LiquifyDab): number[] {
  const r = Math.max(1, dab.radius);
  const p = Math.max(0, Math.min(1, dab.pressure));
  const cw = w / grid.cols;
  const ch = h / grid.rows;
  const i0 = Math.max(0, Math.floor((dab.x - r) / cw));
  const i1 = Math.min(grid.cols, Math.ceil((dab.x + r) / cw));
  const j0 = Math.max(0, Math.floor((dab.y - r) / ch));
  const j1 = Math.min(grid.rows, Math.ceil((dab.y + r) / ch));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const vx = i * cw;
      const vy = j * ch;
      const d = Math.hypot(vx - dab.x, vy - dab.y);
      if (d >= r) continue;
      const q = 1 - (d / r) * (d / r);
      const f = q * q * p;
      const k = (j * (grid.cols + 1) + i) * 2;
      let ox = field[k] ?? 0;
      let oy = field[k + 1] ?? 0;
      // The source point this vertex currently reads.
      const sx = vx - ox;
      const sy = vy - oy;
      switch (dab.tool) {
        case 'warp':
          ox += dab.dx * f;
          oy += dab.dy * f;
          break;
        case 'shiftPixels':
          ox += -dab.dy * f;
          oy += dab.dx * f;
          break;
        case 'turbulence':
          ox += hash2(i, j, dab.seed) * r * 0.04 * f;
          oy += hash2(j, i, dab.seed + 7) * r * 0.04 * f;
          break;
        case 'twirlCW':
        case 'twirlCCW': {
          // Turn the source point about the brush centre (clockwise on screen = positive, y down).
          const a = (dab.tool === 'twirlCW' ? -1 : 1) * 0.12 * f;
          const rx = sx - dab.x;
          const ry = sy - dab.y;
          const nx = dab.x + rx * Math.cos(a) - ry * Math.sin(a);
          const ny = dab.y + rx * Math.sin(a) + ry * Math.cos(a);
          ox = vx - nx;
          oy = vy - ny;
          break;
        }
        case 'pucker':
        case 'bloat': {
          // Pucker reads from farther out (content pulls in); Bloat from nearer (content swells).
          const s = (dab.tool === 'pucker' ? 1 : -1) * 0.08 * f;
          const nx = sx + (sx - dab.x) * s;
          const ny = sy + (sy - dab.y) * s;
          ox = vx - nx;
          oy = vy - ny;
          break;
        }
        case 'reconstruction':
          ox *= 1 - 0.5 * f;
          oy *= 1 - 0.5 * f;
          break;
      }
      field[k] = ox;
      field[k + 1] = oy;
    }
  }
  return field;
}

/** The field's offset at layer point (x, y), bilinear (the kernel's read; for tests and previews). */
export function sampleLiquifyField(field: readonly number[], grid: LiquifyGrid, w: number, h: number, x: number, y: number): { x: number; y: number } {
  const fx = Math.max(0, Math.min(grid.cols, (x / Math.max(1e-9, w)) * grid.cols));
  const fy = Math.max(0, Math.min(grid.rows, (y / Math.max(1e-9, h)) * grid.rows));
  const i = Math.min(grid.cols - 1, Math.floor(fx));
  const j = Math.min(grid.rows - 1, Math.floor(fy));
  const tx = fx - i;
  const ty = fy - j;
  const at = (ii: number, jj: number, c: 0 | 1): number => field[(jj * (grid.cols + 1) + ii) * 2 + c] ?? 0;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  return {
    x: lerp(lerp(at(i, j, 0), at(i + 1, j, 0), tx), lerp(at(i, j + 1, 0), at(i + 1, j + 1, 0), tx), ty),
    y: lerp(lerp(at(i, j, 1), at(i + 1, j, 1), tx), lerp(at(i, j + 1, 1), at(i + 1, j + 1, 1), tx), ty),
  };
}
