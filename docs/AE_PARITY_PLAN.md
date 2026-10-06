# AE parity program (decided 2026-10-06)

Owner request (2026-10-06): bring 3D, object/person editing inside video,
tracking, image editing, layer editing and plugin distribution up to After
Effects 26.x level. Execute the steps **in order, one at a time**, and commit
each step separately. Line numbers below are from the audit at `d81a99bf`.
Re-check them before editing.

Architecture rules from `CLAUDE.md` still apply:
- The C++ engine is the only engine. UI writes go through engine commands.
- Golden render tests gate any shader, snapshot or pass change.
- Files are CRLF.

## Owner decisions

- **Plugins are free only for now**, like the old JS registry. There is no
  price, licence key or payout.
- **The publisher controls visibility, public or private, per plugin.** A
  private plugin installs only for its publisher's account. The backend
  already has `visibility` on `Plugin` (`motion-back/prisma/schema.prisma`
  ~1223); reuse it.
- **Plugins run locally** in `premation-engine`, never on a cloud GPU.
- AI models (video segmentation, face landmarks) are downloaded on first use
  into userData, with a progress UI. They are not shipped in the installer.
- **Substance `.sbsar` is deferred.** It needs Adobe's Substance engine
  licence. Everything else in step 4 goes ahead.
- **Open owner/legal item, not blocking:** the repo is AGPL-3.0 and the SDK
  headers carry no plugin exception.

## Step 1: fix what is broken

1. **Roto propagation zigzag.**
   - Cause: `native/engine/src/jobs/roto_matte.cpp` `matte_to_path` collects
     boundary pixels in scanline order.
   - Fix: walk the contour with `sam::matte_contour`.
   - Also make apply replace the previous "Roto Brush" mask instead of adding
     a duplicate (`kind_roto_brush.cpp:87-110`).
   - Propagate from the SAM matte and every stroke, not only the first
     foreground point (`kind_roto_brush.cpp:171-180`, `rotoBrushTool.ts:191`).
   - Add a test with a real shape (a disc or an L shape) that asserts the path
     is simple, with no self-intersection.
2. **Missing-plugin data loss.**
   - Where: `src/core/project/removedPluginContent.ts`.
   - Keep any namespaced effect type that is unknown, and show a notice like
     "Missing plugin X". Never delete it.
   - Render a missing effect as a pass-through and record it on `layerErrors`.
3. **3D corner radius.**
   - Cause: `snapshot_build.cpp:1654-1658` stores `cornerRadiusScale` from the
     projected `sx/sy` (`threed_port.cpp:547-548`).
   - For 3D layers, use the layer's own scale, not the projected one.
   - Make the extruded front quad and the walls (`extrusion_mesh.cpp:455-465`)
     agree.
   - Keep per-corner radii in the face-plane fallback (`threed_port.cpp:1198`).
4. **Alpha in 3D.**
   - Transparent pixels write depth (`solid3d.wgsl`, `textured3d.wgsl`,
     `materials.json`): add an alpha discard.
   - Shadow and SSAO casters use full quads (`shadow-depth.wgsl`,
     `threed.cpp:480-506,574-598`): sample alpha.
5. **Gizmo on parented layers.**
   - `useGizmo3d.ts:169-205,483-502` and `viewGeometry.ts:180-186`.
   - Place the gizmo at the world position and invert the parent matrix
     before writing local props, as cameras and lights already do.
   - Include Orientation in the local basis (`gizmo3d.ts:189-205`).
6. **Fake tracker quality badge.**
   - `autoTrackCommand.ts:113` hard-codes `distinctness: 1`.
   - Compute it in the engine, or remove the badge until step 3 restores the
     feature picker.
7. **Variable mask feather is ignored** by `raster/mask_paint.cpp:119-123`.
   Render it.
8. **Dead links and stale text.**
   - The viewport right-click "Track Motion…" and "Stabilize…" point to a
     Properties section that doesn't exist (`useWorkspaceContextMenu.ts:194-219`).
     Open the Tracker panel instead.
   - Remove the stale "needs WebCodecs" gate (`TrackMotionSection.tsx:153`).
   - Fix the stale GrabCut and registerSamOnnxSession text
     (`trackMotionActions.ts:486`, `AdvancedTracking.tsx:201`,
     `trackMotionCopy.ts:46`).
9. **SAM model setting is ignored.**
   - `encoderModel:''` is passed at `trackMotionActions.ts:511`,
     `rotoBrushTool.ts:160` and `objectMask.ts:59`.
   - Remove the unused onnxruntime-web SAM boot (`main.tsx:66-95`).
10. **Stale docs.**
    - `docs/PLUGIN_SDK.md:198-202`
    - `docs/ENGINE_API.md:475`
    - `docs/ONE_CLICK_TRACKING.md`
    - `docs/3d-layer-model.md`
    - `docs/CAMERA_SYSTEM.md` §8.2
    - `docs/AE_COMPARISON.md` (Keylight, variable feather, mesh materials)
    - `ROADMAP.md:218-220`

## Step 2: native plugin store (free, public or private)

Editor (`isroil01/premation`) and backend (`isroil01/motion-back`, branch `dev`).

1. **Manifest arch keys.**
   - Accept `windows-x64`, `macos-arm64`, `macos-x64` and `macos-universal`
     keys alongside `windows` and `macos`.
   - Files: `native/engine/src/plugins/manifest.cpp:65-71`, `module_ffi.cpp`.
2. **Tooling.**
   - Port `scripts/pack-plugin.mjs` and `sign-plugin.mjs` from `1b645a4e^`.
     Pack a `premation-plugin.json` bundle and sign the manifest plus the
     per-platform SHA-256 hashes.
   - Add an SDK release artifact: headers, a CMake package, and the
     `premation-plugins` tool (`native/sdk/CMakeLists.txt` install/export,
     `.github/workflows/release.yml`).
   - Add a plugin-author CI template in `examples/` and document it in
     `docs/PLUGIN_SDK.md`.
3. **Backend ingest.**
   - A second reader for `premation-plugin.json` in `plugin-package.ts`.
   - New `PluginVersion` fields: kind `native`, sdk version, and per-platform
     artifacts with hashes.
   - Store bytes in object storage rather than Postgres `packageBytes`, and
     raise the size limits for native packages.
   - A review policy for native binaries in `plugin-scan.ts`, and a verified
     publisher required to make anything public.
   - Keep the existing review queue, revocation list and publisher keys.
4. **Visibility.**
   - The publisher toggles public or private on the listing.
   - Private means only the owner can browse, download or install it.
   - Enforce it in `plugins.service.ts` browse, detail and download.
5. **Editor: browse, detail and install.**
   - Restore and adapt `PluginsList`, `PluginDetailTab`, `installFromRegistry`
     and `publisher/*` from `1b645a4e^`.
   - Add the API methods to `src/core/api/client.ts` and add their routes to
     `backendRoutes.test.ts`.
6. **Electron main: install.**
   - Download, then verify the registry signature and the SHA-256.
   - Stage under `<userData>/native-plugins/<id>` with an atomic swap.
   - Handle macOS quarantine.
   - Owner: `electron/ipc/nativePlugins.ts` (prior art in the deleted
     `nativeInstall.ts` / `nativeTrust.ts`).
7. **Load without a restart.** Add a `rescanPlugins` engine command
   (`70_jobs.eapi`, `PluginHost::scan`).
8. **Enable, disable, update, uninstall.**
   - Persist enabled/disabled and apply it at engine start (`engineHost.ts`).
   - Updates go through `POST /plugins/updates`.
   - Uninstall is a remove-on-next-start queue, because Windows locks a loaded
     DLL.
9. **Use plugin effects.**
   - The Effects panel and the Add menu merge `listEffects`
     (`src/layout/Effects/effectCatalog.ts`).
   - `effectDefFor` covers plugin effects.
   - `EffectStack.tsx` builds cards from `EffectInfo.params`, plus
     `getEffectUi` and `invokeEffectAction`.
10. **Export with plugins.**
    - Start a plugin host in the export job (`export/export_job.cpp:333-343`).
    - Pass `--plugins` from `electron/exportProcess.ts` and from the CLI.
    - The cloud worker keeps refusing plugin effects for now, with a clear
      message.
11. **Revocation.** Check the signed list at engine start and refuse revoked
    plugins.

## Step 3: objects and people in video

1. **Object Matte (AE 26.2 class).**
   - Click or marquee a subject, and it is tracked through the shot by a
     video segmentation model with memory (SAM2-class) through ONNX Runtime
     with a GPU execution provider.
   - Propagate forward, backward, or both. Correction strokes work on any
     frame. Add it to the toolbar.
2. **Soft alpha mattes.**
   - Store a per-frame alpha matte, the way Content-Aware Fill frames are
     stored, instead of a path of at most 48/128 points.
   - Add Refine Edge (hair), decontaminate colours and matte motion blur.
   - Add Refine Soft Matte and Refine Hard Matte effects.
3. **Face tracking.** Outline and detailed features, with a landmark model.
   Writes masks and nulls. New `kind_face_track.cpp`.
4. **Planar tracker (Mocha class).** Region homography, both directions,
   exclusion masks, surface adjust.
5. **3D camera tracker.**
   - Automatic feature detection and focal length solve.
   - 3D track points in the viewer, plus target and ground-plane selection.
   - Create Text, Solid, Null and Shadow Catcher.
6. **Tracker workflow.**
   - Track backward, both ways, or one frame. Per-frame correction.
   - Tracker data saved on the layer (a document group).
   - A confidence graph, an attach point, and a full-resolution option.
   - Apply to any effect point. Rotation/scale stabilize.
   - Warp Stabilizer smoothness, method and framing modes.
   - Restore one-click feature picking: Shi-Tomasi, distinctness, measured
     windows and a companion point.
7. **Content-Aware Fill.**
   - Multi-scale PatchMatch and Bézier holes.
   - Object, Surface and Edge Blend modes, reference frames and lighting
     correction.
   - Any range, and its own panel.
8. **Discoverability.**
   - Animation menu items: Track Motion, Stabilize, Warp Stabilizer, Track
     Camera, Face Track, Content-Aware Fill.
   - A Track Motion section in Properties.

## Step 4: 3D

1. **Styles and effects on every kind of 3D geometry** (extrusions,
   primitives, glTF). Today they are dropped at `threed_port.cpp:815-830`,
   `1331-1337` and `1370-1376`.
2. **Keep layers 3D** under motion blur, advanced blend modes, mattes and
   glass. Today they are pushed off the depth path (`threed.cpp:398-408`,
   `threed_frame.cpp:95-129`).
3. **Shadows.**
   - Floors receive shadows.
   - More shadow-mapped lights, at float depth.
   - Casters drawn across runs.
   - Environment-light shadows.
4. **Environment.**
   - Real HDRI image-based lighting (float, higher resolution, prefiltered),
     that doesn't use up light slots.
   - A visible sky.
   - Animated environment from a comp or video layer (AE 26.2).
5. **Material parity on meshes.** Transparency, IOR, reflection and Phong
   metal (`mesh_shade`, `threed_port.cpp:737-753`). A default light rig when
   the comp has none.
6. **Gizmo rewrite.**
   - One gizmo for several layers, and trackball rotation.
   - Axis-projected scale and per-axis scale in Universal mode.
   - Hotkeys (W/E/R style), typed values while dragging, increment snapping
     and pivot editing.
   - Depth-aware and silhouette picking.
   - A bigger view cube that can be dragged to orbit and has all six faces.
7. **Model import.**
   - glTF with Draco, meshopt and KTX2, alphaMode, vertex colours and
     KHR_materials.
   - OBJ, FBX and USD.
   - Models stored as project assets, not data URLs.
8. **Fog/atmosphere and layer-to-layer reflections.**

## Step 5: image and layer editing

1. **Colour.**
   - Full Lumetri: colour wheels, curves, Hue-vs curves, HSL secondary and
     vignette.
   - Per-channel Levels, and Hue/Saturation with channel ranges and Colorize.
2. **Keying.**
   - Full Keylight, with view modes, screen pre-blur, clip rollback and
     inside/outside masks.
   - Advanced Spill Suppressor, Key Cleaner, and Remove Grain/denoise.
3. **Precision.** Move the about 120 CPU 8-bit kernels to GPU float
   (`kernel_dispatch.cpp:12-30`). Keying, warps and Corner Pin come first.
4. **Masks.**
   - A Masks section in Properties, moving `MaskCard` out of `EffectsPanel`.
   - Layer ▸ Mask menu items.
   - Smart Mask Interpolation.
   - Whole-mask tracking modes.
5. **Deformation.**
   - Puppet on video layers (`layerKinds.ts:84`).
   - A brush-based Liquify, Mesh Warp with variable rows and columns, and
     Reshape.
6. **Crop control.** Paint and Puppet surfaced in Properties.

## Verification per step

- `npm run lint` (warning budget) and `tsc`.
- The touched jest suites, plus the `*.native.test` suites against
  `premation-engine-headless`.
- The native unit tests for the touched libraries.
- The golden render tests for any shader or pass change.
- The backend `npm test` for step 2.
- Cloud sessions have no GPU: run what can run headless, and list what needs
  the Windows GPU machine in `docs/VERIFY_ON_TEST_MACHINE.md`.
