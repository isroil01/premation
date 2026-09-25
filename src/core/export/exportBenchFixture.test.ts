/**
 * Writes the export benchmark's project — only when asked.
 *
 * `scripts/bench-export-pipeline.cjs` runs this with MOTION_EXPORT_BENCH_FIXTURE
 * set to a path; everywhere else (CI, `npm test`) it is a single skipped test.
 * It lives under jest rather than in the script because the document has to be
 * serialised by the app's own scene/animation code, and that code only loads
 * here.
 *
 * The comp is the benchmark's "solid + text + shapes" case at 1920x1080/30fps:
 * a background, six shapes sweeping across (so every frame differs and the
 * video encoder does real work), and three text layers, one of them moving.
 */

import { writeFileSync } from 'node:fs';
import { node } from '../../../packages/render-tests/harness/sceneKit';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation } from '@motion/animation';
import { DEFAULT_COMP_SETTINGS } from '@stores/projectStore';

const target = process.env.MOTION_EXPORT_BENCH_FIXTURE;
const maybe = target ? it : it.skip;

describe('export benchmark fixture', () => {
  maybe('writes a 1920x1080 solid + text + shapes comp', () => {
    const scene = sceneProjectIO.createEmpty('Export Bench');
    const root = scene.nodes[0]!;
    const layers = [];
    defaultAnimation.clear();

    // The heavy variant (scripts/bench-export-engine.cjs, F1) asks for more
    // layers; unset, this is exactly the 6 + 3 comp the pipeline bench uses.
    const shapeCount = Number(process.env.MOTION_EXPORT_BENCH_SHAPES ?? 6);
    const textCount = Number(process.env.MOTION_EXPORT_BENCH_TEXTS ?? 3);
    const colours = ['#ffca3a', '#ff595e', '#8ac926', '#1982c4', '#6a4c93', '#f4f4f8'];
    for (let i = 0; i < shapeCount; i++) {
      const id = `shape_${i}`;
      const row = i % 6;
      const lane = Math.floor(i / 6);
      layers.push(node(id, {
        kind: 'shape',
        position: { x: 160, y: 140 + row * 150 + (lane % 5) * 12 },
        transform: { width: 220 - (lane % 7) * 12, height: 120, shapeType: i % 2 ? 'ellipse' : 'rectangle' },
        style: { fill: colours[(row + lane) % colours.length] },
      }));
      defaultAnimation.setKeyframe(id, 'x', 0, 160 + row * 40 + lane * 23);
      defaultAnimation.setKeyframe(id, 'x', 4, 1760 - row * 40 - lane * 17);
      defaultAnimation.setKeyframe(id, 'rotation', 0, 0);
      defaultAnimation.setKeyframe(id, 'rotation', 4, 180 + row * 30 + lane * 7);
    }
    const baseTexts = ['Export benchmark', 'Streaming raw RGBA into ffmpeg', '1920 x 1080 / 30 fps'];
    const texts = Array.from({ length: textCount }, (_, i) => baseTexts[i % 3]! + (i >= 3 ? ` ${i}` : ''));
    texts.forEach((content, i) => {
      const id = `text_${i}`;
      layers.push(node(id, {
        kind: 'text',
        position: { x: 960, y: 220 + (i % 3) * 320 + Math.floor(i / 3) * 40 },
        components: [{
          id: `${id}_c`,
          type: 'Text',
          props: { content, fontSize: 96 - (i % 3) * 16, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#f4f4f8' },
        }],
      }));
    });
    defaultAnimation.setKeyframe('text_1', 'x', 0, 700);
    defaultAnimation.setKeyframe('text_1', 'x', 4, 1220);

    for (const layer of layers) (layer as { parent?: string }).parent = root.id;
    (root as { children?: string[] }).children = layers.map((l) => l.id);

    const doc = {
      version: '1.1.0',
      scene: { ...scene, nodes: [root, ...layers] },
      animation: defaultAnimation.snapshot(),
      comps: {
        [root.id]: {
          ...DEFAULT_COMP_SETTINGS,
          id: root.id,
          name: 'Export Bench',
          width: 1920,
          height: 1080,
          fps: 30,
          durationSeconds: 4,
          background: '#10131c',
          transparent: false,
          startFrame: 0,
        },
      },
    };
    writeFileSync(target!, JSON.stringify(doc));
    defaultAnimation.clear();
  });
});
