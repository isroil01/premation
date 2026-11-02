# Problem reports (Help ▸ Report a Problem)

How a user tells us something broke, from inside the editor, and what that
report carries. The user-facing page is on the site at
`/docs/getting-started/reporting-problems`.

## Using it

**Help ▸ Report a Problem…** — also in the command palette (`help.reportProblem`).
The viewer is captured *before* the dialog opens, so open it while the problem
is on screen. The dialog asks for:

- **Area** — crash, viewer/rendering, slow, playback, export, import, text,
  effects, audio, interface, plugins, account, other.
- **Impact** — blocks my work / gets in the way / minor.
- **Summary** (one line) and **What happened** (required), **Steps to reproduce**
  (optional), **Email for a reply** (optional; prefilled when signed in).
- **Screenshot** — retake (the dialog hides itself for the capture) or remove.
- **Include project details** — off by default.

On success the dialog shows the report number (`PR-1234`); with an email the
backend also sends the `problem-report.received` template. On failure the draft
stays and **Copy diagnostics** (`diag:copyReport`) is offered instead.

## What leaves the machine

| Always | Only with "Include project details" |
| --- | --- |
| App version, packaged/dev, Electron/Chromium, locale | Project file path |
| OS, release, arch, CPU model and cores, RAM | Footage names and paths (first 100) |
| GPU adapter/vendor/driver and Chromium feature status | Composition names and layer counts |
| Engine state, version, revision, last recovery (no recovery path) | Layer error messages (first 50) |
| Last 40 lines of `engine.log`, paths → `<path>`, user name → `<user>` | |
| Counts: comps, layers, item kinds, missing footage, failing layers by stage | |

The backend scrubs paths out of `diagnostics` again on arrival
(motion-back `src/problem-reports/diagnostics.ts`), so an old or modified
client cannot leak them.

## Where the code is

| Piece | File |
| --- | --- |
| Dialog | `src/layout/Help/ReportProblemDialog.tsx` (+ `.module.css`) |
| Payload, opt-in split, viewport capture | `src/layout/Help/reportProblem.ts` |
| Command | `src/layout/Help/helpCommands.ts` (`help.reportProblem`), menu row in `src/layout/Menu/menuModel.ts` |
| Main-process diagnostics + capture | `electron/ipc/problemReport.ts` (`report:diagnostics`, `report:captureViewport`) |
| Bridge | `electron/preload.ts` `diag.problemDiagnostics` / `diag.captureViewport`; typed in `src/types/motionEditor.d.ts` |
| Tests | `src/layout/Help/reportProblem.test.ts`, `ReportProblemDialog.test.tsx` |

The request is `POST /api/problem-reports` (multipart: `payload` JSON +
`screenshot` PNG), with the session token when there is one — a signed-out
user can still report. Limits: 6 an hour per address, 10 per account.

Operators work the queue in the site's console at `/admin/reports`.
