# Motion Editor — Technical Architecture Document (TAD)

**Status:** Draft v1.0 · **Owner:** Architecture · **Audience:** Engine teams, platform, tooling, QA
**Classification:** Blueprint — normative for all engines

> This document defines the *complete* software architecture for an AI‑native motion
> design application (an After Effects / Blender / Rive / Resolve / Motion class tool).
> It is a **design** document: it specifies contracts, boundaries, data flows, and
> invariants. It intentionally contains **no implementation logic** — only interface
> shapes, data models, and rules that multiple engine teams implement independently.
>
> Where a subsystem already exists in the repository (kernel: `src/core/*`, shell:
> `src/layout/*`, stores: `src/stores/*`), this TAD is the **target** it converges to.

---

## Table of contents

1. Goals, non‑goals, and quality attributes
2. Architectural tenets
3. Layered architecture (the onion)
4. Dependency rules (normative)
5. Cross‑cutting foundations (Kernel contracts)
6. Engine catalog
   - 6.1 Platform / Kernel engines
   - 6.2 Document / Domain engines
   - 6.3 Media & I/O engines
   - 6.4 Rendering & presentation engines
   - 6.5 Shell / UI‑framework engines
   - 6.6 Extensibility
7. Scene Graph — deep dive
8. Data‑flow diagrams
9. Plugin system
10. Project format & serialization
11. Performance architecture
12. Threading & the worker model
13. Backend architecture
14. Security & sandboxing
15. Versioning, migration & compatibility
16. Testing & observability strategy
17. Glossary

---

## 1. Goals, non‑goals, and quality attributes

### 1.1 Product goals
- A **document‑centric**, non‑destructive motion design tool: scene graph + timeline + GPU compositing.
- **AI‑native**: an assistant can read the document, propose typed edits (Commands/Patches), and apply them reversibly — never by re‑authoring blobs.
- **10‑year maintainability**: engines are replaceable; the renderer can move from WebGL→WebGPU→native without touching the UI.
- **Extensible**: third parties ship Effects, Importers, Exporters, Panels, Tools, Generators, Commands without forking.

### 1.2 Non‑goals (v1)
- Real‑time multiplayer editing (designed *for* later, not shipped now).
- Native (non‑Electron) shell. The domain/render layers are shell‑agnostic to allow it later.

### 1.3 Quality attributes (ranked)
1. **Correctness & reversibility** — every mutation is a Command; every Command is undoable or explicitly not.
2. **Isolation** — a crashing plugin/effect/worker never takes down the document.
3. **Performance** — 60 fps interaction on 10k‑node scenes; render decoupled from React.
4. **Portability of the core** — domain & render have zero UI/React dependencies.
5. **Observability** — every engine is inspectable (logs, metrics, event trace).

---

## 2. Architectural tenets

- **T1 — One source of truth.** The *document* (Project + Scene Graph + Timeline) is authoritative. Everything else (render targets, caches, UI state) is derived and disposable.
- **T2 — Mutation only via Commands.** No engine mutates the document directly from an input handler. Input → Command → Document → Events → derived state. (Kernel already enforces this via `CommandSystem`.)
- **T3 — Communicate through interfaces & events, never concretions.** Engines depend on *contracts* resolved from the DI container, and observe each other via the typed Event Bus.
- **T4 — Dependencies point inward.** Outer rings (UI, plugins) depend on inner rings (domain, kernel). Never the reverse. Inner rings expose *ports*; outer rings provide *adapters*.
- **T5 — Rendering is a pure function of state.** `render(sceneSnapshot, camera, time) → framebuffer`. The renderer holds no document authority and no React reference.
- **T6 — Derived state is cache‑keyed & invalidatable.** Any computed artifact (world transforms, layout, GPU textures, waveforms) is keyed by inputs and can be dropped under memory pressure.
- **T7 — Everything is a plugin, eventually.** First‑party engines register through the same extension points third parties will use. Dogfood the plugin API.
- **T8 — Fail isolated, degrade gracefully.** WebGPU→WebGL fallback; worker crash → task retry; effect throw → node renders bypassed with a diagnostic, not an app crash.

---

## 3. Layered architecture (the onion)

```
                        ┌───────────────────────────────────────────────┐
                        │  L5  EXTENSIBILITY                             │
                        │      Plugin Engine · SDK · sandboxed runtimes  │
                        │  ┌─────────────────────────────────────────┐  │
                        │  │ L4  SHELL / UI FRAMEWORK (React side)    │  │
                        │  │     Workspace·Window·Docking·Panel·      │  │
                        │  │     Inspector·Theme·Shortcut             │  │
                        │  │  ┌───────────────────────────────────┐  │  │
                        │  │  │ L3 PRESENTATION-AGNOSTIC          │  │  │
                        │  │  │    Viewport·Rendering·Camera      │  │  │
                        │  │  │  ┌─────────────────────────────┐  │  │  │
                        │  │  │  │ L2 MEDIA & I/O              │  │  │  │
                        │  │  │  │   Import·Export·FileSystem· │  │  │  │
                        │  │  │  │   Asset·Audio               │  │  │  │
                        │  │  │  │  ┌───────────────────────┐  │  │  │  │
                        │  │  │  │  │ L1 DOCUMENT / DOMAIN │  │  │  │  │
                        │  │  │  │  │  Project·SceneGraph· │  │  │  │  │
                        │  │  │  │  │  Selection·Transform·│  │  │  │  │
                        │  │  │  │  │  Timeline·Animation· │  │  │  │  │
                        │  │  │  │  │  Effects·Undo/History│  │  │  │  │
                        │  │  │  │  │ ┌───────────────────┐│  │  │  │  │
                        │  │  │  │  │ │ L0 KERNEL/PLATFORM││  │  │  │  │
                        │  │  │  │  │ │  App·EventBus·    ││  │  │  │  │
                        │  │  │  │  │ │  Command·DI·Log·  ││  │  │  │  │
                        │  │  │  │  │ │  Error·Settings·  ││  │  │  │  │
                        │  │  │  │  │ │  Perf·Memory·     ││  │  │  │  │
                        │  │  │  │  │ │  Workers          ││  │  │  │  │
                        │  │  │  │  │ └───────────────────┘│  │  │  │  │
                        │  │  │  │  └───────────────────────┘  │  │  │  │
                        │  │  │  └─────────────────────────────┘  │  │  │
                        │  │  └───────────────────────────────────┘  │  │
                        │  └─────────────────────────────────────────┘  │
                        └───────────────────────────────────────────────┘
      Rule: an arrow of dependency may only point from an OUTER ring to an INNER ring.
```

- **L0 Kernel** — framework‑agnostic, no DOM assumptions beyond optional guards. Buildable/testable in Node.
- **L1 Document** — the model. Pure data + operations. No React, no GPU, no `window`.
- **L2 Media/IO** — bytes in/out. Talks to workers, FFmpeg, storage.
- **L3 Presentation‑agnostic** — turns document snapshots into pixels; still no React.
- **L4 Shell** — React binds *views* to L0–L3 through stores and ports.
- **L5 Extensibility** — everything registers here; sandboxed.

---

## 4. Dependency rules (normative)

These are **build‑enforced** (lint rules / import boundaries / package graph):

- **D1** No circular dependencies between engines. Cycles are broken by extracting a shared *contract* package or by inverting to an event.
- **D2** **Rendering must never import React** (or `react-dom`, or any UI store). It receives immutable snapshots + a canvas handle.
- **D3** **React must never import rendering internals.** The UI holds a `ViewportHandle` port, nothing else.
- **D4** **Timeline never touches the GPU.** Timeline produces *time*; Animation produces *values*; Scene Graph holds *state*; only Rendering touches the GPU.
- **D5** Domain (L1) imports only Kernel (L0) and shared contracts. It must compile without a browser.
- **D6** All inter‑engine calls go through **interfaces resolved from the DI container** or through the **Event Bus** — never through direct singleton reach‑ins across layers.
- **D7** Plugins depend only on the published **SDK contract package**, never on internal modules.

**Enforcement:** an `eslint` import‑boundary config + a `dependency-cruiser` graph gate in CI. Each engine is its own workspace package (`@me/engine-*`) with an explicit `dependencies` allow‑list.

---

## 5. Cross‑cutting foundations (Kernel contracts)

These four contracts are the spine every engine plugs into. (Kernel seeds already exist: `Application`, `EventBus`, `CommandSystem`, `ServiceContainer`.)

### 5.1 Service Container (Dependency Injection)
The composition root; engines are registered under **tokens** and resolved by contract.

```ts
type Token<T> = symbol & { __t?: T };            // typed token
interface ServiceContainer {
  register<T>(token: Token<T>, factory: (c: ServiceContainer) => T, opts?: { singleton?: boolean }): void;
  resolve<T>(token: Token<T>): T;
  tryResolve<T>(token: Token<T>): T | undefined;
  child(): ServiceContainer;                       // scoped containers (per‑document, per‑window)
}
```
- Engines never `new` each other. They declare dependencies as tokens.
- **Scoped containers**: one root container; a **per‑document** child owns document‑lifetime engines (Scene Graph, Timeline…); a **per‑window** child owns view engines.

### 5.2 Event Bus (typed pub/sub)
Synchronous, in‑process, strongly typed. The *only* many‑to‑many channel.

```ts
interface EventBus {
  on<E extends EventName>(e: E, l: (p: EventMap[E]) => void): Disposable;
  once<E extends EventName>(e: E, l: (p: EventMap[E]) => void): Disposable;
  emit<E extends EventName>(e: E, p: EventMap[E]): void;
}
```
- Events are **facts about the past** (`SelectionChanged`, `NodeAdded`, `TimeChanged`). Never commands.
- The global `EventMap` is **augmented** by each engine via TS declaration merging, so the bus stays typed as engines are added.
- Listeners are isolated: one throwing listener never breaks dispatch (already implemented).

### 5.3 Command System
The single sanctioned mutation path (tenet T2). Backed by the History Engine.

```ts
interface Command<A = unknown> {
  readonly id: CommandId;
  readonly label: string;
  readonly canExecute?: (ctx: CommandContext) => boolean;
  execute(ctx: CommandContext, args?: A): void | Promise<void>;
  undo?(ctx: CommandContext): void;   // present ⇒ recorded on history
  redo?(ctx: CommandContext): void;   // defaults to execute
  merge?(next: Command): Command | null; // coalesce (e.g., drag streams)
}
interface CommandSystem {
  register(cmd: Command): Disposable;
  execute(id: CommandId, args?: unknown): Promise<void>;
  executeByShortcut(chord: KeyChord): Promise<boolean>;
}
```
- **Args‑based commands** allow the AI and macros to invoke the same operations as the UI.
- `merge` enables **transaction coalescing** (a whole drag = one undo step).

### 5.4 Contracts package
A dependency‑free `@me/contracts` package holding shared types (`Id`, `Vec3`, `Transform`, `NodeType`, event names, DTOs, ports). It has **no runtime code**, breaking all would‑be cycles between engines.

---

## 6. Engine catalog

Each engine below follows a fixed template:
**Purpose · Layer/Deps · Responsibilities · Internal modules · Public API · Data models · Events (emit/listen) · Lifecycle · Communication · Extension points · Scalability.**

Interface sketches are **contracts**, not implementations.

---

### 6.1 Platform / Kernel engines (L0)

#### 6.1.1 Application Engine
- **Purpose:** Composition root & lifecycle owner. Boots the kernel, builds DI graph, orchestrates engine start/stop, owns global error/loading state.
- **Deps:** DI, Event Bus, Command, Logging, Error, Settings, Worker pool.
- **Responsibilities:** deterministic boot order; register core services; expose `getService`; graceful shutdown; multi‑document/multi‑window orchestration; recovery on fatal error.
- **Internal modules:** `Bootstrap`, `ServiceRegistrar`, `LifecyclePhases`, `EngineRegistry`, `CrashRecovery`.
- **Public API:**
  ```ts
  interface Application {
    boot(opts: BootOptions): Promise<void>;
    services: ServiceContainer;
    openDocument(ref: ProjectRef): Promise<DocumentSession>;
    closeDocument(id: DocId): Promise<void>;
    shutdown(): Promise<void>;
  }
  ```
- **Data models:** `BootOptions`, `EngineDescriptor { token, phase, deps }`, `DocumentSession { id, container }`.
- **Events:** emits `ApplicationReady`, `ApplicationShutdown`, `DocumentOpened/Closed`, `EngineReady/Error`.
- **Lifecycle:** phases `Kernel → Domain → Media → Render → Shell → Extensions`; each phase awaits the previous.
- **Communication:** everyone resolves through `services`; never the reverse.
- **Extension points:** `registerEngine(descriptor)`, boot hooks.
- **Scalability:** one Application → N `DocumentSession`s (each its own scoped container) → N windows. Enables MDI and, later, headless render farms reusing the same domain code.

#### 6.1.2 Event Bus — see §5.2. (Engine‑level notes) Adds a **dev event recorder** (ring buffer of last N events for time‑travel debugging) and **namespaced channels** so per‑document buses don't cross‑talk.

#### 6.1.3 Command Engine — see §5.3. Internal modules: `Registry`, `Dispatcher`, `ContextBuilder`, `ShortcutBridge`, `TransactionCoalescer`. Scalability: command *palette* + AI both drive the same registry; macros are serialized command lists.

#### 6.1.4 Undo/Redo Engine & 6.1.5 History Engine
- **Purpose:** History stores the *timeline of committed transactions*; Undo/Redo is the façade that walks it.
- **Distinction:** *Command* = how a change is made; *Transaction* = an atomic group of inverse patches; *History* = the ordered stack of transactions; *Undo/Redo* = navigation over it.
- **Internal modules:** `Transaction`, `PatchLog` (inverse ops), `HistoryStack`, `Checkpoint`, `Coalescer`, `Branching` (future non‑linear history).
- **Public API:**
  ```ts
  interface History {
    begin(label: string): Transaction;         // groups patches
    commit(t: Transaction): void; abort(t: Transaction): void;
    undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean;
    snapshot(): HistoryCursor;                  // for persistence
  }
  ```
- **Data model:** `Transaction { id, label, patches: Patch[], inverse: Patch[] }`, `Patch` = `{ op, path, value, prev }` (JSON‑Patch‑like, addressing the document).
- **Events:** `UndoStackChanged`, `TransactionCommitted`.
- **Communication:** all domain engines write through `History.begin/commit`; the renderer ignores history entirely (it just re‑renders on `NodeChanged`).
- **Scalability:** patch‑based history is O(edit) memory, supports **persistent undo across sessions**, and is the substrate for future **branching history** and **collaboration (CRDT/OT)**.

#### 6.1.6 Logging Engine
- **Purpose:** leveled, scoped, structured logging + ring buffer for a Log panel + export for bug reports. (Exists: `src/core/logging`.)
- **API:** `getLogger().scope(name).{debug|info|warn|error}(msg, data)`, `subscribe(sink)`, `history()`.
- **Events:** none on the bus (avoids feedback loops); exposes its own subscription.
- **Scalability:** pluggable sinks (console, file via FS engine, remote telemetry), sampling, redaction.

#### 6.1.7 Error Handling Engine
- **Purpose:** central error taxonomy, boundaries, and recovery policy.
- **Internal modules:** `ErrorTaxonomy` (`UserError | RecoverableError | FatalError`), `BoundaryRegistry`, `RecoveryPolicies`, `CrashReporter`.
- **API:** `report(err, context)`, `wrap(fn)`, `boundary(scope)`. React error boundaries and worker `onerror` funnel here.
- **Events:** `ErrorReported`, `FatalError`.
- **Scalability:** per‑engine circuit breakers; a failing Effects node is quarantined without killing the frame.

#### 6.1.8 Settings Engine & 6.1.9 Preference Engine
- **Settings** = low‑level, namespaced, persisted key/value with pluggable backend (localStorage / config file / DB). (Exists: `src/core/settings`.)
- **Preference** = *typed, user‑facing* preferences (theme, fps, snapping) built **on top of** Settings, with schema, defaults, and reactive UI binding.
- **Rule:** UI reads Preferences; engines read Settings. Preferences persist through Settings.
- **API:** `settings.get/set/observe`; `preferences.value<K>()`, `set<K>()`, `schema`.
- **Events:** `PreferenceChanged`, `SettingChanged`.
- **Scalability:** profiles, workspaces‑as‑presets, org‑level policy overrides, cloud sync.

#### 6.1.10 Theme Engine
- **Purpose:** single authority for light/dark/system, applies CSS variables/`data-theme`, reacts to OS. (Exists: `src/core/theme`.)
- **API:** `getMode()`, `setMode()`, `getResolvedTheme()`, `subscribe()`.
- **Events:** `ThemeChanged`.
- **Extension points:** plugin themes register token overrides; per‑panel theming.
- **Note:** CSS‑variable driven → no re‑render storm; renderer reads a *neutral* color config, not CSS.

#### 6.1.11 Shortcut Engine
- **Purpose:** maps key chords → command ids; context‑sensitive keymaps; conflict detection.
- **Internal modules:** `KeymapRegistry`, `ContextResolver` (which keymap is active given focus), `ChordMatcher`, `ConflictDetector`.
- **API:** `bind(chord, commandId, when?)`, `resolve(event) → commandId | null`.
- **Communication:** on match → `CommandSystem.execute`. Never mutates the document itself.
- **Scalability:** user‑editable keymaps, presets (AE/Blender/Figma emulation), plugin‑contributed bindings.

#### 6.1.12 Performance Engine
- **Purpose:** frame budget, metrics, and adaptive quality governor.
- **Internal modules:** `FrameScheduler` (rAF/idle), `Budgeter` (per‑frame ms budget by task class), `Profiler` (marks, GPU timings), `QualityGovernor` (drops preview resolution under load).
- **API:** `schedule(task, class)`, `mark(name)`, `measure()`, `subscribeStats()`.
- **Events:** `PerfStats`, `QualityChanged`.
- **Communication:** Rendering/Viewport request frames through it; it decides *when* and at *what fidelity*.
- **Scalability:** central place to add multi‑threaded render, GPU occupancy tuning, and telemetry‑driven auto‑tuning.

#### 6.1.13 Memory Manager
- **Purpose:** track and cap memory of *derived* resources; evict under pressure.
- **Internal modules:** `ResourceRegistry` (typed handles: GPU textures/buffers, decoded frames, waveforms, bitmap caches), `Budgets` (per pool), `EvictionPolicy` (LRU/priority), `PressureMonitor`.
- **API:**
  ```ts
  interface MemoryManager {
    track<T>(pool: PoolId, key: string, size: number, dispose: () => void): ResourceHandle<T>;
    touch(h: ResourceHandle): void; release(h: ResourceHandle): void;
    setBudget(pool: PoolId, bytes: number): void; pressure(): PressureLevel;
  }
  ```
- **Events:** `MemoryPressure`, `ResourceEvicted`.
- **Rule:** anything holding non‑trivial memory *must* register a disposer here (GPU, decoded media, caches).
- **Scalability:** the linchpin for large projects — enables streaming, tile caches, and safe headroom.

#### 6.1.14 Background Worker Engine
- **Purpose:** typed task pool over Web Workers (and, in Electron, `utilityProcess`/native addons).
- **Internal modules:** `WorkerPool`, `TaskQueue` (priorities), `RPCChannel` (typed request/response + transferables), `CancellationTokens`.
- **API:**
  ```ts
  interface WorkerEngine {
    run<I, O>(task: TaskName, input: I, opts?: { priority?: Prio; transfer?: Transferable[]; signal?: AbortSignal }): Promise<O>;
    stream<I, O>(task: TaskName, input: I): AsyncIterable<O>;
  }
  ```
- **Events:** `TaskStarted/Progress/Completed/Failed`.
- **Communication:** Import/Export/Effects/Audio/Asset offload here; results are transferables (no copies).
- **Scalability:** pool sizing by cores; sticky workers for warm caches (e.g., an FFmpeg‑wasm worker); native offload later.

---

### 6.2 Document / Domain engines (L1)

> These are pure model engines: **no React, no GPU, no `window`.** They must run headless.

#### 6.2.1 Project Engine
- **Purpose:** owns the *project* — the container of scenes, assets, fonts, settings, history, metadata. Lifecycle: new/open/save/close; dirty tracking; recent list.
- **Deps:** File System, Asset, Scene Graph, Timeline, History, Settings, Serializer.
- **Internal modules:** `ProjectModel`, `DocumentIO` (capture/restore ports), `Serializer` (see §10), `MigrationRunner`, `AutosaveController`, `RecentProjects`.
- **Public API:**
  ```ts
  interface ProjectEngine {
    newProject(name: string): ProjectRef;
    open(ref: ProjectRef): Promise<void>; save(): Promise<boolean>; saveAs(name: string): Promise<boolean>;
    close(): void; state(): { current: ProjectRef | null; dirty: boolean };
    setDocumentIO(io: ProjectDocumentIO): void;  // scene/timeline plug their capture/restore
  }
  ```
- **Data model:** see **§10 Project format**.
- **Events:** `ProjectLoaded/Saved/Unloaded/DirtyChanged`.
- **Lifecycle:** created per `DocumentSession`; owns the per‑document container's domain engines.
- **Communication:** decoupled from content via `ProjectDocumentIO` — scene/timeline register their (de)serializers. (Pattern already implemented in kernel.)
- **Extension points:** plugin data blocks stored under `namespaces` (see §10.4).
- **Scalability:** package format (folder or zipped) supports partial/streamed load, external references, and cloud round‑tripping.

#### 6.2.2 Scene Graph Engine — see the **deep dive in §7**.
Summary: authoritative tree of nodes with transforms, components, metadata; emits fine‑grained change events; serializes deterministically; versioned.

#### 6.2.3 Selection Engine
- **Purpose:** the set of currently selected node ids + selection semantics (primary, ranges, marquee results, multi‑type).
- **Deps:** Scene Graph (read), Event Bus.
- **API:** `set(ids)`, `add/remove/toggle(id)`, `clear()`, `primary()`, `contains(id)`, `query(predicate)`.
- **Data model:** `Selection { ids: Id[]; primary: Id | null; kind: 'node'|'keyframe'|'handle'|... }`.
- **Events:** `SelectionChanged`.
- **Communication:** Transform/Inspector/Viewport all read selection; none write the document through it.
- **Scalability:** typed selections (nodes vs keyframes vs mask points) via a discriminated union; selection *filters* & saved selections.

#### 6.2.4 Transform Engine
- **Purpose:** the math authority for spatial transforms and gizmo operations. Converts pointer deltas → transform Commands; computes world matrices.
- **Deps:** Scene Graph, Selection, Command, (Camera for screen↔world).
- **Internal modules:** `MatrixMath` (2D/3D affine, TRS, pivots), `WorldTransformResolver` (hierarchy composition, cached), `GizmoSolver` (translate/rotate/scale/skew constraints, snapping), `SpaceConversions`.
- **API:**
  ```ts
  interface TransformEngine {
    worldMatrix(nodeId: Id): Mat4;                 // cached, invalidated on change
    localToWorld(nodeId: Id, p: Vec3): Vec3;
    beginGizmo(op: GizmoOp, ids: Id[]): GizmoHandle; // streams into a coalesced Command
  }
  ```
- **Events:** consumes `NodeChanged`; the *result* of a gizmo is a Command → `NodeChanged`.
- **Rule (D4‑adjacent):** Transform computes matrices; it does **not** upload them to the GPU. Rendering reads `worldMatrix`.
- **Scalability:** dirty‑subtree invalidation; SIMD/wasm matrix kernels; constraint/rig system later.

#### 6.2.5 Timeline Engine
- **Purpose:** owns **time** — the playhead, playback transport, frame rate, ranges, markers, and the mapping from tracks↔scene nodes. It does **not** compute animated values (that's Animation) and **never** touches the GPU (D4).
- **Deps:** Scene Graph (track↔node mapping), Audio (sync), Command, Perf (clock).
- **Internal modules:** `Clock` (real‑time playback via wall‑clock delta), `Transport` (play/pause/loop/scrub), `TrackModel` (tracks, lanes, clips as *geometry*), `MarkerModel`, `TimeRuler`.
- **Public API:**
  ```ts
  interface TimelineEngine {
    time: number; duration: number; frameRate: number;
    play(): void; pause(): void; seek(t: number): void;
    setInOut(range: Range): void; addMarker(m: Marker): void;
    tracks(): ReadonlyArray<Track>;                 // derived from scene, for the UI
  }
  ```
- **Data model:** `Track { id, nodeId, kind, clips: Clip[], keyframeRefs }`, `Marker`, `Range`. Tracks are a **projection** of the scene graph (one per animatable node/layer).
- **Events:** `TimeChanged`, `PlayStateChanged`, `TimelineRangeChanged`.
- **Communication:** on each tick emits `TimeChanged`; Animation samples at that time and writes evaluated values into a *render snapshot* (not the authoring document — see §8.2).
- **Scalability:** nested compositions/pre‑comps (a track can reference a sub‑timeline), time‑remapping, multiple independent timelines per project.

#### 6.2.6 Animation Engine
- **Purpose:** the value authority — property tracks, keyframes, interpolation, easing, expressions, drivers. Given `(node, property, t)` it yields the animated value.
- **Deps:** Scene Graph, Timeline (time), Command (keyframe edits).
- **Internal modules:** `PropertyTrack`, `Keyframe`, `Interpolator` (linear/bezier/step/spring), `Easing`, `Sampler` (evaluate a track at t), `ExpressionVM` (sandboxed, later), `MotionPresets`.
- **Public API:**
  ```ts
  interface AnimationEngine {
    sample(nodeId: Id, prop: PropPath, t: number): PropertyValue;
    evaluateScene(t: number): SceneValueSnapshot;   // all animated props at t
    setKeyframe(nodeId: Id, prop: PropPath, t: number, v: PropertyValue): void; // → Command
    tracksFor(nodeId: Id): PropertyTrack[];
  }
  ```
- **Data model:** `PropertyTrack { nodeId, prop, keyframes: Keyframe[], extrapolation }`, `Keyframe { t, value, inHandle, outHandle, easing }`.
- **Events:** `AnimationChanged`, `KeyframeAdded/Removed`.
- **Communication:** consumes `TimeChanged`; produces a `SceneValueSnapshot` consumed by Rendering (§8.2). Keyframe edits are Commands → History.
- **Scalability:** the `Sampler` is the hot path — precompiled per‑track evaluators, cached segments, worker‑parallel evaluation for big scenes; expressions/rigs/physics as pluggable drivers.

#### 6.2.7 Effects Engine
- **Purpose:** the node‑graph of non‑destructive effects/filters attached to scene nodes (blur, color, distortion, generators, masks). Defines the **render graph** the Rendering engine executes.
- **Deps:** Scene Graph, Asset, Memory, Worker/Render (for evaluation), Plugin.
- **Internal modules:** `EffectRegistry` (declarations), `EffectStack` (per node, ordered), `RenderGraphCompiler` (effects → DAG of GPU passes), `ParameterSchema`, `CacheKeys`.
- **Public API (declaration is the extension point):**
  ```ts
  interface EffectDefinition {
    id: EffectId; name: string; category: string;
    params: ParamSchema;                 // typed, animatable
    // pure description of GPU passes; NO direct GPU calls here
    build(ctx: EffectBuildCtx): RenderPassSpec[];
  }
  ```
- **Data model:** `EffectInstance { defId, params: AnimatableParams, enabled }`, `RenderPassSpec { shaderRef, inputs, outputs, uniforms }`.
- **Events:** `EffectAdded/Removed/ParamChanged`.
- **Rule:** effects **describe** passes; only Rendering executes them. This keeps effects portable across WebGPU/WebGL/native.
- **Extension points:** third‑party effects register `EffectDefinition`s; shaders declared abstractly (WGSL + GLSL variants or a shader IR).
- **Scalability:** the render‑graph compiler enables pass fusion, caching, and GPU‑agnostic backends; CPU effects run in workers.

#### 6.2.8 Camera Engine
- **Purpose:** owns camera(s): view/projection, 2D pan/zoom and 3D orbit/dolly, DOF params. Provides screen↔world for Viewport/Transform.
- **Deps:** Scene Graph (a camera can be a node), Event Bus.
- **API:** `active(): Camera`, `viewMatrix()`, `projectionMatrix()`, `screenToWorld(p)`, `frame(bounds)`.
- **Data model:** `Camera { kind: '2d'|'3d', position, target, fov, zoom, near, far }`.
- **Events:** `CameraChanged`.
- **Rule:** Camera produces matrices (data). Rendering consumes them. Camera never renders.
- **Scalability:** multiple cameras, animated cameras (as scene nodes driven by Animation), camera rigs.

#### 6.2.9 Audio Engine
- **Purpose:** audio graph, playback synced to Timeline, waveform generation, mixing, effects sends.
- **Deps:** Asset (media), Timeline (sync), Worker (decode/waveform), Memory.
- **Internal modules:** `AudioGraph` (WebAudio), `Scheduler` (sample‑accurate sync to playhead), `WaveformService` (worker), `Mixer`.
- **API:** `attach(trackId, assetRef)`, `waveform(assetRef): Promise<Waveform>`, `setGain/pan`, `syncTo(timeline)`.
- **Events:** `AudioReady`, `WaveformComputed`.
- **Communication:** subscribes `TimeChanged/PlayStateChanged`; for export, renders offline to PCM for the muxer.
- **Scalability:** many tracks, real‑time effects, VST‑like plugin audio effects, surround.

#### 6.2.10 Asset Engine
- **Purpose:** catalog + lifecycle of media (images, video, audio, fonts, vectors, 3D, LUTs). Owns *references*, decoding, proxies, and caches — the bridge between raw bytes and the document.
- **Deps:** File System, Import, Worker, Memory, MinIO/backend (remote).
- **Internal modules:** `AssetCatalog` (id → descriptor), `Resolver` (ref → bytes/handle), `DecodePipeline` (workers), `ProxyGenerator` (low‑res previews), `Cache` (memory + disk), `FontManager`.
- **Public API:**
  ```ts
  interface AssetEngine {
    register(source: AssetSource): Promise<AssetRef>;
    resolve(ref: AssetRef, quality: 'proxy'|'full'): Promise<DecodedAsset>;
    metadata(ref: AssetRef): AssetMeta;
    release(ref: AssetRef): void;
  }
  ```
- **Data model:** `AssetDescriptor { id, kind, sourceUri, hash, meta, proxies[] }`. The *document* stores only `AssetRef` + hash, never bytes.
- **Events:** `AssetRegistered/Decoded/Evicted`.
- **Communication:** Rendering asks for decoded frames by ref+time+quality; Memory governs eviction.
- **Scalability:** content‑addressed store (dedupe by hash), streaming video via frame cache + proxies, remote assets over MinIO with local cache, background prefetch.

---

### 6.3 Media & I/O engines (L2)

#### 6.3.1 File System Engine
- **Purpose:** abstract, sandbox‑safe filesystem behind a port with swappable adapters (Electron native FS/dialogs, browser File System Access API, virtual/in‑memory, remote MinIO). (Seed exists: `src/core/files`.)
- **API:** `open/save dialogs`, `read/write/list/exists`, `watch(path)`, `chooseSavePath`.
- **Data model:** `FileHandle`, `StoredFile { path, name, bytes }`.
- **Events:** `FileChanged` (watch).
- **Rule:** no engine touches `fs`/`window` directly; they depend on this port. Electron privileged FS lives behind IPC in the main process.
- **Scalability:** transparent local↔cloud; project‑relative + content‑addressed paths.

#### 6.3.2 Import Engine
- **Purpose:** turn external formats (PNG/JPG/SVG/Lottie/AE/mp4/wav/glTF/…) into Assets and/or Scene fragments.
- **Deps:** File System, Asset, Worker, Scene Graph, Plugin.
- **Internal modules:** `ImporterRegistry`, `FormatSniffer`, `ImportPipeline` (decode → normalize → asset/scene), `ProgressReporter`.
- **Public API (importer is the extension point):**
  ```ts
  interface Importer {
    id: string; extensions: string[]; sniff(bytes: Uint8Array): number; // confidence
    import(input: ImportInput, ctx: ImportCtx): Promise<ImportResult>;   // → assets + scene fragment
  }
  ```
- **Events:** `ImportStarted/Progress/Completed/Failed`.
- **Scalability:** third‑party importers; heavy decode in workers; streaming import of large media.

#### 6.3.3 Export Engine
- **Purpose:** render + encode the document (or a range) to files (mp4/mov/webm/gif/png‑seq/image), driving FFmpeg for muxing/encoding.
- **Deps:** Rendering (offline), Audio (offline PCM), FFmpeg worker, File System, Worker, Perf.
- **Internal modules:** `ExporterRegistry`, `RenderJob` (frame pump, deterministic offline clock), `EncoderBridge` (FFmpeg wasm/native), `Muxer`, `JobQueue`, `PresetLibrary`.
- **Public API (exporter is the extension point):**
  ```ts
  interface Exporter {
    id: string; container: string;
    export(job: ExportJob, ctx: ExportCtx): AsyncIterable<ExportProgress>;
  }
  interface ExportEngine { enqueue(job: ExportJob): ExportTicket; cancel(t: ExportTicket): void; }
  ```
- **Data model:** `ExportJob { range, size, fps, codec, container, colorSpace, quality }`.
- **Events:** `ExportQueued/Progress/Completed/Failed`.
- **Rule:** export uses a **deterministic offline render path** (fixed timestep, full quality) — never the interactive preview path.
- **Scalability:** parallel frame render across workers; distributed render on backend farm (same domain code headless); background export queue.

---

### 6.4 Rendering & presentation engines (L3)

#### 6.4.1 Rendering Engine
- **Purpose:** turn `(SceneSnapshot, valueSnapshot, camera, time)` into pixels via a GPU backend. **The only engine that touches the GPU. Zero React. Zero document authority.** (Tenets T5, D2.)
- **Deps:** Effects (render‑graph specs), Camera (matrices), Asset (decoded inputs), Memory (GPU pools), Perf (scheduling).
- **Internal modules:**
  - `RenderBackend` interface with **`WebGPUBackend`** and **`WebGLBackend`** implementations (auto‑select + fallback).
  - `RenderGraphExecutor` — executes the DAG from Effects (passes, ping‑pong targets, fusion).
  - `SceneCompositor` — draws layers back‑to‑front with blend modes/opacity/masks.
  - `ResourceManager` — GPU textures/buffers/pipelines, registered with Memory Manager.
  - `ShaderLibrary` — WGSL + GLSL variants (or shader IR → per‑backend codegen).
  - `FrameGraph` — per‑frame pass scheduling, tiling for large canvases.
- **Public API (port the UI holds):**
  ```ts
  interface RenderBackend {
    readonly kind: 'webgpu' | 'webgl';
    init(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<void>;
    renderFrame(snapshot: RenderSnapshot): FrameResult;   // pure function of inputs
    readPixels(region?: Rect): Promise<ImageData>;         // for export/hit‑testing
    dispose(): void;
  }
  ```
- **Data model:** `RenderSnapshot { layers: RenderLayer[]; camera: CameraMatrices; targets: TargetSpec; colorSpace }`, `RenderLayer { worldMatrix, sourceRef, effects: RenderPassSpec[], blend, opacity, mask }`.
- **Events:** emits none on the document bus; reports via Perf (`FramePresented`, GPU timings).
- **Lifecycle:** created per viewport surface; re‑inits on backend loss (device lost → rebuild resources).
- **Communication:** receives immutable snapshots (produced by Viewport, §6.4.3). Never calls back into the document.
- **Scalability:** WebGPU compute for effects; tiled/streamed rendering for 8K+; multiple surfaces (viewport + thumbnails) sharing pipelines; native backend swap behind the same `RenderBackend` port.

#### 6.4.2 Camera Engine — see §6.2.8 (modeled in domain; the renderer consumes its matrices).

#### 6.4.3 Viewport Engine
- **Purpose:** the *bridge* between document and renderer for an interactive surface. Builds `RenderSnapshot`s, owns hit‑testing, gizmo overlays, guides/rulers/snapping, and translates raw pointer input into intents (which become Commands via Transform/Selection).
- **Deps:** Scene Graph, Selection, Transform, Camera, Animation (current values), Rendering, Perf.
- **Internal modules:** `SnapshotBuilder` (scene + values + camera → RenderSnapshot), `HitTester` (GPU id‑buffer or CPU bvh), `InteractionController` (tools → intents), `OverlayLayer` (gizmos/guides, drawn separately), `ViewportState` (zoom/pan/quality).
- **Public API (the React `ViewportHandle` port — the *only* thing UI holds, satisfying D3):**
  ```ts
  interface ViewportHandle {
    attach(canvas: HTMLCanvasElement): void; detach(): void;
    setTool(tool: ToolId): void; requestRedraw(): void;
    hitTest(screen: Vec2): Id | null;
  }
  ```
- **Events:** consumes `SelectionChanged/TimeChanged/NodeChanged/CameraChanged` → schedules a redraw through Perf.
- **Rule:** the Viewport builds snapshots and hands them to Rendering; React only holds `ViewportHandle`. This is the seam that keeps React and GPU apart.
- **Scalability:** multiple viewports, per‑viewport quality, split views, VR/preview surfaces.

---

### 6.5 Shell / UI‑framework engines (L4, React side)

> These live in the React world but stay **engine‑agnostic**: they know panels, docking, windows — not scene/render internals. They bind to domain engines through ports + Zustand stores. (Seeds exist: `src/layout/*`, `src/stores/*`.)

#### 6.5.1 Workspace Engine
- **Purpose:** named layouts of panels ("Animation", "Color", "Layout") — save/restore/switch; per‑workspace panel arrangement, visibility, sizes.
- **API:** `save(name)`, `apply(name)`, `list()`, `current()`.
- **Data model:** `Workspace { id, name, layout: DockLayout, panelState }`.
- **Events:** `WorkspaceChanged`.
- **Scalability:** shareable/exportable workspaces; role‑based defaults; plugin‑contributed workspaces.

#### 6.5.2 Window Engine
- **Purpose:** Electron window/`BrowserWindow` lifecycle: multi‑window, monitors, DPI, native menus, tear‑off panels → new windows.
- **API:** `create(opts)`, `focus(id)`, `close(id)`, `moveePanelToWindow(...)`.
- **Events:** `WindowOpened/Closed/Focused`.
- **Communication:** with Application for per‑window scoped containers; with Docking for tear‑offs.
- **Scalability:** presentation window, second‑monitor viewport, headless windows for render.

#### 6.5.3 Docking Engine
- **Purpose:** the resizable/dockable panel system — split panes, tabs, drag‑to‑dock, float, tear‑off. (Seed: `SplitPane`, layout stores.)
- **Internal modules:** `DockTree` (nested splits/tabsets), `DragController`, `Serializer` (layout persist), `Constraints` (min/max, collapse).
- **API:** `getLayout()`, `setLayout()`, `dock(panelId, target, region)`, `float(panelId)`.
- **Data model:** `DockLayout` (recursive splits + tabsets + sizes).
- **Events:** `LayoutChanged`, `PanelDocked/Undocked/Resized`.
- **Scalability:** cross‑window docking, layout presets, plugin panels dockable like native.

#### 6.5.4 Panel Engine
- **Purpose:** registry + host for panels (Scene, Assets, Timeline, Inspector, Effects, Log, plugin panels). Owns panel identity, placement region, lifecycle.
- **API:** `register(descriptor)`, `open/close/toggle(id)`, `renderers()`.
- **Data model:** `PanelDescriptor { id, title, icon, region, factory }`.
- **Events:** `PanelOpened/Closed/Focused`.
- **Extension points:** plugins contribute `PanelDescriptor`s; the shell renders them without knowing their content.
- **Scalability:** lazy panel mount, virtualization, panel‑level error boundaries.

#### 6.5.5 Inspector Engine
- **Purpose:** the property‑editing framework — given a selection, resolve which editors to show, bind them to node/component properties, and route edits to Commands. (Seed: `Inspector`, `PropertyRegistry`, `NodeInspector`.)
- **Internal modules:** `PropertyRegistry` (type/prop → editor), `EditorResolver`, `Binding` (value read + change → Command), `GroupModel` (sections), `MultiEditModel` (edit N nodes).
- **Public API (editor registration is the extension point):**
  ```ts
  interface PropertyEditor<T> { match: EditorMatch; render(ctx: EditorCtx<T>): UI; }
  interface InspectorEngine { registerEditor(e: PropertyEditor): Disposable; groupsFor(selection: Selection): InspectorGroup[]; }
  ```
- **Events:** consumes `SelectionChanged/NodeChanged`; edits emit Commands.
- **Rule:** the inspector never mutates nodes directly — it emits Commands (undoable) and reads *resolved* values.
- **Scalability:** animatable properties (keyframe toggles per row), expression binding UI, plugin editors, multi‑select.

#### 6.5.6 Shortcut Engine — see §6.1.11 (kernel; surfaced in shell via keymap UI).

#### 6.5.7 Theme Engine — see §6.1.10.

---

### 6.6 Extensibility (L5)

#### 6.6.1 Plugin Engine — see the **deep dive in §9**.

---

## 7. Scene Graph — deep dive

The Scene Graph is the **spine of the document**. All spatial/content state lives here; Timeline/Animation/Effects/Render are projections and consumers.

### 7.1 Nodes
A node is an identity + transform + component list + children. Behavior lives in **components**, not subclasses (composition over inheritance — the Blender/ECS lesson).

```ts
type NodeType = 'Group' | 'Shape' | 'Text' | 'Image' | 'Video' | 'Audio'
              | 'Camera' | 'Light' | 'Null' | 'Precomp' | string; // extensible

interface SceneNode {
  id: Id;                       // stable, deterministic (path‑hash for reproducibility)
  type: NodeType;
  name?: string;
  parent: Id | null;
  children: Id[];               // ordered (z‑order / render order)
  transform: Transform;         // local TRS + pivot + anchor
  components: Component[];       // renderable, behavioral, data
  visible: boolean; locked: boolean;
  metadata?: Record<string, Json>;   // namespaced (plugins, tooling)
}
```

### 7.2 Components
```ts
interface Component { id: Id; type: ComponentType; props: Record<string, AnimatableValue>; }
// e.g. Renderable(fill/stroke), TextContent, MediaSource, EffectStack, MaskSet,
//      Constraint, Expression, PluginData
```
- Components are **data**; engines interpret them (Rendering reads `Renderable`, Animation animates any `AnimatableValue`).
- Third parties add component types via the Plugin Engine.

### 7.3 Hierarchy, parent/child, transforms
- Strict tree (one parent). `children` order = render/z order.
- **Local transform** on each node; **world transform** computed by composing ancestors (Transform Engine, cached, dirty‑propagated down a subtree on change).
- Pivots/anchors separate rotation/scale origin from position (AE‑style).
- **Precomp** node references another scene/timeline → nesting & instancing.

### 7.4 Change model
- All mutations are **operations** producing fine‑grained events: `NodeAdded/Removed/Reparented/Reordered`, `TransformChanged`, `ComponentChanged`, `PropertyChanged`.
- Events carry the node id and a minimal diff so consumers invalidate precisely (renderer redraws only affected subtrees; Transform invalidates only descendant world matrices).
- The graph itself is **non‑reactive** (plain, fast); a **revision counter** / event stream drives UI recomputation (pattern already used: `sceneStore` revision).

### 7.5 Serialization
- Deterministic, stable ordering; ids are content/path‑derived so the same authoring produces the same file (clean diffs, reproducible tests). (Pattern exists: deterministic node ids.)
- Nodes serialize to a flat list (id‑keyed) + a root reference, avoiding deep nesting blowups and enabling partial load.
- Components serialize their own `props`; unknown component/plugin data is preserved verbatim (forward‑compat).

### 7.6 Versioning
- Every serialized graph carries a `schemaVersion`. A **MigrationRunner** applies ordered migrations `vN → vN+1`.
- **Additive‑first** rule: new fields are optional with defaults; removals are deprecations across ≥1 major version.
- Unknown fields are **retained** on load/save (never dropped) so older files edited by newer apps — and vice‑versa within a major — round‑trip.

### 7.7 Scalability
- Flat id‑map + subtree dirtying scales to 100k+ nodes.
- Spatial index (BVH/quadtree) for hit‑testing and culling, rebuilt incrementally.
- Virtualized layer tree in UI; lazy component hydration; precomps enable divide‑and‑conquer.

---

## 8. Data‑flow diagrams

### 8.1 Interaction → mutation → pixels (the input loop)
```
Pointer/Key (DOM)
   │  (Viewport.InteractionController / Shortcut Engine)
   ▼
Intent  ──►  Command (Command Engine)          ; T2: never mutate from the handler
   │
   ▼
History.begin ─► document mutation (Scene Graph / Animation / Transform)
   │
   ├─► Event Bus: NodeChanged / SelectionChanged / TransformChanged
   │        │
   │        ├─► Inspector (rebind property rows)      [React reads store]
   │        ├─► Timeline (retrack)                    [React reads store]
   │        └─► Viewport.SnapshotBuilder ──► RenderSnapshot
   │                                              │
   ▼                                              ▼
History.commit (undoable transaction)      Rendering.renderFrame(snapshot) ─► GPU ─► pixels
```
Key seams: **Command** (only mutation path), **Event Bus** (fan‑out), **RenderSnapshot** (immutable hand‑off to the GPU — no React, no document authority downstream).

### 8.2 Playback → animation → render (the time loop)
```
Timeline.Clock tick ─► emit TimeChanged{ t }
        │
        ▼
Animation.evaluateScene(t) ──► SceneValueSnapshot            ; pure sample, no mutation
        │   (reads keyframes + expressions; writes nothing to the authoring doc)
        ▼
Viewport.SnapshotBuilder(sceneGraph + valueSnapshot + camera(t))
        ▼
Effects → RenderPassSpec[]  (per layer)                      ; effects DESCRIBE, don't execute
        ▼
Rendering.RenderGraphExecutor  ──► GPU passes ──► composited frame
        ▼
Perf.FramePresented (metrics)     Audio.Scheduler plays synced PCM
```
Invariants: Timeline emits *time*, Animation emits *values into a snapshot* (authoring keyframes are untouched during playback), only Rendering touches the GPU (D4/D5).

### 8.3 Import → asset → document
```
File bytes ─► Import.FormatSniffer ─► Importer (worker) ─► { AssetRef(s) + Scene fragment }
   │                                                          │
   ▼                                                          ▼
Asset.register (content‑addressed, proxied)         Command: InsertSceneFragment ─► Scene Graph
```

### 8.4 Export (deterministic offline path)
```
ExportJob ─► RenderJob (fixed timestep loop)
   for each frame f in range:
      Animation.evaluateScene(f) ─► snapshot ─► Rendering.renderFrame(full quality) ─► pixels
      Audio.renderOffline(f) ─► PCM
   ─► FFmpeg (worker/native): encode + mux ─► File System
```

---

## 9. Plugin system

### 9.1 Principles
- Third parties extend via a **published SDK contract package** (`@me/sdk`) — never internal modules (D7).
- Plugins are **capability‑scoped** and **sandboxed** (see §14). A plugin declares what it contributes and what it may access.
- First‑party engines dogfood the same registration APIs (T7).

### 9.2 Contribution points
| Contribution | Registers | Runs where |
|---|---|---|
| **Effect** | `EffectDefinition` (declarative passes/shaders) | Render graph (GPU by host) |
| **Importer** | `Importer` | Worker (decode) |
| **Exporter** | `Exporter` | Worker + FFmpeg |
| **Generator** | source node/asset producer | Worker/host |
| **Panel** | `PanelDescriptor` (UI) | Sandboxed UI surface |
| **Tool** | `ToolDefinition` (viewport interaction → intents) | Host, via intents → Commands |
| **Command** | `Command` | Host command system |
| **Inspector editor** | `PropertyEditor` | Sandboxed UI |
| **Component/Node type** | schema + interpreters | Domain (data) + host renderer |

### 9.3 Manifest & lifecycle
```ts
interface PluginManifest {
  id: string; version: SemVer; apiVersion: SemVer;
  contributes: Contribution[];
  permissions: Permission[];        // 'read-document' | 'net' | 'fs:project' | 'gpu' | ...
  entry: { main?: string; worker?: string; ui?: string };
}
interface Plugin { activate(ctx: PluginContext): void | Promise<void>; deactivate?(): void; }
```
- **Lifecycle:** discover → validate manifest & apiVersion → grant/deny permissions → `activate(ctx)` (register contributions) → run isolated → `deactivate` (auto‑dispose all registrations).
- `PluginContext` exposes **narrow, versioned facades** (a document *read* API, a Command *dispatch* API, a UI surface) — not raw engines.

### 9.4 Isolation
- UI plugins render in an isolated surface (iframe/worker‑driven virtual DOM) — no direct access to the host DOM/stores.
- Compute plugins run in workers; effects are declarative (host executes GPU) so a plugin never touches the device directly unless granted `gpu`.
- All plugin mutations funnel through Commands → undoable, auditable, cancelable.

### 9.5 Versioning & marketplace
- `apiVersion` gates compatibility; the SDK is semver’d independently of the app.
- Signed packages, capability review, backend registry (NestJS + Postgres + MinIO for artifacts).

---

## 10. Project format & serialization

### 10.1 Package shape (folder or zipped `.meproj`)
```
project.meproj/
├── project.json            # manifest: version, metadata, settings, references
├── scenes/
│   ├── main.scene.json      # scene graph (flat node map + root)
│   └── intro.scene.json
├── timelines/
│   └── main.timeline.json   # tracks, keyframes, markers, ranges
├── assets/
│   ├── catalog.json         # AssetDescriptors (id, kind, hash, meta, proxies)
│   └── blobs/…              # content‑addressed (by hash) OR external refs
├── fonts/…
├── history/                 # optional persisted undo (patch log + checkpoints)
├── cache/                   # derived (proxies, waveforms, thumbnails) — regenerable
├── references.json          # external links (linked media, linked comps)
└── plugins/                 # namespaced plugin data blocks (preserved verbatim)
```

### 10.2 Manifest (`project.json`)
```ts
interface ProjectManifest {
  formatVersion: SemVer; app: { name; version };
  id: Id; name: string; createdAt; modifiedAt;
  settings: ProjectSettings;         // fps, resolution, color space, working space
  scenes: SceneRef[]; timelines: TimelineRef[];
  metadata: Record<string, Json>;
  references: ExternalRef[];          // linked assets/comps
  namespaces: Record<PluginId, Json>; // plugin‑owned data (opaque to host)
}
```

### 10.3 Principles
- **Text‑diffable** JSON for scene/timeline (deterministic key order) → clean VCS diffs, reproducible builds. Binary blobs are content‑addressed and separate.
- **Cache is disposable** and never required to open a project.
- **References over copies**: linked media stays external; `assets/blobs` holds only embedded/collected media.
- **Namespaces** let plugins persist data without host schema changes; host preserves unknown blocks.

### 10.4 Versioning & migration
- `formatVersion` + per‑file `schemaVersion`. A `MigrationRunner` applies ordered, tested migrations on open; save always writes current version.
- **Backward tolerance:** newer app opens older files (migrate up). **Forward tolerance:** newer files opened by an older app within the same major preserve unknown fields (no data loss), with a warning.

---

## 11. Performance architecture

| Concern | Strategy |
|---|---|
| **Caching** | Everything derived is cache‑keyed by inputs: world matrices (by node+ancestors rev), animated values (by track+t segment), effect outputs (by params+input hash), decoded frames (by asset+time+quality), waveforms, thumbnails. Caches register with the Memory Manager and are droppable. |
| **Virtualization** | Layer tree, timeline track rows, asset grids, and long lists are windowed (render only visible + overscan). Timeline lane content is width‑fitted, not fully materialized. |
| **Lazy loading** | Panels mount on demand; assets decode on first use (proxy first, full on demand); precomps load lazily; plugins activate on first contribution use. |
| **GPU resources** | Pooled textures/buffers/pipelines; ping‑pong targets reused across passes; render‑graph fusion reduces passes; device‑lost recovery rebuilds from the (authoritative) document. |
| **Memory pools** | Typed pools per resource class with budgets; LRU/priority eviction under `MemoryPressure`; decoded‑frame ring buffers for video. |
| **Background threads** | Decode, waveform, import, export‑encode, expensive CPU effects, and value evaluation for huge scenes run in the Worker Engine with transferables (zero‑copy). |
| **Task scheduling** | Perf Engine budgets each frame by task class (input > interactive render > preview refine > background). Non‑urgent work runs in idle time; adaptive quality drops preview resolution under load and refines when idle. |
| **Large projects** | Flat id‑maps + subtree dirtying; spatial index for cull/hit; streamed media via proxies; partial project load; content‑addressed dedupe; export scales across workers/backend farm reusing headless domain+render. |

**Golden rule:** the interactive path must never block on I/O or heavy compute — those are async/worker‑bound and reconciled via events.

---

## 12. Threading & the worker model

```
Main (Electron) process ── privileged FS / dialogs / native menus / GPU device owner
        │  IPC (typed)
Renderer process (React shell + domain engines + Viewport)
        │  postMessage (typed RPC, transferables)
Worker pool (Background Worker Engine)
        ├─ decode workers (image/video/audio)         ── sticky, warm caches
        ├─ ffmpeg worker (wasm) / native encoder       ── export/import
        ├─ effect/compute workers (CPU effects, geometry)
        └─ evaluation workers (animation sampling at scale)
```
- **Determinism:** offline render/export uses a fixed timestep and full‑quality path — independent of wall‑clock and dropped frames.
- **Cancellation:** every task takes an `AbortSignal`; scrubbing cancels stale decode/eval.
- **Backpressure:** queues are bounded; the governor sheds preview quality before it drops input responsiveness.

---

## 13. Backend architecture

The backend is **optional for local editing** and required for accounts, sync, collaboration, marketplace, and render farm.

- **NestJS** — modular services: `auth`, `projects`, `assets`, `plugins/registry`, `render-farm`, `billing`. Each maps to a bounded context; DTOs shared via a versioned contract package.
- **PostgreSQL** — projects metadata, users, plugin registry, render jobs, audit log. Documents stored as manifests + object references, not blobs.
- **MinIO (S3)** — content‑addressed asset & artifact store (dedupe by hash); presigned URLs; local cache mirrors it.
- **Docker** — every service containerized; render‑farm workers are the same headless domain+render code packaged as a job runner.
- **Sync model:** project package ⇄ backend via content‑addressed objects; only changed objects transfer. Designed to accept a **CRDT/OT** layer later (the patch‑based History Engine is the hook).
- **Render farm:** `ExportJob` → queue → worker containers render frame ranges in parallel → MinIO → mux → deliver. Reuses the interactive engines headlessly (no forked renderer).

---

## 14. Security & sandboxing

- **Process isolation:** Electron `contextIsolation` on, `nodeIntegration` off; privileged ops (FS, dialogs, network) only in main via a narrow, typed IPC surface.
- **Plugin capability model:** manifest‑declared permissions, user‑granted, enforced by the host. Default‑deny.
- **Plugin runtime isolation:** UI plugins in isolated surfaces; compute plugins in workers; declarative effects (no raw device). No plugin gets the raw document, stores, or DOM — only versioned facades.
- **Mutation auditing:** all document changes are Commands → logged, reversible, attributable (which plugin/user).
- **Supply chain:** signed plugins, registry review, SBOM; assets scanned; presigned, expiring URLs.
- **Injection safety:** importers treat file content as untrusted data; expression VM is sandboxed with no ambient authority.

---

## 15. Versioning, migration & compatibility

- **Three independent semvers:** app version, **project format** version, **plugin API** (`@me/sdk`) version.
- **Contracts are the compatibility boundary.** Engines may be rewritten freely as long as their published interface + events are honored; a major bump is a coordinated, documented event.
- **Migration is first‑class:** ordered, unit‑tested `vN→vN+1` migrations for the project format and scene schema; a golden‑file corpus in CI opens every historical version.
- **Deprecation policy:** additive‑first; removals span ≥1 major with warnings; unknown fields preserved.

---

## 16. Testing & observability strategy

- **Unit** — pure domain engines (Scene Graph ops, Animation sampler, Transform math, migrations) run headless in Node; deterministic ids make golden‑file tests trivial.
- **Contract tests** — every engine ships a conformance suite for its public interface; alternate implementations (e.g., WebGL vs WebGPU backend) run the same suite.
- **Snapshot render tests** — reference frames per effect/blend; perceptual diff in CI (headless GPU).
- **Interaction/E2E** — drive Commands (the same path the UI uses) and assert document + emitted events; the AI and macros are tested through the identical surface.
- **Observability** — Logging (scoped, ring buffer, exportable), Perf metrics (frame budget, GPU timings, memory pools), Event recorder (time‑travel debug), Error taxonomy with crash reports. Every engine is inspectable from a built‑in Diagnostics panel.

---

## 17. Glossary

- **Command** — an executable, (usually) undoable mutation; the only sanctioned way to change the document.
- **Transaction** — an atomic group of inverse patches recorded on History.
- **Snapshot** — an immutable, derived view handed across a boundary (RenderSnapshot, SceneValueSnapshot).
- **Component** — data attached to a node that engines interpret (renderable, media, effect stack…).
- **Precomp** — a node referencing another scene/timeline (nesting/instancing).
- **Port** — an interface an inner layer exposes for an outer layer to adapt to (e.g., `ViewportHandle`, `RenderBackend`).
- **Contribution** — a plugin‑registered extension (effect, panel, importer…).
- **Content‑addressed** — stored/keyed by hash of content (dedupe, integrity, cacheability).

---

### Appendix A — Engine ↔ layer ↔ key dependencies (matrix)

| Engine | Layer | Depends on (contracts) | Emits (key events) |
|---|---|---|---|
| Application | L0 | DI, all kernel | ApplicationReady, DocumentOpened |
| Event Bus | L0 | — | (transport) |
| Command | L0 | History, DI | (drives mutations) |
| Undo/History | L0 | Event Bus | UndoStackChanged |
| Logging | L0 | — | (own stream) |
| Error | L0 | Logging | ErrorReported, FatalError |
| Settings | L0 | FileSystem | SettingChanged |
| Preference | L0 | Settings | PreferenceChanged |
| Theme | L0 | Settings | ThemeChanged |
| Shortcut | L0 | Command | (→ commands) |
| Performance | L0 | — | PerfStats, QualityChanged |
| Memory | L0 | — | MemoryPressure |
| Worker | L0 | — | Task* |
| Project | L1 | FileSystem, Asset, SceneGraph, Timeline, History | Project* |
| Scene Graph | L1 | EventBus, Command | Node*, Transform*, Component* |
| Selection | L1 | SceneGraph | SelectionChanged |
| Transform | L1 | SceneGraph, Selection, Command, Camera | (→ NodeChanged) |
| Timeline | L1 | SceneGraph, Audio, Command | TimeChanged, PlayStateChanged |
| Animation | L1 | Timeline, SceneGraph, Command | AnimationChanged, Keyframe* |
| Effects | L1 | SceneGraph, Asset, Plugin | Effect* |
| Camera | L1 | SceneGraph | CameraChanged |
| Audio | L1 | Asset, Timeline, Worker | Audio*, WaveformComputed |
| Asset | L1/L2 | FileSystem, Import, Worker, Memory | Asset* |
| File System | L2 | (adapters) | FileChanged |
| Import | L2 | FileSystem, Asset, Worker, Plugin | Import* |
| Export | L2 | Rendering, Audio, FFmpeg, Worker | Export* |
| Rendering | L3 | Effects, Camera, Asset, Memory, Perf | (Perf metrics) |
| Viewport | L3 | SceneGraph, Selection, Transform, Camera, Animation, Rendering | (→ redraw) |
| Workspace/Window/Docking/Panel/Inspector | L4 | Panel/Docking ports, domain ports | Layout*, Panel* |
| Plugin | L5 | SDK facades over all above | Plugin* |

---

*End of document. This TAD is normative for engine boundaries, contracts, and data flow; implementation choices within an engine are the owning team’s discretion so long as its public interface, events, and dependency rules are honored.*
