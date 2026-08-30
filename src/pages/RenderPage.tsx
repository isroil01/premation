/**
 * `#/render` — the route a `premation render` launch loads into a hidden window.
 *
 * It is the editor, mounted normally, with nobody looking at it. `Providers` is
 * the reason: it is what boots the engine, registers the core services and
 * wires the stores, and a render that skipped it would be rendering against a
 * different application than the one that produces the preview. The rule this
 * whole feature rests on — a CLI file and an exported file are the same file —
 * only holds if the CLI takes the same path.
 *
 * The route is inert outside a CLI launch: `window.motionEditor.cli.job()` has
 * no handler in a normal session and rejects, and this stands down. So a stray
 * `#/render` in the address bar of a dev build shows a blank panel and does
 * nothing, rather than rendering somebody's project over a file.
 *
 * @see electron/cliRender.ts — the main-process half
 * @see src/core/cli/headlessRender.ts — the render itself
 */

import { useEffect, useRef, useState } from 'react';
import { Providers } from '@providers/Providers';
import {
  listProjectCompositions,
  runHeadlessBatchRender,
  runHeadlessCaptions,
  runHeadlessRender,
  type CliRenderFormat,
  type HeadlessRenderRequest,
} from '@core/cli/headlessRender';
import type { CliDoneReport, CliTaskRequest } from '@app-types/motionEditor';

/**
 * Progress reports per render.
 *
 * The frame loop fires per frame, and every report crosses an IPC boundary and
 * prints a line. At 1% granularity a 30-minute render prints 100 lines; at
 * per-frame it prints tens of thousands, which is not a progress display, it is
 * a log nobody can read.
 */
const PROGRESS_STEP = 0.01;

/** The task, run once, reported once. Rendered by `RenderPage` inside Providers. */
function HeadlessRunner(): JSX.Element {
  const [status, setStatus] = useState('Waiting for a job…');
  /**
   * One run per window, enforced here rather than by an effect dependency.
   *
   * StrictMode double-invokes effects in development, and the second invocation
   * would open the project again mid-render — two frame loops writing into one
   * staging directory, which produces a file with interleaved frames and no
   * error anywhere.
   */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const cli = window.motionEditor?.cli;
    if (!cli?.job || !cli.done) {
      setStatus('This build has no CLI bridge.');
      return;
    }

    void (async () => {
      let task: CliTaskRequest;
      try {
        task = await cli.job!();
      } catch {
        // No job: a normal session that happened to navigate here. Nothing to
        // do, and nothing to report — reporting would exit a process that is
        // somebody's open editor.
        setStatus('Not a render launch.');
        return;
      }

      const report = (result: CliDoneReport): void => cli.done!(result);

      try {
        if (task.kind === 'comps') {
          setStatus('Reading compositions…');
          report({ ok: true, comps: await listProjectCompositions(task.projectPath) });
          return;
        }

        if (task.kind === 'captions') {
          setStatus('Transcribing…');
          const result = await runHeadlessCaptions(
            task.projectPath,
            task.outPath,
            task.comp,
            task.language,
          );
          report({
            ok: true,
            captions: {
              text: result.text,
              cues: result.cues,
              compositionName: result.compositionName,
            },
            warnings: result.warnings,
          });
          return;
        }

        setStatus('Rendering…');
        let lastReported = -1;
        const onProgress = (fraction: number): void => {
          if (fraction < 1 && fraction - lastReported < PROGRESS_STEP) return;
          lastReported = fraction;
          setStatus(`Rendering… ${Math.round(fraction * 100)}%`);
          window.motionEditor?.cli?.progress?.(fraction);
        };

        // The bridge types `format` as a plain string — it crosses IPC as JSON
        // and the two projects cannot share the union. `parseCli` has already
        // rejected anything that is not one of these, on the side that owns the
        // vocabulary, so this is a re-labelling and not a widening.
        const request = task.job as HeadlessRenderRequest & { format: CliRenderFormat };

        if (request.data) {
          const batch = await runHeadlessBatchRender(
            request as typeof request & { data: { text: string; filename: string } },
            onProgress,
          );
          report({ ok: true, ...batch });
          return;
        }

        report({ ok: true, ...(await runHeadlessRender(request, onProgress)) });
      } catch (err) {
        report({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, []);

  // Visible to nobody in a CLI run — the window is never shown. It exists for
  // the case where someone opens `#/render` in a dev browser tab to see what
  // this route does, which should be "says what it is doing", not "blank page".
  return (
    <div style={{ padding: 24, color: '#e6e6e8', font: '13px ui-monospace, monospace' }}>
      premation render — {status}
    </div>
  );
}

export function RenderPage(): JSX.Element {
  return (
    <Providers>
      <HeadlessRunner />
    </Providers>
  );
}

export default RenderPage;
