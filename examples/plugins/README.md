# Example plugins

Two working plugins, and the reason there are two: they solve the same problem —
depth from a flat image — from opposite ends of the API, and the trade between
them is the interesting part.

| | Depth Stack | Parallax 3D |
|---|---|---|
| Makes | Real image layers | No objects; warps pixels |
| Runs on | CPU, once, at command time | GPU, every frame |
| API | Commands + assets + 3D transforms (API 2) | Shader effect (API 4) |
| Can occlude | **Yes** — cards are separate layers | No; one surface has no behind |
| Animatable | Baked keyframes on each card | Every parameter, live |
| Cost | One full-size RGBA allocation per card | Four texture samples per pixel |
| Reversible | Delete the layers | Delete the effect |
| Renderer | Any | **WebGPU only** — passthrough on WebGL2 |

## Installing

Plugins ▸ **Choose folder…** and pick one of the directories here. Then iterate
with **Reload** on the row: it re-reads the folder without asking for consent
again unless the manifest starts asking for something new.

## Where each one actually appears

Installing a plugin does not put anything in the right sidebar by itself — a
plugin shows up wherever its contributions send it, and those are three
different places:

| Contribution | Where to look |
|---|---|
| A **panel** (`contributes.panels`) | Its own tab in the right inspector, beside Properties and Effects — Depth Stack has one |
| A **command** (`commands.register`) | The **Plugins** menu, under the plugin's name, and ⌘⇧P |
| An **effect** (`contributes.effects`) | The **effects browser**, in a folder named after the plugin — that is where Parallax 3D is |

Only Depth Stack contributes a panel. Parallax 3D is an effect: there is nothing
to open, you drop it on a layer.

A tab of your own is granted, not guaranteed — each rail hands out a fixed
number of plugin slots (3 left, 2 right) and past that a panel is demoted into
the shared **Plugin Panels** host. Which happened is printed on the plugin's row.

## Depth Stack

Open the **Depth Stack** tab in the right inspector, select an image layer, set
the sliders and press **Build depth stack**. The same thing without the sliders
is Plugins ▸ Depth Stack ▸ **Explode image into 3D depth cards**.

It cuts the picture into five cards by brightness, gives each a different `z`,
and animates a sideways sweep whose amplitude is proportional to depth. Near
cards travel further than far ones, which is what parallax is.

The original layer stays underneath — hide it to see the stack alone.

## Parallax 3D

Add **Parallax 3D** from the effects browser to any image layer. Drag *Shift X*,
or keyframe it, to move the apparent camera. *Focus plane* chooses which
brightness sits at zero depth: everything brighter comes toward you, everything
darker recedes.

## What neither of these is

**Brightness is not depth.** A real 2.5D plugin displaces the image by a depth
*map* — a second image, usually from a depth model — and this API cannot do
that yet: an effect's generated bind group has exactly one texture, so a shader
cannot sample a second one. That is gap 1 in [`docs/PLUGINS.md`](../../docs/PLUGINS.md) §12,
pinned as a failing-when-lifted assertion in `depthPluginRebuild.test.ts`.

The proxy is good on images lit front-to-back — a subject against a dark
background, anything with haze, a bright sky behind a dark skyline. It is wrong
on a dark object in front of a bright wall, where it will confidently put the
wall in front. That is the proxy being what it is, not a bug.

Depth Stack sidesteps the gap by not being a shader: it builds real layers, so
depth lives in the scene graph where the renderer's existing 3D already handles
it. That is why it can occlude and the shader cannot.
