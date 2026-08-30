# Headless rendering — `premation render`

Render a `.motion` project to a file without opening the editor. Built for CI,
cron jobs, batch work and anything else that has no one sitting in front of it.

The file it writes is the file the editor would have written: the CLI drives the
same deterministic frame loop, the same GPU render graph and the same ffmpeg
encode that the Export dialog and the Render Queue use. There is no second
renderer to keep in step, and no "close enough" path.

- [Why it opens a window](#why-it-opens-a-window)
- [Running it](#running-it)
- [Commands](#commands)
- [Options](#options)
- [Data-driven batches](#data-driven-batches)
- [Exit codes](#exit-codes)
- [Machine-readable output](#machine-readable-output)
- [Windows and stdout](#windows-and-stdout)
- [Assets](#assets)
- [What it does not do](#what-it-does-not-do)
- [Source map](#source-map)

---

## Why it opens a window

The render pipeline is a DOM pipeline. Twenty-odd render-path modules touch
`document`, the texture provider builds real `HTMLImageElement` /
`HTMLVideoElement` objects, and page-loaded web fonts are invisible to a
worker's `OffscreenCanvas` — so a "pure Node" renderer would produce different
pixels from the preview for any composition containing text. That is the same
reason parallel frame rendering was investigated and declined; see
[`docs/AE_COMPARISON.md`](AE_COMPARISON.md) §3, Tier 1b.

So a CLI render *is* the editor: a hidden `BrowserWindow`, the real engine, the
real scene graph, and nothing shown. `backgroundThrottling` is off, because
Chromium otherwise throttles a hidden window's timers to about one tick per
second and the frame loop yields between frames.

What the headless process does **not** boot is everything a render has no
business holding open: no application menu, no auto-updater, no managed backend,
no account session, no plugin network bridge, no AI provider channel. The IPC it
registers is the disk (the project, its assets, its blobs) and ffmpeg.

---

## Running it

**From a packaged build**, the app executable *is* the CLI:

```bash
Premation render Promo.motion --comp Main --out promo.mp4
```

**From this repository**, build the renderer once, then drive the compiled main
process:

```bash
npm run build:local
```

```bash
npm run cli -- render Promo.motion --comp Main --out promo.mp4
```

`npm run cli` compiles `electron/` and launches Electron; everything after `--`
is the command line. It reads the built renderer from `dist/`, so re-run
`npm run build:local` after changing renderer code.

Each render is its own process. The single-instance lock that makes a
`premation://` deep link return to an already-open editor is deliberately
bypassed for CLI runs — without that, a render started while the editor was open
would exit 0 having rendered nothing.

---

## Commands

### `render <project> [options]`

Renders one composition to one file.

```bash
premation render Promo.motion --out promo.mp4
```

With no `--comp`, it renders the project's first real composition — "real"
meaning not the auto-minted empty one a fresh document carries, which would
otherwise deliver a blank frame and report success.

With no `--out`, it writes beside the project, named after it:
`Promo.motion` → `Promo.mp4`.

### `reframe <project> --aspect <ratio>`

Retargets the composition to another shape — following the subject, jumping at
cuts — and renders the result. Every `render` option applies.

```bash
premation reframe Promo.motion --aspect 9:16 --out vertical.mp4
```

Aspects: `9:16`, `1:1`, `4:5`, `16:9`, `4:3`. The reframed composition is created
in the project exactly as the editor's command creates it; the source is
untouched. See [`AUTO_REFRAME.md`](AUTO_REFRAME.md) for how the crop decides
where to look.

### `captions <project> [--out subs.srt]`

Transcribes the composition's own audio and writes a caption file.

```bash
premation captions Promo.motion --out promo.srt --language en
```

`.vtt` writes WebVTT, anything else SubRip. Needs an OpenAI key in the desktop
app's keystore — see [`CAPTIONS.md`](CAPTIONS.md) for why that provider and
where the key lives. A silent composition is reported as such rather than
producing an empty file.

To burn captions INTO a render instead, pass `--captions` to `render`:

```bash
premation render Promo.motion --captions promo.srt --out subtitled.mp4
```

That replaces any captions already in the composition, so re-running a pipeline
does not stack a second set of layers over the first.

### `comps <project>`

Lists what is in a project — name, size, frame rate, duration and id — so a
script can discover what to render.

```bash
premation comps Promo.motion
```

```
Main  (1920×1080 @ 30fps, 12.00s, id comp_1)
Lower Third  (1920×1080 @ 30fps, 4.00s, id comp_7)
```

---

## Options

| Option | Meaning |
|---|---|
| `--comp <name\|id>` | Composition to render. Matched by id, then by exact name, then case-insensitively. |
| `--out <file>` | Output path. Created directories are fine; the file is **overwritten**. |
| `--format <fmt>` | `mp4`, `mov`, `webm`, `gif`, `hdr10`, `hlg`, `png-sequence`, `jpg-sequence`, `exr-sequence`, `png`. Inferred from `--out`'s extension when it is unambiguous, else `mp4`. |
| `--range <a-b>` | Inclusive frame range, e.g. `--range 0-119` renders 120 frames. |
| `--start <frame>` / `--end <frame>` | The same range, given separately. `--end` is inclusive. |
| `--fps <n>` | Override the composition's frame rate. |
| `--scale <n>` | Uniform output scale. `--scale 0.5` halves both dimensions. |
| `--width <px>` / `--height <px>` | Output size. Giving one keeps the composition's aspect ratio. |
| `--quality <tier>` | `high` (default), `medium`, `draft`. |
| `--prores <profile>` | `mov` only: `proxy`, `lt`, `422`, `hq`, `4444` (default). Refused on other formats rather than silently ignored. |
| `--transparent` | Force an alpha channel on regardless of the composition's own setting. |
| `--data <file>` | A CSV or JSON table. Renders one file per row — see below. |
| `--from-row <n>` | Start a `--data` batch at row *n* (1-based). Resumes without re-rendering. |
| `--captions <file>` | Import an `.srt`/`.vtt` before rendering (burn-in). |
| `--aspect <ratio>` | `reframe` only: the target shape. |
| `--language <code>` | `captions` only: a speech language hint. |
| `--json` | One JSON object per line. |
| `--quiet` | No progress lines; the result still prints. |
| `--log <file>` | Mirror every line into a file as well. See [Windows and stdout](#windows-and-stdout). |

`--out` **overwrites**, where the Render Queue never does. A queued render
suffixing ` (2)` protects a file the user forgot about; a pipeline whose artifact
lands at `promo (7).mp4` on the seventh run has no artifact path at all.

A bad command line exits **2** without booting anything — a typo should not cost
a GPU boot to discover.

---

## Data-driven batches

Author one composition, expose the layers you want driven as **template
fields**, and render one file per row of a spreadsheet:

```bash
premation render LowerThird.motion --data people.csv --out "out/{index}-{name}.mp4"
```

```
name,role
Ada Lovelace,Mathematician
Grace Hopper,Rear Admiral
```

A column fills the template field with the **same id**. Columns with no field
(a `notes` column, an output-name column) are ignored; fields with no column
keep their authored value on every row. Text, colour and number fields are
filled; `media` fields are reported as skipped rather than silently ignored.

**`--out` must contain a `{token}`**, and the CLI refuses the command if it
does not. `{index}` is the 1-based row number, zero-padded to the width of the
table so the folder sorts in table order; anything else names a column. Values
are made filename-safe, and a cell that sanitises to nothing falls back to its
row number so two rows can never collide on one path.

```
--out "out/{index}-{name}.mp4"   →  out/01-Ada Lovelace.mp4
--out "out/{name}.mp4"           →  out/Ada Lovelace.mp4
--out "out/promo.mp4"            →  refused: every row would overwrite the last
```

Rows render **strictly sequentially** — apply the row, await the whole render,
then the next. That is not an implementation detail: a render reads the live
scene graph when it runs, so queueing forty jobs and filling forty rows would
produce forty copies of the last row, each correctly named after a different
one, with nothing reported. See `src/core/template/batchRender.ts`.

A failed row is recorded and the batch continues; the run then exits **1** with
every row named in the log, because thirty-nine good files and one named failure
is a better morning than one error and no files — and a pipeline must not read
"39 of 40" as green.

A batch that was interrupted resumes with `--from-row`, which is 1-based
because the log, the CSV and every spreadsheet are:

```bash
premation render Promo.motion --data rows.csv --out "out/{index}.mp4" --from-row 31
```

The editor's **Render every row** does the same: stopping it leaves a "Resume
from row N" button rather than throwing away files that are already on disk.

The same loop is in the editor: **Templates ▸ Data ▸ Render every row**, which
writes into the folder the Render Queue already asked for. Both put the
template's own values back when they finish, so a batch never leaves the last
row's copy on your layers.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The file was written. |
| `1` | The render failed. The reason is the last line printed. |
| `2` | The command line was wrong. Nothing was rendered. |

A render that stops making progress for 15 minutes is stopped and reported,
rather than holding a CI runner until the runner's own timeout kills it with no
explanation. The clock resets on every frame, so it bounds the *gap* between
frames, never the length of the render.

---

## Machine-readable output

`--json` prints one object per line:

```json
{"event":"progress","fraction":0.5,"percent":50}
{"event":"warning","message":"warning: Layer \"Clip\" points at media this machine cannot resolve (local-path): C:\\footage\\a.mp4"}
{"event":"done","message":"Wrote …","outPath":"…","frames":120,"width":1920,"height":1080,"fps":30,"elapsedMs":48210,"warnings":[]}
```

Failures print `{"event":"error","message":"…"}` and exit 1.

---

## Windows and stdout

A packaged Electron app on Windows is a GUI-subsystem binary with **no console
attached**, so a run started from `cmd` or PowerShell gets the exit code and
nothing else — `console.log` has nowhere to go. This is a Windows packaging
constraint, not something the CLI can work around from inside the process.

Use `--log` there:

```bash
Premation render Promo.motion --out promo.mp4 --json --log render.log
```

The exit code is reliable on every platform, with or without `--log`.

---

## Assets

A `.motion` bundle carries its own footage, and the CLI restores it.

Saving a bundle **collects** every asset that only lived in that session's
memory: the bytes are content-addressed into `blobs/`, recorded in
`assets/registry.json`, and the document is repointed at them. Opening one —
including headlessly — reads that registry back, so a project moved to another
machine renders the footage it was authored with, with no relink step. Verified
by rendering a hand-built bundle whose document carried nothing but a dead
`blob:` URL and an asset id.

Two things still travel badly, and the CLI names both rather than hiding them:

- **Media referenced by an absolute path** belongs to the machine that authored
  it. Printed as a warning line naming the layer and the path.
- **A dead object URL with no matching registry row** — footage imported into a
  project that was never saved as a bundle. Also warned, and if the frame would
  be visibly wrong the export refuses outright rather than shipping a hole; see
  `offlineRenderer.ts`.

Projects with no external footage — shapes, text, solids, effects, precomps —
render anywhere regardless.

---

## What it does not do

- **No parallelism.** One render at a time, one row at a time. Run several
  processes if your machine has the GPU headroom.
- **No audio-only or interchange formats.** `wav`, `lottie`, `json`, `edl`,
  `otio`, `fcpxml`, `ale` and `mogrt` hand a blob to the browser's download
  machinery rather than writing a path, so they remain editor features.
- **No queue.** Pausing, resuming and reordering belong to the Render Queue
  panel, which has a person in front of it.

---

## Source map

| File | What it owns |
|---|---|
| [`electron/cliArgs.ts`](../electron/cliArgs.ts) | argv → a job. Pure, and fully unit-tested. |
| [`electron/cliRender.ts`](../electron/cliRender.ts) | The hidden window, the watchdog, stdout, the exit code. |
| [`electron/main.ts`](../electron/main.ts) | Which launch this is, and what a headless one is allowed to register. |
| [`src/pages/RenderPage.tsx`](../src/pages/RenderPage.tsx) | The `#/render` route: boots `Providers`, asks for its job, reports once. |
| [`src/core/cli/headlessRender.ts`](../src/core/cli/headlessRender.ts) | Open the project, resolve the composition, render, write the file. |
| [`src/core/export/renderJob.ts`](../src/core/export/renderJob.ts) | The render itself — shared verbatim with the Render Queue. |
| [`src/core/template/batchRender.ts`](../src/core/template/batchRender.ts) | The one-render-per-row loop, the naming rules, and the restore. |
