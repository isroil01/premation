import {
  blendOp,
  dabStampCacheSize,
  dabStampKey,
  deviceScaleOf,
  drawPaint,
  drawPaintStrokes,
  hasPaintStrokes,
  isDirectStroke,
  paintReach,
  paintSignature,
  strokeDeviceMatrix,
} from './paintRaster';
import { normalizeStroke, type PaintStroke } from './paintStrokes';

const stroke = (over: Partial<PaintStroke> = {}): PaintStroke => ({
  id: 's1',
  points: [{ x: 0, y: 0 }, { x: 10, y: 5 }],
  color: '#ff0000',
  size: 20,
  opacity: 1,
  hardness: 1,
  mode: 'paint',
  ...over,
});

/** A 2D context stand-in recording every `filter` / composite write, with a
 *  settable transform scale — jsdom has no canvas. */
function recordingContext(scale: number): { ctx: CanvasRenderingContext2D; filters: string[]; ops: string[] } {
  const filters: string[] = [];
  const ops: string[] = [];
  const noop = (): void => {};
  const ctx = {
    canvas: { width: 100, height: 100 },
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    stroke: noop, fill: noop, arc: noop, drawImage: noop, setTransform: noop,
    getTransform: () => ({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }),
    strokeStyle: '', fillStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', globalAlpha: 1,
    set filter(v: string) { filters.push(v); },
    get filter() { return filters[filters.length - 1] ?? 'none'; },
    set globalCompositeOperation(v: string) { ops.push(v); },
    get globalCompositeOperation() { return ops[ops.length - 1] ?? 'source-over'; },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, filters, ops };
}

describe('soft-edge blur follows the raster scale', () => {
  // `ctx.filter = blur()` ignores the CTM, so a local-px sigma drawn under a 2×
  // raster used to come out half as soft as under a 1× one.
  test('sigma is multiplied by the device scale', () => {
    const s = stroke({ size: 30, hardness: 0.5 }); // sigma = 0.5·30/3 = 5 local px
    const at1 = recordingContext(1);
    drawPaintStrokes(at1.ctx, [s]);
    const at2 = recordingContext(2);
    drawPaintStrokes(at2.ctx, [s]);
    expect(at1.filters).toContain('blur(5px)');
    expect(at2.filters).toContain('blur(10px)');
  });

  test('a hard brush sets no blur, and erase cuts', () => {
    const r = recordingContext(3);
    drawPaintStrokes(r.ctx, [stroke({ mode: 'erase' })]);
    expect(r.filters.filter((f) => f !== 'none')).toEqual([]);
    expect(r.ops).toContain('destination-out');
  });

  test('deviceScaleOf reads the transform, defaulting to 1', () => {
    expect(deviceScaleOf(recordingContext(4).ctx)).toBeCloseTo(4);
    expect(deviceScaleOf({} as CanvasRenderingContext2D)).toBe(1);
  });
});

describe('paint padding', () => {
  test('reach is half the brush plus the soft tail (3 sigma)', () => {
    expect(paintReach({ strokes: [stroke({ size: 20 })] })).toBeCloseTo(10);
    // sigma = 0.4·20/3 → 3σ = 8
    expect(paintReach({ strokes: [stroke({ size: 20, hardness: 0.6 })] })).toBeCloseTo(18);
    expect(paintReach(undefined)).toBe(0);
  });
});

describe('paintSignature', () => {
  test('stable for the same strokes, changes when a stroke does', () => {
    const a = stroke();
    expect(paintSignature({ strokes: [a] })).toBe(paintSignature({ strokes: [a] }));
    const moved = stroke({ points: [{ x: 0, y: 0 }, { x: 10, y: 6 }] });
    expect(paintSignature({ strokes: [moved] })).not.toBe(paintSignature({ strokes: [a] }));
    expect(paintSignature({ strokes: [a, stroke({ id: 's2' })] })).not.toBe(paintSignature({ strokes: [a] }));
  });

  test('empty for no paint', () => {
    expect(paintSignature(undefined)).toBe('');
    expect(hasPaintStrokes({ strokes: [] })).toBe(false);
  });

  test('a v1 stroke keeps the v1 key; v2 options and pen input extend it', () => {
    const v1 = paintSignature({ strokes: [stroke()] });
    expect(v1).not.toContain('|');
    expect(paintSignature({ strokes: [stroke({ spacing: 0.25 })] })).not.toBe(v1);
    expect(paintSignature({ strokes: [stroke({ pressure: [1, 0.5] })] })).not.toBe(v1);
    expect(paintSignature({ strokes: [stroke()], onTransparent: true })).not.toBe(v1);
  });
});

// ── Model v2 renderer ──────────────────────────────────────────────────

interface LogEntry { canvas: string; op: string; src?: string; gco?: string; alpha?: number; style?: string }

/** Fake canvases for `document.createElement('canvas')`: every context logs
 *  the draws that matter (drawImage / fillRect / stroke / clearRect) with the
 *  composite state at the time. */
const log: LogEntry[] = [];
let canvasSeq = 0;
function fakeCanvas(width = 0, height = 0): HTMLCanvasElement {
  const name = `c${(canvasSeq += 1)}`;
  const canvas = { width, height, __name: name } as unknown as HTMLCanvasElement & { __name: string };
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const noop = (): void => {};
  const ctx = {
    canvas,
    globalCompositeOperation: 'source-over', globalAlpha: 1, filter: 'none',
    fillStyle: '' as unknown, strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, arc: noop, translate: noop, rotate: noop, scale: noop,
    setTransform(a: number | DOMMatrix, b?: number, c?: number, d?: number, e?: number, f?: number) {
      m = typeof a === 'number' ? { a, b: b!, c: c!, d: d!, e: e!, f: f! } : { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f };
    },
    getTransform: () => m,
    createRadialGradient: () => ({ addColorStop: noop }),
    fill(this: { globalCompositeOperation: string }) { log.push({ canvas: name, op: 'fill', gco: this.globalCompositeOperation }); },
    stroke(this: { globalCompositeOperation: string; strokeStyle: string }) { log.push({ canvas: name, op: 'stroke', gco: this.globalCompositeOperation, style: this.strokeStyle }); },
    clearRect() { log.push({ canvas: name, op: 'clearRect' }); },
    fillRect(this: { globalCompositeOperation: string; fillStyle: unknown }) {
      log.push({ canvas: name, op: 'fillRect', gco: this.globalCompositeOperation, style: String(this.fillStyle) });
    },
    drawImage(this: { globalCompositeOperation: string; globalAlpha: number }, img: { __name?: string }) {
      log.push({ canvas: name, op: 'drawImage', src: img?.__name, gco: this.globalCompositeOperation, alpha: this.globalAlpha });
    },
  };
  (canvas as unknown as { getContext: () => unknown }).getContext = () => ctx;
  return canvas;
}

describe('v2 renderer', () => {
  const realCreate = document.createElement.bind(document);
  beforeAll(() => {
    jest.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas' ? fakeCanvas() : realCreate(tag)) as typeof document.createElement);
  });
  afterAll(() => jest.restoreAllMocks());
  beforeEach(() => { log.length = 0; });

  const target = (): { ctx: CanvasRenderingContext2D; name: string } => {
    const c = fakeCanvas(200, 200) as HTMLCanvasElement & { __name: string };
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 100, 100);
    return { ctx, name: c.__name };
  };
  const on = (name: string, op: string): LogEntry[] => log.filter((e) => e.canvas === name && e.op === op);

  test('a v1 stroke takes the v1 direct pass: one polyline, no buffer', () => {
    const t = target();
    const v1 = normalizeStroke({ points: [{ x: 0, y: 0 }, { x: 10, y: 5 }], color: '#ff0000', size: 20 }, 's1');
    expect(isDirectStroke(v1)).toBe(true);
    drawPaint(t.ctx, { strokes: [v1] });
    expect(on(t.name, 'stroke')).toEqual([{ canvas: t.name, op: 'stroke', gco: 'source-over', style: '#ff0000' }]);
    expect(log.filter((e) => e.op === 'drawImage')).toEqual([]);
  });

  test('a dab stroke: dabs accumulate in a buffer, colour fills it, one composite at Opacity', () => {
    const t = target();
    const s = stroke({ points: [{ x: -50, y: 0 }, { x: 50, y: 0 }], size: 20, spacing: 0.25, opacity: 0.6, flow: 0.5 });
    expect(isDirectStroke(s)).toBe(false);
    drawPaint(t.ctx, { strokes: [s] });
    const composites = on(t.name, 'drawImage');
    expect(composites).toHaveLength(1);
    expect(composites[0]).toMatchObject({ gco: 'source-over', alpha: 0.6 });
    const buffer = composites[0]!.src!;
    const dabs = on(buffer, 'drawImage');
    expect(dabs).toHaveLength(21);
    expect(dabs.every((d) => d.alpha === 0.5 && d.gco === 'source-over')).toBe(true);
    expect(on(buffer, 'fillRect').pop()).toMatchObject({ gco: 'source-in', style: '#ff0000' });
  });

  test('the tip stamp is cached per (diameter, hardness, roundness, angle)', () => {
    const t = target();
    const s = stroke({ id: 'a', size: 17, hardness: 0.3, roundness: 0.5, angle: 30, spacing: 0.5 });
    drawPaint(t.ctx, { strokes: [s] });
    const n = dabStampCacheSize();
    drawPaint(t.ctx, { strokes: [stroke({ id: 'b', size: 17, hardness: 0.3, roundness: 0.5, angle: 210, spacing: 0.5 })] });
    expect(dabStampCacheSize()).toBe(n); // 210° ≡ 30° for an ellipse
    expect(dabStampKey(17, 0.3, 1, 45).key).toBe(dabStampKey(17, 0.3, 1, 0).key); // round tips ignore angle
  });

  test('Mode and Channels choose the composite', () => {
    expect(blendOp('multiply')).toBe('multiply');
    expect(blendOp('add')).toBe('lighter');
    expect(blendOp(undefined)).toBe('source-over');
    const t = target();
    drawPaint(t.ctx, { strokes: [stroke({ id: 'm', blend: 'screen' })] });
    expect(on(t.name, 'drawImage')[0]).toMatchObject({ gco: 'screen' });
    log.length = 0;
    drawPaint(t.ctx, { strokes: [stroke({ id: 'r', channels: 'rgb' })] });
    expect(on(t.name, 'drawImage')[0]).toMatchObject({ gco: 'source-atop' });
    log.length = 0;
    drawPaint(t.ctx, { strokes: [stroke({ id: 'al', channels: 'alpha', color: '#000000', opacity: 0.5 })] });
    expect(on(t.name, 'drawImage')[0]).toMatchObject({ gco: 'destination-out', alpha: 0.5 });
  });

  test('Start/End and a per-stroke transform route through the buffer', () => {
    expect(isDirectStroke(stroke({ end: 0.5 }))).toBe(false);
    expect(isDirectStroke(stroke({ transform: { anchorX: 0, anchorY: 0, x: 10, y: 0, scale: 100, rotation: 0 } }))).toBe(false);
    const m = strokeDeviceMatrix([2, 0, 0, 2, 5, 5], { transform: { anchorX: 0, anchorY: 0, x: 10, y: 0, scale: 100, rotation: 0 } });
    expect(m).toEqual([2, 0, 0, 2, 25, 5]);
    expect(paintReach({ strokes: [stroke({ size: 20, transform: { anchorX: 0, anchorY: 0, x: 30, y: 0, scale: 100, rotation: 0 } })] })).toBeCloseTo(40);
  });

  test('Paint Only erasers cut the paint layer, never the layer source', () => {
    const t = target();
    drawPaint(t.ctx, {
      strokes: [
        stroke({ id: 'b1', mode: 'paint' }),
        stroke({ id: 'e1', mode: 'erase', eraseMode: 'paintOnly' }),
      ],
    });
    const onTarget = on(t.name, 'drawImage');
    // Only the finished paint layer lands on the target.
    expect(onTarget).toHaveLength(1);
    expect(onTarget[0]).toMatchObject({ gco: 'source-over' });
    expect(log.some((e) => e.canvas === t.name && e.gco === 'destination-out')).toBe(false);
    const paintLayer = onTarget[0]!.src!;
    expect(log.some((e) => e.canvas === paintLayer && e.op === 'stroke' && e.gco === 'destination-out')).toBe(true);
  });

  test('Last Stroke Only cuts its target inside the target stroke\'s own buffer', () => {
    const t = target();
    drawPaint(t.ctx, {
      strokes: [
        stroke({ id: 'b1' }),
        stroke({ id: 'b2', color: '#00ff00' }),
        stroke({ id: 'e1', mode: 'erase', eraseMode: 'lastStroke', eraseTargetId: 'b1' }),
      ],
    });
    // b2 draws direct; b1 is buffered and cut; the eraser never touches the target.
    expect(log.some((e) => e.canvas === t.name && e.gco === 'destination-out')).toBe(false);
    const cut = log.find((e) => e.op === 'drawImage' && e.gco === 'destination-out');
    expect(cut).toBeDefined();
    expect(cut!.canvas).not.toBe(t.name);
  });

  test('clone from another layer samples the host-supplied source; none → nothing drawn', () => {
    const image = fakeCanvas(40, 30) as HTMLCanvasElement & { __name: string };
    const cloneSource = jest.fn(() => ({ image, width: 40, height: 30 }));
    const t = target();
    const c = stroke({ id: 'c', mode: 'clone', cloneOffsetX: 3, cloneOffsetY: 0, cloneSourceId: 'B', cloneTime: 2 });
    drawPaint(t.ctx, { strokes: [c] }, { cloneSource });
    expect(cloneSource).toHaveBeenCalledWith('B', 2);
    expect(log.some((e) => e.op === 'drawImage' && e.src === image.__name && e.gco === 'source-in')).toBe(true);
    log.length = 0;
    drawPaint(t.ctx, { strokes: [c] });
    expect(on(t.name, 'drawImage')).toEqual([]);
  });

  test('Paint On Transparent clears the layer before painting', () => {
    const t = target();
    drawPaint(t.ctx, { strokes: [stroke()], onTransparent: true });
    const ops = log.filter((e) => e.canvas === t.name).map((e) => e.op);
    expect(ops.indexOf('clearRect')).toBeLessThan(ops.indexOf('stroke'));
    expect(hasPaintStrokes({ strokes: [], onTransparent: true })).toBe(true);
  });
});
