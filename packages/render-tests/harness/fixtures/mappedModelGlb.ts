/**
 * A textured glTF model, built in memory — the fixture for the PBR-map scenes.
 *
 * Everything here is generated rather than checked in as binary. A committed
 * .glb would be a black box: when the scene's golden moved, nobody could tell
 * whether the renderer changed or the file did, and the maps' contents — which
 * are the whole point of the scenes — would be invisible in review. Generated,
 * every texel has a reason written next to it.
 *
 * The images are real PNGs because they travel the real path: the mesh registry
 * mints an object URL per image, the texture provider loads it through an
 * `img` element, and the browser decodes it. Fake bytes would fail to decode
 * and the maps would silently arrive as the white fallback — which is exactly
 * the failure these scenes exist to catch, so the fixture must not be able to
 * cause it.
 */

// ── A minimal PNG encoder ────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)), false);
  return out;
}

/**
 * RGBA8 pixels → PNG bytes.
 *
 * DEFLATE is written as STORED blocks — no compression at all. These images are
 * 8×8, so compressing would save nothing, and a stored stream is a dozen lines
 * that cannot be subtly wrong instead of a compressor that can.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Filter byte 0 (None) in front of every scanline.
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const stream: number[] = [0x78, 0x01]; // zlib header, no preset dictionary
  for (let off = 0; off < raw.length; off += 0xffff) {
    const len = Math.min(0xffff, raw.length - off);
    stream.push(off + len >= raw.length ? 1 : 0, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff);
    for (let i = 0; i < len; i++) stream.push(raw[off + i]!);
  }
  const ad = adler32(raw);
  stream.push((ad >>> 24) & 0xff, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff);

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, width, false);
  idv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(stream)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** An 8×8 image whose texels come from a function of the texel coordinates. */
function image8(fn: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) rgba.set(fn(x, y), (y * 8 + x) * 4);
  }
  return encodePng(8, 8, rgba);
}

// ── The four maps ────────────────────────────────────────────────────

/** Base colour: a warm/cool check, so the UV mapping is legible in the frame. */
const BASE_COLOUR = image8((x, y) =>
  (((x >> 1) + (y >> 1)) % 2 === 0 ? [220, 200, 170, 255] : [90, 110, 150, 255]));

/**
 * Normal map: four quadrants tilted toward four different directions, steeply.
 *
 * Steep on purpose — a subtle map is indistinguishable from no map at golden
 * tolerance, and the scene's job is to prove the map ARRIVES and is oriented
 * correctly, not to look tasteful. Tangent space with +Y up (glTF's OpenGL
 * convention), so 128 is flat and each quadrant reads ±0.7 in x or y.
 */
const NORMAL_MAP = image8((x, y) => {
  const nx = x < 4 ? -0.7 : 0.7;
  const ny = y < 4 ? 0.7 : -0.7;
  const enc = (v: number): number => Math.round((v * 0.5 + 0.5) * 255);
  return [enc(nx), enc(ny), enc(Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))), 255];
});

/**
 * Metallic-roughness. glTF fixes the channels: G is roughness, B is metallic.
 * Roughness ramps left→right and metal switches at the halfway row, so one
 * frame carries both a smooth-to-rough gradient and a dielectric/metal split.
 * R is left at zero so a shader reading the wrong channel comes out obviously
 * wrong rather than plausibly wrong.
 */
const METALLIC_ROUGHNESS = image8((x, y) => [0, Math.round(20 + (x / 7) * 220), y < 4 ? 0 : 255, 255]);

/** Occlusion: R channel only, a dark band down the middle columns. */
const OCCLUSION = image8((x) => [x >= 3 && x <= 4 ? 40 : 255, 0, 0, 255]);

/** Emissive: one bright square and black elsewhere — a patch no light in the
 *  scene could produce, so its presence is unambiguous. */
const EMISSIVE = image8((x, y) => (x >= 5 && y >= 5 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

// ── The GLB ──────────────────────────────────────────────────────────

function pad4(n: number): number { return (4 - (n % 4)) % 4; }

/**
 * A 2×2 quad in glTF space, UV-mapped 0..1, whose material carries the map set.
 *
 * `withMaps: false` produces the SAME geometry and the SAME base colour with
 * every extra slot removed. That is the control the mapped frame is read
 * against, and it is also the scene that pins the other half of the contract:
 * a model without maps must keep taking the narrow `mesh3d-textured` pipeline.
 */
export function buildMappedModelGlb(withMaps: boolean): ArrayBuffer {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const images = withMaps
    ? [BASE_COLOUR, NORMAL_MAP, METALLIC_ROUGHNESS, OCCLUSION, EMISSIVE]
    : [BASE_COLOUR];

  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const blobs: Uint8Array[] = [];
  let cursor = 0;
  const push = (bytes: Uint8Array): number => {
    cursor += pad4(cursor);
    views.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.length });
    blobs.push(bytes);
    cursor += bytes.length;
    return views.length - 1;
  };
  const posView = push(new Uint8Array(positions.buffer.slice(0)));
  const nrmView = push(new Uint8Array(normals.buffer.slice(0)));
  const uvView = push(new Uint8Array(uvs.buffer.slice(0)));
  const idxView = push(new Uint8Array(indices.buffer.slice(0)));
  const imgViews = images.map((im) => push(im));

  const bin = new Uint8Array(cursor);
  views.forEach((v, i) => bin.set(blobs[i]!, v.byteOffset));

  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [
      { bufferView: posView, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: nrmView, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: uvView, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: idxView, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    images: imgViews.map((v) => ({ bufferView: v, mimeType: 'image/png' })),
    textures: images.map((_, i) => ({ source: i })),
    materials: [{
      name: withMaps ? 'mapped' : 'plain',
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0 },
        metallicFactor: 1,
        roughnessFactor: 1,
        ...(withMaps ? { metallicRoughnessTexture: { index: 2 } } : {}),
      },
      ...(withMaps
        ? {
            normalTexture: { index: 1, scale: 1 },
            occlusionTexture: { index: 3, strength: 1 },
            emissiveTexture: { index: 4 },
            emissiveFactor: [1, 0.4, 0.1],
          }
        : {}),
    }],
    meshes: [{
      name: 'panel',
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }],
    }],
    nodes: [{ name: 'panel', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = pad4(jsonBytes.length);
  const binPad = pad4(bin.length);
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  u8.set(jsonBytes, 20);
  // JSON pads with SPACES, BIN with zeros — the spec is explicit about both.
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20;
  const at = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(at, bin.length + binPad, true);
  dv.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
  u8.set(bin, at + 8);
  return out;
}
