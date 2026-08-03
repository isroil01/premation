# Editor Wiring Audit — buttons and features that are not wired, not finished, or not working

**Date:** 2026-08-03
**Branch:** `dev` (working tree carries the in-flight chrome-consistency pass)
**Scope:** the editor pages only — `src/App.tsx`, `src/pages/EditorPage.tsx`, `src/layout/**`, the
stores those surfaces read/write, and the Electron shell where it owns a menu. Excludes the
dashboard, auth pages, and AE feature parity (that is `docs/FEATURE_AUDIT.md`).
**Question asked:** *before adding new features, what is already here but half-connected?*

**Method:** static trace, both directions. For every interactive surface: control → handler →
store/command → **reader**. A control counts as wired only when something downstream actually
consumes what it writes. Conversely, every engine-side reader was checked for a control that can
write it. Counts of setter/field references were taken mechanically, then each candidate was
confirmed by reading the code.

**Caveat:** this is static analysis. Items marked ⚠ **unverified at runtime** are read off the code
with high confidence but were not reproduced in a running build.

---

> **RESOLVED 2026-08-03** on `fix/wiring-audit`. 25 of 27 items fixed, 2
> withdrawn as **wrong** (see §Resolution). Every fix landed with a guard —
> 8 new test files, 1 lint rule pair, and one type change that makes the bad
> state unrepresentable. **#23 deferred**, unchanged, by direction.
>
> Two audit findings did not survive verification, which is the point of
> verifying: `preferenceStore.setMany` and `projectStore.breadcrumbPath` are
> both LIVE. See §Resolution for what the original scan got wrong.

## Headline

The command layer is in good shape. **All 63 app-menu items resolve to a registered command**, the
panel registry and the renderer map are 1:1 with no orphans on either side, there is not a single
`TODO`/`FIXME` marker in `src/`, and no `useState` value in `src/layout`, `src/components` or
`src/pages` is set without being read. Previous dead-UI sweeps clearly worked.

What is left is a different shape of problem — not *unwired buttons* so much as **half-crossed
seams**: a switch with no reader, a reader with no switch, two systems that each half-own the same
feature, and four things that work in the browser and silently do nothing in the packaged desktop
app.

| Severity | Count |
|---|---|
| **P1** — broken for the user in a shipped build | 4 |
| **P2** — half-built (one side of the wire is missing) | 7 |
| **P3** — duplicated or inconsistent | 5 |
| **P4** — dead code, permanently-disabled UI, stale docstrings | 11 |
| **Total** | **27** |

---

## P1 — Broken for the user in a shipped build

### 1. Three features silently do nothing in the packaged Electron app (`window.prompt`)

Chromium in Electron does not implement `prompt()` — it logs an error and returns `undefined`.
There is no polyfill anywhere in `src/` or `electron/` (checked). Three call sites depend on it:

| Feature | Site |
|---|---|
| **Save Current Workspace…** (Workspaces dropdown) | [TopNav.tsx:217](src/layout/TopNav/TopNav.tsx:217) |
| **Save Preset** (Effects panel effect-stack) | [EffectsPanel.tsx:236](src/layout/Effects/EffectsPanel.tsx:236) |
| **Rename…** (layer context menu) | [useWorkspace.ts:1380](src/layout/Workspace/useWorkspace.ts:1380) |

Each guards on the return (`if (!name) return`), so the failure is silent: the user clicks, nothing
happens, no error. The desktop app is the primary product, so all three are dead there while working
in a browser build.

**Fix:** `customPrompt` from [Dialogs.tsx:122](src/components/Modal/Dialogs.tsx:122) — already the
pattern used by `project.sync` ([Providers.tsx:783](src/providers/Providers.tsx:783)).

### 2. AI provider setup is unreachable in the local (OSS) edition

`aiEnabled()` returns `true` in both editions ([edition.ts:104](src/core/config/edition.ts:104)), so
the AI panel is live and tells the user *"Connect an AI provider to start"* with this link:

```
<a href="#/dashboard?tab=settings">Open AI settings →</a>
```
— [AiChatPanel.tsx:373](src/layout/AiChat/AiChatPanel.tsx:373)

But `/dashboard` is registered **only** under `cloudProjectsEnabled()`
([AppRouter.tsx](src/routes/AppRouter.tsx)), which is false in the local edition. The hash falls
through to the catch-all → `Navigate to "/"` → which the local edition redirects straight to
`/editor`. The user is bounced back to where they started.

`AiSettingsSection` — the **only** API-key entry UI in the app — is mounted at exactly one place:
[DashboardPage.tsx:1285](src/pages/DashboardPage.tsx:1285).

**Net effect:** the OSS edition's headline is "the full editor, with your own API key", and there is
no reachable place to enter the key.

**Fix:** mount `AiSettingsSection` in the editor (a Customize… tab is the natural home) and point the
link at it rather than at a route that may not exist.

### 3. "Dock Bottom Timeline" makes a panel disappear

[PanelHeader.tsx:125](src/layout/EditorLayout/PanelHeader.tsx:125) offers three dock targets.
`dockPanel(panelId, 'bottomTimeline')` ([layoutStore.ts:377](src/stores/layoutStore.ts:377)) sets
`panel.region` and pushes the id into `panelOrder.bottomTimeline` — but **nothing renders that
region's panels**. `EditorLayout` puts the `timeline` element in the bottom pane
([EditorLayout.tsx:148](src/layout/EditorLayout/EditorLayout.tsx:148)), and `DockPanel` is only
mounted for `leftSidebar` ([LeftSidebar.tsx:26](src/layout/LeftSidebar/LeftSidebar.tsx:26)) and
`rightInspector`.

The panel vanishes, and its header — the only way to dock it back — went with it. Recovery is Reset
Layout, or a panel-specific reopen command where one exists (`F3`, `F6`).

**Fix:** either drop the third menu item, or render docked panels in the bottom region.

### 4. Render Queue "Pause" is actually "Abort"

The toolbar button is labelled **Pause**, carries a pause icon, and is titled *"Pause render queue"*
([RenderQueuePanel.tsx:152](src/layout/RenderQueue/RenderQueuePanel.tsx:152)). What it calls:

```js
pauseAll() {
  // The abort signal stops the frame loop and disposes the sink, which kills
  // any running ffmpeg child and removes its staging directory.
  get()._abort?.abort();
  set({ isRunning: false, _abort: null });
}
```
— [renderQueueStore.ts:312](src/stores/renderQueueStore.ts:312)

There is no resume: pressing "Render All" restarts every job from frame 0. A user who pauses a
40-minute render to free the CPU loses the render. The store's own comment is accurate; the label is
not.

**Fix:** rename to "Stop" and confirm when a job is mid-render, or implement real pause/resume.

---

## P2 — Half-built: one side of the wire is missing

### 5. Per-layer **Draft Quality** switch is write-only — the toggle changes nothing

The switch exists ([LayerSwitchesControls.tsx:76](src/layout/Inspector/LayerSwitchesControls.tsx:76)),
persists to `fx.quality` ([layerQuality.ts:25](src/core/effects/layerQuality.ts:25)), is carried into
the render snapshot ([buildSnapshot.ts:1597](src/core/rendering/buildSnapshot.ts:1597)) and is hashed
into the content key ([contentHash.ts:55](src/core/rendering/contentHash.ts:55)).

**No renderer reads it.** A repo-wide grep for `layer.quality` consumers finds none in
`packages/renderer/src`, and every `imageSmoothingEnabled` site in the codebase hardcodes `true`
(`canvas2dEffects.ts:316`, `proceduralCanvas2d.ts:139`, `particleRender.ts:112`,
`AppTextureProvider.ts:109`).

The module docstring asserts the opposite: *"the renderer reads it to toggle
`imageSmoothingEnabled`"* ([layerQuality.ts:5](src/core/effects/layerQuality.ts:5)).

Because it is in the content hash, flipping the switch **invalidates the cache and forces a
re-render that produces an identical image** — strictly worse than doing nothing.

### 6. 3D gizmo snapping does not exist

`guidesStore.gizmo3dSnapping` ([:166](src/stores/guidesStore.ts:166)) has **zero writers and zero
readers** outside the store. `toggleGizmo3dSnapping` ([:297](src/stores/guidesStore.ts:297)) has no
caller. The field's only appearance outside its own definition is in the guides cache key
([:363](src/stores/guidesStore.ts:363)).

### 7. 3D gizmo local/world axis mode has no control

The inverse of #6. `useGizmo3d.ts:51` **reads** `gizmo3dAxisMode`, so the engine honours it — but
`setGizmo3dAxisMode` ([guidesStore.ts:296](src/stores/guidesStore.ts:296)) has zero callers.
`SceneControls` offers gizmo *modes* (universal/position/scale/rotation) and no axis-space toggle
([SceneControls.tsx:29](src/layout/SceneControls/SceneControls.tsx:29)). The gizmo is permanently
`'local'`; there is no way to reach world space.

### 8. Workspace lock — the gate exists, the switch does not

`workspaceLocked` hides the panel-options menu
([PanelHeader.tsx:81](src/layout/EditorLayout/PanelHeader.tsx:81)), but `setWorkspaceLocked`
([layoutStore.ts:424](src/stores/layoutStore.ts:424)) has **no caller**. There is no Lock Workspace
command, menu item or button, so the flag is permanently `false`.

### 9. Floating panels are unreachable

`layoutStore.floatPanel` is called from exactly one place —
`workspaceManager.applyWorkspace` ([workspaceManager.ts:237](src/core/layout/workspaceManager.ts:237))
— replaying a snapshot. **No UI floats a panel**: the panel-options menu offers Pop Out and three
Dock targets, never Float. So `floatingPanels` is always empty, and every saved workspace
faithfully records `[]` ([workspaceManager.ts:197](src/core/layout/workspaceManager.ts:197)).

### 10. Workspace JSON export/import has no UI

`exportWorkspaceJSON` ([:262](src/core/layout/workspaceManager.ts:262)) and `importWorkspaceJSON`
([:268](src/core/layout/workspaceManager.ts:268)) are implemented and have **zero callers**. The
module docstring advertises them, plus *"automatic monitor layout matching"* — no such method exists
in the file at all.

### 11. Multi-monitor panel targeting is inert

`popoutPanel(panelId, monitorId)` accepts a monitor, and `panel.monitorId` rides along in saved
workspaces. The only UI caller passes nothing:
`popoutPanel(panelId)` ([PanelHeader.tsx:58](src/layout/EditorLayout/PanelHeader.tsx:58)). Nothing
enumerates monitors. The field can only ever be set by importing a hand-edited workspace.

---

## P3 — Duplicated or inconsistent

### 12. **Two parallel workspace-preset systems** that cannot see each other

| | `core/layout/workspaceLayouts.ts` | `core/layout/workspaceManager.ts` |
|---|---|---|
| Built-ins | 4 (Default / Animation / Effects / Minimal) | 8 (default, motion-design, ai-focus, animation, color-grading, dual-monitor-studio, presentation, minimal) |
| Settings key | `workspaceLayouts` | `workspace.userWorkspaces` |
| Saved by | Customize… → Workspaces | TopNav → Workspaces → "Save Current Workspace…" |
| Read by | **only** [CustomizeDialog.tsx:163](src/layout/Settings/CustomizeDialog.tsx:163) | **only** [TopNav.tsx:182](src/layout/TopNav/TopNav.tsx:182) |

A workspace saved from the toolbar never appears in Customize…, and vice versa. Both ship a preset
named "Default" with different contents. `workspaceManager` is the richer of the two (ids, floating
and external panels, dock edges); `workspaceLayouts` is the older one.

**Fix:** delete `workspaceLayouts.ts` and point CustomizeDialog at the manager. Note the migration:
anything a user already saved under the `workspaceLayouts` key is otherwise silently orphaned.

### 13. `uiStore.showGrid` / `showRulers` duplicate `guidesStore.grid` / `rulers`

The `uiStore` copies ([uiStore.ts:51,53](src/stores/uiStore.ts:51)) and their togglers
([:142,:146](src/stores/uiStore.ts:142)) have **zero readers and zero writers** outside the store.
Every live grid/ruler control goes through `guidesStore` (View menu, ViewControls, canvas context
menu, Composition Settings). Two sources of truth, one of them inert.

### 14. Composition menu has no "New Composition…", but the feature exists

[menuModel.ts:85](src/layout/Menu/menuModel.ts:85) removed the item with the rationale *"compositions
are created only from the dashboard, one project per composition."* That is no longer true:
`openNewCompositionDialog()` is live in the Project panel
([ProjectPanel.tsx:128](src/layout/Project/ProjectPanel.tsx:128)) and the whole
`NewCompositionDialog` is built. The menu is missing an entry for a working feature, and the comment
that explains its absence is stale.

### 15. Two example scenes are registered but have no menu home

`scene.loadSaaSAd` and `scene.loadShowcase` are registered with confirm-on-dirty handling
([Providers.tsx:444](src/providers/Providers.tsx:444)) and appear only in the Command Palette.
`AppMenuBar`'s own docstring lists an **"Examples"** group in the menu bar
([AppMenuBar.tsx:4](src/layout/Menu/AppMenuBar.tsx:4)) — `APP_MENU` has no such group.

The same "registered, palette-only" shape applies to `layer.fitToComp*` (5 commands),
`layer.centreAnchor`, `layer.rigLogo`, `shape.merge*` (4), `view.motionPath` and `view.plugins`.
Those are defensible; the Examples one contradicts a docstring.

### 16. Native browser dialogs vs the app's own modal chrome

`window.confirm` at [confirmDiscard.ts:44](src/core/project/confirmDiscard.ts:44) — which guards New
Project, Open and Close — and 9 `window.alert`/`window.confirm` calls in
[PluginsModal.tsx](src/layout/Plugins/PluginsModal.tsx). These *work* in Electron (unlike `prompt`),
but they render as OS dialogs beside a codebase that has `customConfirm`/`customPrompt` and uses them
elsewhere.

---

## P4 — Dead code, permanently-disabled UI, stale docstrings

### 17. `aiEnabled()` is a constant `true` — 8 dead branches, and one guard that no longer guards

[edition.ts:104](src/core/config/edition.ts:104) is now `() => true`. Every `!aiEnabled()` branch is
unreachable:

- the *"The AI assistant is coming soon."* banner — [AiChatPanel.tsx:354](src/layout/AiChat/AiChatPanel.tsx:354)
- the `'Coming soon'` placeholder and send-button title — [:724](src/layout/AiChat/AiChatPanel.tsx:724), [:868](src/layout/AiChat/AiChatPanel.tsx:868)
- the disabled textarea and send button — [:734](src/layout/AiChat/AiChatPanel.tsx:734), [:871](src/layout/AiChat/AiChatPanel.tsx:871)
- four early-returns in [aiProviderStore.ts:311,317,323,362](src/stores/aiProviderStore.ts:311)

The one that matters: [DirectorRunner.ts:71](src/core/ai/DirectorRunner.ts:71) intends to refuse the
director pipeline in the local edition —

```js
// The director pipeline runs server-side; there is no local equivalent, so in
// the local edition it is simply absent. Same refusal as `streamTurn`.
if (!aiEnabled()) throw new AiError('coming_soon', '…');
const token = getToken();
if (!token) throw new AiError('auth', 'Sign in to run the AI director pipeline.');
```

The refusal cannot fire, so a local-edition run reaches `getToken()`, finds none, and reports **"Sign
in to run the AI director pipeline"** in an edition that has no sign-in. ⚠ *unverified at runtime* —
`AgentLoop.ts:474` wraps the call in a `try`/`recordPathFailure`, so it may degrade rather than
surface; worth reproducing.

### 18. File ▸ Version History… is permanently greyed in the local edition

[menuModel.ts:58](src/layout/Menu/menuModel.ts:58) lists the item unconditionally; the command is
registered only under `cloudProjectsEnabled()`
([Providers.tsx:1165](src/providers/Providers.tsx:1165)); an unregistered id renders `disabled`
([AppMenuBar.tsx:90](src/layout/Menu/AppMenuBar.tsx:90)).

The comment at [Providers.tsx:1161](src/providers/Providers.tsx:1161) says the command is left
unregistered *precisely so there is no "permanently-disabled menu item next to a feature that does
work"* — but the menu model is static, so the disabled item appears anyway. The intent needs the
menu entry to be conditional too.

### 19. Dead state fields

| Field | Site | Status |
|---|---|---|
| `uiStore.focusedPanelId` + `setFocusedPanel` | [uiStore.ts:43](src/stores/uiStore.ts:43), [:72](src/stores/uiStore.ts:72) | zero callers, zero readers. Comment says *"for keyboard routing"* — never wired. |
| `layoutStore.allowGroup` | [layoutStore.ts:122](src/stores/layoutStore.ts:122) | declared on the panel type, never set, never read. |
| `projectStore.breadcrumbPath` | [projectStore.ts:15](src/stores/projectStore.ts:15) | written by `openTab`, never rendered — there is no breadcrumb UI. |

### 20. Unused store APIs

`preferenceStore.setMany` and `uiStore.setPointer` have no callers.

### 21. Seven tools have a toolbar button but no command

`buildToolCommands` ([Providers.tsx:107](src/providers/Providers.tsx:107)) registers 14 tools.
Missing: **pencil, curvature, line, polygon, star, mask-rect, mask-ellipse**. Consequence: those
seven are absent from the Command Palette and **cannot be given a keyboard shortcut in Customize…**,
while their siblings can. Nothing is broken — it is an inconsistent surface.

### 22. `CameraTool` is registered in the engine and unreachable from the app

`CameraTool` ([packages/workspace/src/tools/builtin.ts:1226](packages/workspace/src/tools/builtin.ts:1226))
is constructed and registered at [:1446](packages/workspace/src/tools/builtin.ts:1446), but there is
no `'camera'` member in the `Tool` union ([uiStore.ts:14](src/stores/uiStore.ts:14)) and no entry in
`TOOL_MAP` ([WorkspaceController.ts:19](src/core/workspace/WorkspaceController.ts:19)). Camera
navigation is done instead through `guidesStore.cameraTool` (orbit/pan/dolly), so the engine tool is
a second, unused implementation of the same idea.

*(`MoveTool` looked like the same case but is fine — it has no toolbar button, yet `tool.move` is
registered and reachable from the palette.)*

### 23. Tool Options bar covers 5 of 21 tools

[ToolOptionsBar.tsx](src/layout/TopNav/ToolOptionsBar.tsx) renders options for brush, pencil, line,
polygon and star, and returns `null` for everything else. Pen, curvature, both mask tools, puppet
pin, bone, text, shape and ellipse show an empty strip where AE shows parameters (mask
feather/expansion, puppet mesh density, rectangle roundness). Not broken — unfinished.

### 24. Maximize/restore glyph goes stale

[TitleBar.tsx:14](src/layout/TitleBar/TitleBar.tsx:14) tracks `isMaximized` in local state and flips
it on click. An OS-level maximize (double-click the title bar, `Win`+`↑`, snap) does not update it,
so the button shows the wrong glyph until clicked twice. Nothing subscribes to the window's actual
state.

### 25. "Back to Dashboard" is a no-op in the local edition

[TopNav.tsx:501](src/layout/TopNav/TopNav.tsx:501) navigates to `/`, which the router redirects to
`/dashboard` **or**, when `cloudProjectsEnabled()` is false, to `/editor` — i.e. back to where the
user already is. The arrow should be hidden in that edition.

### 26. Stale docstrings that describe behaviour the code no longer has

| File | Claim | Reality |
|---|---|---|
| [layerQuality.ts:5](src/core/effects/layerQuality.ts:5) | "the renderer reads it to toggle `imageSmoothingEnabled`" | no reader — see #5 |
| [workspaceManager.ts:3](src/core/layout/workspaceManager.ts:3) | "workspace JSON export/import, and automatic monitor layout matching" | export/import have no callers; monitor matching does not exist |
| [OnboardingOverlay.tsx:5](src/layout/Onboarding/OnboardingOverlay.tsx:5) | "The first step offers the *Coming from After Effects?* shortcut import" | no such control in the component; `AE_PRESET` is already the default keymap |
| [AppMenuBar.tsx:4](src/layout/Menu/AppMenuBar.tsx:4) | menu groups include "Examples" | no Examples group — see #15 |
| [StatusBar.tsx:5](src/layout/StatusBar/StatusBar.tsx:5) | "purely presentational; the timeline engine **will** push … into a center chip" | `App.tsx:1074` already fills all three slots with live state |

### 27. Render Queue panel has no close affordance

`renderQueue` is registered `onDemand: true` **and** `closable: false`
([panelDefs.ts:80](src/layout/EditorLayout/panelDefs.ts:80)), so `PanelHeader` renders no ✕. It can
only be dismissed with `F6` or the Window menu. Every other `onDemand` panel (`project`, `history`,
`plugins`) is `closable: true`.

---

## What was checked and found correctly wired

Recorded so the next pass does not re-walk it:

- **Every one of the 63 `APP_MENU` items** resolves to a registered command (`project.*`, `edit.*`,
  `comp.*`, `layer.*`, `effect.*`, `anim.*`, `view.*`, `help.*`). Unregistered ids render `disabled`
  rather than no-op'ing, in both menu renderers.
- **The Electron native menu is a deliberate subset, not a gap** — the full `AppMenuBar` renders in
  the custom title bar ([TitleBar.tsx:52](src/layout/TitleBar/TitleBar.tsx:52)), and the native
  template exists for users who reach for `Alt`.
- **Panel registry ↔ renderer map is exactly 1:1** — 13 defs in `panelDefs.ts`, 13 entries in
  `getAllPanelRenderers()`, no orphans in either direction.
- **Both sidebars receive the full renderer map**, so cross-docking left↔right works
  ([App.tsx:1253](src/App.tsx:1253)).
- **Timeline filter box** is genuinely wired through to track filtering
  (`BottomTimeline` → `Timeline.tsx:317`), as are Loop, Draft, Preview Resolution, Global Shy, Motion
  Blur, Split, Trim In/Out and Graph Editor.
- **Render Queue actions** (`startAll`, `skipJob`, `duplicateJob`, `clearFinished`,
  `chooseOutputDir`) all exist and are correctly gated — `chooseOutputDir` is hidden when the shell
  cannot pick a folder.
- **Command Palette** enumerates the whole registry, so palette-only commands are genuinely
  reachable.
- **No unread `useState`** in any file under `src/layout`, `src/components` or `src/pages`.
- **No `TODO`/`FIXME`/`not implemented` markers** in `src/` outside the `F11` lint-suppression
  headers already tracked in `COMPOSITING_PLAN.md`.
- **Effects panel availability gate** was already removed rather than left as a constant-`true` stub
  ([EffectsPanel.tsx:147](src/layout/Effects/EffectsPanel.tsx:147)) — the right call, noted here so
  it is not "restored" by mistake.

---

## Suggested order

Cheapest-first, and each is independent of the others:

| # | Item | Size | Why here |
|---|---|---|---|
| 1 | **#1** — three `window.prompt` sites → `customPrompt` | XS | Three features come back to life in the desktop app for a one-line change each. Highest ratio on the board. |
| 2 | **#4** — rename Pause → Stop (or confirm before abort) | XS | A label change that stops the queue destroying work under a false promise. |
| 3 | **#3** — drop "Dock Bottom Timeline" | XS | Deleting one menu item removes a way to lose a panel. |
| 4 | **#5** — Draft Quality: implement the reader, or remove the switch | S | Currently *worse* than absent — it busts the frame cache for an identical image. Either end is fine; both ends must agree. |
| 5 | **#2** — mount `AiSettingsSection` in the editor | S | Makes the OSS edition's headline feature actually usable. |
| 6 | **#18**, **#25**, **#14** — edition-conditional menu items and buttons | S | Three small honesty fixes to what the UI claims is available. |
| 7 | **#12** — collapse the two workspace systems into one | M | Real consolidation, and it needs a migration for the orphaned settings key — hence not earlier. |
| 8 | **#6–#11** — finish or delete the half-built 3D/layout features | M | Each is a decision ("do we want this?") more than an implementation. Deleting is a legitimate answer for all six. |
| 9 | **#17**, **#19**, **#20**, **#26** — dead branches, dead fields, stale docstrings | S | Pure cleanup, but do it *after* the decisions above so it is done once. |
| 10 | **#21**, **#23** — tool commands and tool-options coverage | M | Consistency work; the surfaces function today. |

**#22 (`CameraTool`)** needs a decision before it can be sized: it is a second implementation of
camera navigation, and the `guidesStore` one is the live path. Deleting it is probably correct, but
confirm nothing in the engine's own tests depends on it first.

---

## Resolution (2026-08-03)

Branch `fix/wiring-audit`, merged to `dev`. Working rule for the whole run:
**verify the item is still broken before touching it, and land every fix with a
guard.** Both rules earned their keep — see the two withdrawn items below.

### The two systemic guards, built first

| | What it does |
|---|---|
| **G1** `src/core/rendering/__tests__/contentHashReaders.test.ts` | Parses `contentHash.ts` and asserts **every** field folded into the hash has a dot-access reader in the pixel path. Went **red on `quality` and nothing else** before #5, green after. A field added to the hash is enrolled automatically — it cannot be forgotten. |
| **G2** the F11 lint rule | **Already landed** in `eslint.config.js` (three selectors, baselined disables). Verified live, not re-implemented. |

### Per item

| # | State | Fix | Guard |
|---|---|---|---|
| 1 | fixed | 3 `window.prompt` → `customPrompt` | lint bans prompt/alert/confirm in `src/` |
| 2 | fixed | `AiSettingsSection` mounted in Customize ▸ AI; banner opens it in-app | `editionReachability.test.ts` — `src/layout` may not link edition-gated routes |
| 3 | fixed | "Dock Bottom Timeline" removed | `panelDocking.test.ts` — dock targets ⊆ DockPanel hosts |
| 4 | fixed | Pause → **Stop**, danger confirm mid-render | none (labelling; noted in commit) |
| 5 | fixed | reader implemented: `RenderLayer.quality` → `Renderable.sampling` → nearest sampler | **G1** + `snapshotToFrameScene.test.ts` |
| 6, 8, 9, 10, 11, 22 | deleted | gizmo snapping, workspace lock, float surface, workspace JSON IO, `monitorId`, `CameraTool` | `deadLayoutState.test.ts` (10 symbols + `PlacementMode` cannot express `'floating'`) |
| 7 | **finished, not deleted** | `useGizmo3d` already read `gizmo3dAxisMode`; added the L/W/V control | asserted in `deadLayoutState.test.ts` |
| 12 | fixed | `workspaceLayouts.ts` deleted, CustomizeDialog → manager, **migration** | `workspaceMigration.test.ts` — 6 cases against literal pre-change fixtures |
| 13, 19 | deleted | `uiStore.showGrid`/`showRulers`, `focusedPanelId`, `setPointer`, `allowGroup` | `deadLayoutState.test.ts` |
| 14, 18, 25 | fixed | New Composition… added; Version History edition-gated; Back-to-Dashboard hidden | `menuModel.test.ts` — visible ⇔ registered, per edition |
| 15, 26 | fixed | 5 stale docstrings corrected **after** the code decisions | — |
| 16 | fixed | `confirmDiscard` + 9 PluginsModal sites → `customConfirm`/`customAlert` | same lint rule as #1 |
| 17 | fixed | gate reads `aiRunsThroughBackend()`, not the now-constant `aiEnabled()`; 8 dead branches removed | `directorEditionGate.test.ts` — pins **both** editions |
| 21 | fixed | 7 tools registered as commands | `toolCommands.test.ts` — toolbar ⊆ commands |
| 27 | fixed | `renderQueue` → `closable: true` | — |
| 23 | **deferred** | Tool Options covers 5 of 21 tools | by direction — unfinished, not broken |

### Two findings that were WRONG

Both were reported as dead and are not. Deleting either would have caused a
regression, and only checking before cutting caught them:

- **`preferenceStore.setMany`** — called at `preferenceStore.ts:209`, on the
  boot path. The original scan excluded the store's own file when counting
  callers, so an internal-but-live caller read as zero.
- **`projectStore.breadcrumbPath`** — the audit said "written by `openTab`,
  never rendered". True about rendering, wrong about *use*: `openTab` reads
  `breadcrumbPath[length - 2]` to inherit the parent comp's size/fps, so a
  precomp opens at the project's real dimensions. Deleting it would have opened
  every precomp at the wrong size.

**The lesson generalises:** "no callers outside its own module" is not the same
as "no callers", and "nothing renders it" is not the same as "nothing reads it".

### Verified at runtime, not just compiled

Local edition (`VITE_EDITION=local`) at `dev:local`, driven through the DOM
(screenshots time out in this app; measure via JS):

- **#7** clicking **W** flips `aria-pressed` L→W — the store the gizmo reads
  actually changes. It rendered *and* worked, which are different claims.
- **#18** File menu has **no** Version History (Sync is correctly grey — an
  `enabled` state, not a registration gap).
- **#14** Composition ▸ **New Composition…** present and enabled.
- **#25** no Back-to-Dashboard button; no `#/dashboard` links anywhere.
- **#2** Customize ▸ **AI** renders three provider key inputs
  (`sk-ant-…`, `sk-…`, `AIza…`) — previously unreachable in this edition.
- **#1** Save Current Workspace opens the in-app prompt and saves.
- **#12** …and that workspace then appears in **Customize ▸ Workspaces**,
  beside the manager's 8 presets. Two lists became one. This is the single
  most valuable check of the run.
- **#21** both mask tools now resolve in the Command Palette.

Zero console errors, zero server errors. Suite **510 suites / 5955 tests**
green (from 503 / 5889). `tsc --noEmit` clean. **`npm run render-tests` gate
green** — the new sampler regressed no golden, and 18 previously-divergent
scenes now match exactly.

### Version

`0.2.0`. #12 was the only schema change in the run, as predicted — the
migration is idempotent via a flag and leaves the legacy key intact, so rolling
back to a build with the old workspace system still finds its data.
