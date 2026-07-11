# @motion/workspace

The framework-independent **Workspace Engine** — the interaction layer between
the user and the Scene Graph. It owns everything that happens inside the editor
viewport: camera, coordinate systems, tools, input, selection, hit-testing,
grid, guides, and snapping.

It is **not** rendering, **not** React, **not** animation, and **not** the Scene
Graph. It _coordinates_ those systems; it never draws and never mutates the graph
directly.

```
host events ─▶ InputSystem ─▶ ToolManager ─▶ tools ─▶ commands / camera
                                   │
   Workspace ◀── subsystems (camera, selection, guides…) ─▶ events + overlay
```

## Design

- **No DOM, no GPU, no React.** Pure TypeScript over plain value types
  (`Vec2`, `Mat2D`, `Rect`). Runs headless in Node (that's how it's tested).
- **Ports, not dependencies.** The engine talks to the rest of the app through
  four interfaces so it stays decoupled and unit-testable:
  - `SceneGraphPort` — read nodes (world bounds, matrices, z-order, locks).
  - `SelectionPort` — the app owns selection truth; the workspace drives it.
  - `CommandPort` — interactions become `WorkspaceCommand`s so the app owns
    undo/redo. The workspace submits; it never keeps history.
  - `RendererPort` — told _what_ to repaint (dirty regions + overlay), never
    _how_ the user interacts.
- **Renderer never handles input. Scene Graph never handles input. Workspace
  coordinates everything.**

## Subsystems

| Area | Module | Highlights |
| --- | --- | --- |
| Viewport | `viewport/Viewport` | CSS-pixel size, DPR/high-DPI, screen offset, visible region |
| Camera | `camera/Camera` | pan, zoom-to-cursor/fit/selection, world↔screen matrix, `visibleWorldRect` |
| Animated camera | `camera/CameraAnimator` | eased center + log-space zoom tweens, host-ticked |
| Coordinates | `coordinates/CoordinateSystem` | screen ⇄ viewport ⇄ world ⇄ parent ⇄ local |
| Grid | `grid/Grid` | infinite, adaptive 1-2-5 spacing, minor/major, fade |
| Guides | `guides/Guides` | H/V guides, locking, derived center + safe-area |
| Snapping | `snap/SnapEngine` | grid / guides / object edges·centers·corners, pixel threshold |
| Hit testing | `hit/SpatialIndex` + `hit/HitTester` | quadtree broad-phase (100k+), precise local test, z-priority |
| Selection | `selection/*` | single / multi / shift / marquee (contain vs crossing), handles |
| Cursor | `cursor/CursorManager` | base + transient override stack, CSS mapping |
| Input | `input/InputSystem` | pointer/pen/touch/wheel/keyboard, drag threshold, click/double-click |
| Tools | `tools/*` | pluggable state machines: select, move, hand, zoom, rect, ellipse, pen, text, camera |

## Public API

```ts
import { Workspace, MemoryScene, MemorySelection, RecordingCommandPort } from '@motion/workspace';

const ws = new Workspace({
  scene: new MemoryScene([...]),      // your SceneGraphPort
  selection: new MemorySelection(),   // your SelectionPort
  commands: new RecordingCommandPort(),
  viewport: { width: 1280, height: 800, dpr: window.devicePixelRatio },
});
ws.initialize();

// Drive it with normalized input (see input/normalize.ts for DOM helpers):
ws.feedPointerDown(evt); ws.feedPointerMove(evt); ws.feedPointerUp(evt);
ws.feedWheel(evt); ws.feedKeyDown(evt);

// Direct API:
ws.setTool('rectangle');
ws.zoom(1.25, { x: 640, y: 400 });
ws.zoomToSelection(64, 300);           // animated
const node = ws.hitTest(ws.screenToWorld({ x, y }));
ws.select('node-id');
ws.worldToScreen(pt); ws.screenToWorld(pt);
ws.reset();

// React to changes:
ws.events.on('ZoomChanged', ({ zoom }) => …);
ws.events.on('SelectionChanged', ({ selected }) => …);

// Feed the renderer:
renderer.draw(ws.overlay());           // selection, handles, marquee, snap lines, guides — screen space
```

## Events

`WorkspaceFocused`, `ViewportChanged`, `ZoomChanged`, `PanChanged`,
`CameraChanged`, `SelectionChanged`, `HoverChanged`, `ToolChanged`,
`CursorChanged`, `GuideAdded`, `GuideRemoved`, `GuideMoved`, `GridChanged`,
`MarqueeChanged`, `InteractionStarted`, `InteractionEnded`.

## Adding a tool

Implement `Tool` (all handlers optional) and register it — no core changes:

```ts
ws.registerTool({
  id: 'ai', label: 'AI', shortcut: 'k', cursor: 'crosshair',
  onClick(e, ctx) { ctx.execute(/* a WorkspaceCommand */); },
});
ws.setTool('ai');
```

## Tests

```
npm test            # from packages/workspace, or:
npx jest --config packages/workspace/jest.config.cjs
```

Covers math, camera, viewport, coordinate conversion, hit-testing (incl. 10k-node
broad-phase), grid, guides, snapping, selection/marquee/handles, and full
input-driven Workspace flows. 72 tests, headless (Node).
