// Heavier D5 fixtures from bench.json: styles.json (fill opacity animated 60->90 % on
// every shape + inner shadow, glow, drop shadow, stroke — the TS re-bakes every frame)
// and grades.json (gaussian blur 20, hue-rotate, levels, noise on every shape).
const fs = require('node:fs');
const path = require('node:path');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench.json'), 'utf8'));
function variant(name, effectsFor, fillOpacity) {
  const d = JSON.parse(JSON.stringify(base));
  for (const n of d.scene.nodes) {
    if (!n.id.startsWith('shape_')) continue;
    const fx = { id: `${n.id}_fx`, type: 'fx', props: { effects: effectsFor(n.id) } };
    n.components.push(fx);
    if (fillOpacity) {
      const st = n.components.find((c) => c.type === 'Style');
      st.props.fillOpacity = 60;
      d.animation.tracks[n.id] = d.animation.tracks[n.id] || {};
      d.animation.tracks[n.id].fillOpacity = { nodeId: n.id, prop: 'fillOpacity', keyframes: [{ t: 0, value: 60 }, { t: 4, value: 90 }] };
    }
  }
  fs.writeFileSync(path.join(__dirname, 'fixtures', name), JSON.stringify(d));
}
variant('styles.json', (id) => [
  { id: `${id}_a`, type: 'inner-shadow', params: { opacity: 80, softness: 12, distance: 6 } },
  { id: `${id}_b`, type: 'glow', params: { radius: 24, intensity: 90 } },
  { id: `${id}_c`, type: 'drop-shadow', params: { distance: 12, softness: 16, opacity: 60 } },
  { id: `${id}_d`, type: 'stroke', params: { width: 6, color: '#ffffff' } },
], true);
variant('grades.json', (id) => [
  { id: `${id}_a`, type: 'gaussian-blur', params: { blurriness: 20 } },
  { id: `${id}_b`, type: 'hue-rotate', params: { amount: 90 } },
  { id: `${id}_c`, type: 'levels', params: { inputBlack: 20, inputWhite: 230 } },
  { id: `${id}_d`, type: 'noise', params: { amount: 10 } },
], false);
// CPU-bound on purpose: Lightning in Multiply (the one composite the GPU route
// leaves to the CPU bake) + Median + Dust & Scratches, fill opacity animated.
variant('heavy.json', (id) => [
  { id: `${id}_a`, type: 'lightning', params: { composite: 3, thickness: 20, glow: 30, branches: 6, detail: 6 } },
  { id: `${id}_b`, type: 'median', params: { radius: 8 } },
  { id: `${id}_c`, type: 'dust-scratches', params: { radius: 6, threshold: 10 } },
], true);
console.log('wrote styles.json, grades.json, heavy.json');
