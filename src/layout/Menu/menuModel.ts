/**
 * Application menu model — a data-driven map of menu groups → items, each
 * bound to a command id. This is the extension point: future engines append
 * items (or whole groups) here, and the CommandRegistry supplies the label /
 * enabled state / shortcut, so the menu bar stays a thin renderer.
 *
 * SHAPE. Each top-level group is meant to fit on screen without scrolling —
 * roughly what After Effects and Premiere manage: the handful of entries a
 * user reaches for constantly stay at the top level, and every long family
 * (five reframe aspects, five caption verbs, eight keyframe assistants…)
 * collapses into a parent carrying `children`. `menuSubmenus.test.ts` pins
 * the ceiling, so a group that grows past it has to fold something rather
 * than run off the bottom of the window again.
 */

import { BuiltinCommands } from '@core/commands/Command';
import { cloudProjectsEnabled } from '@core/config/edition';
// `tryCoreServices`, not `getFileManager`: this model's `visible` predicates are
// evaluated wherever the menu renders, and TitleBar renders on /login and
// /dashboard, where the core has not booted. `coreServices()` throws there.
import { tryCoreServices } from '@core/services/coreServices';
import { buildWorkspaceMenuItems } from './workspaceMenu';

/** Project-lifecycle command ids (registered against ProjectManager at boot). */
export const ProjectCommands = {
  New: 'project.new',
  Open: 'project.open',
  Save: 'project.save',
  SaveAs: 'project.saveAs',
  SaveToComputer: 'project.saveToComputer',
  /**
   * Fork the project on the SERVER. This is what Save As did in the cloud
   * editor, which is why Save As could not write a file to the user's machine
   * there. Split out so both things exist and each says what it does.
   */
  SaveCopyToCloud: 'project.saveCopyToCloud',
  IncrementAndSave: 'project.incrementAndSave',
  /**
   * End-to-end encrypted sync of the open `.motion` bundle.
   *
   * The whole stack — cipher, chunk diff, three-way reconcile, HTTP transport,
   * and the `/api/sync` endpoints behind it — shipped without a single way to
   * invoke it. This is that way.
   */
  Sync: 'project.sync',
  Close: 'project.close',
  About: 'help.about',
} as const;

export interface MenuItemModel {
  commandId?: string;
  /** Overrides the command's label. */
  label?: string;
  separator?: boolean;
  /**
   * A nested menu. Either a fixed list, or a thunk evaluated by the RENDERER
   * every time the menu is drawn — which is what a submenu built from user data
   * needs (see `workspaceMenu.ts`: saving a layout must make it appear without
   * a reload, and `useAppMenuGroups` memoises).
   *
   * A parent carrying `children` needs no `commandId`; it is not itself an
   * action, so the renderers must not grey it out for lacking one.
   */
  children?: ReadonlyArray<MenuItemModel> | (() => ReadonlyArray<MenuItemModel>);
  /**
   * A direct action, for entries that CANNOT be commands — a workspace the user
   * invented at runtime has no registration to point at. Ignored when
   * `commandId` is set; the registry stays the single source for anything that
   * can live in it (label, enabled state, shortcut, palette entry).
   */
  onSelect?: () => void;
  /** Checked state for an `onSelect` entry. Command-backed items use `Command.isChecked`. */
  checked?: () => boolean;
  /**
   * Hide the item entirely when this returns false. Evaluated per render by
   * `useAppMenuGroups`, which also collapses the separators left behind.
   *
   * For EDITION differences, not for enabled/disabled state — a command that
   * exists but cannot run right now should stay visible and grey out, which is
   * what `Command.enabled` already does. This is for entries whose command is
   * never registered in this build, and which would otherwise sit permanently
   * disabled next to items that work.
   */
  visible?: () => boolean;
}

export interface MenuGroupModel {
  id: string;
  label: string;
  items: MenuItemModel[];
}

/**
 * Label of the Layer ▸ New submenu. `useAppMenuGroups` appends plugin layer
 * kinds inside it, so the two files agree on the name through this constant
 * rather than through a string that has to be kept in step by hand.
 */
export const LAYER_NEW_SUBMENU_LABEL = 'New';

export const APP_MENU: MenuGroupModel[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { commandId: ProjectCommands.New, label: 'New Project' },
      { commandId: ProjectCommands.Open, label: 'Open Project…' },
      { separator: true },
      { commandId: ProjectCommands.Save, label: 'Save' },
      { commandId: ProjectCommands.SaveAs, label: 'Save As…' },
      /**
       * Only where it is a DIFFERENT command from Save As.
       *
       * Save As now opens a save dialog and writes a portable `.motion` file in
       * every build. On the desktop that is genuinely distinct from Save As,
       * which writes the local-first directory bundle that Sync reconciles
       * against — so both belong there. Anywhere else the two would run the
       * identical code under two names, which is two menu entries for one
       * feature and a user wondering which one is the real save.
       */
      {
        commandId: ProjectCommands.SaveToComputer,
        label: 'Save Portable Copy…',
        visible: () => tryCoreServices()?.files.environment === 'electron',
      },
      {
        commandId: ProjectCommands.SaveCopyToCloud,
        label: 'Save Copy to Cloud…',
        visible: cloudProjectsEnabled,
      },
      { commandId: ProjectCommands.IncrementAndSave, label: 'Increment and Save' },
      { separator: true },
      { commandId: ProjectCommands.Sync, label: 'Sync Project…' },
      { separator: true },
      // Import sits with Export rather than under Layer: what arrives is a
      // FILE from outside the project, and the layer tree it becomes is the
      // consequence, not the request.
      { commandId: 'file.import3DModel', label: 'Import 3D Model…' },
      { commandId: 'file.export', label: 'Export…' },
      { separator: true },
      // Registered ONLY under `cloudProjectsEnabled()` (see Providers) —
      // snapshots live on the backend, keyed by project id. The registration
      // comment says it stays unregistered locally so there is no
      // "permanently-disabled menu item next to a feature that does work"…
      // but this model is static, so the disabled item appeared anyway. Same
      // predicate on both sides now, which is what that intent required.
      { commandId: 'file.versionHistory', label: 'Version History…', visible: cloudProjectsEnabled },
      { separator: true },
      { commandId: ProjectCommands.Close, label: 'Close Project' },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { commandId: BuiltinCommands.Undo, label: 'Undo' },
      { commandId: BuiltinCommands.Redo, label: 'Redo' },
      { separator: true },
      { commandId: 'edit.cut', label: 'Cut' },
      { commandId: 'edit.copy', label: 'Copy' },
      { commandId: 'edit.paste', label: 'Paste' },
      { separator: true },
      { commandId: BuiltinCommands.SelectAll, label: 'Select All' },
      { commandId: BuiltinCommands.Deselect, label: 'Deselect' },
      { separator: true },
      { commandId: BuiltinCommands.DuplicateSelected, label: 'Duplicate' },
      { separator: true },
      {
        // Text-based editing. Both act on the transcript panel's selection
        // rather than on layers — delete the selected words' time range from
        // every layer, closing the gap; or select the filler words to delete.
        // Folded beside Delete because that is the verb they refine.
        label: 'Transcript',
        children: [
          { commandId: 'transcript.deleteSelection', label: 'Delete Transcript Selection' },
          { commandId: 'transcript.selectFillers', label: 'Select Filler Words' },
        ],
      },
      { commandId: BuiltinCommands.DeleteSelected, label: 'Delete' },
    ],
  },
  {
    id: 'composition',
    label: 'Composition',
    items: [
      // "New Composition…" was removed on the rationale that compositions are
      // created only from the dashboard, one project per composition. That is
      // no longer true: `openNewCompositionDialog` is live in the empty-comp
      // start cards and the Composition panel menu, so the menu was simply
      // missing an entry for a working feature.
      { commandId: 'comp.new', label: 'New Composition…' },
      {
        // All three act on FOOTAGE rather than on the open comp, which is why
        // they sit beside New Composition rather than under Layer: the result
        // of each is a composition that did not exist before (or, for Assemble
        // on a layer, a comp whose whole cut did not exist before).
        label: 'New From Footage',
        children: [
          { commandId: 'comp.multicam', label: 'New Multicam from Selected Assets…' },
          { commandId: 'comp.newFromSelectedClips', label: 'New Composition from Selected Clips…' },
          { commandId: 'comp.assembleFromFootage', label: 'Assemble from Footage…' },
        ],
      },
      { separator: true },
      { commandId: 'comp.settings', label: 'Composition Settings…' },
      { commandId: 'comp.delete', label: 'Delete Composition' },
      { separator: true },
      {
        // One entry per target shape rather than a dialog: the only input is
        // the aspect, and this way the whole feature is reachable by typing
        // '9:16' into the command palette. Each greys itself out for a comp
        // already at that aspect, which would have nothing to pan within.
        label: 'Auto-Reframe',
        children: [
          { commandId: 'comp.autoReframe.9:16', label: '9:16 Vertical' },
          { commandId: 'comp.autoReframe.1:1', label: '1:1 Square' },
          { commandId: 'comp.autoReframe.4:5', label: '4:5 Portrait' },
          { commandId: 'comp.autoReframe.16:9', label: '16:9 Widescreen' },
          { commandId: 'comp.autoReframe.4:3', label: '4:3 Classic' },
        ],
      },
      {
        // Captions sit under Composition rather than Layer: they are a
        // property of the whole comp (its spoken words), and every one of
        // these acts on all of them at once, not on a selection.
        label: 'Captions',
        children: [
          { commandId: 'captions.import', label: 'Import…' },
          { commandId: 'captions.generate', label: 'Generate from Audio' },
          { commandId: 'captions.exportSrt', label: 'Export .srt…' },
          { commandId: 'captions.exportVtt', label: 'Export .vtt…' },
          { commandId: 'captions.clear', label: 'Remove All' },
        ],
      },
      {
        // The transcript panel's verbs: the same spoken words, as an editable list.
        label: 'Transcript',
        children: [
          { commandId: 'transcript.transcribe', label: 'Transcribe Composition' },
          { commandId: 'transcript.addCaptions', label: 'Convert to Captions' },
          { commandId: 'transcript.exportSrt', label: 'Export .srt…' },
          { commandId: 'transcript.exportVtt', label: 'Export .vtt…' },
        ],
      },
      { separator: true },
      { commandId: 'comp.saveFrame', label: 'Save Frame As PNG' },
      { commandId: 'comp.copyFrame', label: 'Copy Frame to Clipboard' },
      { separator: true },
      // A demo-scene loader, not a composition verb — last, below a rule, so
      // it does not read as part of the working set above it.
      { commandId: 'scene.loadBlockTower', label: 'Load: Block Tower' },
    ],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      {
        // Everything that creates a layer, under one parent — the shape AE
        // uses (Layer ▸ New ▸ …), and the one `useAppMenuGroups` extends with
        // plugin layer kinds, so a plugin's layer sits beside Text and Solid
        // rather than under a menu named after the mechanism providing it.
        label: LAYER_NEW_SUBMENU_LABEL,
        children: [
          { commandId: 'layer.newText', label: 'Text' },
          { commandId: 'layer.newSolid', label: 'Solid…' },
          { commandId: 'layer.newCamera', label: 'Camera' },
          { commandId: 'layer.newLight', label: 'Light' },
          { commandId: 'layer.newNull', label: 'Null Object' },
          { commandId: 'layer.newAdjustment', label: 'Adjustment Layer' },
          { separator: true },
          {
            // The 3D inserts existed only in the TopNav "+" dropdown — a place
            // you browse rather than search. They belong beside the other New
            // entries.
            label: '3D Primitive',
            children: [
              { commandId: 'layer.new3d.cube', label: 'Cube' },
              { commandId: 'layer.new3d.sphere', label: 'Sphere' },
              { commandId: 'layer.new3d.cylinder', label: 'Cylinder' },
              { commandId: 'layer.new3d.plane', label: 'Plane' },
              { commandId: 'layer.new3d.cone', label: 'Cone' },
              { commandId: 'layer.new3d.torus', label: 'Torus' },
              { commandId: 'layer.new3d.capsule', label: 'Capsule' },
              { commandId: 'layer.new3d.box', label: 'Box (mesh)' },
            ],
          },
        ],
      },
      { separator: true },
      {
        label: 'Arrange',
        children: [
          { commandId: 'layer.bringToFront', label: 'Bring to Front' },
          { commandId: 'layer.bringForward', label: 'Bring Forward' },
          { commandId: 'layer.sendBackward', label: 'Send Backward' },
          { commandId: 'layer.sendToBack', label: 'Send to Back' },
        ],
      },
      { commandId: 'layer.precompose', label: 'Pre-compose…' },
      { separator: true },
      {
        // Derive new layers from the selection — nulls from a path's points,
        // shapes from text, a traced outline from footage.
        label: 'Create',
        children: [
          { commandId: 'layer.nullsFromPath', label: 'Nulls From Path Points' },
          { commandId: 'layer.nullsFromPathLive', label: 'Nulls From Path Points (Points Follow Nulls)' },
          { commandId: 'layer.shapesFromText', label: 'Shapes From Text' },
          { commandId: 'layer.autoTrace', label: 'Auto-trace…' },
        ],
      },
      {
        /**
         * Boolean path ops. Both engines shipped complete and lived in ONE
         * place: the Scene panel's node kebab, found only by right-clicking a
         * multi-selection. Live first, because it is the one to reach for —
         * the operands stay animatable — with the destructive bakes below a
         * rule, which is the same order the kebab uses.
         */
        label: 'Path Operations',
        children: [
          { commandId: 'shape.boolean.union', label: 'Union (Add)' },
          { commandId: 'shape.boolean.subtract', label: 'Subtract' },
          { commandId: 'shape.boolean.intersect', label: 'Intersect' },
          { commandId: 'shape.boolean.exclude', label: 'Exclude (XOR)' },
          { separator: true },
          { commandId: 'shape.mergeUnion', label: 'Merge Paths (Bake): Union' },
          { commandId: 'shape.mergeSubtract', label: 'Merge Paths (Bake): Subtract' },
          { commandId: 'shape.mergeIntersect', label: 'Merge Paths (Bake): Intersect' },
          { commandId: 'shape.mergeExclude', label: 'Merge Paths (Bake): Exclude' },
        ],
      },
      { separator: true },
      {
        // AE puts Scene Edit Detection under Layer, and so did the code's own
        // comment on the clip menu — which was the only place it could be run.
        label: 'Scene Edit Detection',
        children: [
          { commandId: 'layer.sceneEditDetect.markers', label: 'Markers' },
          { commandId: 'layer.sceneEditDetect.split', label: 'Split Clips' },
        ],
      },
    ],
  },
  {
    id: 'effect',
    label: 'Effect',
    items: [
      // Short enough to stay flat; ruled into families so it scans like AE's
      // Effect menu rather than like the order the shaders were written in.
      { commandId: 'effect.blur', label: 'Fast Box Blur' },
      { separator: true },
      { commandId: 'effect.brightness', label: 'Brightness & Contrast' },
      { commandId: 'effect.contrast', label: 'Contrast' },
      { commandId: 'effect.saturate', label: 'Hue/Saturation' },
      { commandId: 'effect.hue', label: 'Hue Rotate' },
      { separator: true },
      { commandId: 'effect.glow', label: 'Glow' },
      { commandId: 'effect.grayscale', label: 'Grayscale' },
      { commandId: 'effect.sepia', label: 'Sepia' },
    ],
  },
  {
    // AE's Animation menu — keyframe assistants that were shortcut-only.
    id: 'animation',
    label: 'Animation',
    items: [
      // The three eases stay at the top level: they are the entries a user
      // reaches for on every other keyframe, and AE keeps them there too.
      { commandId: 'anim.easyEase', label: 'Easy Ease' },
      { commandId: 'anim.easyEaseIn', label: 'Easy Ease In' },
      { commandId: 'anim.easyEaseOut', label: 'Easy Ease Out' },
      {
        label: 'Keyframe Interpolation',
        children: [
          { commandId: 'anim.interpLinear', label: 'Linear' },
          { commandId: 'anim.interpHold', label: 'Hold' },
        ],
      },
      {
        // AE Animation ▸ Keyframe Assistant — engines lived in the palette /
        // TopNav only; this menu is where AE muscle memory looks first.
        label: 'Keyframe Assistant',
        children: [
          { commandId: 'animation.easyEaseAll', label: 'Easy Ease All Keyframes' },
          { commandId: 'animation.timeReverseKeyframes', label: 'Time-Reverse Keyframes' },
          { commandId: 'animation.exponentialScale', label: 'Exponential Scale' },
          { commandId: 'animation.smoother', label: 'The Smoother…' },
          { commandId: 'animation.wiggler', label: 'The Wiggler…' },
          { separator: true },
          // The two that act across LAYERS rather than within one property's
          // keyframes, below a rule.
          { commandId: 'animation.sequenceLayerBars', label: 'Sequence Layers…' },
          { commandId: 'animation.sequenceLayers', label: 'Stagger Animations…' },
        ],
      },
      { separator: true },
      {
        // Creates animation on layers that have none — the counterpart to
        // Stagger Animations above, which only offsets keyframes that exist.
        label: 'Animate',
        children: [
          { commandId: 'animation.animateIn', label: 'Animate In' },
          { commandId: 'animation.animateOut', label: 'Animate Out' },
          { separator: true },
          {
            label: 'Motion Feel',
            children: [
              { commandId: 'animation.motionFeel.snappy', label: 'Snappy' },
              { commandId: 'animation.motionFeel.smooth', label: 'Smooth' },
              { commandId: 'animation.motionFeel.bouncy', label: 'Bouncy' },
            ],
          },
        ],
      },
      {
        // Everything driven by the comp's sound: the beat-driven verbs, the
        // two edits that read the waveform, and the bake to keyframes.
        label: 'Audio',
        children: [
          { commandId: 'animation.animateInOnBeats', label: 'Animate In on Beats' },
          { commandId: 'audio.markBeats', label: 'Markers on Beats' },
          { separator: true },
          { commandId: 'audio.removeSilence', label: 'Remove Silence…' },
          { commandId: 'audio.duckMusic', label: 'Duck Under Voice…' },
          { separator: true },
          { commandId: 'animation.convertAudioToKeyframes', label: 'Convert Audio to Keyframes' },
        ],
      },
      {
        label: 'Time',
        children: [
          { commandId: 'time.speedRamp.quarter', label: 'Speed Ramp to 25%' },
          { commandId: 'time.speedRamp.normal', label: 'Speed Ramp back to 100%' },
        ],
      },
      {
        // The three that turn something procedural into plain keyframes.
        label: 'Bake',
        children: [
          { commandId: 'dynamics.bakePhysics', label: 'Bake Physics to Keyframes…' },
          { commandId: 'dynamics.bakeParticles', label: 'Bake Particles to Layers…' },
          {
            commandId: 'animation.convertExpressionToKeyframes',
            label: 'Convert Expression to Keyframes',
          },
        ],
      },
      { separator: true },
      { commandId: 'animation.motionSketch', label: 'Motion Sketch' },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      { commandId: BuiltinCommands.ToggleLeftSidebar, label: 'Toggle Scene Panel' },
      { commandId: BuiltinCommands.ToggleRightInspector, label: 'Toggle Inspector' },
      { commandId: BuiltinCommands.ToggleTimeline, label: 'Toggle Timeline' },
      { separator: true },
      {
        label: 'Guides & Grid',
        children: [
          { commandId: 'view.grid', label: 'Show Grid' },
          { commandId: 'view.proportionalGrid', label: 'Show Proportional Grid' },
          { commandId: 'view.snapToGrid', label: 'Snap to Grid' },
          { commandId: 'view.rulers', label: 'Toggle Rulers' },
          { commandId: 'view.safeAreas', label: 'Toggle Safe Areas' },
        ],
      },
      // A PREVIEW setting, like the guides above it: proxies change what the
      // viewport decodes and nothing about what an export writes.
      { commandId: 'view.useProxies', label: 'Use Proxies' },
      { separator: true },
      { commandId: 'view.fitSelection', label: 'Fit Selection in View' },
      { commandId: 'timeline.zoomToFit', label: 'Fit Composition in Timeline' },
      { commandId: 'timeline.zoomToWorkArea', label: 'Fit Work Area in Timeline' },
      {
        label: 'Timeline Tools',
        children: [
          { commandId: 'timeline.editMode.select', label: 'Selection Tool' },
          { commandId: 'timeline.editMode.razor', label: 'Razor Tool' },
          { commandId: 'timeline.editMode.slip', label: 'Slip Tool' },
          { commandId: 'timeline.editMode.slide', label: 'Slide Tool' },
          { commandId: 'timeline.editMode.roll', label: 'Roll Tool' },
        ],
      },
      { separator: true },
      {
        label: 'Cache',
        children: [
          { commandId: 'preview.cacheWorkArea', label: 'Cache Work Area Now' },
          { commandId: 'preview.purgeRam', label: 'Purge RAM Preview' },
          { commandId: 'preview.purgeDisk', label: 'Purge Disk Cache' },
        ],
      },
      { separator: true },
      // No Reset Layout here: Window ▸ Workspace owns it, beside the layout
      // presets it resets to. It was listed in both, which is two menu entries
      // for one command.
      { commandId: BuiltinCommands.SwitchTheme, label: 'Switch Theme' },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [
      { commandId: 'view.commandPalette', label: 'Command Palette' },
      { commandId: 'view.presentation', label: 'Present (Preview)' },
      { separator: true },
      { commandId: 'view.history', label: 'History' },
      { commandId: 'view.transcript', label: 'Transcript' },
      { commandId: 'view.effectControls', label: 'Effect Controls' },
      { commandId: 'view.renderQueue', label: 'Render Queue' },
      { commandId: 'view.graphEditor', label: 'Graph Editor' },
      { separator: true },
      // Built per render from WorkspaceManager — half of it is user data. See
      // workspaceMenu.ts.
      { label: 'Workspace', children: buildWorkspaceMenuItems },
      { commandId: 'view.customize', label: 'Customize…' },
      // No Plugins entry here: the Plugins GROUP (built dynamically in
      // pluginMenu.ts) owns it, and a second door labelled the same thing is
      // how a user ends up thinking there are two features.
    ],
  },

  {
    id: 'help',
    label: 'Help',
    items: [
      { commandId: 'help.tour', label: 'Take a Tour' },
      { separator: true },
      { commandId: ProjectCommands.About, label: 'About Premation' },
    ],
  },
];
