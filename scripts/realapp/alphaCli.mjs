//   node scripts/realapp/alphaCli.mjs <outDir> [premation-scene --batch outDir]
// F1: the alpha golden scenes through the CLI export (premation-engine --export,
// PNG sequence), each frame compared with its reference and with the native-golden
// frame (premation-scene) of the same document.
import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RT = `${W}/packages/render-tests`;
const cmp = await import(pathToFileURL(`${RT}/scripts/comparator.mjs`).href);
const ENGINE = process.env.PREMATION_ENGINE_PATH ?? `${W}/native/build/windows-clang-cl-engine/engine/premation-engine${process.platform === 'win32' ? '.exe' : ''}`;
const OUT = process.argv[2];
const GOLDEN = process.argv[3]; // a premation-scene --batch out dir of the same scenes (optional)
const ids = (await fs.readdir(`${RT}/scenes`)).filter((f) => /^alpha-.*\.json$/.test(f)).map((f) => f.slice(0, -5));
let pass = 0, total = 0, exact = 0;
for (const id of ids) {
  const doc = JSON.parse(await fs.readFile(`${RT}/scenes/${id}.json`, 'utf8'));
  const dir = path.join(OUT, id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(`${RT}/scenes/${id}.json`, path.join(dir, 'project.json'));
  for (const m of doc.harness?.media ?? []) await fs.copyFile(`${RT}/scenes/${id}.media/${m}`, path.join(dir, m));
  for (const frame of doc.harness.frames) {
    const work = path.join(dir, `work-${frame}`);
    await fs.mkdir(work, { recursive: true });
    const job = { projectPath: path.join(dir, 'project.json'), workDir: work, sequence: 'png', startFrame: frame, endFrame: frame, audio: false,
      fontsManifest: `${RT}/harness/fonts/fonts.json`, chromiumProfile: true };
    const jobFile = path.join(work, 'job.json');
    await fs.writeFile(jobFile, JSON.stringify(job));
    const r = spawnSync(ENGINE, ['--export', jobFile], { encoding: 'utf8', timeout: 120000 });
    const png = path.join(work, 'frames', 'frame_00000.png');
    total++;
    if (r.status !== 0 || !existsSync(png)) {
      console.log(`${id}#${frame}`.padEnd(40), 'EXIT', r.status, (r.stdout || '').split('\n').filter((l) => /error|preflight/.test(l)).slice(-2).join(' ').slice(0, 300));
      continue;
    }
    const actual = await cmp.readPng(png);
    const ref = await cmp.readPng(`${RT}/references/${id}/${frame}.png`);
    const tol = typeof doc.harness.tolerance === 'number' ? doc.harness.tolerance : undefined;
    const c = cmp.compareFrames(actual, ref, { tolerance: tol });
    let vsGolden = '';
    if (GOLDEN && existsSync(path.join(GOLDEN, id, `${frame}.png`))) {
      const g = await cmp.readPng(path.join(GOLDEN, id, `${frame}.png`));
      let max = 0;
      for (let i = 0; i < g.data.length; i++) max = Math.max(max, Math.abs(g.data[i] - actual.data[i]));
      if (max === 0) exact++;
      vsGolden = `vs premation-scene max ${max}`;
    }
    if (c.pass) pass++;
    console.log(`${id}#${frame}`.padEnd(40), c.pass ? 'pass' : 'FAIL', (c.ratio * 100).toFixed(3) + '%', vsGolden, c.mismatchReason ?? '');
  }
}
console.log(`alpha scenes through the CLI export: ${pass}/${total} within tolerance of the reference; ${exact} byte-identical to premation-scene`);
