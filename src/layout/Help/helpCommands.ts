/**
 * Help-menu commands that ship with this directory: What's New and the
 * documentation opener. Registered from the modal host (always mounted once),
 * the same pattern as `timelineFitCommands.ts`. Menu rows to add in
 * `menuModel.ts` ▸ Help:
 *
 *   { commandId: 'help.whatsNew',  label: "What's New…" }
 *   { commandId: 'help.docs',      label: 'Documentation' }
 *   { commandId: 'help.powerTour', label: 'Power-user tour' }   (onboardingStore)
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { openWhatsNew } from './WhatsNewDialog';
import { openHelp } from './openHelp';
import { openReportProblem } from './ReportProblemDialog';
import { t } from '@core/i18n';

export const HELP_WHATS_NEW_COMMAND = asCommandId('help.whatsNew');
export const HELP_DOCS_COMMAND = asCommandId('help.docs');
export const HELP_OPEN_LOGS_COMMAND = asCommandId('help.openLogs');
export const HELP_COPY_DIAGNOSTICS_COMMAND = asCommandId('help.copyDiagnostics');
export const HELP_REPORT_PROBLEM_COMMAND = asCommandId('help.reportProblem');

/** The desktop bridge's diagnostics half (absent in the browser / tests). */
function diag(): NonNullable<Window['motionEditor']>['diag'] | undefined {
  return window.motionEditor?.diag;
}

export function buildHelpCommands(): ReadonlyArray<Command> {
  return [
    {
      id: HELP_WHATS_NEW_COMMAND,
      label: t('help.whatsNew.command', "What's New…"),
      description: t('help.whatsNew.description', 'The changelog for this version.'),
      icon: 'sparkles',
      enabled: () => true,
      execute: () => {
        openWhatsNew();
      },
    },
    {
      id: HELP_DOCS_COMMAND,
      label: t('help.docs.command', 'Documentation'),
      description: t('help.docs.description', 'Open the editor reference.'),
      icon: 'info',
      enabled: () => true,
      execute: () => {
        void openHelp('editor');
      },
    },
    // The front door for bug reports: a screenshot, the user's words and safe
    // diagnostics, straight to the console's queue (motion-back problem-reports).
    {
      id: HELP_REPORT_PROBLEM_COMMAND,
      label: t('help.reportProblem.command', 'Report a Problem…'),
      description: t('help.reportProblem.description', 'Send the team a screenshot of the viewer, what happened, and safe diagnostics.'),
      icon: 'warning',
      enabled: () => true,
      execute: () => {
        void openReportProblem();
      },
    },
    // A shipped build has no DevTools: these are how a user reports a blank
    // viewport or an engine restart (the engine log and the GPU as Chromium sees it).
    {
      id: HELP_OPEN_LOGS_COMMAND,
      label: t('help.openLogs.command', 'Open Logs Folder'),
      description: t('help.openLogs.description', 'Reveal the engine log (engine.log) in your file manager.'),
      icon: 'folder',
      enabled: () => typeof diag()?.openLogs === 'function',
      execute: () => {
        void diag()?.openLogs?.();
      },
    },
    {
      id: HELP_COPY_DIAGNOSTICS_COMMAND,
      label: t('help.copyDiagnostics.command', 'Copy Diagnostics Report'),
      description: t('help.copyDiagnostics.description', 'Copy this machine, its GPU and the last engine log lines to the clipboard for a bug report.'),
      icon: 'copy',
      enabled: () => typeof diag()?.copyReport === 'function',
      execute: () => {
        void diag()?.copyReport?.();
      },
    },
  ];
}

let installed = false;

export function installHelpCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const c of buildHelpCommands()) registry.register(c);
}
