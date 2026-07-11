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
