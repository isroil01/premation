/**
 * The Electron half of `verify-plugin-effect.mjs`.
 *
 * Renders a plugin-shaped effect at several parameter values on a REAL WebGPU
 * adapter and prints the mean output for each, as one `RESULT:` line.
 *
 * ── Why it talks to WebGPU directly instead of driving the app ───────────────
 *
 * The question is narrow: does a parameter packed at the offset the host
 * generated arrive in the shader at the offset the shader declares? Driving the
 * whole editor to ask it would put the scene graph, the render graph, the
 * texture provider and the effect stack between the question and the answer —
 * so a failure would say "something in the renderer is wrong" rather than
 * "the uniform layout is wrong", which is the one thing being asked.
 *
 * The shader and the uniform block are BUILT THE SAME WAY the host builds them,
 * from the same rules, which is what makes the answer transferable. If those
 * rules change and this file does not, it stops testing the shipping layout —
 * so it derives the header size from the same arithmetic rather than hardcoding
 * 64 and hoping.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Dawn needs these; without them `navigator.gpu` is absent or yields no adapter
// and the probe reports a SKIP rather than a result.
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

const AMOUNTS = JSON.parse(process.argv[2] ?? '[0,0.5,1]');

/**
 * The probe runs in the page because that is where `navigator.gpu` lives.
 *
 * Serialised as a string rather than bundled: this file has no build step, and
 * a probe that needed one would be a probe nobody runs.
 */
const PAGE = `
async function run(amounts) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();

  // A WebGPU validation failure does not throw at the call site — it is
  // reported asynchronously, and the affected work simply does not happen. For
  // this probe that means a readback buffer full of zeros, which reads exactly
  // like "the shader returned black" and would be diagnosed as a shader bug.
  // Collected and raised instead, so the harness cannot misreport its own
  // mistakes as the feature failing.
  const gpuErrors = [];
  device.addEventListener('uncapturederror', (e) => gpuErrors.push(String(e.error.message)));

  /*
    64, not 16. \`copyTextureToBuffer\` requires \`bytesPerRow\` to be a multiple
    of 256, and at 16px wide a tightly packed row is 64 bytes — which fails
    validation, leaves the readback zeroed, and produces a flat-zero curve
    indistinguishable from a shader that never ran.
  */
  const W = 64, H = 64;

  /*
    The SAME struct the host generates: the renderer's mvp/uvRect header first,
    then the plugin's parameters. If this file and the host ever disagree about
    that, the probe stops measuring the shipping layout — which is why the
    header is spelled out here rather than assumed.
  */
  const shader = device.createShaderModule({ code: \`
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  amount : f32,
};
@group(0) @binding(0) var<uniform> params : Object;

struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  var o : VOut;
  o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = p[i] * 0.5 + vec2<f32>(0.5);
  return o;
}
// Stands in for the author's fragment: a constant input scaled by a parameter.
// A passthrough would return 1.0 regardless; a parameter at the wrong offset
// would return whatever the transform happens to hold.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 1.0) * params.amount;
}\` });

  const HEADER_FLOATS = 12 + 4;            // padded mat3 + vec4
  const SIZE = Math.ceil((HEADER_FLOATS + 1) * 4 / 16) * 16;
  const uniform = device.createBuffer({ size: SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const bgl = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module: shader, entryPoint: 'vs' },
    fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const bind = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: uniform } }] });

  const target = device.createTexture({
    size: [W, H], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const out = [];
  for (const amount of amounts) {
    const data = new Float32Array(SIZE / 4);
    // Identity mvp, padded per column exactly as std140 requires.
    data[0] = 1; data[5] = 1; data[10] = 1;
    // uvRect
    data[12] = 0; data[13] = 0; data[14] = 1; data[15] = 1;
    // The parameter, at the offset the generated struct puts it.
    data[HEADER_FLOATS] = amount;
    device.queue.writeBuffer(uniform, 0, data);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: target.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: W * 4 }, [W, H]);
    device.queue.submit([enc.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();

    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i];
    out.push(sum / (px.length / 4));
  }

  await device.queue.onSubmittedWorkDone();
  if (gpuErrors.length) throw new Error('WebGPU validation: ' + gpuErrors.join(' | '));
  return out;
}
`;

/**
 * The page this probe runs in, written to disk on the way past.
 *
 * MUST NOT be a `data:` URL. WebGPU is secure-context only, and a `data:` URL
 * is an opaque origin where `isSecureContext` is false — so `navigator.gpu` is
 * undefined there regardless of the hardware or the flags above. This probe
 * loaded one for months and reported "no WebGPU adapter on this machine",
 * which is the harness describing its own bug as the environment's limitation.
 * A `file://` origin is a secure context and sees the real adapter.
 */
const PAGE_PATH = path.join(os.tmpdir(), 'motion-plugin-effect-probe.html');

app.whenReady().then(async () => {
  fs.writeFileSync(PAGE_PATH, '<!doctype html><title>plugin effect probe</title>');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await win.loadFile(PAGE_PATH);
  try {
    const result = await win.webContents.executeJavaScript(
      `${PAGE}\nrun(${JSON.stringify(AMOUNTS)})`,
    );
    // Three outcomes, said out loud and distinctly. "No marker at all" used to
    // mean skip, which quietly swallowed every way this can genuinely break —
    // a thrown error, a crashed GPU process, a probe that never got started —
    // and reported all of them as a machine without an adapter, exit 0.
    if (result) console.log(`RESULT:${JSON.stringify(result)}`);
    else console.log('SKIP:navigator.gpu absent, or requestAdapter returned null');
  } catch (err) {
    console.log(`ERROR:${String((err && err.message) || err)}`);
  }
  app.quit();
});

app.on('window-all-closed', () => app.quit());
