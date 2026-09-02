/**
 * Application menu model — a data-driven map of menu groups → items, each
 * bound to a command id. This is the extension point: future engines append
 * items (or whole groups) here, and the CommandRegistry supplies the label /
 * enabled state / shortcut, so the menu bar stays a thin renderer.
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
      { commandId: 'comp.multicam', label: 'New Multicam from Selected Assets…' },
      // Both act on FOOTAGE rather than on the open comp, which is why they sit
      // beside New Composition rather than under Layer: the result of each is a
      // composition that did not exist before (or, for Assemble on a layer, a
      // comp whose whole cut did not exist before).
      { commandId: 'comp.newFromSelectedClips', label: 'New Composition from Selected Clips…' },
      { commandId: 'comp.assembleFromFootage', label: 'Assemble from Footage…' },
      { commandId: 'comp.settings', label: 'Composition Settings…' },
      { commandId: 'comp.delete', label: 'Delete Composition' },
      { commandId: 'scene.loadBlockTower', label: 'Load: Block Tower' },
      { separator: true },
      // One entry per target shape rather than a dialog: the only input is the
      // aspect, and this way the whole feature is reachable by typing '9:16'
      // into the command palette. Each greys itself out for a comp already at
      // that aspect, which would have nothing to pan within.
      { commandId: 'comp.autoReframe.9:16', label: 'Auto-Reframe to 9:16 Vertical' },
      { commandId: 'comp.autoReframe.1:1', label: 'Auto-Reframe to 1:1 Square' },
      { commandId: 'comp.autoReframe.4:5', label: 'Auto-Reframe to 4:5 Portrait' },
      { commandId: 'comp.autoReframe.16:9', label: 'Auto-Reframe to 16:9 Widescreen' },
      { commandId: 'comp.autoReframe.4:3', label: 'Auto-Reframe to 4:3 Classic' },
      { separator: true },
      // Captions sit under Composition rather than Layer: they are a property
      // of the whole comp (its spoken words), and every one of these acts on
      // all of them at once, not on a selection.
      { commandId: 'captions.import', label: 'Import Captions…' },
      { commandId: 'captions.generate', label: 'Generate Captions from Audio' },
      { commandId: 'captions.exportSrt', label: 'Export Captions (.srt)…' },
      { commandId: 'captions.exportVtt', label: 'Export Captions (.vtt)…' },
      { commandId: 'captions.clear', label: 'Remove All Captions' },
      { separator: true },
      { commandId: 'comp.saveFrame', label: 'Save Frame As PNG' },
      { commandId: 'comp.copyFrame', label: 'Copy Frame to Clipboard' },
    ],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      { commandId: 'layer.newText', label: 'New Text Layer' },
      { commandId: 'layer.newSolid', label: 'New Solid Layer…' },
      { commandId: 'layer.newCamera', label: 'New Camera Layer' },
      { commandId: 'layer.newLight', label: 'New Light Layer' },
      { commandId: 'layer.newNull', label: 'New Null Object' },
      { commandId: 'layer.newAdjustment', label: 'New Adjustment Layer' },
      {
        // The 3D inserts existed only in the TopNav "+" dropdown — a place you
        // browse rather than search. They belong beside the other New entries.
        label: 'New 3D Primitive',
        children: [
          { commandId: 'layer.new3d.cube', label: 'Cube' },
          { commandId: 'layer.new3d.sphere', label: 'Sphere' },
          { commandId: 'layer.new3d.cylinder', label: 'Cylinder' },
          { commandId: 'layer.new3d.plane', label: 'Plane' },
        ],
      },
      { separator: true },
      { commandId: 'layer.bringToFront', label: 'Bring to Front' },
      { commandId: 'layer.bringForward', label: 'Bring Forward' },
      { commandId: 'layer.sendBackward', label: 'Send Backward' },
      { commandId: 'layer.sendToBack', label: 'Send to Back' },
      { separator: true },
      { commandId: 'layer.precompose', label: 'Pre-compose…' },
      { separator: true },
      { commandId: 'layer.nullsFromPath', label: 'Create Nulls From Path Points' },
      { commandId: 'layer.nullsFromPathLive', label: 'Create Nulls From Path Points (Points Follow Nulls)' },
      { commandId: 'layer.shapesFromText', label: 'Create Shapes From Text' },
      { commandId: 'layer.autoTrace', label: 'Auto-trace…' },
      { separator: true },
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
      // AE puts Scene Edit Detection under Layer, and so did the code's own
      // comment on the clip menu — which was the only place it could be run.
      { commandId: 'layer.sceneEditDetect.markers', label: 'Scene Edit Detection → Markers' },
      { commandId: 'layer.sceneEditDetect.split', label: 'Scene Edit Detection → Split Clips' },
    ],
  },
  {
    id: 'effect',
    label: 'Effect',
    items: [
      { commandId: 'effect.blur', label: 'Fast Box Blur' },
      { commandId: 'effect.glow', label: 'Glow' },
      { commandId: 'effect.brightness', label: 'Brightness & Contrast' },
      { commandId: 'effect.contrast', label: 'Contrast' },
      { commandId: 'effect.saturate', label: 'Hue/Saturation' },
      { commandId: 'effect.grayscale', label: 'Grayscale' },
      { commandId: 'effect.sepia', label: 'Sepia' },
      { commandId: 'effect.hue', label: 'Hue Rotate' },
    ],
  },
  {
    // AE's Animation menu — keyframe assistants that were shortcut-only.
    id: 'animation',
    label: 'Animation',
    items: [
      { commandId: 'anim.easyEase', label: 'Easy Ease' },
      { commandId: 'anim.easyEaseIn', label: 'Easy Ease In' },
      { commandId: 'anim.easyEaseOut', label: 'Easy Ease Out' },
      { separator: true },
      { commandId: 'anim.interpLinear', label: 'Linear Interpolation' },
      { commandId: 'anim.interpHold', label: 'Hold Interpolation' },
      { separator: true },
      // AE Animation ▸ Keyframe Assistant — engines lived in the palette / TopNav
      // only; this menu is where AE muscle memory looks first.
      { commandId: 'animation.easyEaseAll', label: 'Easy Ease All Keyframes' },
      { commandId: 'animation.timeReverseKeyframes', label: 'Time-Reverse Keyframes' },
      { commandId: 'animation.exponentialScale', label: 'Exponential Scale' },
      { commandId: 'animation.smoother', label: 'The Smoother…' },
      { commandId: 'animation.wiggler', label: 'The Wiggler…' },
      { commandId: 'animation.sequenceLayerBars', label: 'Sequence Layers…' },
      { commandId: 'animation.sequenceLayers', label: 'Stagger Animations…' },
      { separator: true },
      { commandId: 'dynamics.bakePhysics', label: 'Bake Physics to Keyframes…' },
      { commandId: 'dynamics.bakeParticles', label: 'Bake Particles to Layers…' },
      { separator: true },
      // Creates animation on layers that have none — the counterpart to
      // Stagger Animations above, which only offsets keyframes that exist.
      { commandId: 'animation.animateIn', label: 'Animate In' },
      { commandId: 'animation.animateOut', label: 'Animate Out' },
      { commandId: 'animation.motionFeel.snappy', label: 'Motion Feel: Snappy' },
      { commandId: 'animation.motionFeel.smooth', label: 'Motion Feel: Smooth' },
      { commandId: 'animation.motionFeel.bouncy', label: 'Motion Feel: Bouncy' },
      { commandId: 'animation.animateInOnBeats', label: 'Animate In on Beats' },
      { commandId: 'audio.markBeats', label: 'Markers on Beats' },
      { separator: true },
      { commandId: 'time.speedRamp.quarter', label: 'Speed Ramp to 25%' },
      { commandId: 'time.speedRamp.normal', label: 'Speed Ramp back to 100%' },
      { separator: true },
      { commandId: 'animation.motionSketch', label: 'Motion Sketch' },
      { commandId: 'animation.convertAudioToKeyframes', label: 'Convert Audio to Keyframes' },
      {
        commandId: 'animation.convertExpressionToKeyframes',
        label: 'Convert Expression to Keyframes',
      },
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
      { commandId: 'view.grid', label: 'Show Grid' },
      { commandId: 'view.proportionalGrid', label: 'Show Proportional Grid' },
      { commandId: 'view.snapToGrid', label: 'Snap to Grid' },
      { commandId: 'view.rulers', label: 'Toggle Rulers' },
      { commandId: 'view.safeAreas', label: 'Toggle Safe Areas' },
      // A PREVIEW setting, like the guides above it: proxies change what the
      // viewport decodes and nothing about what an export writes.
      { commandId: 'view.useProxies', label: 'Use Proxies' },
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
      { commandId: 'preview.cacheWorkArea', label: 'Cache Work Area Now' },
      { commandId: 'preview.purgeRam', label: 'Purge RAM Preview' },
      { commandId: 'preview.purgeDisk', label: 'Purge Disk Cache' },
      { separator: true },
      { commandId: BuiltinCommands.ResetLayout, label: 'Reset Layout' },
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
