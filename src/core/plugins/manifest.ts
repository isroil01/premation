/**
 * The plugin manifest — the contract between a package on disk and this host.
 *
 * Everything the manager needs in order to describe a plugin to the user BEFORE
 * a line of its code runs lives here: who wrote it, what version it is, which
 * host API it was built against, and — the part that matters — exactly what it
 * is asking permission to touch. A format whose only fields are `name` and a
 * function (which is what the previous plugin object was) cannot support an
 * informed install decision, because there is nothing to show but the name.
 *
 * API 2 extends that principle from *permissions* to *contributions*. Under
 * API 1 a plugin's commands existed only after its worker booted and its
 * `activate()` called `commands.register` — so the only way to find out what a
 * plugin offered was to run it. That is backwards for two reasons at once:
 *
 *   • A listing page cannot say "6 commands, 1 panel" before install.
 *   • Every installed plugin has to be started at launch just in case, and with
 *     forty of them that is forty workers racing an 8-second boot timeout.
 *
 * So `contributes` is DECLARED, read without executing anything, and
 * `activationEvents` says what should actually wake the worker up.
 *
 * Validation is strict and returns *messages*, not booleans: "this plugin did
 * not install" with no reason is the second-least actionable thing a plugin
 * manager can say, after saying nothing at all.
 */

import { ICON_NAMES } from '@components/Icon/iconNames';
import { parseLayerKinds, type LayerKindContribution } from './layerKindSchema';
import { parseEffects, THREAD_SAFETY, type EffectContribution, type ThreadSafety } from './effectSchema';
import { parseExporters, type ExporterContribution } from './exporterSchema';
import { parseImporters, type ImporterContribution } from './importerSchema';
import { parsePresets, type PresetContribution } from './presetSchema';
import { parseNet, type NetContribution } from './netSchema';
import { parseAudioEffects, type AudioEffectContribution } from './audioEffectSchema';
import { parseInspectorPanels, type PluginInspectorPanelContribution } from './uiParams';
import { parsePluginTools, type PluginToolContribution } from './uiTools';
import { parsePluginShortcuts, type PluginShortcutContribution } from './uiShortcuts';
import { parsePluginExpressions, type PluginExpressionContribution } from './uiExpressions';
import { RUNTIME_TIERS, DEFAULT_RUNTIME_TIER, type RuntimeTier } from './runtimeTier';

/**
 * Host API generation. Bump on a BREAKING change to the plugin-facing API.
 *
 * 3 — `contributes.layerKinds`. A plugin can declare a layer type the editor
 *     has never heard of, with animatable properties that behave like native
 *     ones. This is a version bump rather than an additive feature because it
 *     changes what a DOCUMENT contains: a project that uses a custom layer now
 *     references the plugin that defines it, which nothing before API 3 did.
 *
 * 4 — `contributes.effects`. A plugin can draw pixels: WGSL plus a typed
 *     parameter schema, compiled and bound by the host. A version bump for the
 *     same reason 3 was — a document using a plugin effect references the
 *     plugin that provides it — and because `render: "shader"` on a layer kind
 *     stops being a reserved value and starts meaning something.
 *
 * 6 — `contributes.exporters`, `contributes.importers` and `contributes.presets`. A plugin can read
 *     and write file formats the editor does not know. Both landed in the same
 *     grammar because they are one idea in two directions, and splitting them
 *     across 6 and 7 would make an author bump a version for the half they did
 *     not use.
 *
 * 7 — `contributes.inspector`, `contributes.tools`, `contributes.shortcuts` and
 *     `contributes.expressions`: the plugin's own user interface. A grammar bump
 *     only — the four keys are new, and what a plugin may CALL to drive them is
 *     a capability (`ui.inspector`, `ui.canvas`, `ui.tools`, `ui.expressions`),
 *     which is the axis an author actually needs to ask about.
 *
 *     The four landed together on purpose. They are one feature seen from four
 *     sides, and a plugin that contributes a tool with no way to draw, or
 *     parameters with no way to act on them, is half of something.
 *
 * 8 — `contributes.audioEffects`. A plugin can process SOUND — declared as a
 *     chain of the same WebAudio primitives the built-in audio effects are
 *     made of, so the one graph builder wires both and live playback cannot
 *     drift from an export. See `audioEffectSchema.ts` for why it is a
 *     declared graph rather than AE's sample callback.
 *
 *     A grammar bump only: the ability to CALL anything new is a capability
 *     (`audio.effects`), which is the axis an author needs to ask about.
 *
 *     `contributes.exporters`. A plugin can write a file format the editor does
 *     not know: the host renders and hands over frames, the plugin returns
 *     bytes, the host writes the file. A GRAMMAR bump only — it adds a
 *     `contributes` key — so `HOST_API_VERSION` does not move with it. The
 *     ability to CALL the new surface is a capability (`exporters`), which is
 *     the axis a plugin actually needs to ask about.
 *
 * 5 — The split. Up to here this number meant four things at once: the manifest
 *     grammar, the shape of `contributes`, the host method surface, and effect
 *     semantics. They stop moving together at 5, so they stop sharing a number.
 *
 *     `MANIFEST_VERSION` is what a manifest declares as `apiVersion` — the
 *     GRAMMAR it is written in. `HOST_API_VERSION` is what this host provides.
 *     Everything finer-grained than that is a capability, because a version can
 *     only express "newer than" and the question a plugin actually has is "does
 *     this host have the thing I call". See `capabilities.ts`.
 */
export const HOST_API_VERSION = 5;

/**
 * The newest manifest GRAMMAR this host can read.
 *
 * Separate from `HOST_API_VERSION` from 5 onward, and the two now move
 * independently: adding a host method bumps neither (it adds a capability),
 * while a new manifest key bumps only this one.
 *
 * A manifest declaring a grammar newer than this is refused, and that has not
 * changed — reading a document with keys whose meaning is unknown is how a
 * validator silently accepts something it does not understand.
 */
export const MANIFEST_VERSION = 8;

/** Everything a plugin may ask for. Nothing outside this list is grantable. */
export const PERMISSIONS = {
  'scene:read': {
    label: 'Read your layers',
    detail: 'See the names, structure and properties of layers in your composition.',
  },
  /*
    Listed BEFORE `scene:write`, and the order is load-bearing.

    The consent screen renders this object in key order, and a user reading top
    to bottom should meet the narrow grant before the wide one. "Build the
    layers beneath its own" is something a person can picture; "create, change
    and delete layers" is not, and meeting the wide one first makes the narrow
    one read as a footnote to it rather than as the alternative.
  */
  'scene:proxy': {
    label: 'Build the layers beneath its own',
    detail:
      'Generate and update the child layers underneath layers this plugin itself created. '
      + 'It cannot reach anything else in your composition, and it stops managing a layer the moment you edit it.',
  },
  'scene:write': {
    label: 'Modify your layers',
    detail: 'Create, change and delete layers. Every change is undoable.',
  },
  'animation:read': {
    label: 'Read your animation',
    detail: 'See keyframes and sample animated values over time.',
  },
  'animation:write': {
    label: 'Modify your animation',
    detail: 'Create and change keyframes and expressions. Every change is undoable.',
  },
  'assets:read': {
    label: 'Read images in your project',
    // Was "Plugins cannot access the internet." That stopped being true when
    // `net:fetch` shipped, and a reassurance that has quietly become false is
    // worse than no reassurance — the user reads it while deciding what to
    // trust. The remaining sentence is still true and still worth saying: a
    // plugin has NO network of its own, and reaching one is a separate
    // permission with its own named destinations.
    detail: 'Read the pixels of images already in your composition. Plugins have no network access unless you also grant "Contact specific websites".',
  },
  'net:fetch': {
    label: 'Contact specific websites',
    /*
      The one permission whose danger is a COMBINATION, said plainly.

      Listing "can reach the internet" beside "can read your layers" leaves the
      user to multiply the two, and most will not. A plugin holding both can
      take a copy of the project somewhere else, and that is not a flaw in the
      design — it is what the pair means. The consent screen names the hosts
      separately, from `contributes.net`.
    */
    detail: 'Send and receive data from the websites this plugin lists below — and only those. Combined with permission to read your layers, a plugin could copy your project to them.',
  },
  'assets:write': {
    label: 'Add images to your project',
    detail: 'Create new images and place them as layers. Every change is undoable.',
  },
  timeline: {
    label: 'Control the playhead',
    detail: 'Read the current time and move the playhead.',
  },
  /*
    Separate from `scene:write`, and last, because it is the widest thing here.

    "Modify your layers" is a statement about the composition the user is
    looking at. Adding and removing COMPOSITIONS restructures the project
    around them — a plugin holding this can put work somewhere they were not
    looking, and deleting one takes every layer in it. Folding that into
    `scene:write` would have made an existing grant silently mean more than it
    did when the user gave it, which is the one thing a permission may never do.
  */
  /*
    Reading AUDIO CONTENT, not audio settings.

    Level, pan and fades are ordinary animatable properties — a plugin already
    reads and writes them through `animation:read` / `animation:write`, and
    nothing here changes that. What this grants is the decoded WAVEFORM: how
    loud the audio actually is, moment to moment. That is the user's media
    content rather than their document structure, which is the same distinction
    `assets:read` draws for images, and it gets its own line for the same reason
    — widening `assets:read`'s wording to cover audio would make a grant a user
    already gave silently mean more than it did.
  */
  /*
    The rendered pixels of the composition, handed to a plugin frame by frame.

    Strictly more than `assets:read` (the images already in the project) and
    more than `scene:read` (its structure): this is the finished picture. Held
    together with `net:fetch` it is the whole video leaving the machine, so the
    detail says that rather than describing the feature.
  */
  /*
    The bytes of a file the USER opened with this plugin's format.

    Narrow by construction — a plugin never picks the file, and never sees one
    it did not claim an extension for — but still its own line, because "read a
    file off my machine" is not something any other permission here implies.
  */
  'import:files': {
    label: 'Read files you open with it',
    detail: 'Read the contents of files you import whose format this plugin provides. It cannot browse your machine or open anything you did not choose.',
  },
  'export:frames': {
    label: 'Receive your rendered frames',
    detail: 'See every rendered frame of a composition you export with this plugin’s format, in order. Combined with permission to contact websites, a plugin could send your finished video to them.',
  },
  'audio:read': {
    label: 'Analyse audio in your project',
    detail: 'Read the loudness of audio layers over time, to drive animation from sound. It cannot play, export or copy the audio.',
  },
  'composition:write': {
    label: 'Add and remove compositions',
    detail:
      'Create, rename, open and delete compositions in your project. '
      + 'Deleting one removes every layer it contains. Every change is undoable.',
  },
} as const;

export type PluginPermission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PluginPermission[];

/**
 * Permissions that CONTAIN other permissions.
 *
 * `scene:write` is "create, change and delete layers"; `scene:proxy` is a
 * proper subset of that — the same verbs, restricted to a plugin's own proxy
 * subtrees. Holding the wide one and being refused the narrow one would be
 * nonsense, and it is also the migration: every plugin installed before
 * `scene:proxy` existed holds `scene:write` and must keep working with no
 * re-consent.
 *
 * ── Why this is a table and not an `||` in the gate ─────────────────────────
 *
 * The registry's publish-time scanner reads the same method→permission map to
 * infer which permissions a package actually uses. Without the implication it
 * would see a call to `scene.setProxyChildren`, conclude the package needs
 * `scene:proxy`, find only `scene:write` in the manifest, and report an
 * undeclared permission — sending every existing proxy plugin to manual review
 * for a call it is fully entitled to make. So the relationship has to be known
 * on BOTH sides, which makes it data rather than a branch.
 *
 * Deliberately not transitive and deliberately not a graph. One level is what
 * the model needs; a hierarchy is a thing to get subtly wrong in a security
 * check, and `expandPermissions` below would have to close over it.
 */
export const PERMISSION_IMPLIES: Readonly<Partial<Record<PluginPermission, readonly PluginPermission[]>>> = {
  'scene:write': ['scene:proxy'],
};

/**
 * A grant, plus everything it contains.
 *
 * The set to check a required permission against — never the raw grant. A
 * caller that tests `granted.includes(required)` directly is the bug this
 * exists to prevent, and it is a quiet one: it refuses a plugin holding a
 * STRICTLY WIDER permission than the one being asked for.
 */
export function expandPermissions(
  granted: readonly PluginPermission[],
): ReadonlySet<PluginPermission> {
  const out = new Set<PluginPermission>(granted);
  for (const held of granted) {
    for (const implied of PERMISSION_IMPLIES[held] ?? []) out.add(implied);
  }
  return out;
}

/** A command declared in the manifest — and, identically, one registered at
 *  runtime. One shape, so a declared command and a registered one cannot drift. */
export interface PluginCommandContribution {
  /** Plugin-local id; the host namespaces it as `plugin.<pluginId>.<id>`. */
  id: string;
  label: string;
  /** Icon name from the editor's vocabulary. Checked here, at validation time,
   *  rather than at render time — an unknown name that silently falls back to
   *  the generic glyph is a typo the author never finds out about. */
  icon?: string;
  /** When true the host only enables it with a non-empty selection. */
  needsSelection?: boolean;
  /**
   * A heading to group this command under in the Plugins menu.
   *
   * Presentation only, and flat — one level, like a layer prop's `group`, and
   * for the same reason: a plugin that could nest menus could bury a command
   * three levels down where nobody finds it. What this is actually for is the
   * plugin with fourteen commands, which without it turns the Plugins menu into
   * a scroll (the group is already at its 14-entry ceiling — see
   * `menuSubmenus.test.ts`).
   */
  submenu?: string;
}

/**
 * Where the host should put a panel.
 *
 * One field with three values rather than two orthogonal ones (dock × shape),
 * because two would spell four combinations of which only three are real — and
 * the fourth ("shared, but in the left sidebar") would need a second shared host
 * nobody asked for. Each value names a destination the user can point at.
 *
 *  • `shared` — a tab inside the one "Plugin Panels" panel in the right
 *    inspector. Costs no rail space, so it is the default and the right answer
 *    for the common case: a small panel of controls for the current selection.
 *  • `sidebar` — its OWN rail tab in the left sidebar, beside Scene, Assets and
 *    Library. For a plugin that is a place you go rather than a control you
 *    reach for: a browser, a library, an asset generator.
 *  • `inspector` — its own rail tab in the right inspector, beside Properties
 *    and Effects. For a full editor that still belongs to the selection.
 *
 * A rail tab is not granted just because it is asked for — see
 * `layout/Plugins/pluginPanelDefs.ts`, which caps how many a rail will give out.
 */
export type PluginPanelPlacement = 'shared' | 'sidebar' | 'inspector';

export const PANEL_PLACEMENTS: readonly PluginPanelPlacement[] = ['shared', 'sidebar', 'inspector'];

/** A panel declared in the manifest. */
export interface PluginPanelContribution {
  id: string;
  title: string;
  /** Package-relative path to the panel's HTML. */
  entry: string;
  /**
   * Always set after parsing — `shared` when the manifest says nothing, which is
   * what every plugin written before this field existed gets, and is exactly
   * the behaviour it already had.
   */
  placement: PluginPanelPlacement;
  /**
   * Rail glyph, for a panel that gets its own tab.
   *
   * Validated against the editor's icon set at PARSE time, like `command.icon`:
   * the rail is icon-ONLY, so a name that silently falls back to the generic
   * plugin glyph is a typo whose only symptom is a tab the author cannot tell
   * apart from someone else's.
   */
  icon?: string;
}

/**
 * What a plugin contributes, readable without executing it.
 *
 * Always normalised by `parseManifest` — every key present, arrays possibly
 * empty — so no consumer has to write `contributes?.commands ?? []`. A field
 * that is sometimes absent and sometimes empty is two representations of one
 * state, and every reader has to know about both.
 */
export interface PluginContributes {
  commands: PluginCommandContribution[];
  panels: PluginPanelContribution[];
  /**
   * Layer types this plugin invents. Requires `apiVersion: 3`.
   *
   * See `layerKindSchema.ts` — including why `render` is part of the schema
   * rather than a runtime choice, and why only some property types animate.
   */
  layerKinds: LayerKindContribution[];
  exporters: ExporterContribution[];
  importers: ImporterContribution[];
  presets: PresetContribution[];
  /**
   * Effects this plugin draws. Requires `apiVersion: 4`.
   *
   * See `effectSchema.ts` — including why the shader is DATA rather than a
   * callback, and why the host writes the bindings rather than the author.
   */
  effects: EffectContribution[];
  /**
   * Hosts this plugin may contact. Requires `apiVersion: 4` and the
   * `net:fetch` permission — see `netSchema.ts`.
   *
   * `null` means the plugin declared no network block, which is the common
   * case. That is NOT the same as an empty host list, which is refused:
   * network access to nowhere is a mistake rather than a configuration.
   */
  net: NetContribution | null;
  /**
   * User interface, all four of them requiring `apiVersion: 7`.
   *
   * They arrived together because they are one idea seen from four sides — a
   * plugin that can be USED rather than only invoked — and splitting them
   * across four grammar versions would make an author bump a number for the
   * three they did not write.
   */
  /** Parameter sections on layers the plugin does not own — see `uiParams.ts`. */
  inspector: PluginInspectorPanelContribution[];
  /** Toolbar tools whose pointer events reach the plugin — see `uiTools.ts`. */
  tools: PluginToolContribution[];
  /** Chords for the plugin's own commands, granted only if free — `uiShortcuts.ts`. */
  shortcuts: PluginShortcutContribution[];
  /** Functions callable from expressions — see `uiExpressions.ts`. */
  expressions: PluginExpressionContribution[];
  /**
   * Audio effects this plugin declares. Requires `apiVersion: 8`.
   *
   * A CHAIN of WebAudio primitives rather than a sample callback — see
   * `audioEffectSchema.ts`, which explains at length why the parity rule in
   * `audioEffects.ts` makes that the only shape that can work here.
   */
  audioEffects: AudioEffectContribution[];
}

/**
 * Keys that are recognised but must be empty in this version.
 *
 * Empty as of API 4, when `effects` became real. Kept as a mechanism rather
 * than deleted: it is how the NEXT reserved key gets refused with a version
 * message instead of an unknown-key one, and those are different problems for
 * an author — one means "wait", the other means "you made a typo".
 */
export const RESERVED_CONTRIBUTION_KEYS: readonly string[] = [];

/**
 * What wakes a plugin's worker up.
 *
 * `onStartup` is the API-1 behaviour and stays the default, because a plugin
 * that does not say when it is needed has to be assumed to be needed always.
 */
export type ActivationEvent =
  | 'onStartup'
  | `onCommand:${string}`
  | `onPanel:${string}`
  // Fired when a document containing this kind is opened. Declaring a kind
  // implies it (see `activatesOnLayerKind`); the spelling exists so an
  // author can be explicit, and so the set is readable from the manifest.
  | `onLayerKind:${string}`
  /*
    Fired when the user picks one of this plugin's tools.

    Declaring a tool implies it, the same way declaring a layer kind implies
    `onLayerKind` — a tool whose worker is not running is a cursor that swallows
    every click and answers none of them, which is worse than no tool at all.
  */
  | `onTool:${string}`
  /*
    Fired when a render leaves the queue — finished, failed, or skipped.

    A post-render action is the reason this exists (AE has had them since
    forever): tell a webhook the deliverable is ready, write a log line, put a
    badge in a panel. Those plugins have nothing to do until a render ends, so
    waking them at startup would be forty workers idling for an event most
    sessions never fire.
  */
  | 'onRenderFinished';

export interface PluginManifest {
  /** Reverse-DNS, e.g. `studio.acme.easing-lab`. Namespaced so two vendors
   *  cannot collide, and stable so a document could one day reference it. */
  id: string;
  name: string;
  /** `major.minor.patch`. */
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  /**
   * The manifest GRAMMAR this plugin is written in. Refused when newer than
   * `MANIFEST_VERSION` — reading keys whose meaning is unknown is how a
   * validator silently accepts something it does not understand.
   *
   * Called `apiVersion` on the wire because that is what every published
   * manifest already says and the name is frozen in signed bytes. From version
   * 5 it means the grammar and nothing else; what the plugin can CALL is
   * `requires` / `optional`.
   */
  apiVersion: number;
  /**
   * Capabilities without which this plugin cannot run.
   *
   * Checked at INSTALL, and refused there rather than at the first call. A
   * plugin that installs and then fails is worse than one that never installs:
   * the user has already agreed to its permissions, it sits in their list
   * looking healthy, and the failure arrives later attached to whatever they
   * happened to be doing.
   *
   * Absent means "whatever `apiVersion` implied" — see
   * `CAPABILITIES_BY_API_VERSION`, which is what keeps every already-published
   * manifest installing unchanged.
   */
  requires?: string[];
  /**
   * Capabilities this plugin uses if they are there.
   *
   * Never gates an install. It exists so `motion.capabilities.has(...)` means
   * something an author declared rather than something they probed for, and so
   * a listing can say what a plugin will do on a better machine.
   */
  optional?: string[];
  /**
   * Which runtime this plugin asks for. Absent in the source means `sandboxed`;
   * always present after parsing.
   *
   * `native` imports the entry module into the RENDERER REALM — synchronous
   * handles to the scene graph, code that can run per frame, a real render
   * pass, and no permission gate, because there is no boundary left to gate.
   * It is what makes an After-Effects-class plugin possible here, and it is
   * refused until the user has agreed for this specific plugin.
   *
   * Defaulted rather than required, so every manifest already published keeps
   * its meaning. A field nobody wrote must never be able to mean
   * "unrestricted". See `runtimeTier.ts`, especially the rule that a sandboxed
   * plugin turning native on update has to ask again.
   */
  runtime: RuntimeTier;
  /** Package-relative path to the entry ES module. */
  main: string;
  /**
   * What the SANDBOXED tier may reach.
   *
   * Parsed and stored for a native plugin too, and enforced for neither more
   * nor less than it always was: for `native` there is no gate to apply it at,
   * so it becomes disclosure — what the author says they touch, which a
   * listing shows and a reviewer can hold against what the code does.
   */
  permissions: PluginPermission[];
  /** Always present after parsing — see `PluginContributes`. A legacy
   *  `panel: "panel.html"` string is normalised into `panels` here, so nothing
   *  downstream needs to know that spelling ever existed. */
  contributes: PluginContributes;
  /** Always non-empty after parsing; `['onStartup']` when unspecified. */
  activationEvents: ActivationEvent[];
  /**
   * A COMPILED module this package ships. Absent for every plugin that has one
   * of those only in its future, which is almost all of them.
   *
   * Nothing about this field grants anything. It declares that a binary exists
   * and where; whether it is allowed to run is decided by a signature and a
   * separate consent step (`native/nativeTrust.ts`), and it runs in a process
   * of its own either way. Deliberately NOT `runtime: "native"` — that is the
   * renderer-realm tier, a different thing with a different failure mode, and
   * conflating them would make one consent answer the other's question.
   */
  native?: PluginNative;
}

/**
 * The `native` block: which binary, for which machine, against which ABI.
 *
 * Shaped after OFX's bundle layout (`Win64/`, `MacOS/`, `Linux-x86-64/`) rather
 * than after a single path with placeholders in it. A vendor ships the three
 * platforms they build for and names each one; a host looks up one key. A
 * template like `bin/{platform}/x.node` reads as more general and is worse at
 * the only job it has — it cannot express "this build is arm64-only", which is
 * most of the interesting cases.
 */
export interface PluginNative {
  /**
   * The MAJOR ABI this addon was built against.
   *
   * Declared here as well as returned by the binary, and the two are checked
   * against each other. The manifest's copy is what lets the app say "this
   * plugin needs a newer Premation" WITHOUT loading a stranger's code to find
   * out — which is the whole reason the check exists.
   */
  abi: number;
  /** `platform-arch` (`win32-x64`) → package-relative path to the binary. */
  platforms: Record<string, string>;
  /**
   * Package-relative path → SHA-256 hex of the binary's bytes.
   *
   * Written by `scripts/pack-plugin.mjs --native`. Advisory here — the main
   * process hashes the file it is about to load and consent is pinned to THAT
   * — but it is what makes a mismatch nameable: "the binary is not the one this
   * package was built with" rather than "the hash changed".
   */
  hashes?: Record<string, string>;
  /** How the host may schedule calls. Default `instance`, as for CPU kernels. */
  threadSafety?: ThreadSafety;
  /** Hard per-call ceiling in ms. The host clamps it; see `NATIVE_CALL_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Idle ms before the process is stopped. The host clamps it too. */
  idleTimeoutMs?: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
/** Contribution-local ids: no dots, because the host joins on dots. */
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ICONS: ReadonlySet<string> = new Set(ICON_NAMES);

/** The panel id a legacy `panel: "…"` string is normalised to. */
export const LEGACY_PANEL_ID = 'main';

/**
 * A package-relative path that cannot escape the package.
 *
 * `../` in a manifest path is a directory traversal against whatever read the
 * package — worth refusing at the format level rather than trusting every
 * consumer to be careful.
 */
function isSafePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length < 256 &&
    !p.startsWith('/') &&
    !/^[a-zA-Z]:/.test(p) &&
    !p.split(/[\\/]/).includes('..')
  );
}

/**
 * What the INSTALLER knows and the manifest cannot claim for itself.
 *
 * Exactly one field so far, and the shape exists to keep it that way: a trust
 * decision belongs to whoever chose to install the package, never to the
 * package. `limits: "extended"` is a request that only a caller passing
 * `trusted: true` can grant — a local folder, developer mode, or a publisher
 * the user has trusted.
 *
 * Defaults to untrusted, which is what the REGISTRY's own validation must use:
 * it runs on a server, for a package nobody has chosen to trust yet, and a
 * default of "trusted" there would publish a plugin against ceilings no
 * installing machine would honour.
 */
export interface ManifestParseOptions {
  trusted?: boolean;
}

export interface ManifestResult {
  manifest: PluginManifest | null;
  /** Empty exactly when `manifest` is non-null. */
  errors: string[];
}

/** An empty, fully-normalised contribution block. */
function emptyContributes(): PluginContributes {
  return {
    commands: [], panels: [], layerKinds: [], effects: [], exporters: [], importers: [], presets: [],
    net: null, inspector: [], tools: [], shortcuts: [], expressions: [], audioEffects: [],
  };
}

/**
 * Does a `contributes` block actually declare anything?
 *
 * ★ The version gates below must fire on a block that DECLARES something, not
 * on a block that merely EXISTS — because a normalised block always exists.
 *
 * `parseManifest` always writes `contributes`, including for an API-1 manifest
 * that never had one, and the installed-plugin index stores that normalised
 * manifest. So every boot re-parses this parser's own output (see
 * `validateMeta` in `pluginStore.ts`), and a gate keyed on existence rejects
 * the app's own writing — silently dropping every installed plugin at the next
 * launch. Keyed on content, an empty block round-trips and an author who really
 * did declare commands under `"apiVersion": 1` is still told so.
 */
function declaresContributions(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const c = raw as Record<string, unknown>;
  for (const [key, v] of Object.entries(c)) {
    // `null` and `[]` are what `emptyContributes()` writes for "nothing here".
    if (v == null) continue;
    if (!Array.isArray(v)) return true;
    if (v.length === 0) continue;
    /*
      The one non-empty thing normalising an API-1 package produces on its own:
      a bare `panel: "panel.html"` promoted to the single legacy panel entry.
      Refusing it would refuse the classic API-1 shape — which is the shape most
      likely to have been installed longest.

      This does mean an API-1 author who hand-writes that exact entry is no
      longer told to bump their apiVersion. That is the right trade: the result
      is identical to the `panel` key they are allowed to write, and the cost of
      the alternative is a plugin that uninstalls itself overnight.
    */
    if (
      key === 'panels' &&
      v.length === 1 &&
      (v[0] as { id?: unknown } | null)?.id === LEGACY_PANEL_ID
    ) continue;
    return true;
  }
  return false;
}

/**
 * Validate `contributes`, pushing messages rather than throwing.
 *
 * Takes `name` because a legacy panel has no declared title and the plugin's
 * own name is the only honest thing to put in the tab.
 *
 * ── Idempotent, and that is a requirement rather than a nicety ───────────────
 *
 * `parseManifest(parseManifest(x).manifest)` must equal `parseManifest(x)`. The
 * store persists the NORMALISED manifest and re-parses it at every boot, so any
 * asymmetry between what this emits and what it accepts is not a cosmetic
 * inconsistency — it is a plugin the user has to install again after every
 * restart. `manifestRoundTrip.test.ts` is that property.
 */
function parseContributes(
  raw: unknown,
  legacyPanel: unknown,
  name: string,
  apiVersion: number,
  errors: string[],
  options: ManifestParseOptions,
): PluginContributes {
  const out = emptyContributes();

  if (raw !== undefined && apiVersion < 2 && declaresContributions(raw)) {
    errors.push('"contributes" requires "apiVersion": 2. Bump it, or remove the block.');
    return out;
  }
  if (raw !== undefined && legacyPanel !== undefined) {
    // Whichever one won, the other would be silently ignored, and the author
    // would be debugging a panel that "does not open" while looking at a
    // manifest that declares it twice.
    errors.push('Declare a panel either as "panel" or in "contributes.panels" — not both.');
    return out;
  }

  if (raw === undefined) {
    // API 1 shape. A bare `panel` string becomes the one declared panel.
    if (legacyPanel !== undefined) {
      if (!isSafePath(legacyPanel)) {
        errors.push('"panel", when present, must be a package-relative path to an HTML file.');
      } else {
        // `shared`, like every other undeclared panel. An API-1 package predates
        // placement entirely, and the one thing it must keep doing is what it
        // did before.
        out.panels.push({
          id: LEGACY_PANEL_ID,
          title: name || LEGACY_PANEL_ID,
          entry: legacyPanel,
          placement: 'shared',
        });
      }
    }
    return out;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"contributes" must be an object.');
    return out;
  }
  const c = raw as Record<string, unknown>;

  for (const key of RESERVED_CONTRIBUTION_KEYS) {
    const v = c[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      errors.push(`"contributes.${key}" must be an array.`);
    } else if (v.length > 0) {
      errors.push(`"contributes.${key}" is not supported in this version.`);
    }
  }

  if (c.presets !== undefined) {
    if (apiVersion >= 6) {
      out.presets = parsePresets(c.presets, 'contributes.presets', errors);
    } else if (!Array.isArray(c.presets)) {
      errors.push('"contributes.presets" must be an array.');
    } else if (c.presets.length > 0) {
      errors.push('"contributes.presets" requires "apiVersion": 6.');
    }
  }

  if (c.importers !== undefined) {
    if (apiVersion >= 6) {
      out.importers = parseImporters(c.importers, 'contributes.importers', errors);
    } else if (!Array.isArray(c.importers)) {
      errors.push('"contributes.importers" must be an array.');
    } else if (c.importers.length > 0) {
      errors.push('"contributes.importers" requires "apiVersion": 6.');
    }
  }

  if (c.exporters !== undefined) {
    if (apiVersion >= 6) {
      out.exporters = parseExporters(c.exporters, 'contributes.exporters', errors);
    } else if (!Array.isArray(c.exporters)) {
      errors.push('"contributes.exporters" must be an array.');
    } else if (c.exporters.length > 0) {
      // Same back-compat rule as `layerKinds` and `effects`: an empty block
      // declares nothing and stays valid on an older grammar.
      errors.push('"contributes.exporters" requires "apiVersion": 6.');
    }
  }

  if (c.layerKinds !== undefined) {
    if (apiVersion >= 3) {
      out.layerKinds = parseLayerKinds(c.layerKinds, errors, ICONS, { apiVersion });
    } else if (!Array.isArray(c.layerKinds)) {
      errors.push('"contributes.layerKinds" must be an array.');
    } else if (c.layerKinds.length > 0) {
      // Only a NON-EMPTY block is using the feature. An API-2 manifest that
      // spells out `layerKinds: []` was valid before this version shipped and
      // stays valid — refusing it would break packages that declared nothing.
      //
      // The message names the version, because the fix is a one-character edit
      // and "not supported in this version" sends the author looking for a
      // newer editor they already have.
      errors.push('"contributes.layerKinds" requires "apiVersion": 3.');
    }
  }

  if (c.effects !== undefined) {
    if (apiVersion >= 4) {
      out.effects = parseEffects(c.effects, errors, {
        trusted: options.trusted === true,
        // `effects` itself has been API 4 since it shipped; the fields INSIDE an
        // effect have their own versions (see `EFFECT_FIELD_SINCE`), because an
        // older host ignores an unknown key rather than refusing it.
        apiVersion,
      });
    } else if (!Array.isArray(c.effects)) {
      errors.push('"contributes.effects" must be an array.');
    } else if (c.effects.length > 0) {
      // Same back-compat rule as `layerKinds`, and it matters more here: every
      // manifest written against API 1–3 was allowed to spell out
      // `effects: []`, because the key was RESERVED and validated as
      // must-be-empty. Requiring API 4 for an empty block would break packages
      // that declared nothing, which is the opposite of what a version gate is
      // for.
      errors.push('"contributes.effects" requires "apiVersion": 4.');
    }
  }

  /*
    A `"shader"` kind's shader must be one of THIS plugin's effects.

    Checked here rather than in either validator, because it is the one rule
    that spans both contribution lists and neither list can see the other. The
    kind is DROPPED rather than accepted with a dangling name: a shader kind
    that names nothing draws nothing, and an author who ships one finds out from
    a user staring at an empty layer.

    Only reachable when both lists parsed, so an effect that was itself refused
    takes its kind with it — which is right: the kind could not have drawn with
    a shader the host rejected either.
  */
  if (out.layerKinds.length > 0) {
    const effectIds = new Set(out.effects.map((e) => e.id));
    out.layerKinds = out.layerKinds.filter((kind) => {
      if (kind.shader === undefined) return true;
      if (effectIds.has(kind.shader)) return true;
      errors.push(
        `"contributes.layerKinds" kind "${kind.id}" draws with shader "${kind.shader}", `
        + `which this plugin does not declare in "contributes.effects"${effectIds.size > 0 ? ` (it declares: ${[...effectIds].join(', ')})` : ''}.`,
      );
      return false;
    });
  }

  // `null` is ABSENT, not a malformed block. That is not leniency for authors'
  // sake — it is the value `emptyContributes()` writes for "this plugin asks
  // for no network", so a re-parse of our own normalised manifest arrives here
  // with `null` every time. Testing `!== undefined` made that reject: below API
  // 4 with "requires apiVersion 4", and at API 4 with `parseNet(null)` saying
  // "must be an object". Either way the record was dropped at the next boot.
  if (c.net !== undefined && c.net !== null) {
    if (apiVersion >= 4) {
      out.net = parseNet(c.net, errors);
    } else {
      // No empty-block escape hatch here, unlike `effects` and `layerKinds`.
      // `net` was never a reserved key, so no older manifest can be declaring
      // it — anything that does is asking for the capability.
      errors.push('"contributes.net" requires "apiVersion": 4.');
    }
  }

  if (c.commands !== undefined) {
    if (!Array.isArray(c.commands)) {
      errors.push('"contributes.commands" must be an array.');
    } else {
      const seen = new Set<string>();
      c.commands.forEach((entry, i) => {
        const at = `contributes.commands[${i}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`"${at}" must be an object.`);
          return;
        }
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id : '';
        if (!LOCAL_ID_RE.test(id)) {
          errors.push(`"${at}.id" must be lowercase letters, digits and dashes (1–64 characters).`);
          return;
        }
        if (seen.has(id)) {
          errors.push(`"${at}.id" duplicates an earlier command id "${id}".`);
          return;
        }
        seen.add(id);

        const label = typeof e.label === 'string' ? e.label.trim() : '';
        if (!label || label.length > 80) {
          errors.push(`"${at}.label" is required (1–80 characters).`);
          return;
        }
        if (e.icon !== undefined && (typeof e.icon !== 'string' || !ICONS.has(e.icon))) {
          errors.push(`"${at}.icon" is not an icon this editor has. Omit it to use the plugin glyph.`);
          return;
        }
        if (
          e.submenu !== undefined &&
          (typeof e.submenu !== 'string' || !e.submenu.trim() || e.submenu.length > 40)
        ) {
          errors.push(`"${at}.submenu", when present, is 1–40 characters.`);
          return;
        }
        out.commands.push({
          id,
          label,
          ...(typeof e.icon === 'string' ? { icon: e.icon } : {}),
          ...(e.needsSelection === true ? { needsSelection: true } : {}),
          ...(typeof e.submenu === 'string' && e.submenu.trim() ? { submenu: e.submenu.trim() } : {}),
        });
      });
    }
  }

  if (c.panels !== undefined) {
    if (!Array.isArray(c.panels)) {
      errors.push('"contributes.panels" must be an array.');
    } else {
      const seen = new Set<string>();
      c.panels.forEach((entry, i) => {
        const at = `contributes.panels[${i}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`"${at}" must be an object.`);
          return;
        }
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id : '';
        if (!LOCAL_ID_RE.test(id)) {
          errors.push(`"${at}.id" must be lowercase letters, digits and dashes (1–64 characters).`);
          return;
        }
        if (seen.has(id)) {
          errors.push(`"${at}.id" duplicates an earlier panel id "${id}".`);
          return;
        }
        seen.add(id);

        const title = typeof e.title === 'string' ? e.title.trim() : '';
        if (!title || title.length > 80) {
          errors.push(`"${at}.title" is required (1–80 characters) — it is the tab label.`);
          return;
        }
        // Same rule as `main`: a panel entry is a path the host will read out
        // of the package, so it gets the same traversal check.
        if (!isSafePath(e.entry)) {
          errors.push(`"${at}.entry" must be a package-relative path to an HTML file.`);
          return;
        }

        // Refused rather than defaulted. A typo like "left" would otherwise mean
        // the panel quietly appears somewhere the author never chose, and the
        // only symptom is "my panel is in the wrong place" with nothing to read.
        let placement: PluginPanelPlacement = 'shared';
        if (e.placement !== undefined) {
          if (typeof e.placement !== 'string' || !PANEL_PLACEMENTS.includes(e.placement as PluginPanelPlacement)) {
            errors.push(
              `"${at}.placement" must be one of ${PANEL_PLACEMENTS.map((p) => `"${p}"`).join(', ')}.`,
            );
            return;
          }
          placement = e.placement as PluginPanelPlacement;
        }

        if (e.icon !== undefined && (typeof e.icon !== 'string' || !ICONS.has(e.icon))) {
          errors.push(`"${at}.icon" is not an icon this editor has. Omit it to use the plugin glyph.`);
          return;
        }
        // Not an error, because the panel still works — it just gets the generic
        // glyph, and on an icon-only rail that is worth saying out loud once.
        // Refusing it outright would make `icon` mandatory in all but name for
        // the two placements where it matters.
        if (placement !== 'shared' && e.icon === undefined) {
          errors.push(
            `"${at}" asks for its own tab, so it needs an "icon" — the sidebar rail shows glyphs, not titles.`,
          );
          return;
        }

        out.panels.push({
          id,
          title,
          entry: e.entry,
          placement,
          ...(typeof e.icon === 'string' ? { icon: e.icon } : {}),
        });
      });
    }
  }

  /*
    The UI block, parsed LAST because three of the four name a command.

    A button, a shortcut and (soon) anything else that acts has to point at
    something in `contributes.commands`, and checking that here — rather than at
    the moment the user presses it — is the difference between an install error
    with a line number and a control that silently does nothing.
  */
  const commandIds = new Set(out.commands.map((cmd) => cmd.id));

  if (c.inspector !== undefined) {
    if (apiVersion >= 7) {
      out.inspector = parseInspectorPanels(c.inspector, 'contributes.inspector', out.commands, ICONS, errors);
    } else if (!Array.isArray(c.inspector)) {
      errors.push('"contributes.inspector" must be an array.');
    } else if (c.inspector.length > 0) {
      // Same back-compat rule every other gated key follows: an empty block
      // declares nothing and stays valid on an older grammar.
      errors.push('"contributes.inspector" requires "apiVersion": 7.');
    }
  }

  if (c.tools !== undefined) {
    if (apiVersion >= 7) {
      out.tools = parsePluginTools(c.tools, 'contributes.tools', ICONS, errors);
    } else if (!Array.isArray(c.tools)) {
      errors.push('"contributes.tools" must be an array.');
    } else if (c.tools.length > 0) {
      errors.push('"contributes.tools" requires "apiVersion": 7.');
    }
  }

  if (c.shortcuts !== undefined) {
    if (apiVersion >= 7) {
      out.shortcuts = parsePluginShortcuts(c.shortcuts, 'contributes.shortcuts', commandIds, errors);
    } else if (!Array.isArray(c.shortcuts)) {
      errors.push('"contributes.shortcuts" must be an array.');
    } else if (c.shortcuts.length > 0) {
      errors.push('"contributes.shortcuts" requires "apiVersion": 7.');
    }
  }

  if (c.expressions !== undefined) {
    if (apiVersion >= 7) {
      out.expressions = parsePluginExpressions(c.expressions, 'contributes.expressions', errors);
    } else if (!Array.isArray(c.expressions)) {
      errors.push('"contributes.expressions" must be an array.');
    } else if (c.expressions.length > 0) {
      errors.push('"contributes.expressions" requires "apiVersion": 7.');
    }
  }

  // Grammar 8. The parser owns its own version gate (it needs the number to
  // word the message), so unlike the four above there is no wrapper here.
  if (c.audioEffects !== undefined) {
    out.audioEffects = parseAudioEffects(c.audioEffects, errors, apiVersion);
  }

  return out;
}

/** Validate `activationEvents` against what the plugin actually declares. */
function parseActivationEvents(
  raw: unknown,
  contributes: PluginContributes,
  errors: string[],
): ActivationEvent[] {
  // Missing or empty both mean "no opinion", and the safe reading of no opinion
  // is the API-1 behaviour: start it.
  if (raw === undefined) return ['onStartup'];
  if (!Array.isArray(raw)) {
    errors.push('"activationEvents" must be an array.');
    return ['onStartup'];
  }
  if (raw.length === 0) return ['onStartup'];

  const commandIds = new Set(contributes.commands.map((c) => c.id));
  const panelIds = new Set(contributes.panels.map((p) => p.id));
  const layerKindIds = new Set(contributes.layerKinds.map((k) => k.id));
  const out: ActivationEvent[] = [];

  for (const ev of raw) {
    if (typeof ev !== 'string') {
      errors.push('Every entry in "activationEvents" must be a string.');
      continue;
    }
    if (ev === 'onStartup') {
      if (!out.includes('onStartup')) out.push('onStartup');
      continue;
    }
    // No target to check: unlike a command or a panel, this one names nothing
    // the manifest has to also declare.
    if (ev === 'onRenderFinished') {
      if (!out.includes('onRenderFinished')) out.push('onRenderFinished');
      continue;
    }
    const command = /^onCommand:(.*)$/.exec(ev);
    if (command) {
      // A reference to something that does not exist is an event that can never
      // fire — which presents to the user as a plugin that simply never starts,
      // with nothing anywhere saying why.
      if (!commandIds.has(command[1]!)) {
        errors.push(`"activationEvents" refers to command "${command[1]}", which is not in "contributes.commands".`);
        continue;
      }
      if (!out.includes(ev as ActivationEvent)) out.push(ev as ActivationEvent);
      continue;
    }
    const panel = /^onPanel:(.*)$/.exec(ev);
    if (panel) {
      if (!panelIds.has(panel[1]!)) {
        errors.push(`"activationEvents" refers to panel "${panel[1]}", which is not in "contributes.panels".`);
        continue;
      }
      if (!out.includes(ev as ActivationEvent)) out.push(ev as ActivationEvent);
      continue;
    }
    const tool = /^onTool:(.*)$/.exec(ev);
    if (tool) {
      if (!contributes.tools.some((t) => t.id === tool[1]!)) {
        errors.push(`"activationEvents" refers to tool "${tool[1]}", which is not in "contributes.tools".`);
        continue;
      }
      if (!out.includes(ev as ActivationEvent)) out.push(ev as ActivationEvent);
      continue;
    }
    const layerKind = /^onLayerKind:(.*)$/.exec(ev);
    if (layerKind) {
      if (!layerKindIds.has(layerKind[1]!)) {
        errors.push(
          `"activationEvents" refers to layer kind "${layerKind[1]}", which is not in "contributes.layerKinds".`,
        );
        continue;
      }
      if (!out.includes(ev as ActivationEvent)) out.push(ev as ActivationEvent);
      continue;
    }
    errors.push(
      `Unknown activation event "${ev}". Valid: onStartup, onCommand:<id>, onPanel:<id>, onLayerKind:<id>, onTool:<id>.`,
    );
  }

  return out.length > 0 ? out : ['onStartup'];
}

/** Validate raw parsed JSON as a manifest. Never throws. */
export function parseManifest(raw: unknown, options: ManifestParseOptions = {}): ManifestResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, errors: ['plugin.json is not a JSON object.'] };
  }
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!ID_RE.test(id)) {
    errors.push('"id" must be reverse-DNS and lowercase, e.g. "studio.acme.easing-lab".');
  }
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || name.length > 80) errors.push('"name" is required (1–80 characters).');

  const version = typeof r.version === 'string' ? r.version.trim() : '';
  if (!VERSION_RE.test(version)) errors.push('"version" must be semver, e.g. "1.0.0".');

  const description = typeof r.description === 'string' ? r.description.trim() : '';
  if (!description || description.length > 400) {
    errors.push('"description" is required (1–400 characters) — it is what the user reads before installing.');
  }

  const apiVersion = typeof r.apiVersion === 'number' ? r.apiVersion : NaN;
  if (!Number.isInteger(apiVersion) || apiVersion < 1) {
    errors.push('"apiVersion" must be a whole number ≥ 1.');
  } else if (apiVersion > MANIFEST_VERSION) {
    // Compared against the GRAMMAR version, not the host API version. From 5
    // they move independently, and this field has only ever described the
    // grammar — what a plugin can CALL is `requires`.
    errors.push(
      `This plugin's manifest is written for format ${apiVersion}; this version of Premation `
      + `reads up to ${MANIFEST_VERSION}. Update the app.`,
    );
  }

  const requires = parseCapabilityList(r.requires, 'requires', errors);
  const optional = parseCapabilityList(r.optional, 'optional', errors);

  /*
    The runtime tier.

    Absent means `sandboxed`, and that default is load-bearing rather than
    convenient: every manifest published before this field existed must keep
    meaning exactly what it meant, and the failure direction if this were
    wrong is that a field nobody wrote silently grants unrestricted access.

    An unknown value is refused rather than defaulted. "runtime": "sandbox" —
    a plausible typo — must not quietly become the strict tier if the author
    meant the loose one, nor the loose tier if they meant the strict one; and
    a future tier name read by an older build is precisely the case where
    guessing is worst.
  */
  let runtime: RuntimeTier = DEFAULT_RUNTIME_TIER;
  if (r.runtime !== undefined) {
    if (typeof r.runtime !== 'string' || !(RUNTIME_TIERS as readonly string[]).includes(r.runtime)) {
      errors.push(
        `"runtime" must be one of ${RUNTIME_TIERS.join(', ')} — omit it for the sandboxed default.`,
      );
    } else {
      runtime = r.runtime as RuntimeTier;
    }
  }

  if (!isSafePath(r.main)) errors.push('"main" must be a package-relative path to the entry module.');

  const native = parseNative(r.native, errors);

  const contributes = parseContributes(r.contributes, r.panel, name, apiVersion, errors, options);
  const activationEvents = parseActivationEvents(r.activationEvents, contributes, errors);

  const permsRaw = r.permissions;
  const permissions: PluginPermission[] = [];
  if (permsRaw !== undefined) {
    if (!Array.isArray(permsRaw)) {
      errors.push('"permissions" must be an array.');
    } else {
      for (const p of permsRaw) {
        if (typeof p !== 'string' || !(p in PERMISSIONS)) {
          errors.push(`Unknown permission "${String(p)}". Valid: ${ALL_PERMISSIONS.join(', ')}.`);
        } else if (!permissions.includes(p as PluginPermission)) {
          permissions.push(p as PluginPermission);
        }
      }
    }
  }

  /*
    ★ The permission and the host list must agree, in BOTH directions.

    They are two halves of one statement — "this plugin reaches the network, and
    these are the places" — and either half alone is a manifest that means
    something different from what it looks like:

      • `net:fetch` with no hosts is a permission the consent screen would show
        with nothing under it. The user is asked to approve "contact websites"
        and shown no websites, which is the vaguest possible version of the one
        permission that most needs to be specific.

      • Hosts with no `net:fetch` is a list the user is never shown, attached to
        a capability the plugin does not have. Harmless today and exactly the
        shape of a plugin that adds the permission in its next version, when the
        hosts have already been sitting in the manifest unread.

    Checked here rather than in `parseNet`, because only this scope can see both.
  */
  const wantsNet = permissions.includes('net:fetch');
  if (wantsNet && !contributes.net) {
    errors.push(
      'The "net:fetch" permission requires a "contributes.net.hosts" list — the consent screen names the hosts, and a permission with nothing under it tells the user nothing.',
    );
  }
  if (!wantsNet && contributes.net) {
    errors.push(
      '"contributes.net" was declared without the "net:fetch" permission. Ask for the permission, or remove the block.',
    );
  }

  if (errors.length > 0) return { manifest: null, errors };
  return {
    manifest: {
      id,
      name,
      version,
      description,
      apiVersion,
      // Always written, never omitted-when-default. Every consumer asks which
      // tier this is, and an optional field would make each of them re-derive
      // the default — which is the single value that must not be got wrong.
      runtime,
      main: r.main as string,
      ...(typeof r.author === 'string' && r.author.trim() ? { author: r.author.trim().slice(0, 80) } : {}),
      ...(typeof r.homepage === 'string' && /^https?:\/\//i.test(r.homepage)
        ? { homepage: r.homepage.slice(0, 300) }
        : {}),
      permissions,
      // Omitted when empty rather than stored as `[]`. Absent means "whatever
      // this `apiVersion` implied", which is a different statement from "needs
      // nothing" — and every manifest published before capabilities existed
      // means the first one.
      ...(requires.length > 0 ? { requires } : {}),
      ...(optional.length > 0 ? { optional } : {}),
      contributes,
      activationEvents,
      // Omitted when absent rather than stored as an empty block. "This package
      // ships no compiled code" has to be the shape of the field being MISSING,
      // so that no consumer can read a present-but-empty `native` as a tier it
      // should ask the user about.
      ...(native ? { native } : {}),
    },
    errors: [],
  };
}

/** The same private helper every sibling schema module keeps. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The `native` block.
 *
 * Refuses rather than repairs, at every step, which is not the house style for
 * optional manifest fields and is the right style for this one: everything here
 * decides which FILE a compiled module is loaded from, and a validator that
 * quietly drops a malformed platform key turns "my arm64 build did not load"
 * into a silent fallback onto the x64 one.
 *
 * What it does NOT check: whether the paths exist (the package reader knows
 * that, and a manifest is parsed by the registry too, where the files are not
 * present) and whether the platform key is one this build has heard of (a
 * package built for a platform the app grows support for next year must stay
 * readable today — see `nativePlatforms.ts`).
 */
function parseNative(raw: unknown, errors: string[]): PluginNative | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    errors.push('"native" must be an object with an "abi" number and a "platforms" map.');
    return undefined;
  }

  const abi = typeof raw.abi === 'number' ? raw.abi : NaN;
  if (!Number.isInteger(abi) || abi < 1) {
    errors.push('"native.abi" must be the whole MAJOR ABI number the module was built against.');
  }

  if (!isPlainObject(raw.platforms)) {
    errors.push(
      '"native.platforms" must map a platform-arch key ("win32-x64") to a package-relative path.',
    );
    return undefined;
  }

  const platforms: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.platforms)) {
    // `platform-arch`, both lowercase, and nothing else. The key is looked up
    // by string equality against `process.platform`-`process.arch`, so a key
    // that is merely close is a binary that is never found and never reported.
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(key)) {
      errors.push(`"native.platforms" key "${key}" must be "<platform>-<arch>", e.g. "win32-x64".`);
      continue;
    }
    if (!isSafePath(value)) {
      errors.push(`"native.platforms.${key}" must be a package-relative path to the module.`);
      continue;
    }
    platforms[key] = value as string;
  }
  if (Object.keys(platforms).length === 0) {
    errors.push('"native.platforms" names no usable binary.');
  }

  const hashes: Record<string, string> = {};
  if (raw.hashes !== undefined) {
    if (!isPlainObject(raw.hashes)) {
      errors.push('"native.hashes" must map a package-relative path to a sha256 hex string.');
    } else {
      for (const [key, value] of Object.entries(raw.hashes)) {
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
          // Not fatal, and deliberately so: the hash that decides anything is
          // the one the main process measures. A malformed one here is an
          // author's packaging mistake, not a reason the plugin cannot load.
          continue;
        }
        hashes[key] = value.toLowerCase();
      }
    }
  }

  let threadSafety: ThreadSafety | undefined;
  if (raw.threadSafety !== undefined) {
    if (!(THREAD_SAFETY as readonly unknown[]).includes(raw.threadSafety)) {
      errors.push(`"native.threadSafety" must be one of ${THREAD_SAFETY.join(', ')}.`);
    } else {
      threadSafety = raw.threadSafety as ThreadSafety;
    }
  }

  const ms = (value: unknown, field: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push(`"native.${field}" must be a positive number of milliseconds.`);
      return undefined;
    }
    return value;
  };
  const timeoutMs = ms(raw.timeoutMs, 'timeoutMs');
  const idleTimeoutMs = ms(raw.idleTimeoutMs, 'idleTimeoutMs');

  return {
    abi,
    platforms,
    ...(Object.keys(hashes).length > 0 ? { hashes } : {}),
    ...(threadSafety ? { threadSafety } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  };
}

/**
 * Validate a `requires` / `optional` list.
 *
 * Shape only. Whether a capability is one THIS host has is decided at install
 * (`checkCapabilities`), not here, and the split matters: a manifest naming
 * `webgpu` is perfectly valid, and refusing it during parsing would make a
 * plugin unreadable on a WebGL2 machine rather than merely uninstallable —
 * which would also stop the registry, which has no GPU at all, from validating
 * it on publish.
 */
function parseCapabilityList(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`"${field}" must be an array of capability names.`);
    return [];
  }
  if (raw.length > 32) {
    errors.push(`"${field}" lists ${raw.length} capabilities; the limit is 32.`);
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(entry)) {
      errors.push(`"${field}" contains ${JSON.stringify(entry)}, which is not a capability name.`);
      continue;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * One line summarising what a plugin adds — "6 commands · 1 panel".
 *
 * The point of declaring contributions is that this can be shown on a listing
 * page BEFORE install, so it takes the counts and not a running plugin.
 */
export function describeContributions(contributes: PluginContributes): string {
  const parts: string[] = [];
  const { commands, panels, layerKinds, tools } = contributes;
  if (commands.length > 0) parts.push(`${commands.length} command${commands.length === 1 ? '' : 's'}`);
  if (panels.length > 0) parts.push(`${panels.length} panel${panels.length === 1 ? '' : 's'}`);
  // Listed beside panels because a tool is the most VISIBLE thing a plugin can
  // add: it takes a slot on the toolbar and, while active, every click in the
  // viewport. Someone deciding whether to install should see that up front.
  if (tools.length > 0) parts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}`);
  // Listed because it is the contribution that changes a DOCUMENT. A user
  // deciding whether to uninstall should be able to see that this one leaves
  // something behind in their projects.
  if (layerKinds.length > 0) {
    parts.push(`${layerKinds.length} layer type${layerKinds.length === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Adds no commands or panels.';
}

/**
 * Does this plugin want to start as soon as the editor does?
 *
 * The one question the host asks at boot, and the difference between spawning
 * forty workers and spawning none.
 */
export function activatesOnStartup(manifest: PluginManifest): boolean {
  return manifest.activationEvents.includes('onStartup');
}

/**
 * Does `manifest` want to wake when a document containing one of its layer
 * kinds is opened?
 *
 * Implicit rather than declared: a plugin that defines a layer kind and does
 * NOT start when one appears is a plugin whose layers sit inert in a project
 * that has it installed. There is no coherent reason to opt out, and making it
 * opt-in would mean every author gets it wrong once.
 */
export function activatesOnLayerKind(manifest: PluginManifest, kindId: string): boolean {
  return manifest.contributes.layerKinds.some((k) => k.id === kindId)
    || manifest.activationEvents.includes(`onLayerKind:${kindId}` as ActivationEvent);
}

/**
 * Does `manifest` want to wake when the user picks one of its tools?
 *
 * Implicit, like `activatesOnLayerKind` and for a sharper version of the same
 * reason: a tool whose plugin is not running takes every click in the viewport
 * and answers none of them, so there is no coherent way to opt out.
 */
export function activatesOnTool(manifest: PluginManifest, toolId: string): boolean {
  return manifest.contributes.tools.some((t) => t.id === toolId)
    || manifest.activationEvents.includes(`onTool:${toolId}` as ActivationEvent);
}
