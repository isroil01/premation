# Premation MCP — Claude controls the installed app

> **Approved and built, 2026-10-08** (branch `claude-mcp`). This plan
> corrects the original "Native MCP" brief against what the repository
> actually contains. §12 maps it to the code as built and lists what differs
> from the plan. User guide: `docs/CONNECT_CLAUDE.md`.

---

## 0. Goal

A motion designer who has **installed Premation** clicks *Settings → AI →
Claude → Connect*, opens Claude Desktop (or Claude Code), and asks Claude to
build or change their project. Claude's edits land in the open project live,
are undoable, and Claude can render frames to look at what it made and fix it.

Not a goal: a web or hosted MCP endpoint, a second editor implementation, or
any route that bypasses the C++ engine. ChatGPT (remote-only MCP) is out of
scope for v1.

## 1. What already exists (reused, not rebuilt)

| Need | Already in the repo |
|---|---|
| One source of truth | `premation-engine` (C++) owns the document; the page reads the mirror |
| Tool vocabulary | `packages/ai-tools` — 65 tools, one definition, `toMcpToolList()` in `src/emit/index.ts:48` |
| Tool execution | `src/core/ai/toolHandlers.ts` (`buildAiTools`), run by `runToolTurn()` in `src/core/ai/aiTurn.ts` — the same registry the in-app AgentLoop uses |
| Undo grouping | Engine `beginGesture`/`endGesture` (rollback on `commit=false`), `CommandBatch` (atomic, one undo entry) — `packages/engine-api/schema/20_session.eapi`, `10_envelope.eapi:54` |
| AI provenance | `Origin.ai` on every request (`00_core.eapi:248`); `aiTransaction.ts` labels turns `AI: …` |
| Concurrency guard | `Request.baseRevision` → engine replies `conflict` (`10_envelope.eapi:50`) |
| Eyes | `getThumbnail` query (encoded image, `80_queries.eapi:348`); `renderFeedback.ts` already uses it via `engineCompStill` |
| Headless tests | `premation-engine-headless`, `src/core/engine/__testHelpers__/appEngine.ts`, `*.native.test.ts` |
| Packaging | `electron-builder.yml` `extraResources` + `scripts/stageEngine.cjs` |

## 2. Decisions (corrections to the original brief)

**D1 — MCP reaches the engine through Electron main, never directly.**
The engine is a single-client stdio child of main (`electron/engineHost.ts:700`);
it has no socket and must not grow one (main's command log is what makes
crash-replay work). Route:

```
Claude ──stdio/MCP──▶ premation-mcp ──named pipe──▶ Electron main ──▶ page tool runtime ──▶ engine API ──▶ premation-engine
```

**D2 — Tool calls run in the page's existing tool runtime (MVP).**
Handlers depend on page stores and the document mirror, so main forwards each
MCP call to the focused project window, which executes it with the same
registry and `createToolContext` the in-app AI uses. One AI implementation,
two front doors (in-app chat, MCP). This calls tool functions, not UI.
*Later (§9):* make handlers engine-API-only so they also run in main/headless.

**D3 — Expose the existing vocabulary; do not invent a parallel one.**
The brief's `create_text_layer`/`set_position` list is replaced by the 65
existing tools (filtered to an allow-list, §5). No `premation_` prefix —
clients already namespace by server (`mcp__premation__…`). Author mode's
`author_scene` is added when it lands; it is the tool weaker callers need most.

**D4 — Undo boundaries are explicit, not guessed.** MCP has no "turn".
- Each mutating call = one `CommandBatch` / one gesture = one undo entry.
- `begin_edit(label)` / `end_edit(commit)` let Claude group a multi-step
  change into one entry (`AI (Claude): label`).
- An open group closes itself after 30 s idle or when the client disconnects.
- While a group is open, user edits from the UI are **not** absorbed: the UI
  edit first closes the AI group (commit), then applies as its own entry.
  Gestures do not nest, so this ordering is enforced in main.

**D5 — Revisions are checked where staleness matters, not on every call.**
Objects are addressed by stable id. `baseRevision` is sent only by
read-modify-write tools (e.g. replace keyframes, reorder). A `conflict`
returns a structured error telling Claude to re-read.

**D6 — Packaging: no new runtime, no new binary (if the fuse allows).**
Claude's config runs the installed Electron binary as Node:
`command = <Premation.exe>`, `args = [<resources>/mcp/premation-mcp.js]`,
`env = { ELECTRON_RUN_AS_NODE: "1" }`. The script bundles the official
`@modelcontextprotocol/sdk` (stdio). We set no Electron fuses today, so
`RunAsNode` is enabled. **If** we later disable that fuse for hardening, the
fallback is a ~200-line C++ byte pump (`premation-mcp.exe`) with the MCP
logic moved into main.

**D7 — Connecting Claude: official bundle first, JSON edit as fallback.**
Primary: generate a Claude Desktop extension bundle (`.mcpb`) and open it —
Claude shows its own consent screen and owns its config. Fallback (and for
older Claude Desktop): merge `mcpServers.premation` into
`claude_desktop_config.json` with backup, never touching other entries.
Claude Code: a copy button for `claude mcp add premation -- …`.
*Verify the current `.mcpb` manifest format before building D7.*

## 3. Components

### 3.1 `premation-mcp` (thin adapter, `electron/mcp/server.ts` → bundled `resources/mcp/premation-mcp.js`)
- MCP over stdio via the official SDK. `tools/list` comes from main (so the
  list reflects the running app's real capabilities and entitlements).
- Connects to main's pipe with the pairing token (§6). No business logic,
  no document state, no cache beyond the tool list.
- App not running → every tool returns *"Premation is not open. Open
  Premation and try again."* (Auto-launch: §9.)
- Logs to `<userData>/logs/mcp.log`, no project content.

### 3.2 Pipe server in main (`electron/mcpBridge.ts`, new)
- `net.createServer` on `\\.\pipe\premation-mcp-<user-sid>` /
  `<userData>/mcp.sock` (0600). One client at a time in v1.
- Verifies the token, records `clientInfo` from MCP `initialize` → this is
  what drives an honest **Connected** status in the UI.
- Owns the undo-group state machine of D4 and the idle timer.
- Routes `tools/call` to the target window over a new IPC pair
  (`mcp:call` / `mcp:result`), registered behind the existing `ipcGuard`.

### 3.3 Page side (`src/core/ai/mcpHost.ts`, new — no React)
- Receives `mcp:call`, runs it through `getAiRegistry().execute` with a
  `createToolContext` bound to the open gesture (pattern of `runToolTurn`).
- Normalises results/errors to §7's shape.
- A small store flag drives a "Claude is editing…" badge with **Stop**
  (aborts the context signal, ends the group with `commit=false`).

### 3.4 Settings → AI → Claude (`src/components/settings/ClaudeConnect*.tsx`)
States: *Not installed* → *Ready to connect* → *Configured* → *Connected
(Claude Desktop, 2 min ago)*; plus *Needs repair* (path invalid after update).
Buttons: Connect, Test connection, Disconnect, Repair, Diagnostics (no secrets).
Off by default; turning it on creates the token.

## 4. Target selection

Tools take an optional `project` id; default is the focused project window.
New tools: `list_open_projects`, `get_editor_context` (active comp, selection,
playhead — editor state, read-only, never written into the document).

## 5. Tool surface (v1 allow-list)

From the existing registry, filtered by `kind` and an explicit allow-list:
- **read:** project/comp/layer/keyframe/effect inspection tools, `get_editor_context`, `list_open_projects`
- **write/compose:** layer create/update/delete, transform, keyframes, effects
  (validated against the registry; unknown effect → list of real ones),
  3D/camera/light where the engine supports them
- **render:** `render_frame(comp, time, maxSize=1024)` → MCP image content
  from `getThumbnail`; `render_contact_sheet(comp, times[])` later
- **session:** `begin_edit`, `end_edit`, `undo_last_ai_edit`

Excluded: anything that runs code (expressions are document data and are
allowed; plugin install, shell, scripts are not), file export to arbitrary
paths, cloud/account tools. Media import accepts only paths under folders the
user granted in Settings. Paid capabilities go through the same entitlement
check as the in-app AI.

## 6. Security

- Off by default; local only; no TCP port.
- Pipe ACL / socket mode restricts to the current OS user; a random token in
  `<userData>/mcp.token` (0600) is required on connect, rotated on Disconnect.
- Allow-listed tools only (§5); all args validated by the existing
  `ai-tools` schemas before reaching the engine.
- Every write carries `Origin.ai` and the label `AI (Claude): …` in history.

## 7. Results and errors

Every call returns `{ ok, data?, error?: { code, message, hint, candidates? }, revision }`.
Example: `{ code: "layer_not_found", message: "Layer layer_123 no longer exists.",
candidates: [{id, name}…] }`. Engine `conflict` → `{ code: "stale", hint: "re-read" }`.
Unsupported features say so — no fake success.

## 8. Milestones (each a local commit; no push until told)

| # | Scope | Done when |
|---|---|---|
| M0 | Spike: Electron-as-Node stdio server talks to a stub pipe in main | Claude Desktop lists one `ping` tool on Windows + macOS |
| M1 | `mcpBridge` + `mcpHost`, read tools, `render_frame` | Claude summarises the open project and shows a frame |
| M2 | Write tools + `author_scene` + D4 undo groups + Stop badge + D8 gate | Logo-reveal workflow runs; one Ctrl+Z reverts a grouped edit; Free account is refused |
| M3 | Settings → Claude: detect, connect (`.mcpb` + JSON fallback), test, disconnect, repair, diagnostics, upgrade path | All config cases in §10 pass |
| M4 | Packaging in `electron-builder.yml` + stageEngine check; update-path repair; D9 uninstall macro | Fresh install → connect → works with no Node on the machine; uninstall leaves other servers intact |
| M5 | Docs: developer section in `AI_ARCHITECTURE_FULL.md`, user guide "Connect Claude to Premation" | — |

## 9. Later

- Auto-launch Premation from `premation-mcp` when it is not running.
- Engine-API-only handlers so tools run in main/headless (batch use without a window).
- Remote relay for ChatGPT/Gemini app via Premation Cloud (needs its own security review).

## 10. Tests

- **Adapter:** startup, initialize, tools/list, schema rejection, app-not-running message (jest, fake pipe).
- **Bridge:** token reject, reconnect, client disconnect closes group, idle timeout, UI edit closes AI group first.
- **Tools on the real engine:** `mcp.native.test.ts` on `appEngine` — create comp/layer, keyframes, effect (real + unknown), 3D, `render_frame` returns an image, grouped edit undoes in one step, `conflict` surfaces as `stale`.
- **Claude config:** not installed, no config, existing servers kept, malformed config untouched + manual path shown, duplicate entry, disconnect removes only ours, repair after path change, backup written.
- **Security:** no tool outside the allow-list is callable; import outside granted folders refused.

## 11. Owner answers (2026-10-08)

1. **Paid plan only** → D8.
2. **Order: build now.** Author mode is already past M3 (commits through M5),
   so `author_scene` (wrapping `@motion/author` compile) ships in M2, not later.
3. **Uninstall removes our Claude entry** → D9.

**D8 — Gating: Premation paid plan.** *Update 2026-10-08: switched OFF for now
(owner) — `CLAUDE_REQUIRES_PRO = false` in `src/core/ai/mcp/mcpAccess.ts`; any
signed-in account, Free included, may use Claude. Flip that constant to
restore everything below.* The gate reads the server's decision,
`CloudAccess.plan === 'pro'` (`src/core/api/client.ts:523`, cached by
`entitlementStore`); the client never computes entitlement itself.
- Checked when Settings → Claude connects, on every MCP `initialize`, and on
  each `entitlementStore` refresh. Not signed in / not paid → Connect shows
  the upgrade path (respecting `salesOpen`); a connected client gets every
  tool answering *"Claude for Premation needs a Premation Pro plan."*
- Plan lapses mid-session → the next call gets that answer; nothing already
  done is touched.
- Local (self-hosted) edition: no billing, `access` is null → unrestricted,
  the same rule every other gated feature follows.
- Honest limit: this is a client-side check of a server decision, like the
  rest of the editor's local features. When the plugin platform's
  engine-checked signed entitlement lands, MCP switches to it.

**D9 — Uninstall.**
- Windows: an NSIS `customUnInstall` macro (via `nsis.include` in
  `electron-builder.yml`) runs a small cleanup that removes only
  `mcpServers.premation` from Claude's config (backup first). If Claude was
  connected through the `.mcpb` bundle, Claude owns that entry; the cleanup
  removes the extension through the same config path where possible, else
  it shows as unavailable in Claude.
- macOS has no uninstaller (drag to Trash), so nothing can run at removal.
  Mitigation: Disconnect in Settings, and the entry points at a path that no
  longer exists, which Claude reports as a failed server rather than running
  anything.
- Auto-update is not an uninstall: the entry survives and is repaired (§3.4).

## 12. As built (2026-10-08)

| Piece | File |
|---|---|
| Tool surface (allow-list + MCP-only tools + server instructions) | `packages/ai-tools/src/mcp.ts` |
| MCP server (stdio, official SDK 1.30.1, bundled to one file) | `packages/mcp-server/src/server.ts`, `pipeClient.ts`; `scripts/buildMcp.cjs` → `build/mcp/premation-mcp.cjs` |
| Pipe server, token, relay to the page | `electron/mcp/bridge.ts` |
| Claude Desktop config: detect, merge, backup, remove | `electron/mcp/claudeConfig.ts` |
| Settings channels, launch spec, auto-repair at launch, uninstall cleanup | `electron/mcp/ipc.ts`; `electron/main.ts` (`--premation-mcp-uninstall`) |
| End-to-end self-test | `electron/mcp/selfTest.ts` |
| Page host: queue, undo groups, eyes, `author_scene`, gate | `src/core/ai/mcp/mcpHost.ts`, `mcpDefaults.ts`, `mcpAccess.ts` |
| Editor wiring + "Claude is editing" badge | `src/hooks/useMcpHost.ts`, `src/components/ClaudeActivityBadge.tsx`, `src/pages/EditorPage.tsx` |
| Settings → AI Engine → Claude for Premation | `src/layout/Settings/ClaudeConnectSection.tsx` |
| Packaging | `electron-builder.yml` / `.selfhosted.yml` extraResources `build/mcp → mcp`; `build/installer.nsh` (`customUnInstall`, skipped on update) |

`sessionToolContext` (src/core/ai/toolContext.ts) is new: a tool context that
keeps the run's style, scene window and the client's alias map across calls,
which an MCP client needs (it calls `define_style` once, then many tools).

### Developing with Claude connected

1. Add to `.env.local` (git-ignored), then restart `npm run electron:dev`:

   ```
   VITE_MCP_DEV_PLAN=pro    # use Claude without a paid account or a backend
   # VITE_MCP_DEV_PLAN=free # or: test the "needs Pro" refusal
   ```

   Read only when `import.meta.env.DEV` (`src/main.tsx`) and ignored again
   unless `isDevBuild()` (`src/core/ai/mcp/mcpAccess.ts`), so a production
   bundle never honours it. The Settings card says when it is in force.
2. `npm run electron:dev` already rebuilds the connector
   (`electron:compile` runs `scripts/buildMcp.cjs`); after changing
   `packages/mcp-server` alone, run `npm run mcp:build`.
3. Settings → AI Engine → Claude for Premation → Connect. A development build
   registers as **`premation-dev`** (launching `node_modules/electron` on
   `build/mcp/premation-mcp.cjs`, with the dev profile's pipe), beside — never
   over — an installed Premation's `premation` entry; Disconnect removes only
   `premation-dev`. Restart Claude Desktop to pick it up.
4. Claude Code instead: the card's *Turn on for Claude Code* + the copied
   `claude mcp add premation-dev …` command.

The pipe is keyed by the user-data folder, so the dev app and an installed app
never answer each other's calls.

### Differences from the plan

- **D7:** v1 connects Claude Desktop by editing `claude_desktop_config.json`
  (merge + backup, never a malformed file), not a `.mcpb` bundle — the edit is
  verifiable, repairable and removable on uninstall; `.mcpb` stays a later
  option once its manifest format is pinned. Both Claude data folders found on
  Windows (classic and Microsoft Store) are written.
- **§4:** no `list_open_projects` / `project` argument — the app has one editor
  window; calls go to the project open in it. `get_selection` already covers
  "the selected layer".
- **§5:** excluded in v1: `generate_image/video/speech/3d_model` (spend credit
  without the in-app cost prompt), `export_video` (writes files),
  `create_media_from_attachment` (needs an in-app attachment). `create_media`
  places only already-imported assets, so no folder grant was needed yet.
- **D4:** a group also closes when its client disconnects; the user-activity
  close runs on pointerdown/keydown (capture) through the call queue.

### Verified

- Unit + integration: `electron/mcp/claudeConfig.test.ts` (16),
  `electron/mcp/bridge.test.ts` (9 — real bundled server over stdio → pipe →
  bridge), `src/core/ai/mcp/mcpHost.test.ts` (10), `mcpAccess.test.ts` (4),
  `packages/ai-tools/src/mcp.test.ts` (5), `packages/mcp-server` (6).
- Real engine: `src/core/ai/mcp/mcpHost.native.test.ts` (8) — one undo entry per
  call / per group, rollback, user-activity commit, refusal, `author_scene`.
- Real app (isolated second instance, GPU engine): self-test all 5 steps green;
  a simulated Claude built a glowing title in one group ("Claude: title
  reveal", origin `ai`), `render_frame` / `render_filmstrip` returned the real
  frames, the badge showed and cleared on disconnect.
- Not yet done: a run with the real Claude Desktop app (needs the packaged or
  restarted dev app + a Pro account), a packaged installer build, macOS.

## 13. Round 2 (2026-10-08): extension, no-project, indicators, deeper tools

Owner asks: Premation's logo and the single name "Premation" in Claude;
smoother connect UX and live indicators; Claude can start with no project and
create one; deeper editing; files in/out with in-app approval.

- **Install route = Claude Desktop extension (`.mcpb`).** Claude shows a
  server's own logo only for an installed extension (a config-file entry gets
  a generic icon). Connect now writes `<userData>/mcp/Premation.mcpb`
  (`electron/mcp/extension.ts`: manifest 0.3, `name: premation`,
  `display_name: Premation`, `icon.png` = build/icon.png, `server.type: node`
  so Claude runs the bundled server with its own Node, `PREMATION_MCP_DIR`
  baked in) and opens it; Claude shows its install screen. Detection reads
  `<Claude data>/Claude Extensions/*/manifest.json`. Trade-off (accepted):
  removing the extension is done in Claude (Settings → Extensions); Disconnect
  turns Premation's side off and says so. The config-file route stays under
  Advanced. Dev and installed builds both register as `premation`.
- **Front desk** (`src/core/ai/mcp/frontDesk.ts`, mounted app-wide by
  `src/hooks/useMcpFrontDesk.ts`): `get_app_state`, `list_projects`,
  `create_project`, `open_project` work on any page; everything else goes to
  the editor host once a project is loaded (waiting for the RIGHT project),
  else a sentence telling Claude to create/open one. Cloud create shares
  `core/project/newProjectDocument.ts` with the Dashboard; local create runs
  the start screen's `project.new`.
- **New editor tools:** `list_compositions`, `create_composition`,
  `set_active_composition`, `save_project` (via `src/hooks/mcpEditorOps.ts`),
  `import_media` and `export_video` behind an in-app **Allow / Deny**
  (`claudeStore.requestApproval`, 2-minute timeout = deny).
- **MCP prompts** (`packages/mcp-server/src/prompts.ts`): Logo reveal, Kinetic
  typography, Product promo, Vertical social clip, Polish my animation.
- **Indicators:** `ClaudeIndicator` pill in the title bar on every page (Ready /
  Connected / Working / Needs you) with an activity panel (live step, approvals,
  recent steps, Stop, "Undo Claude's last change" — only when the newest history
  entry is Claude's), the editor badge names the step and carries approvals, and
  the Settings card is three live steps.
- **Fix found while testing:** the bridge marked the page gone on
  `did-start-loading`, which also fires for in-page (hash) navigation, so
  `create_project` from the home screen failed itself. Now
  `did-start-navigation` with `!isSameDocument`.
- Verified in an isolated real instance: from the login screen Claude created a
  1080×1920 project, built a grouped change, rendered; an import waited for a
  real click on Allow and placed the layer. Not verified: the extension install
  in Claude Desktop (needs the user's click), cloud-edition create/open.

## 14. Round 3 (2026-10-08): audio, and why output looked like AI slop

**Diagnosis.** Over MCP Claude got only primitives; every piece of Premation's
design machinery was unreachable (look packs, ~110 techniques, the caster with
~49 layout templates, the design/timing linters, the critique, the SFX library).

**New tools** (`src/core/ai/mcp/designTools.ts`, defs in `packages/ai-tools/src/mcp.ts`):
`get_design_guide`, `list_looks` / `apply_look`, `list_techniques` /
`apply_technique`, `cast_piece` (Claude is the caster's brief + pick hooks;
`menusOnly` returns the per-beat menus), `review_design` (verifyScene +
keyframe filmstrip + speed graphs + critique questions); audio: `list_sfx`,
`add_sfx`, `set_audio_levels`, `duck_audio`, and `generate_speech` behind
Allow (uses credit). Server instructions now lead with the design process.

**Quality bugs found by rendering cast output, and fixed (they hit the in-app
caster path too):**
- Type was web-sized: body 17px at 1080p → 10px labels, 72px "display".
  `baseSizeFor` is now 32px at 1080p (design-system/type.ts).
- Text collided (overline across headline): fixed row offsets assumed small
  type. New `resolveTextCollisions` pass (design-system/textCollisions.ts) in
  the caster after every layout, a test that NO template × look × variant
  produces colliding text, and real-height spacing in list.numbered_steps,
  ui.notification_stack, hero.vast_space, endcard.mark_and_line.
- The linter failed optical alignment at display sizes (OFF_GRID): it now
  accepts a text box offset by its first letter's optical overhang.
- `cast_piece` with no picks cast NO motion technique (the caster repairs a
  bad pick, never invents one) → everything was a bare fade. Missing picks now
  take the best-ranked entrance/kinetic technique per beat (camera/depth only
  when Claude chooses them — an auto camera move emptied whole beats).
  **Reversed 2026-10-13:** auto-picking the first menu entry made every cast
  with N beats the same N layouts and entrances whatever the brief said. A
  missing pick now returns the menus and builds nothing; Claude chooses per
  beat. The server instructions and `get_design_guide` lead with
  `author_scene` (Claude designs against the whole engine) and present looks,
  techniques and `cast_piece` as instruments, never the starting point. The
  in-app chat changed the same day: Author mode no longer falls back to the
  caster — a failed author run is an error the user sees — and the caster's
  default one-beat brief on a failed model call is gone (`coerceBrief` throws).
- Techniques move x/y as OFFSETS from rest; the keyframe tools take absolute
  positions; nothing converted → every cast entrance sent its text to y = 0.
  `absolutizePositions` (technique-library/emit.ts) in the caster and
  `apply_technique`.
- `fill: 'transparent'` is refused by update_layer and the refusal drops the
  whole update → the "rings" ornament rendered as a solid default-blue disc.
  Devices use `#00000000`; the linter no longer calls that pure black.
- The end card's "mark" was a solid accent square with a shadow (placeholder
  look): now a short accent rule above the type.

**Measured:** the same brief went from 12 verifier findings (all flat fades,
overlapping type, 10px labels, a blue square) to 2 minor ones, with real
entrances. Full suite green (16,213), lint 0 errors.

**Open (separate tasks):** engine stills render gradient backdrops washed out
vs the viewport (task "Fix washed-out gradients in engine stills"); a huge
layer blanks the whole frame (task from round 1). Quality is now "clean and
correct", not yet "award-winning": richer looks, imagery (imported media in
`cast_piece` beats), and stronger technique choice are the next levers.

## 15. Stream E (2026-11-02): subjects, tracking, transcription, assets, rigs

**Diagnosis.** The engine ran every analysis job the user has (object matte,
track motion / apply, transcribe…) and the model could reach none of them:
footage was only placeable, a person in a shot only cut out through
`place_behind_subject` with a point, rigs took one pin per call with no kinds,
and `apply_layer_style` knew two of ten styles. Audit: the job kinds in
`native/engine/src/jobs/job_kinds.hpp` against `packages/ai-tools`.

**New registry tools** (`packages/ai-tools/src/tools/media.ts`, handlers in
`src/core/ai/mediaTools.ts` — offered in-app and over MCP alike; every point on
footage is FOOTAGE px from the top-left, times are composition seconds):

| Tool | What it does |
|---|---|
| `find_subjects` | Find Objects: the model's candidates in a frame (index, bounds, area, seed). Nothing written. |
| `select_subject` | Points (labelled subject / not), a box or a candidate → one subject's soft matte on a frame (`runSubjectEdit`); a new subject per call unless `subject` names one; optional `name`. Returns id, coverage, bounds; over MCP a matte preview image. |
| `refine_subject` | Add / subtract points, brush strokes (paint or refine, radius), the subject's live edge (feather, choke, contrast, smooth, invert). |
| `follow_subject` | `propagateObjectMatte` through the work area / a range from the selected frame; a background job (`jobId`) or `wait: true`. |
| `apply_subject_style` | The Subjects panel's presets through `src/core/workspace/subjectPort.ts` (registered by `layout/Workspace/placeBehindSubjectCommand.ts`), plus `background_blur`, `remove_background` / `keep_background` (the Object Matte effect on / off). |
| `track_point` / `attach_to_track` | The one-click `trackMotion` job (autoFeature, both ways from the playhead) held per session as `track_N`; `trackApply` as follow / transform / createNull / stabilize / effectPoint. |
| `transcribe` | `transcribeCompositionDetailed`: cues + word timings (+ language); `createCaptions` replaces the comp's caption layers (`captionReplaceCommands`) in the call's undo step. Behind Allow over MCP (it sends audio to the user's provider). |
| `get_job_status` | The jobs this assistant started (`AI_JOBS`): progress, result, cancel. |
| `get_editor_context` | Comp, playhead, work area, selected layers / properties / keyframes, subjects in focus, active tool, running jobs. |
| `describe_asset` | Real metadata (engine item: size, duration, fps, codec, audio, alpha, bytes, layers using it); over MCP a contact sheet decoded by `engineFootageStill`. |

**Changed:** `render_frame` takes `compId`, `layerIds` (a solo: the live
document copied with those layers soloed and drawn by `renderDocumentStill`),
`region` / `zoom` (cropped page-side), `assetId` (a source frame). Overlays are
not drawn by the renderer (no engine flag): render_rig_view, inspect_layers and
the subject previews cover masks / pins / bounds. `create_puppet_rig`: pin
`kind` (position / advanced / bend / starch / overlap), `scale`, `overlap`,
`mesh` (density, expansion, mode, solver, maxRotationDeg, and for image
layers traceAccuracy 0–100 % / alphaThreshold 0–255 — stream C1's
`puppet/mesh/*` properties), `append`. `create_skeleton_rig`: `mesh`
(density, expansion, mode, traceAccuracy, alphaThreshold, preserveVolume =
dual-quaternion skinning).
`set_puppet_pin_keyframes`: many `pins` per call, per-key `easing` / `bezier`
and spatial `tangentIn` / `tangentOut` (AnimFacade.setPointsKeyframe `opts`).
`pose_skeleton`: rotation optional, per-key easing, `ikPoses` (goal, pole,
`ik` true/false or `ikBlend` 0..1 — ikMode.<bone> is now an FK→IK blend,
keyed with the pose's easing). `render_rig_view` reports the mesh settings and pin kinds; the
mesh and weights are not drawn (no mesh query). `apply_layer_style`: all ten
styles incl. glass (its own `glass.<field>` tracks in `patchLayerStyle`),
`enabled: false`, Global Light; the `glass` object also takes stream D's liquid
fields (surface edge|dome|luma|layer, thickness, ior, dispersion, caustic,
fresnel, bumpLayerId — written as `glass.<field>` tracks / style fields, so
they land once the engine exposes them). `add_effect` offers `goo` (liquid
merge); the author guide explains Source: Backdrop on refraction / glass /
displacement-map and goo for metaball merges. `update_layer`'s `ior` hint corrected (Fresnel
F0, not refraction); `backdropBlur` points at the glass style.
`list_capabilities { area: "media" }` lists the subject presets, tracking modes
and coordinates; `get_author_guide` and the server instructions carry the
footage workflow. The MCP server declares `resources`: `premation://asset/<id>`
from `list_assets`, read through `describe_asset`.

**Jobs inside a turn (live finding, skater clip):** the engine never applies a
finished job's edits while a gesture is open (session_jobs.cpp), so a job
started with `apply: true` from inside the AI turn's gesture waited for the
gesture the turn was waiting to close — `select_subject` never returned. The
media tools now start their jobs HELD (`apply: false`) and apply the result
through the turn's session (`applyJobResult` via `ctx.engine.apply`,
mediaTools.ts `turnApplier`): `runSubjectEdit` / `propagateObjectMatte` take
an `applyResult` option (rotoBrushTool.ts `JobApplyOptions`, the UI keeps the
default), track_point / attach_to_track do the same inline. follow_subject
left running (wait: false) keeps the engine's own apply, which lands when no
gesture is open (an open begin_edit group holds it until end_edit).

**Verified without an engine:** `packages/ai-tools/src/mcp.test.ts` (schemas,
coercion), `registry.test.ts` (85 tools), `packages/mcp-server/src/resources.test.ts`,
`src/core/ai/mediaTools.test.ts` (jobs, refusals), `src/core/ai/mcp/mcpHost.test.ts`
(render_frame options, previews, transcribe approval). Not verified: the jobs
on the real app engine (the headless engine runs none) — select / refine /
follow a subject on a clip, track + attach, transcribe + captions, the solo and
asset stills; after `npm run mcp:build` the announced list must show 85 + the
MCP-only tools.
