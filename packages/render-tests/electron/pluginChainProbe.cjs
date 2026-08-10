/**
 * The Electron half of `verify-plugin-chain.mjs`.
 *
 * Runs the sample plugin's REAL composed passes over a synthetic source on a
 * real WebGPU adapter, ping-ponging between two targets exactly as
 * `runEffectsChain` does, and reports a profile of the image after each stage.
 *
 * The shaders are read from JSON produced by `emitChainShaders.mjs` — they are
 * the app's own output, not a copy. See that file for why.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

const SHADERS = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

/*
  The page. Note carefully: this whole string is a template literal, and the
  shader sources are interpolated into it as JSON — never as nested template
  literals. A backtick anywhere inside would end this string early and turn the
  rest of the file into syntax errors, which is a mistake already made twice in
  this directory's sibling probe.
*/
const PAGE = `
async function run(spec) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();

  const gpuErrors = [];
  device.addEventListener('uncapturederror', (e) => gpuErrors.push(String(e.error && e.error.message)));

  // 256-byte row alignment for copyTextureToBuffer; 64 px * 4 B = 256 exactly.
  const W = 64, H = 64;
  const RADIUS = 6;

  function makeTarget() {
    return device.createTexture({
      size: [W, H], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  /*
    The source: a small bright SQUARE at the centre.

    ── Why not a column, which was the first attempt ──────────────────────────

    A full-height column is INVARIANT under a vertical blur: every neighbour in
    Y is identical, and with clamp-to-edge sampling there is no black beyond the
    top and bottom rows to pull in either. So the vertical pass runs, does
    exactly what it should, and changes not one byte — and a probe measuring
    only brightness reports "the second pass never ran". That is a false
    accusation against correct code, which is worse than no probe.

    A square has edges in BOTH axes, so each pass leaves a signature on its own
    axis and nothing else. Written by rendering rather than by uploading, so it
    lives in a real render target with the same format and sampling behaviour
    as the ping-pong ones.
  */
  const seed = device.createShaderModule({ code: [
    'struct V { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };',
    '@vertex fn vs(@builtin(vertex_index) i : u32) -> V {',
    '  var p = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));',
    '  var o : V; o.pos = vec4<f32>(p[i], 0.0, 1.0); o.uv = p[i] * 0.5 + vec2<f32>(0.5); return o;',
    '}',
    '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {',
    '  let x = i32(uv.x * ' + W + '.0);',
    '  let y = i32(uv.y * ' + H + '.0);',
    '  let inX = x >= ' + ((W >> 1) - 2) + ' && x < ' + ((W >> 1) + 2) + ';',
    '  let inY = y >= ' + ((H >> 1) - 2) + ' && y < ' + ((H >> 1) + 2) + ';',
    '  let on = select(0.0, 1.0, inX && inY);',
    '  return vec4<f32>(on, on, on, 1.0);',
    '}',
  ].join('\\n') });

  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });

  const readback = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  async function readTexture(tex) {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: readback, bytesPerRow: W * 4 }, [W, H]);
    device.queue.submit([enc.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return px;
  }

  /**
   * How wide the light is along each axis, and how bright overall.
   *
   * spreadX and spreadY are the whole discrimination. A horizontal pass widens
   * X and leaves Y untouched; a vertical pass does the reverse. Any other
   * combination — neither growing, both growing on one draw, X growing twice —
   * names a specific wiring failure. See the assertions in the .mjs half.
   *
   * Counted against 5% of the peak so the measure is relative: an 8-bit target
   * quantises a Gaussian tail to zero, and an absolute threshold would call
   * that a narrower blur rather than a dimmer one.
   *
   * (No backticks in any comment inside this template literal. One would end
   * the page string here. The warning above this constant did not stop me
   * doing it once already.)
   */
  function profileSized(px, w, h) {
    const colSum = new Array(w).fill(0);
    const rowSum = new Array(h).fill(0);
    let total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = px[(y * w + x) * 4];
        colSum[x] += v; rowSum[y] += v; total += v;
      }
    }
    const countAbove = (arr) => {
      const peak = Math.max.apply(null, arr);
      return peak <= 0 ? 0 : arr.filter((c) => c > peak * 0.05).length;
    };
    return {
      spreadX: countAbove(colSum),
      spreadY: countAbove(rowSum),
      mean: total / (w * h),
    };
  }

  const profile = (px) => profileSized(px, W, H);

  /*
    The unit quad the generated vertex stage expects.

    The host's composed vertex shader reads @location(0) pos : vec2<f32> and
    transforms it by params.mvp — it does NOT synthesise its vertices from
    vertex_index. That is a real property of the shader being tested, so the
    probe supplies the same vertex buffer the renderer's quad service does
    rather than editing the shader to suit itself.
  */
  const quad = new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]);
  const quadBuf = device.createBuffer({
    size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(quadBuf, 0, quad);

  function pipelineFor(code) {
    const module = device.createShaderModule({ code });
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    return {
      bgl,
      pipeline: device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: {
          module, entryPoint: 'vs',
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
        },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      }),
    };
  }

  /**
   * The uniform block, written the way the RENDERER writes it.
   *
   * mvp identity, uvRect full, then the host pass block at float 16 — texelSize
   * from the real target size, passScale 1, passIndex per pass — then the
   * plugin's parameters at their declared offsets. If the app's packer and this
   * disagree the probe fails, which is the point.
   */
  function uniformsFor(passIndex, byteSize, params) {
    const data = new Float32Array(Math.max(byteSize, 128) / 4);
    /*
      mvp maps the UNIT QUAD to clip space: scale 2, translate -1. The
      generated vertex stage computes params.mvp * vec3(pos, 1), and pos
      arrives in [0,1] — an identity matrix would put the whole quad in the
      top-right quadrant and the readback would be three-quarters black.

      Column-major with each column padded to a vec4, which is what std140
      does to a mat3x3 and the reason the header is 48 bytes and not 36.
    */
    data[0] = 2; data[1] = 0; data[2] = 0;   // col 0
    data[4] = 0; data[5] = 2; data[6] = 0;   // col 1
    data[8] = -1; data[9] = -1; data[10] = 1; // col 2
    // uvRect: the whole texture. uv = uvRect.xy + pos * uvRect.zw = pos.
    data[12] = 0; data[13] = 0; data[14] = 1; data[15] = 1;
    data[16] = 1 / W; data[17] = 1 / H;
    data[18] = 1;
    data[19] = passIndex;
    for (const p of params) {
      if (p.name === 'radius') data[p.offset / 4] = RADIUS;
    }
    return data;
  }

  function draw(pipe, srcTex, destTex, uniformData) {
    const ubo = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(ubo, 0, uniformData);
    const bind = device.createBindGroup({
      layout: pipe.bgl,
      entries: [
        { binding: 0, resource: { buffer: ubo } },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: sampler },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: destTex.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipe.pipeline);
    pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, quadBuf);
    pass.draw(6);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  // --- seed the source -----------------------------------------------------
  const a = makeTarget(), b = makeTarget(), c = makeTarget();
  const seedPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: seed, entryPoint: 'vs' },
    fragment: { module: seed, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  {
    const enc = device.createCommandEncoder();
    const p = enc.beginRenderPass({
      colorAttachments: [{ view: a.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    p.setPipeline(seedPipe); p.draw(3); p.end();
    device.queue.submit([enc.finish()]);
  }

  const stages = [];
  stages.push(Object.assign({ name: 'source' }, profile(await readTexture(a))));

  /*
    Ping-pong, exactly as runEffectsChain does: each pass reads the current
    texture and writes a free one, and the written one becomes current.
  */
  const pipes = spec.passes.map((p) => pipelineFor(p.wgsl));
  let cur = a;
  const spare = [b, c];
  for (let i = 0; i < spec.passes.length; i++) {
    const dest = spare[i % 2];
    draw(pipes[i], cur, dest, uniformsFor(i, spec.uniformBytes, spec.params));
    cur = dest;
    stages.push(Object.assign(
      { name: 'after ' + spec.passes[i].name },
      profile(await readTexture(cur)),
    ));
  }

  /*
    ── The downsampled run ────────────────────────────────────────────────────

    The same two shaders again, into QUARTER-size targets, with texelSize taken
    from those targets rather than from the viewport. That one substitution is
    the whole of AE-1, and it is the one that fails silently.

    Why comparing composition-space width discriminates it: a pass at scale s
    steps i/(W*s) in UV, which is i/s pixels of the ORIGINAL image. Same tap
    count, wider reach — that is precisely why downsampling makes a big blur
    affordable. So a correct quarter-scale blur is several times wider in
    composition space than the same shader at full scale.

    If texelSize were wrongly the viewport's (1/W) while rendering into a W/4
    target, each tap would step a quarter of a target texel, and the result in
    composition space would come out the SAME width as the full-scale run —
    the downsample buying nothing but blockiness. Equal widths is the failure;
    a large ratio is the pass.
  */
  const QS = 4;
  const qw = Math.max(1, Math.floor(W / QS));
  const qh = Math.max(1, Math.floor(H / QS));
  const makeSmall = () => device.createTexture({
    size: [qw, qh], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  });
  const qa = makeSmall(), qb = makeSmall();
  const smallReadback = device.createBuffer({
    // 256-byte row alignment: a 16px row is 64 bytes, so pad the copy stride.
    size: 256 * qh, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  function uniformsScaled(passIndex) {
    const data = uniformsFor(passIndex, spec.uniformBytes, spec.params);
    // The substitution under test: texel size from the SCALED target.
    data[16] = 1 / qw; data[17] = 1 / qh;
    data[18] = 1 / QS;
    return data;
  }

  let qcur = cur;
  for (let i = 0; i < spec.passes.length; i++) {
    const dest = i % 2 === 0 ? qa : qb;
    // Pass 0 reads the FULL-size source, exactly as the chain does when the
    // first scaled pass follows a full-scale one — the downsample happens by
    // drawing a full-screen quad into a smaller target.
    draw(pipes[i], i === 0 ? a : qcur, dest, uniformsScaled(i));
    qcur = dest;
  }

  const encQ = device.createCommandEncoder();
  encQ.copyTextureToBuffer({ texture: qcur }, { buffer: smallReadback, bytesPerRow: 256 }, [qw, qh]);
  device.queue.submit([encQ.finish()]);
  await smallReadback.mapAsync(GPUMapMode.READ);
  const qpx = new Uint8Array(smallReadback.getMappedRange().slice(0));
  smallReadback.unmap();

  // Row stride is the padded 256, not qw*4.
  const packed = new Uint8Array(qw * qh * 4);
  for (let y = 0; y < qh; y++) packed.set(qpx.subarray(y * 256, y * 256 + qw * 4), y * qw * 4);
  const qprof = profileSized(packed, qw, qh);

  await device.queue.onSubmittedWorkDone();
  if (gpuErrors.length) throw new Error('WebGPU validation: ' + gpuErrors.join(' | '));
  return {
    stages,
    scaled: {
      targetWidth: qw,
      spreadXTexels: qprof.spreadX,
      // Back into composition pixels, which is where the two runs compare.
      spreadXComp: qprof.spreadX * QS,
    },
  };
}
`;

const PAGE_PATH = path.join(os.tmpdir(), 'motion-plugin-chain-probe.html');

app.whenReady().then(async () => {
  fs.writeFileSync(PAGE_PATH, '<!doctype html><title>plugin chain probe</title>');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await win.loadFile(PAGE_PATH);
  try {
    const result = await win.webContents.executeJavaScript(
      `${PAGE}\nrun(${JSON.stringify(SHADERS)})`,
    );
    if (result) console.log(`RESULT:${JSON.stringify(result)}`);
    else console.log('SKIP:navigator.gpu absent, or requestAdapter returned null');
  } catch (err) {
    console.log(`ERROR:${String((err && err.message) || err)}`);
  }
  app.quit();
});

app.on('window-all-closed', () => app.quit());
