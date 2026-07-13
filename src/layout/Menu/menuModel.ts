/**
 * Application menu model — a data-driven map of menu groups → items, each
 * bound to a command id. This is the extension point: future engines append
 * items (or whole groups) here, and the CommandRegistry supplies the label /
 * enabled state / shortcut, so the menu bar stays a thin renderer.
 */

import { BuiltinCommands } from '@core/commands/Command';

/** Project-lifecycle command ids (registered against ProjectManager at boot). */
export const ProjectCommands = {
  New: 'project.new',
  Open: 'project.open',
  Save: 'project.save',
  SaveAs: 'project.saveAs',
  Close: 'project.close',
  About: 'help.about',
} as const;

export interface MenuItemModel {
  commandId?: string;
  /** Overrides the command's label. */
  label?: string;
  separator?: boolean;
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
      { commandId: 'comp.new', label: 'New Composition…' },
      { commandId: ProjectCommands.New, label: 'New Project' },
      { commandId: ProjectCommands.Open, label: 'Open…' },
      { separator: true },
      { commandId: ProjectCommands.Save, label: 'Save' },
      { commandId: ProjectCommands.SaveAs, label: 'Save As…' },
      { separator: true },
      { commandId: 'file.export', label: 'Export…' },
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
      { commandId: 'comp.new', label: 'New Composition…' },
      { commandId: 'comp.settings', label: 'Composition Settings…' },
    ],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      { commandId: 'layer.newText', label: 'New -> Text' },
      { commandId: 'layer.newSolid', label: 'New -> Solid…' },
      { commandId: 'layer.newCamera', label: 'New -> Camera' },
      { commandId: 'layer.newLight', label: 'New -> Light' },
      { commandId: 'layer.newNull', label: 'New -> Null Object' },
      { commandId: 'layer.newAdjustment', label: 'New -> Adjustment Layer' },
      { separator: true },
      { commandId: 'layer.precompose', label: 'Pre-compose…' },
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
    id: 'view',
    label: 'View',
    items: [
      { commandId: BuiltinCommands.ToggleLeftSidebar, label: 'Toggle Scene Panel' },
      { commandId: BuiltinCommands.ToggleRightInspector, label: 'Toggle Inspector' },
      { commandId: BuiltinCommands.ToggleTimeline, label: 'Toggle Timeline' },
      { separator: true },
      { commandId: 'view.grid', label: 'Toggle Grid' },
      { commandId: 'view.rulers', label: 'Toggle Rulers' },
      { commandId: 'view.safeAreas', label: 'Toggle Safe Areas' },
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
      { commandId: 'view.effectControls', label: 'Effect Controls' },
      { commandId: 'view.renderQueue', label: 'Render Queue' },
      { commandId: 'view.graphEditor', label: 'Graph Editor' },
      { separator: true },
      { commandId: 'view.customize', label: 'Customize…' },
      { commandId: 'view.plugins', label: 'Plugins…' },
    ],
  },

  {
    id: 'help',
    label: 'Help',
    items: [
      { commandId: 'help.tour', label: 'Take a Tour' },
      { separator: true },
      { commandId: ProjectCommands.About, label: 'About Motion Editor' },
    ],
  },
];
