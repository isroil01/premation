/**
 * The starter template — a complete, working plugin package, generated on
 * demand and downloaded as a `.zip`.
 *
 * This is a DEVELOPER affordance, not content: nothing here is installed, and
 * the manager's list stays empty until a user installs something themselves.
 * It exists because "write a plugin" is otherwise a blank page — the format,
 * the entry-point signature, the permission names and the panel message shape
 * all have to be right at once, and reading them out of documentation is how
 * people get them wrong.
 *
 * The template exercises every part of the API surface once: a DECLARED
 * command, a permission-gated write, an image read/write round trip, and a
 * themed panel that talks back to its plugin.
 *
 * It is also, in practice, the spec. Far more authors will copy this than will
 * read `docs/PLUGINS.md`, so it is written at API 2 with a `contributes` block
 * and lazy activation — whatever shape this file has is the shape the ecosystem
 * will have.
 */

import { zipSync, strToU8 } from 'fflate';
import { HOST_API_VERSION } from '@core/plugins/manifest';

const MANIFEST = {
  id: 'com.example.hello-motion',
  name: 'Hello Motion',
  version: '1.0.0',
  description: 'Starter template — a command, a keyframe write, and a panel. Edit main.js and re-install.',
  author: 'Your name',
  apiVersion: HOST_API_VERSION,
  main: 'main.js',
  // Declared, so the editor can list them before this plugin has ever run —
  // and so it does not have to run at launch just to find out what it offers.
  contributes: {
    commands: [
      { id: 'bounce', label: 'Bounce selection', icon: 'zap', needsSelection: true },
      { id: 'greyscale', label: 'Greyscale selected image', icon: 'image', needsSelection: true },
    ],
    // No `placement`, so `shared`: a tab inside the Plugin Panels panel. That
    // is the right answer for a panel this size, and the starter says so by
    // example rather than by taking a sidebar slot it does not need. A panel
    // that is a PLACE the user goes — a browser, a library — declares
    // `placement: 'sidebar'` (or `'inspector'`) plus an `icon`, and gets a rail
    // tab of its own. See docs/PLUGINS.md § Panels.
    panels: [
      { id: 'main', title: 'Hello Motion', entry: 'panel.html' },
    ],
  },
  // Nothing here starts at launch. The worker spawns the first time one of
  // these is used, and the commands are in the palette the whole time.
  activationEvents: ['onCommand:bounce', 'onCommand:greyscale', 'onPanel:main'],
  permissions: ['scene:read', 'scene:write', 'animation:write', 'timeline', 'assets:read', 'assets:write'],
};

const MAIN_JS = `/**
 * Hello Motion — starter plugin.
 *
 * The host calls activate once, in a sandboxed Worker, with the plugin API.
 * Everything on \`motion\` is async: it is a message to the editor, not a
 * function call into it.
 */
export function activate(motion) {
  // The command is DECLARED in plugin.json; this attaches the behaviour to it.
  // Because it is declared, it was already in the Command Palette
  // (Cmd/Ctrl+Shift+P) before this worker existed — invoking it is what
  // started us.
  motion.commands.register(
    { id: 'bounce', label: 'Bounce selection', icon: 'zap', needsSelection: true },
    async ({ selection }) => {
      const t = await motion.timeline.getTime();
      for (const id of selection) {
        // One bulk write per track: cheaper than a keyframe at a time, and it
        // lands as a single undo step.
        await motion.animation.setKeyframes(id, 'y', [
          { t: t,        value: 0,   easing: 'easeOut' },
          { t: t + 0.18, value: -60, easing: 'easeIn'  },
          { t: t + 0.42, value: 0,   easing: 'easeOut' },
        ]);
      }
      await motion.ui.notify(\`Bounced \${selection.length} layer(s)\`, 'success');
    },
  );

  // Images. Read a layer's pixels, change them, write a new asset back, and
  // put it in the composition. \`bytes\` is straight RGBA8 and arrives by
  // transfer, so a 4K frame costs a pointer rather than a copy.
  motion.commands.register(
    { id: 'greyscale', label: 'Greyscale selected image', icon: 'image', needsSelection: true },
    async ({ selection }) => {
      for (const layerId of selection) {
        const img = await motion.assets.getImage({ layerId });
        const px = img.bytes;
        for (let i = 0; i < px.length; i += 4) {
          // Rec. 601 luma. Alpha (i + 3) is deliberately left alone.
          const y = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
          px[i] = y; px[i + 1] = y; px[i + 2] = y;
        }
        const made = await motion.assets.createImage({
          width: img.width, height: img.height, bytes: px,
          mime: 'image/rgba8', name: 'greyscale',
        });
        await motion.scene.createLayer({ kind: 'image', assetId: made.assetId, name: 'Greyscale' });
      }
      await motion.ui.notify('Greyscaled ' + selection.length + ' image(s)', 'success');
    },
  );

  // Talk to the panel. The panel calls motionPanel.send(...) and this fires.
  // The panel id is optional while this plugin declares only one.
  motion.ui.onPanelMessage(async (msg) => {
    if (msg && msg.type === 'count') {
      const layers = await motion.scene.getLayers();
      motion.ui.sendToPanel({ type: 'count', value: layers.length });
    }
  });
}
`;

const PANEL_HTML = `<!--
  Themed for free. The editor posts its own colours, type and spacing in as
  \`--pm-*\` custom properties, on load and on every theme change, and the
  \`pm-*\` classes below are built into the panel shell — no stylesheet to
  link, and nothing to do to follow the editor into light mode. Hardcode a
  colour here and you are the only thing in the app that does not.
-->
<div class="pm-section">
  <h3 class="pm-section-title">Hello Motion</h3>
  <p class="pm-muted" style="margin:0">
    This panel runs in a sandboxed frame. It can talk to its own plugin and nothing else.
  </p>
</div>

<div class="pm-section">
  <div class="pm-row">
    <span class="pm-label">Layers in this project</span>
    <button id="count" class="pm-button pm-button--primary">Count</button>
  </div>
  <p id="out" class="pm-status"></p>
</div>
<script>
  const out = document.getElementById('out');
  document.getElementById('count').onclick = () => motionPanel.send({ type: 'count' });
  motionPanel.onMessage((msg) => {
    if (msg && msg.type === 'count') out.textContent = msg.value + ' layers in this project.';
  });
</script>
`;

const README = `# Hello Motion — plugin starter

## Files
- \`plugin.json\` — the manifest. \`id\` must be reverse-DNS and unique.
- \`main.js\`     — the entry ES module. Must export \`activate(motion)\`.
- \`panel.html\`  — optional UI, shown in a sandboxed frame.

## Install it
the **Plugins** panel ▸ **Add plugin** ▸ **Install from a folder…** (pick this folder), or zip it
and use **Choose package…**.

## Iterate on it
Edit \`main.js\`, then hit **Reload** on this plugin's row — it re-reads the
folder and reinstalls without the consent screen (you only see that again if
you add a permission). Your \`console.log\` goes to the row's **Log**, together
with any call the permission gate refused.

## Declare what you contribute
\`contributes\` in \`plugin.json\` is read WITHOUT running your code, so your
commands and panels are in the palette, the Plugins menu and the manager from
the moment the user installs — not from the moment your worker boots.

\`activationEvents\` then says when the worker should actually start:
\`onStartup\`, \`onCommand:<id>\`, \`onPanel:<id>\`. This template starts on demand,
which is why the editor can carry forty installed plugins without spawning
forty workers at launch. Omit \`activationEvents\` entirely and you get
\`onStartup\`.

\`commands.register\` still works at runtime, and is the only way under
\`apiVersion: 1\`. Under \`apiVersion: 2\` a command you register but did not
declare is accepted and logged as a warning — it works, but it cannot appear
until you have started.

## Where it shows up
Your commands appear in the **Plugins** menu under this plugin's name, and in
the command palette (Cmd/Ctrl+Shift+P). Each panel in \`contributes.panels\`
becomes a tab in the **Plugins** dock panel — \`motion.ui.openPanel()\` reveals
it, and it stays usable while you drag on the canvas. Inline \`<script>\` in the
panel runs; \`fetch\` does not.

## Panels are themed for you
The editor posts its colours, radius, type and spacing into your frame as
\`--pm-*\` custom properties, on load and again whenever the theme changes, and
the \`pm-*\` component classes (\`pm-button\`, \`pm-input\`, \`pm-row\`, \`pm-section\`,
\`pm-label\`, \`pm-status\`, \`pm-muted\`) are built into the panel shell. There is
nothing to link. Use them and your panel follows the editor into light mode;
hardcode \`#17171a\` and you are the only thing in the app that does not.
\`document.documentElement\` also carries \`data-pm-theme="light|dark"\` for when
you need to branch on more than a colour.

## What plugins can and cannot do
Your code runs in a Worker: no DOM, no \`localStorage\`, no \`fetch\`. Everything
you do goes through the \`motion\` API and is checked against the permissions
your manifest declares and the user approved. Every project change is undoable.

## Permissions
\`scene:read\`, \`scene:write\`, \`animation:read\`, \`animation:write\`,
\`assets:read\`, \`assets:write\`, \`timeline\`.
Ask for the fewest you need — the list is shown to the user before they install.

## The API
\`\`\`js
motion.ui.notify(message, level)          // level: info | success | warning | error
motion.ui.openPanel(panelId?) / closePanel(panelId?)   // id optional with one panel
motion.ui.sendToPanel([panelId,] data) / onPanelMessage([panelId,] fn)
motion.commands.register(spec, handler)
motion.composition.get()
motion.scene.getSelection() / setSelection(ids)
motion.scene.getLayers() / getLayer(id)
motion.scene.createLayer({ kind, name, x, y })          // shape | text | group | null
motion.scene.createLayer({ kind: 'image', assetId })    // needs scene:write
motion.scene.setProperty(id, prop, value)
motion.scene.renameLayer(id, name) / deleteLayer(id)
motion.animation.getTracks(id) / sample(id, prop, time)
motion.animation.setKeyframe(id, prop, time, value, easing)
motion.animation.setKeyframes(id, prop, [{ t, value, easing }])
motion.animation.removeKeyframe(id, prop, time)
motion.animation.setExpression(id, prop, source)
motion.assets.getImage({ layerId }) / getImage({ assetId })       // assets:read
motion.assets.createImage({ width, height, bytes, mime, name })   // assets:write
motion.timeline.getTime() / setTime(seconds)
\`\`\`

### Images
\`getImage\` returns \`{ assetId, width, height, mime, bytes }\`, where \`bytes\` is
STRAIGHT (un-premultiplied) RGBA8 of length \`width * height * 4\` — the same
layout as \`getImageData\`. Buffers are TRANSFERRED, not copied, in both
directions, so do not keep a reference to one after you pass it on.

\`createImage\` takes \`mime: 'image/rgba8'\` (and then \`bytes.length\` must be
exactly \`width * height * 4\`) or \`image/png\` / \`image/jpeg\` / \`image/webp\`, in
which case the real dimensions come from decoding and yours are ignored.

There are ceilings, and exceeding one is an ordinary refused call carrying a
named code you can branch on: 8192 px per side, 16 MP, 64 MB per asset, 96 MB
in flight per plugin, and 256 MB per plugin per session (released when it
stops).

## Package contents
\`.js .mjs .json .html .css .svg .txt .md .wgsl .glsl\` as text, and
\`.png .jpg .jpeg .webp\` as binary. 2 MB per file, 8 MB per package, 200 files.

Bundle to a single ES module if you use dependencies — \`main\` is loaded as one file.
`;

/**
 * The starter package as bytes.
 *
 * Separated from the download so it can be run through the real package reader
 * in a test. The starter is the de facto spec — far more authors will copy it
 * than will read the docs — so shipping it in a state the editor itself would
 * refuse to install is the worst failure this file has, and it is completely
 * silent: nobody finds out until someone downloads it.
 */
export function buildStarterPackage(): Uint8Array {
  return zipSync({
    'hello-motion/plugin.json': strToU8(`${JSON.stringify(MANIFEST, null, 2)}\n`),
    'hello-motion/main.js': strToU8(MAIN_JS),
    'hello-motion/panel.html': strToU8(PANEL_HTML),
    'hello-motion/README.md': strToU8(README),
  });
}

/** Build the starter package and hand it to the browser as a download. */
export function downloadStarterPlugin(): void {
  const zipped = buildStarterPackage();
  // `zipSync` returns a view over a larger buffer; Blob needs the exact bytes.
  const blob = new Blob([zipped.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hello-motion.zip';
  a.click();
  URL.revokeObjectURL(url);
}
