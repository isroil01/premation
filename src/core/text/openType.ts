/**
 * OpenType glyph outlines — the font's own Béziers, for Create Shapes From Text.
 *
 * A deliberately small reader: enough of the sfnt structure to turn a code
 * point into a list of closed contours in font units. It handles the two
 * outline formats in use — TrueType `glyf` (quadratic splines, composites)
 * and CFF `CFF ` (Type 2 charstrings, local/global subrs, hintmask) — plus
 * `cmap` formats 4 and 12 for the character map, `head` for unitsPerEm and
 * `hmtx` for advances. Nothing else: no kerning, no GSUB, no variable-font
 * deltas (a variable face yields its DEFAULT instance). Layout is the
 * canvas's job — it already kerns and shapes — and this module only answers
 * "what shape is this glyph".
 *
 * Quadratics are promoted to cubics exactly (a quadratic is a cubic with both
 * control points at ⅔ of the way), so every contour comes back in the ONE
 * representation the Geometry component stores. Coordinates are font units,
 * y-up; the caller scales by fontSize/unitsPerEm and flips y.
 *
 * Pure over an ArrayBuffer, so it is testable on a hand-built font and usable
 * on whatever the Local Font Access API hands back.
 */

export interface OutlinePoint { x: number; y: number; inX: number; inY: number; outX: number; outY: number }
export interface GlyphContour { points: OutlinePoint[] }
export interface GlyphOutline {
  contours: GlyphContour[];
  /** Advance width in font units. */
  advance: number;
}

export interface ParsedFont {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Code point → outline, or null when the font has no glyph for it. */
  glyphFor(codePoint: number): GlyphOutline | null;
  /** `glyf` or `CFF` — which outline format the face carries. */
  kind: 'glyf' | 'cff';
}

// ── sfnt directory ──────────────────────────────────────────────────

interface TableRec { offset: number; length: number }

function readTables(view: DataView): Map<string, TableRec> {
  let base = 0;
  const tag = view.getUint32(0);
  if (tag === 0x74746366) base = view.getUint32(12); // 'ttcf' → first face
  const numTables = view.getUint16(base + 4);
  const tables = new Map<string, TableRec>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    const t = String.fromCharCode(view.getUint8(rec), view.getUint8(rec + 1), view.getUint8(rec + 2), view.getUint8(rec + 3));
    tables.set(t, { offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) });
  }
  return tables;
}

// ── cmap ────────────────────────────────────────────────────────────

function parseCmap(view: DataView, cmap: TableRec): (cp: number) => number {
  const n = view.getUint16(cmap.offset + 2);
  let best: { off: number; format: number; score: number } | null = null;
  for (let i = 0; i < n; i++) {
    const rec = cmap.offset + 4 + i * 8;
    const platform = view.getUint16(rec), encoding = view.getUint16(rec + 2);
    const off = cmap.offset + view.getUint32(rec + 4);
    const format = view.getUint16(off);
    if (format !== 4 && format !== 12) continue;
    // Prefer a full-Unicode (format 12) table, then Windows BMP, then any Unicode.
    const score = format === 12 ? 3 : platform === 3 && encoding === 1 ? 2 : platform === 0 ? 1 : 0;
    if (!best || score > best.score) best = { off, format, score };
  }
  if (!best) return () => 0;
  const { off, format } = best;
  if (format === 12) {
    const groups = view.getUint32(off + 12);
    return (cp) => {
      // Binary search the sequential map groups.
      let lo = 0, hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = off + 16 + mid * 12;
        const start = view.getUint32(g), end = view.getUint32(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return view.getUint32(g + 8) + (cp - start);
      }
      return 0;
    };
  }
  // Format 4.
  const segX2 = view.getUint16(off + 6);
  const segs = segX2 / 2;
  const endBase = off + 14, startBase = endBase + segX2 + 2, deltaBase = startBase + segX2, rangeBase = deltaBase + segX2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segs; i++) {
      const end = view.getUint16(endBase + i * 2);
      if (cp > end) continue;
      const start = view.getUint16(startBase + i * 2);
      if (cp < start) return 0;
      const delta = view.getInt16(deltaBase + i * 2);
      const rangeOff = view.getUint16(rangeBase + i * 2);
      if (rangeOff === 0) return (cp + delta) & 0xffff;
      const addr = rangeBase + i * 2 + rangeOff + (cp - start) * 2;
      if (addr + 2 > view.byteLength) return 0;
      const g = view.getUint16(addr);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
}

// ── hmtx ────────────────────────────────────────────────────────────

function parseHmtx(view: DataView, hhea: TableRec, hmtx: TableRec): (gid: number) => number {
  const numH = view.getUint16(hhea.offset + 34);
  return (gid) => {
    const i = Math.min(gid, numH - 1);
    return i < 0 ? 0 : view.getUint16(hmtx.offset + i * 4);
  };
}

// ── TrueType glyf ───────────────────────────────────────────────────

interface QuadPt { x: number; y: number; on: boolean }

/**
 * Quadratic TrueType contour → cubic outline points.
 *
 * TrueType stores on-curve anchors with off-curve quadratic controls between
 * them; two consecutive off-curve points imply an on-curve anchor at their
 * midpoint. Walk the ring once from an on-curve start, materialising those
 * implied anchors, then promote each quadratic control Q to the cubic pair
 * C1 = P0 + ⅔(Q − P0), C2 = P1 + ⅔(Q − P1) — an exact conversion.
 */
function quadContourToCubic(pts: QuadPt[]): OutlinePoint[] {
  if (pts.length < 2) return [];
  let ring = pts;
  let start = ring.findIndex((p) => p.on);
  if (start < 0) {
    // All off-curve (a TrueType circle can be): the midpoint of the first
    // two controls is an on-curve point; start there.
    const a = ring[0]!, b = ring[1]!;
    ring = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }, ...ring.slice(1), a];
    start = 0;
  }
  ring = [...ring.slice(start), ...ring.slice(0, start)];

  type Anchor = { x: number; y: number; inQ?: { x: number; y: number }; outQ?: { x: number; y: number } };
  const anchors: Anchor[] = [{ x: ring[0]!.x, y: ring[0]!.y }];
  let prevOff: { x: number; y: number } | null = null;
  const segmentTo = (x: number, y: number): void => {
    if (prevOff) anchors[anchors.length - 1]!.outQ = prevOff;
    anchors.push({ x, y, ...(prevOff ? { inQ: prevOff } : {}) });
    prevOff = null;
  };
  const n = ring.length;
  for (let k = 1; k <= n; k++) {
    const p = ring[k % n]!;
    if (p.on) {
      segmentTo(p.x, p.y);
    } else if (prevOff) {
      segmentTo((prevOff.x + p.x) / 2, (prevOff.y + p.y) / 2);
      prevOff = { x: p.x, y: p.y };
    } else {
      prevOff = { x: p.x, y: p.y };
    }
  }
  // The walk ended by re-entering the start anchor; fold that closing segment's
  // incoming control onto anchor 0 and drop the duplicate.
  const closing = anchors.pop()!;
  anchors[0]!.inQ = closing.inQ;

  return anchors.map((a) => ({
    x: a.x, y: a.y,
    inX: a.inQ ? a.x + (2 / 3) * (a.inQ.x - a.x) : a.x,
    inY: a.inQ ? a.y + (2 / 3) * (a.inQ.y - a.y) : a.y,
    outX: a.outQ ? a.x + (2 / 3) * (a.outQ.x - a.x) : a.x,
    outY: a.outQ ? a.y + (2 / 3) * (a.outQ.y - a.y) : a.y,
  }));
}

function parseGlyf(view: DataView, tables: Map<string, TableRec>): ((gid: number) => GlyphContour[]) | null {
  const head = tables.get('head'), maxp = tables.get('maxp'), loca = tables.get('loca'), glyf = tables.get('glyf');
  if (!head || !maxp || !loca || !glyf) return null;
  const longLoca = view.getInt16(head.offset + 50) === 1;
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const locaAt = (g: number): number => longLoca ? view.getUint32(loca.offset + g * 4) : view.getUint16(loca.offset + g * 2) * 2;

  const outline = (gid: number, depth: number): GlyphContour[] => {
    if (gid < 0 || gid >= numGlyphs || depth > 8) return [];
    const start = glyf.offset + locaAt(gid), end = glyf.offset + locaAt(gid + 1);
    if (end <= start) return [];
    const nc = view.getInt16(start);
    if (nc < 0) {
      // Composite: each component is a glyph placed by an affine.
      const out: GlyphContour[] = [];
      let p = start + 10;
      for (;;) {
        const flags = view.getUint16(p), cgid = view.getUint16(p + 2);
        p += 4;
        let dx: number, dy: number;
        if (flags & 1) { dx = view.getInt16(p); dy = view.getInt16(p + 2); p += 4; }
        else { dx = view.getInt8(p); dy = view.getInt8(p + 1); p += 2; }
        let a = 1, b = 0, c = 0, d = 1;
        const f2 = (o: number): number => view.getInt16(o) / 16384;
        if (flags & 8) { a = d = f2(p); p += 2; }
        else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
        else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
        for (const ct of outline(cgid, depth + 1)) {
          out.push({ points: ct.points.map((q) => ({
            x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy,
            inX: a * q.inX + c * q.inY + dx, inY: b * q.inX + d * q.inY + dy,
            outX: a * q.outX + c * q.outY + dx, outY: b * q.outX + d * q.outY + dy,
          })) });
        }
        if (!(flags & 0x20)) break;
      }
      return out;
    }
    const endPts: number[] = [];
    let p = start + 10;
    for (let i = 0; i < nc; i++) { endPts.push(view.getUint16(p)); p += 2; }
    const nPts = nc ? endPts[nc - 1]! + 1 : 0;
    const insLen = view.getUint16(p); p += 2 + insLen;
    const flags = new Uint8Array(nPts);
    for (let i = 0; i < nPts;) {
      const f = view.getUint8(p++);
      flags[i++] = f;
      if (f & 8) { let r = view.getUint8(p++); while (r-- > 0 && i < nPts) flags[i++] = f; }
    }
    const xs = new Int16Array(nPts), ys = new Int16Array(nPts);
    let v = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i]!;
      if (f & 2) { const d = view.getUint8(p++); v += (f & 16) ? d : -d; }
      else if (!(f & 16)) { v += view.getInt16(p); p += 2; }
      xs[i] = v;
    }
    v = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i]!;
      if (f & 4) { const d = view.getUint8(p++); v += (f & 32) ? d : -d; }
      else if (!(f & 32)) { v += view.getInt16(p); p += 2; }
      ys[i] = v;
    }
    const contours: GlyphContour[] = [];
    let s = 0;
    for (let c = 0; c < nc; c++) {
      const e = endPts[c]!;
      const pts: QuadPt[] = [];
      for (let i = s; i <= e; i++) pts.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) !== 0 });
      if (pts.length >= 2) contours.push({ points: quadContourToCubic(pts) });
      s = e + 1;
    }
    return contours;
  };
  return (gid) => outline(gid, 0);
}

// ── CFF (Type 2 charstrings) ────────────────────────────────────────

function readIndex(view: DataView, pos: number): { items: Array<[number, number]>; end: number } {
  const count = view.getUint16(pos);
  if (count === 0) return { items: [], end: pos + 2 };
  const offSize = view.getUint8(pos + 2);
  const readOff = (i: number): number => {
    const o = pos + 3 + i * offSize;
    let v = 0;
    for (let k = 0; k < offSize; k++) v = (v << 8) | view.getUint8(o + k);
    return v;
  };
  const dataStart = pos + 3 + (count + 1) * offSize - 1;
  const items: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) items.push([dataStart + readOff(i), dataStart + readOff(i + 1)]);
  return { items, end: dataStart + readOff(count) };
}

function parseDict(view: DataView, start: number, end: number): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  let operands: number[] = [];
  let p = start;
  while (p < end) {
    const b0 = view.getUint8(p);
    if (b0 <= 21) {
      let op = b0; p++;
      if (b0 === 12) { op = 1200 + view.getUint8(p); p++; }
      dict.set(op, operands); operands = [];
    } else if (b0 === 28) { operands.push(view.getInt16(p + 1)); p += 3; }
    else if (b0 === 29) { operands.push(view.getInt32(p + 1)); p += 5; }
    else if (b0 === 30) {
      // Real number, nibble-encoded.
      let s = ''; p++;
      for (;;) {
        const b = view.getUint8(p++);
        let done = false;
        for (const nib of [b >> 4, b & 15]) {
          if (nib <= 9) s += nib;
          else if (nib === 10) s += '.';
          else if (nib === 11) s += 'E';
          else if (nib === 12) s += 'E-';
          else if (nib === 14) s += '-';
          else if (nib === 15) { done = true; break; }
        }
        if (done) break;
      }
      operands.push(parseFloat(s) || 0);
    }
    else if (b0 >= 32 && b0 <= 246) { operands.push(b0 - 139); p++; }
    else if (b0 >= 247 && b0 <= 250) { operands.push((b0 - 247) * 256 + view.getUint8(p + 1) + 108); p += 2; }
    else if (b0 >= 251 && b0 <= 254) { operands.push(-(b0 - 251) * 256 - view.getUint8(p + 1) - 108); p += 2; }
    else p++;
  }
  return dict;
}

const bias = (n: number): number => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

function parseCff(view: DataView, cff: TableRec): ((gid: number) => GlyphContour[]) | null {
  const base = cff.offset;
  const hdrSize = view.getUint8(base + 2);
  const nameIdx = readIndex(view, base + hdrSize);
  const topIdx = readIndex(view, nameIdx.end);
  const stringIdx = readIndex(view, topIdx.end);
  const gsubrIdx = readIndex(view, stringIdx.end);
  const top = topIdx.items[0];
  if (!top) return null;
  const topDict = parseDict(view, top[0], top[1]);
  const csOff = topDict.get(17)?.[0];
  if (csOff === undefined) return null;
  const charStrings = readIndex(view, base + csOff);
  // Private dict → local subrs.
  const priv = topDict.get(18);
  let lsubrs: Array<[number, number]> = [];
  let nominalWidthX = 0;
  if (priv && priv.length === 2) {
    const pd = parseDict(view, base + priv[1]!, base + priv[1]! + priv[0]!);
    nominalWidthX = pd.get(21)?.[0] ?? 0;
    const subrs = pd.get(19)?.[0];
    if (subrs !== undefined) lsubrs = readIndex(view, base + priv[1]! + subrs).items;
  }
  // CID-keyed fonts: per-glyph private dicts via FDArray/FDSelect.
  const isCid = topDict.has(1230);
  let fdSelect: ((gid: number) => number) | null = null;
  let fdLocal: Array<Array<[number, number]>> = [];
  if (isCid) {
    const fdaOff = topDict.get(1236)?.[0], fdsOff = topDict.get(1237)?.[0];
    if (fdaOff !== undefined) {
      const fda = readIndex(view, base + fdaOff);
      fdLocal = fda.items.map(([s, e]) => {
        const fd = parseDict(view, s, e);
        const pv = fd.get(18);
        if (!pv || pv.length !== 2) return [];
        const pd = parseDict(view, base + pv[1]!, base + pv[1]! + pv[0]!);
        const so = pd.get(19)?.[0];
        return so === undefined ? [] : readIndex(view, base + pv[1]! + so).items;
      });
    }
    if (fdsOff !== undefined) {
      const p = base + fdsOff;
      const fmt = view.getUint8(p);
      if (fmt === 0) fdSelect = (gid) => view.getUint8(p + 1 + gid);
      else if (fmt === 3) {
        const nR = view.getUint16(p + 1);
        const sentinel = view.getUint16(p + 3 + nR * 3);
        fdSelect = (gid) => {
          for (let i = 0; i < nR; i++) {
            const first = view.getUint16(p + 3 + i * 3);
            const next = i + 1 < nR ? view.getUint16(p + 3 + (i + 1) * 3) : sentinel;
            if (gid >= first && gid < next) return view.getUint8(p + 5 + i * 3);
          }
          return 0;
        };
      }
    }
  }
  // nominalWidthX only matters for advance widths, which hmtx supplies.
  void nominalWidthX;

  const gbias = bias(gsubrIdx.items.length);

  return (gid) => {
    const cs = charStrings.items[gid];
    if (!cs) return [];
    const local = isCid && fdSelect ? (fdLocal[fdSelect(gid)] ?? []) : lsubrs;
    const lbias = bias(local.length);
    const contours: GlyphContour[] = [];
    let cur: OutlinePoint[] = [];
    let x = 0, y = 0;
    const st: number[] = [];
    let nStems = 0;
    let widthParsed = false;

    const moveTo = (nx: number, ny: number): void => {
      closePath();
      cur = [{ x: nx, y: ny, inX: nx, inY: ny, outX: nx, outY: ny }];
      x = nx; y = ny;
    };
    const lineTo = (nx: number, ny: number): void => {
      if (cur.length === 0) cur.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      cur.push({ x: nx, y: ny, inX: nx, inY: ny, outX: nx, outY: ny });
      x = nx; y = ny;
    };
    const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number): void => {
      if (cur.length === 0) cur.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      const last = cur[cur.length - 1]!;
      last.outX = c1x; last.outY = c1y;
      cur.push({ x: nx, y: ny, inX: c2x, inY: c2y, outX: nx, outY: ny });
      x = nx; y = ny;
    };
    const closePath = (): void => {
      if (cur.length >= 2) {
        // A charstring's closing segment is implicit; if the last point sits on
        // the first, merge them so the ring has no zero-length edge.
        const f = cur[0]!, l = cur[cur.length - 1]!;
        if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) { f.inX = l.inX; f.inY = l.inY; cur.pop(); }
        if (cur.length >= 2) contours.push({ points: cur });
      }
      cur = [];
    };

    const run = (start: number, end: number, depth: number): void => {
      if (depth > 10) return;
      let p = start;
      while (p < end) {
        const b0 = view.getUint8(p++);
        if (b0 >= 32 || b0 === 28) {
          if (b0 === 28) { st.push(view.getInt16(p)); p += 2; }
          else if (b0 <= 246) st.push(b0 - 139);
          else if (b0 <= 250) { st.push((b0 - 247) * 256 + view.getUint8(p) + 108); p++; }
          else if (b0 <= 254) { st.push(-(b0 - 251) * 256 - view.getUint8(p) - 108); p++; }
          else { st.push(view.getInt32(p) / 65536); p += 4; }
          continue;
        }
        switch (b0) {
          case 1: case 3: case 18: case 23: // stems
            if (!widthParsed && st.length % 2 === 1) { st.shift(); } widthParsed = true;
            nStems += st.length >> 1; st.length = 0; break;
          case 19: case 20: // hintmask
            if (!widthParsed && st.length % 2 === 1) { st.shift(); } widthParsed = true;
            nStems += st.length >> 1; st.length = 0;
            p += (nStems + 7) >> 3; break;
          case 21: // rmoveto
            if (!widthParsed && st.length > 2) st.shift(); widthParsed = true;
            moveTo(x + (st[0] ?? 0), y + (st[1] ?? 0)); st.length = 0; break;
          case 22: // hmoveto
            if (!widthParsed && st.length > 1) st.shift(); widthParsed = true;
            moveTo(x + (st[0] ?? 0), y); st.length = 0; break;
          case 4: // vmoveto
            if (!widthParsed && st.length > 1) st.shift(); widthParsed = true;
            moveTo(x, y + (st[0] ?? 0)); st.length = 0; break;
          case 5: // rlineto
            for (let i = 0; i + 1 < st.length; i += 2) lineTo(x + st[i]!, y + st[i + 1]!);
            st.length = 0; break;
          case 6: case 7: { // hlineto / vlineto alternate
            let horiz = b0 === 6;
            for (let i = 0; i < st.length; i++) { if (horiz) lineTo(x + st[i]!, y); else lineTo(x, y + st[i]!); horiz = !horiz; }
            st.length = 0; break;
          }
          case 8: // rrcurveto
            for (let i = 0; i + 5 < st.length; i += 6) {
              const c1x = x + st[i]!, c1y = y + st[i + 1]!, c2x = c1x + st[i + 2]!, c2y = c1y + st[i + 3]!;
              curveTo(c1x, c1y, c2x, c2y, c2x + st[i + 4]!, c2y + st[i + 5]!);
            }
            st.length = 0; break;
          case 24: { // rcurveline
            let i = 0;
            for (; i + 5 < st.length - 2; i += 6) {
              const c1x = x + st[i]!, c1y = y + st[i + 1]!, c2x = c1x + st[i + 2]!, c2y = c1y + st[i + 3]!;
              curveTo(c1x, c1y, c2x, c2y, c2x + st[i + 4]!, c2y + st[i + 5]!);
            }
            if (i + 1 < st.length) lineTo(x + st[i]!, y + st[i + 1]!);
            st.length = 0; break;
          }
          case 25: { // rlinecurve
            let i = 0;
            for (; i + 1 < st.length - 6; i += 2) lineTo(x + st[i]!, y + st[i + 1]!);
            if (i + 5 < st.length) {
              const c1x = x + st[i]!, c1y = y + st[i + 1]!, c2x = c1x + st[i + 2]!, c2y = c1y + st[i + 3]!;
              curveTo(c1x, c1y, c2x, c2y, c2x + st[i + 4]!, c2y + st[i + 5]!);
            }
            st.length = 0; break;
          }
          case 26: case 27: { // vvcurveto / hhcurveto
            let i = 0;
            let d1 = 0;
            if (st.length % 4 === 1) { d1 = st[0]!; i = 1; }
            for (; i + 3 < st.length; i += 4) {
              if (b0 === 26) {
                const c1x = x + d1, c1y = y + st[i]!, c2x = c1x + st[i + 1]!, c2y = c1y + st[i + 2]!;
                curveTo(c1x, c1y, c2x, c2y, c2x, c2y + st[i + 3]!);
              } else {
                const c1x = x + st[i]!, c1y = y + d1, c2x = c1x + st[i + 1]!, c2y = c1y + st[i + 2]!;
                curveTo(c1x, c1y, c2x, c2y, c2x + st[i + 3]!, c2y);
              }
              d1 = 0;
            }
            st.length = 0; break;
          }
          case 30: case 31: { // vhcurveto / hvcurveto
            let horiz = b0 === 31;
            let i = 0;
            while (i + 3 < st.length) {
              const lastArg = i + 8 > st.length ? (st.length - i === 5 ? st[i + 4]! : 0) : 0;
              if (horiz) {
                const c1x = x + st[i]!, c1y = y, c2x = c1x + st[i + 1]!, c2y = c1y + st[i + 2]!;
                curveTo(c1x, c1y, c2x, c2y, c2x + lastArg, c2y + st[i + 3]!);
              } else {
                const c1x = x, c1y = y + st[i]!, c2x = c1x + st[i + 1]!, c2y = c1y + st[i + 2]!;
                curveTo(c1x, c1y, c2x, c2y, c2x + st[i + 3]!, c2y + lastArg);
              }
              horiz = !horiz;
              i += 4;
            }
            st.length = 0; break;
          }
          case 10: { // callsubr
            const idx = (st.pop() ?? 0) + lbias;
            const sub = local[idx];
            if (sub) run(sub[0], sub[1], depth + 1);
            break;
          }
          case 29: { // callgsubr
            const idx = (st.pop() ?? 0) + gbias;
            const sub = gsubrIdx.items[idx];
            if (sub) run(sub[0], sub[1], depth + 1);
            break;
          }
          case 11: return; // return
          case 14: // endchar
            if (!widthParsed && (st.length === 1 || st.length === 5)) st.shift();
            widthParsed = true;
            closePath();
            return;
          case 12: { // escape
            const b1 = view.getUint8(p++);
            if (b1 === 35) { // flex
              const a = st;
              const c1x = x + a[0]!, c1y = y + a[1]!, c2x = c1x + a[2]!, c2y = c1y + a[3]!, jx = c2x + a[4]!, jy = c2y + a[5]!;
              curveTo(c1x, c1y, c2x, c2y, jx, jy);
              const c3x = jx + a[6]!, c3y = jy + a[7]!, c4x = c3x + a[8]!, c4y = c3y + a[9]!;
              curveTo(c3x, c3y, c4x, c4y, c4x + a[10]!, c4y + a[11]!);
            } else if (b1 === 34) { // hflex
              const a = st, y0 = y;
              const c1x = x + a[0]!, c1y = y, c2x = c1x + a[1]!, c2y = y + a[2]!, jx = c2x + a[3]!, jy = c2y;
              curveTo(c1x, c1y, c2x, c2y, jx, jy);
              const c3x = jx + a[4]!, c3y = c2y, c4x = c3x + a[5]!, c4y = y0;
              curveTo(c3x, c3y, c4x, c4y, c4x + a[6]!, y0);
            } else if (b1 === 36) { // hflex1
              const a = st, y0 = y;
              const c1x = x + a[0]!, c1y = y + a[1]!, c2x = c1x + a[2]!, c2y = c1y + a[3]!, jx = c2x + a[4]!, jy = c2y;
              curveTo(c1x, c1y, c2x, c2y, jx, jy);
              const c3x = jx + a[5]!, c3y = c2y, c4x = c3x + a[6]!, c4y = c3y + a[7]!;
              curveTo(c3x, c3y, c4x, c4y, c4x + a[8]!, y0);
            } else if (b1 === 37) { // flex1
              const a = st, sx = x, sy = y;
              const dx = a[0]! + a[2]! + a[4]! + a[6]! + a[8]!, dy = a[1]! + a[3]! + a[5]! + a[7]! + a[9]!;
              const c1x = x + a[0]!, c1y = y + a[1]!, c2x = c1x + a[2]!, c2y = c1y + a[3]!, jx = c2x + a[4]!, jy = c2y + a[5]!;
              curveTo(c1x, c1y, c2x, c2y, jx, jy);
              const c3x = jx + a[6]!, c3y = jy + a[7]!, c4x = c3x + a[8]!, c4y = c3y + a[9]!;
              if (Math.abs(dx) > Math.abs(dy)) curveTo(c3x, c3y, c4x, c4y, c4x + a[10]!, sy);
              else curveTo(c3x, c3y, c4x, c4y, sx, c4y + a[10]!);
            }
            st.length = 0;
            break;
          }
          default:
            st.length = 0;
        }
      }
    };
    run(cs[0], cs[1], 0);
    closePath();
    return contours;
  };
}

// ── Entry ───────────────────────────────────────────────────────────

export function parseFont(buf: ArrayBuffer): ParsedFont | null {
  if (buf.byteLength < 12) return null;
  const view = new DataView(buf);
  const tables = readTables(view);
  const head = tables.get('head'), hhea = tables.get('hhea'), hmtx = tables.get('hmtx'), cmap = tables.get('cmap');
  if (!head || !hhea || !hmtx || !cmap) return null;
  const unitsPerEm = view.getUint16(head.offset + 18) || 1000;
  const ascender = view.getInt16(hhea.offset + 4), descender = view.getInt16(hhea.offset + 6);
  const gidOf = parseCmap(view, cmap);
  const advanceOf = parseHmtx(view, hhea, hmtx);
  const cff = tables.get('CFF ');
  const outlineOf = cff ? parseCff(view, cff) : parseGlyf(view, tables);
  if (!outlineOf) return null;
  const cache = new Map<number, GlyphOutline | null>();
  return {
    unitsPerEm, ascender, descender,
    kind: cff ? 'cff' : 'glyf',
    glyphFor(cp) {
      const hit = cache.get(cp);
      if (hit !== undefined) return hit;
      const gid = gidOf(cp);
      const result = gid === 0 && cp !== 0 ? null : { contours: outlineOf(gid), advance: advanceOf(gid) };
      cache.set(cp, result);
      return result;
    },
  };
}
