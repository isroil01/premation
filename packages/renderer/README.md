# @motion/renderer — Rendering Engine

A framework-independent, backend-abstracted rendering engine for professional
motion graphics. **WebGPU** primary, **WebGL2** fallback, **Null** (headless) for
tests and server-side. No React, no DOM manipulation, no timeline/animation
logic — it renders a `FrameScene` and nothing else.

## Architecture

```
        Renderer  (public API, lifecycle, viewports)
           │  depends on ▼ (never imports a backend)
      RenderBackend  ── WebGPUBackend | WebGL2Backend | NullBackend
           ▲
   ResourceManager · ShaderCache · MaterialSystem · RenderGraph · QuadRenderer
```

- **Backend abstraction** (`gpu/RenderBackend.ts`): the single seam. Everything
  above it is GPU-API-agnostic; only the three backend files speak WebGPU/WebGL.
- **Render Graph** (`rendergraph/`): passes declare `reads`/`writes`/`after`;
  the graph topologically orders them, detects cycles, and allocates transient
  render targets. Adding a pass never touches the others.
- **Passes** (`rendergraph/passes/`): clear · background · shape · image · video
  · text · selection · overlay, plus mask/effect (offscreen targets, off by
  default). Each translates renderables into draw commands.
- **Command buffer + QuadRenderer** (`commands/`, `pipeline/`): passes emit
  `DrawItem`s; the executor batches consecutive same-pipeline items (one pipeline
  bind per batch) over a shared unit-quad vertex buffer.
- **ResourceManager** (`gpu/ResourceManager.ts`): dedups by key (no duplicate
  GPU allocations) and auto-disposes resources idle past a frame window (LRU).
- **Shaders / materials**: registry + content-hashed compile cache; materials
  bind a shader to fixed pipeline state and produce deduped pipelines.
- **Camera + Viewport**: 2D pan/zoom camera (view/projection matrices, screen↔
  world), viewports with grid/checkerboard/guides overlays and per-viewport
  cameras (multi-viewport ready).

## Public API

```ts
import { Renderer, NullBackend, buildFrameScene, Color } from '@motion/renderer';

const renderer = new Renderer({ backend: new NullBackend() }); // or WebGPU/WebGL2
await renderer.initialize({ canvas });

const viewport = renderer.createViewport({ width: 1280, height: 720 });
viewport.camera.zoomBy(1.25);

const scene = buildFrameScene(
  { id: 'main', size: { width: 1920, height: 1080 }, background: Color.black() },
  [{ id: 'box', kind: 'rect', x: 100, y: 100, width: 400, height: 300, color: Color.fromHex('#2b7eff') }],
  /* selection */ ['box'],
);

renderer.render(viewport, scene);           // one-shot frame
// or multi-viewport:
const frame = renderer.beginFrame();
renderer.renderViewport(viewA, scene, frame);
renderer.renderViewport(viewB, scene, frame);
renderer.endFrame();

renderer.resize(1920, 1080, devicePixelRatio);
renderer.dispose();
```

The renderer consumes a **`FrameScene`** (flat, paint-ordered renderables with
resolved world matrices). It never imports the scene graph, timeline, animation,
or React — an adapter (`integration/buildFrameScene.ts`) fills the DTO.

## Scripts

```
npm run typecheck   # tsc --noEmit
npm run test        # jest (headless, NullBackend)
```

48 unit tests cover math, resource management (dedup + GC), render graph
(ordering + cycle detection), shader cache, camera, viewport, command batching,
and the renderer lifecycle (init → render → resize → dispose, multi-viewport,
culling, pipeline sharing).
