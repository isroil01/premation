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
 * The template exercises every part of the API surface once: a command, a
 * permission-gated write, and a panel that talks back to its plugin.
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
  panel: 'panel.html',
  permissions: ['scene:read', 'animation:write', 'timeline'],
};

const MAIN_JS = `/**
 * Hello Motion — starter plugin.
 *
 * The host calls activate() once, in a sandboxed Worker, with the plugin API.
 * Everything on \`motion\` is async: it is a message to the editor, not a
 * function call into it.
 */
export function activate(motion) {
  // A command. It shows up in the Command Palette (Cmd/Ctrl+Shift+P) as
  // "Hello Motion: Bounce selection".
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

  // Talk to the panel. The panel calls motionPanel.send(...) and this fires.
  motion.ui.onPanelMessage(async (msg) => {
    if (msg && msg.type === 'count') {
      const layers = await motion.scene.getLayers();
      motion.ui.sendToPanel({ type: 'count', value: layers.length });
    }
  });
}
`;

const PANEL_HTML = `<h3 style="margin:0 0 10px;font-size:14px">Hello Motion</h3>
<p style="margin:0 0 12px;color:#9a9aa4">
  This panel runs in a sandboxed frame. It can talk to its own plugin and nothing else.
</p>
<button id="count">Count layers</button>
<p id="out" style="margin-top:10px"></p>
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
Plugins ▸ **Choose folder…** (pick this folder) or zip it and use **Choose package…**.

## What plugins can and cannot do
Your code runs in a Worker: no DOM, no \`localStorage\`, no \`fetch\`. Everything
you do goes through the \`motion\` API and is checked against the permissions
your manifest declares and the user approved. Every project change is undoable.

## Permissions
\`scene:read\`, \`scene:write\`, \`animation:read\`, \`animation:write\`, \`timeline\`.
Ask for the fewest you need — the list is shown to the user before they install.

## The API
\`\`\`js
motion.ui.notify(message, level)          // level: info | success | warning | error
motion.ui.openPanel() / closePanel()
motion.ui.sendToPanel(data) / onPanelMessage(fn)
motion.commands.register(spec, handler)
motion.composition.get()
motion.scene.getSelection() / setSelection(ids)
motion.scene.getLayers() / getLayer(id)
motion.scene.createLayer({ kind, name, x, y })   // shape | text | group | null
motion.scene.setProperty(id, prop, value)
motion.scene.renameLayer(id, name) / deleteLayer(id)
motion.animation.getTracks(id) / sample(id, prop, time)
motion.animation.setKeyframe(id, prop, time, value, easing)
motion.animation.setKeyframes(id, prop, [{ t, value, easing }])
motion.animation.removeKeyframe(id, prop, time)
motion.animation.setExpression(id, prop, source)
motion.timeline.getTime() / setTime(seconds)
\`\`\`

Bundle to a single ES module if you use dependencies — \`main\` is loaded as one file.
`;

/** Build the starter package and hand it to the browser as a download. */
export function downloadStarterPlugin(): void {
  const zipped = zipSync({
    'hello-motion/plugin.json': strToU8(`${JSON.stringify(MANIFEST, null, 2)}\n`),
    'hello-motion/main.js': strToU8(MAIN_JS),
    'hello-motion/panel.html': strToU8(PANEL_HTML),
    'hello-motion/README.md': strToU8(README),
  });
  // `zipSync` returns a view over a larger buffer; Blob needs the exact bytes.
  const blob = new Blob([zipped.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hello-motion.zip';
  a.click();
  URL.revokeObjectURL(url);
}
