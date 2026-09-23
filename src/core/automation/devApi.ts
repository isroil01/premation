/**
 * The dev/automation handle on `window.__premationAutomation` (B5):
 *
 *   const a = window.__premationAutomation;
 *   const rec = await a.recordSession();            // … edit in the UI, run an AI turn, a script …
 *   const log = rec.stop();                   // JSON lines (save it; `premation render --commands`)
 *   await a.replaySession(log);               // a fresh engine reproduces the session
 *   await a.runScript(src, { grant: ['document.read', 'document.write'] });
 *   await a.runToolTurn('AI: build', [{ name: 'create_layer', args: {…} }, …]);
 *
 * `runScript` from here asks no dialog: the `grant` list IS the consent (the
 * developer typing it is the user). A script that asks for more than was
 * granted is refused, exactly as a declined prompt would.
 *
 * Installed by Providers after the engine boots; a no-op without `window`.
 */

import { recordSession, replaySession, logFromJsonl, logToJsonl } from './commandLog';
import { runScript, type RunScriptOptions } from '@core/scripting/scriptHost';
import type { ScriptPermission } from '@core/scripting/protocol';
import { runToolTurn } from '@core/ai/aiTurn';

export function installAutomationDevApi(): () => void {
  if (typeof window === 'undefined') return () => {};
  const api = {
    recordSession,
    replaySession,
    logFromJsonl,
    logToJsonl,
    runToolTurn,
    runScript: (source: string, opts: Omit<RunScriptOptions, 'consent'> & { grant?: ScriptPermission[] } = {}) => {
      const grant = new Set(opts.grant ?? []);
      return runScript(source, { ...opts, consent: (req) => req.permissions.every((p) => grant.has(p)) });
    },
  };
  (window as unknown as { __premationAutomation?: typeof api }).__premationAutomation = api;
  return () => {
    const w = window as unknown as { __premationAutomation?: typeof api };
    if (w.__premationAutomation === api) delete w.__premationAutomation;
  };
}
