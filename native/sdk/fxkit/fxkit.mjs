// fxkit: write an effect once in WGSL, get its GPU path and a C++ CPU twin (docs/PLUGIN_SDK.md
// "Writing effects in WGSL: fxkit"). Ships with the SDK; plugins stay native (decision G2).
//
//   node fxkit.mjs <project>            regenerate <project>/gen/* and <project>/premation-plugin.json
//   node fxkit.mjs <project> --check    fail if a generated file is out of date
//
// <project>/fxkit.json is the plugin's manifest (id, name, version, vendor, sdk, binary, …) plus an
// optional "fxkit" block: { "category": "Effects menu category", "families": [ordered names],
// "catalogJs": "ui/catalog.js" (a window.FXKIT catalogue for the plugin's own panels) }.
// <project>/fx/*.fx are the effects; <project>/fx/_lib.fx (optional) is shared by all of them,
// after the kit's own std.fx.
//
// An effect is written ONCE, in fx/<slug>.fx: a JSON meta block (name, params, presets) and a
// kernel in a WGSL subset. The WGSL goes to the GPU as written; the same text is transpiled to
// C++ (against include/premation_fxkit/fxmath.hpp) for the CPU path. Both paths therefore run the same maths, and
// tools/check.mjs holds them to it.
//
// The subset (lint-enforced below): `fn` with typed params, `let` / `var` / `const`, if (…) with
// parentheses, for / loop / break / continue, the vec2f / vec3f / vec4f / vec2i / f32 / i32 / u32
// types, read-only swizzles, `array<T, N>`. No structs, no `%` on floats, no vector compares, no
// ternaries (use select), no `1i` literals, no discard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (ARGS.length !== 1) {
  console.error('usage: node fxkit.mjs <project> [--check]');
  process.exit(2);
}
const ROOT = path.resolve(ARGS[0]);
const FX = path.join(ROOT, 'fx');
const GEN = path.join(ROOT, 'gen');
const CHECK = process.argv.includes('--check');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'fxkit.json'), 'utf8'));
const KIT_OPTS = CONFIG.fxkit || {};
const PLUGIN_ID = CONFIG.id;
if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(PLUGIN_ID || '')) {
  console.error('fxkit.json: id must be a reverse-domain plugin id (e.g. com.example.fx)');
  process.exit(1);
}
const CATEGORY = KIT_OPTS.category || CONFIG.name;
const category = (family) => (family ? `${CATEGORY} · ${family}` : CATEGORY);

const problems = [];
const fail = (where, msg) => problems.push(`${where}: ${msg}`);

// ── reading ───────────────────────────────────────────────────────────────

function readFx(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^\s*\/\*@fx\s*([\s\S]*?)\*\/\s*/);
  const slug = path.basename(file, '.fx');
  if (!m) {
    fail(slug, 'missing the /*@fx { … } */ meta block');
    return null;
  }
  let meta;
  try {
    meta = JSON.parse(m[1]);
  } catch (e) {
    fail(slug, `meta is not JSON: ${e.message}`);
    return null;
  }
  return { slug, meta, code: text.slice(m[0].length) };
}

// ── params ────────────────────────────────────────────────────────────────

const VALUE_TYPES = new Set(['float', 'int', 'angle', 'checkbox', 'popup', 'color', 'point', 'layer']);
const WGSL_TYPE = { float: 'f32', angle: 'f32', int: 'i32', checkbox: 'i32', popup: 'i32', color: 'vec4f', point: 'vec2f' };
const SIZE = { f32: 4, i32: 4, vec2f: 8, vec4f: 16 };
const RESERVED = new Set(['fn', 'let', 'var', 'const', 'if', 'else', 'for', 'loop', 'return', 'break', 'continue', 'true', 'false',
  'struct', 'switch', 'case', 'default', 'while', 'p', 'c', 'uv', 'src', 'level', 'effect', 'auto', 'int', 'float', 'double', 'char',
  'class', 'this', 'new', 'delete', 'static', 'template', 'typename', 'register', 'signed', 'unsigned', 'short', 'long', 'union', 'enum',
  // WGSL reserved words that read like ordinary names
  'active', 'as', 'asm', 'attribute', 'buffer', 'cast', 'catch', 'common', 'compile', 'demote', 'do', 'enable', 'filter', 'final',
  'handle', 'impl', 'import', 'inline', 'layout', 'macro', 'meta', 'method', 'module', 'move', 'mut', 'namespace', 'null', 'of',
  'operator', 'override', 'package', 'pass', 'patch', 'precision', 'private', 'public', 'readonly', 'ref', 'require', 'resource',
  'sample', 'self', 'set', 'shared', 'smooth', 'std', 'super', 'target', 'texture', 'type', 'typedef', 'use', 'using', 'virtual',
  'where', 'with', 'yield', 'match', 'loop', 'enum', 'impl', 'trait', 'unless', 'goto', 'mod', 'fn', 'alias', 'diagnostic', 'requires', 'fwidth', 'select', 'mix', 'step', 'fract', 'length', 'distance', 'round', 'sign', 'exp', 'log']);
const SWIZZLE = /^[xyzwrgba]{1,4}$/;  // the transpiler rewrites any 2–4 letter run of these

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}

/** The auto params every effect gets: Mix (or a generator's Blend + Opacity) and the hidden GPU tag. */
function autoParams(meta) {
  const out = [{ type: 'group', id: 900, name: 'Output', collapsed: true, key: '_g900' }];
  if (meta.generator) {
    out.push({ type: 'popup', id: 903, key: 'fxk_blend', name: 'Composite', default: 1,
      choices: ['Replace', 'Over Layer', 'Under Layer', 'Add', 'Screen', 'Multiply', 'Inside Layer Alpha'],
      desc: 'How the generated image combines with the layer it is applied to.' });
    out.push({ type: 'float', id: 904, key: 'fxk_opacity', name: 'Opacity', default: 100, min: 0, max: 100, precision: 1, unit: '%' });
  } else {
    out.push({ type: 'float', id: 901, key: 'fxk_mix', name: 'Mix', default: 100, min: 0, max: 100, precision: 1, unit: '%',
      desc: 'Blend between the original layer (0 %) and the effect (100 %).' });
  }
  out.push({ type: 'end', id: 902, key: '_e902' });
  // The Studio's bulk / popup edits: a panel's setParam cannot carry a popup choice, so it hands
  // the values to this hidden button and the plugin writes them with set_param_value (one undo step).
  out.push({ type: 'button', id: 998, key: 'fxk_set', name: 'Set Values', hidden: true, desc: 'Studio hook: applies several values in one step.' });
  out.push({ type: 'checkbox', id: 999, key: 'fxk_debug', name: 'Path Tag', default: false, hidden: true, animate: false,
    desc: 'Test hook: paints which render path ran.' });
  return out;
}

function checkParams(slug, meta) {
  const params = [...(meta.params || []), ...autoParams(meta)];
  const ids = new Set();
  const keys = new Set();
  let depth = 0;
  let layers = 0;
  for (const p of params) {
    const where = `${slug}.${p.key || p.id}`;
    if (!Number.isInteger(p.id) || p.id <= 0 || p.id > 999) fail(where, 'id must be an integer 1..999');
    if (ids.has(p.id)) fail(where, `duplicate id ${p.id}`);
    ids.add(p.id);
    if (p.type === 'group') {
      depth++;
      p.key = p.key || `_g${p.id}`;
      continue;
    }
    if (p.type === 'button') {
      p.key = p.key || `_b${p.id}`;
      continue;
    }
    if (p.type === 'end') {
      depth--;
      p.key = p.key || `_e${p.id}`;
      if (depth < 0) fail(where, 'group end without a start');
      continue;
    }
    if (!VALUE_TYPES.has(p.type)) fail(where, `unknown type '${p.type}'`);
    if (!/^[a-z][a-z0-9_]*$/.test(p.key || '')) fail(where, 'key must be lower_snake_case');
    if (RESERVED.has(p.key) || SWIZZLE.test(p.key)) fail(where, `key '${p.key}' is reserved or reads as a swizzle`);
    if (keys.has(p.key)) fail(where, `duplicate key '${p.key}'`);
    keys.add(p.key);
    if (!p.name && !p.hidden) fail(where, 'needs a name');
    if (p.type === 'layer') layers++;
    if (p.id < 900 && p.id >= 900) fail(where, 'ids 900+ are reserved');
    if (['float', 'int', 'angle'].includes(p.type)) {
      if (typeof p.default !== 'number') fail(where, 'numeric default required');
      if (p.type !== 'angle') {
        if (typeof p.min !== 'number' || typeof p.max !== 'number' || p.min >= p.max) fail(where, 'min < max required');
        else if (p.default < p.min || p.default > p.max) fail(where, 'default outside min..max');
      }
    }
    if (p.type === 'popup') {
      if (!Array.isArray(p.choices) || p.choices.length < 2) fail(where, 'popup needs 2+ choices');
      if (!Number.isInteger(p.default) || p.default < 1 || p.default > (p.choices || []).length) fail(where, 'popup default is a 1-based index');
    }
    if (p.type === 'color' && !hexToRgb(p.default)) fail(where, 'colour default is #rrggbb');
    if (p.type === 'point' && !(Array.isArray(p.default) && p.default.length === 2)) fail(where, 'point default is [dx, dy] from the layer centre');
    if (p.type === 'checkbox' && typeof p.default !== 'boolean') fail(where, 'checkbox default is true/false');
  }
  if (depth !== 0) fail(slug, 'unbalanced groups');
  if (layers > 1) fail(slug, 'at most one layer param (the aux layer)');
  return params;
}

/** WGSL uniform layout of the value params (declaration order, natural alignment). */
function layout(params) {
  let off = 0;
  const fields = [];
  for (const p of params) {
    const t = WGSL_TYPE[p.type];
    if (!t || p.key === 'fxk_debug') continue;
    const size = SIZE[t];
    off = Math.ceil(off / size) * size;
    fields.push({ key: p.key, type: t, offset: off, param: p });
    off += size;
  }
  const bytes = Math.ceil(Math.max(off, 16) / 16) * 16;
  return { fields, bytes };
}

// ── show expressions (UPDATE_PARAMS_UI and the Studio panel) ─────────────

function showExpr(slug, expr, params, lang) {
  if (!expr) return null;
  const byKey = new Map(params.filter((p) => p.key).map((p) => [p.key, p]));
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    if (name === 'true' || name === 'false') return name;
    const p = byKey.get(name);
    if (!p) {
      fail(slug, `show: unknown key '${name}'`);
      return '0';
    }
    if (p.type === 'layer') return lang === 'cpp' ? `u.has_layer(${p.id})` : `!!v.${name}`;
    return lang === 'cpp' ? `u.v(${p.id})` : `fxkitNum(v, '${name}')`;
  });
}

// ── transpiler: the WGSL subset → C++ member functions ───────────────────

const SWZ_MAP = { r: 'x', g: 'y', b: 'z', a: 'w', x: 'x', y: 'y', z: 'z', w: 'w' };

function lint(where, code) {
  const rules = [
    [/\bstruct\b/, 'structs are not supported'],
    [/\bdiscard\b/, 'discard is not supported'],
    [/\bswitch\b/, 'switch is not supported; use if / else'],
    [/\bbitcast\b/, 'bitcast is not supported'],
    [/\b\d+i\b/, 'use plain integer literals, not the i suffix'],
    [/vec[234]<\s*f32\s*>/, 'write vec2f / vec3f / vec4f'],
    [/\bif\s+[^(\s]/, 'if needs parentheses'],
    [/\bwhile\b/, 'use for / loop'],
    [/\?[^?]*:/, 'no ternaries; use select(f, t, cond)'],
    [/\.[xyzwrgba]{2,4}\s*(\+|-|\*|\/)?=(?!=)/, 'swizzle assignment is not supported; build a new vector'],
    [/\bmat[234]x[234]/, 'matrices are not supported; use rot2() or dot products'],
    [/\btextureLoad\b|\btextureSample/, 'read textures through src() / texel() / level() / pass_a() / aux()'],
  ];
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [re, msg] of rules) {
    const m = stripped.match(re);
    if (m) fail(where, `${msg} (near "${stripped.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\n/g, ' ')}")`);
  }
  if (/%/.test(stripped)) {
    // integer % is fine in both languages; a float % is not portable — kernels use fmodp() instead.
    for (const m of stripped.matchAll(/([\w.)\]]+)\s*%\s*([\w.(]+)/g)) {
      if (/\d\.\d|\.\d|\d\./.test(m[0])) fail(where, `float % is not portable; use fmodp() (near "${m[0]}")`);
    }
  }
}

/** Replace `array<T, N>(a, b, …)` with `std::array<T, N>{a, b, …}` (balanced parens). */
function arrays(code) {
  let out = '';
  let i = 0;
  const re = /\barray<([^<>]+)>\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    out += code.slice(i, m.index) + `std::array<${m[1]}>{`;
    let depth = 1;
    let j = re.lastIndex;
    for (; j < code.length && depth > 0; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') depth--;
    }
    out += arrays(code.slice(re.lastIndex, j - 1)) + '}';
    i = j;
    re.lastIndex = j;
  }
  return out + code.slice(i);
}

function transpile(where, code) {
  lint(where, code);
  // Protect comments and strings from the rewrites.
  const saved = [];
  let c = code.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, (s) => `\u0001${saved.push(s) - 1}\u0002`);
  c = arrays(c);
  c = c.replace(/(?<!std::)\barray<([^<>]+)>/g, 'std::array<$1>');
  // functions
  c = c.replace(/\bfn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([\w:<>, ]+?))?\s*\{/g, (_, name, args, ret) => {
    const a = args.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const mm = /^(\w+)\s*:\s*(.+)$/.exec(s);
      if (!mm) {
        fail(where, `bad parameter '${s}' in fn ${name}`);
        return s;
      }
      return `${mm[2].trim()} ${mm[1]}`;
    });
    return `${ret ? ret.trim() : 'void'} ${name}(${a.join(', ')}) const {`;
  });
  // declarations
  c = c.replace(/\blet\s+(\w+)\s*:\s*([\w:<>, ]+?)\s*=/g, 'const $2 $1 =');
  c = c.replace(/\blet\s+(\w+)\s*=/g, 'const auto $1 =');
  c = c.replace(/\bvar\s+(\w+)\s*:\s*([\w:<>, ]+?)\s*=/g, '$2 $1 =');
  c = c.replace(/\bvar\s+(\w+)\s*:\s*([\w:<>, ]+?)\s*;/g, '$2 $1{};');
  c = c.replace(/\bvar\s+(\w+)\s*=/g, 'auto $1 =');
  // const: module level → static constexpr members; in a body → constexpr locals
  {
    let depth = 0;
    let out = '';
    const re = /[{}]|\bconst\s+(\w+)\s*(?::\s*([\w:<>, ]+?))?\s*=/g;
    let last = 0;
    let m;
    while ((m = re.exec(c))) {
      out += c.slice(last, m.index);
      last = re.lastIndex;
      if (m[0] === '{') { depth++; out += '{'; continue; }
      if (m[0] === '}') { depth--; out += '}'; continue; }
      const type = m[2] ? m[2].trim() : 'auto';
      out += depth === 0 ? `static constexpr ${type} ${m[1]} =` : `constexpr ${type} ${m[1]} =`;
    }
    c = out + c.slice(last);
  }
  c = c.replace(/\bloop\s*\{/g, 'for (;;) {');
  // conversions (types stay types in declarations; calls become conversion functions)
  c = c.replace(/\b(i32|u32|f32)\s*\(/g, 'to_$1(');
  // swizzles: multi-component reads become methods, single components map rgba → xyzw
  c = c.replace(/\.([xyzwrgba]{2,4})\b(?!\s*\()/g, (_, s) => `.${[...s].map((ch) => SWZ_MAP[ch]).join('')}()`);
  c = c.replace(/\.([rgba])\b(?!\s*\()/g, (_, s) => `.${SWZ_MAP[s]}`);
  // float literals → f-suffixed (so no double sneaks into float maths)
  c = c.replace(/(?<![\w.])(\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)(?![\w.])/g, '$1f');
  c = c.replace(/(?<![\w.])(\d+\.\d*(?:[eE][+-]?\d+)?f)f\b/g, '$1');
  // restore comments (\u0001 / \u0002 bracket the placeholders: they never occur in source text)
  // eslint-disable-next-line no-control-regex
  c = c.replace(/\u0001(\d+)\u0002/g, (_, n) => saved[Number(n)]);
  return c;
}

// ── swizzles for include/premation_fxkit/fxmath.hpp ───────────────────────────────────────────

function swizzles() {
  const files = {};
  const defs = [];
  const VT = { 2: 'vec2f', 3: 'vec3f', 4: 'vec4f' };
  for (const n of [2, 3, 4]) {
    const comps = 'xyzw'.slice(0, n).split('');
    const decl = [];
    const combos = (len) => {
      let acc = [''];
      for (let i = 0; i < len; i++) acc = acc.flatMap((a) => comps.map((ch) => a + ch));
      return acc;
    };
    for (const len of [2, 3, 4]) {
      for (const s of combos(len)) {
        decl.push(`  constexpr ${VT[len]} ${s}() const;`);
        defs.push(`constexpr ${VT[len]} ${VT[n]}::${s}() const { return ${VT[len]}(${[...s].join(', ')}); }`);
      }
    }
    files[`swz_vec${n}.inc`] = `// GENERATED by fxkit.mjs\n${decl.join('\n')}\n`;
  }
  files['swz_defs.inc'] = `// GENERATED by fxkit.mjs\n${defs.join('\n')}\n`;
  return files;
}

// ── C++ emission ──────────────────────────────────────────────────────────

const cstr = (s) => JSON.stringify(String(s ?? ''));
const CPP_TYPE = { f32: 'f32', i32: 'i32', vec2f: 'vec2f', vec4f: 'vec4f' };
const PR_TYPE = { float: 'PR_PARAM_FLOAT_SLIDER', int: 'PR_PARAM_SLIDER', angle: 'PR_PARAM_ANGLE', checkbox: 'PR_PARAM_CHECKBOX',
  popup: 'PR_PARAM_POPUP', color: 'PR_PARAM_COLOR', point: 'PR_PARAM_POINT', layer: 'PR_PARAM_LAYER', group: 'PR_PARAM_GROUP_START',
  end: 'PR_PARAM_GROUP_END', button: 'PR_PARAM_BUTTON' };

function rawChunks(s) {
  // MSVC-compatible: string literals stay under its per-literal limit.
  const out = [];
  for (let i = 0; i < s.length; i += 12000) out.push(`R"FXKWGSL(${s.slice(i, i + 12000)})FXKWGSL"`);
  return out.join('\n');
}

function paramTable(fx) {
  return fx.params.map((p) => {
    const def = p.type === 'color' ? hexToRgb(p.default) : p.type === 'point' ? [p.default[0], p.default[1], 0, 0]
      : p.type === 'checkbox' ? [p.default ? 1 : 0, 0, 0, 0] : typeof p.default === 'number' ? [p.default, 0, 0, 0] : [0, 0, 0, 0];
    let flags = [];
    if (p.type === 'group' && p.collapsed) flags.push('PR_PARAM_FLAG_START_COLLAPSED');
    if (p.hidden) flags.push('PR_PARAM_FLAG_HIDDEN');
    if (p.animate === false || p.type === 'layer') flags.push('PR_PARAM_FLAG_CANNOT_ANIMATE');
    const lo = p.min ?? (p.type === 'angle' ? -1e6 : 0);
    const hi = p.max ?? (p.type === 'angle' ? 1e6 : 0);
    const slo = p.smin ?? (p.type === 'angle' ? 0 : lo);
    const shi = p.smax ?? (p.type === 'angle' ? 360 : hi);
    return `  {${PR_TYPE[p.type]}, ${p.id}, ${flags.length ? flags.join(' | ') : '0'}, ${cstr(p.name || '')}, {${def.map((v) => +v).join(', ')}}, ${+lo}, ${+hi}, ${+slo}, ${+shi}, ${p.precision ?? (p.type === 'int' ? 0 : 2)}, ${p.choices ? cstr(p.choices.join('|')) : 'nullptr'}, ${p.desc ? cstr(p.desc) : 'nullptr'}}`;
  }).join(',\n');
}

function fillCode(fx) {
  return fx.layout.fields.map((f) => {
    const p = f.param;
    if (p.type === 'point') return `    p.${f.key} = r.point(${p.id});`;
    if (p.type === 'color') return `    p.${f.key} = r.color(${p.id});`;
    if (f.type === 'i32') return `    p.${f.key} = r.integer(${p.id});`;
    if (p.unit === 'px') return `    p.${f.key} = r.pixels(${p.id});`;
    return `    p.${f.key} = r.number(${p.id});`;
  }).join('\n');
}

function wgslParams(fx) {
  return `struct Params {\n${fx.layout.fields.map((f) => `  ${f.key}: ${f.type},`).join('\n')}\n}\n@group(0) @binding(1) var<uniform> prm: Params;\n`;
}

function finalFn(fx) {
  const ret = fx.meta.generator
    ? 'return fxk_composite(src(p), effect(p), prm.fxk_blend, clamp(prm.fxk_opacity * 0.01, 0.0, 1.0));'
    : 'let o = src(p);\n  return mix(o, effect(p), clamp(prm.fxk_mix * 0.01, 0.0, 1.0));';
  return `fn fxk_final(p: vec2f) -> vec4f {\n  ${ret}\n}\n`;
}

function emitCpp(all) {
  const fxs = all.map((fx) => {
    const code = transpile(fx.slug, fx.code + '\n' + finalFn(fx));
    const passes = fx.meta.passes || [];
    const ui = fx.params.filter((p) => p.show).map((p) => `    u.show(${p.id}, ${showExpr(fx.slug, p.show, fx.params, 'cpp')});`).join('\n');
    const layerParam = fx.params.find((p) => p.type === 'layer');
    const flags = [
      fx.meta.generator ? 'PR_OUT_FLAG_GENERATOR' : null,
      fx.meta.animated ? 'PR_OUT_FLAG_NON_PARAM_VARY' : null,
    ].filter(Boolean);
    return `
// ── ${fx.meta.name} (fx/${fx.slug}.fx) ──
struct P_${fx.slug} {
${fx.layout.fields.map((f) => `  ${CPP_TYPE[f.type]} ${f.key}{};`).join('\n')}
};
inline constexpr ParamDesc kParams_${fx.slug}[] = {
${paramTable(fx)}
};
struct Fx_${fx.slug} : Ctx {
  P_${fx.slug} prm{};
  static constexpr EffectDesc desc{${cstr(`${PLUGIN_ID}.${fx.slug}`)}, ${cstr(fx.meta.name)}, ${cstr(fx.about)}, kParams_${fx.slug},
      static_cast<std::uint32_t>(std::size(kParams_${fx.slug})), ${fx.meta.pyramid || 0}, ${passes.length}, ${fx.meta.expand ? cstr(fx.meta.expand) : 'nullptr'},
      ${flags.length ? flags.join(' | ') : '0U'}, kWgsl_${fx.slug}, ${fx.layout.bytes}, ${layerParam ? layerParam.id : 0}};
  static void fill(P_${fx.slug}& p, const ParamReader& r) {
${fillCode(fx)}
  }
  static void pack(const P_${fx.slug}& p, std::uint8_t* b) {
${fx.layout.fields.map((f) => `    std::memcpy(b + ${f.offset}, &p.${f.key}, ${SIZE[f.type]});`).join('\n')}
  }
  static void ui([[maybe_unused]] const UiCtx& u) {
${ui}
  }
  [[nodiscard]] static float expand_px([[maybe_unused]] const P_${fx.slug}& prm) {
    return ${fx.meta.expand ? expandExpr(fx) : '0.0F'};
  }
  [[nodiscard]] vec4f run_pass(int i, vec2f p) const {
${passes.map((name, i) => `    if (i == ${i}) return ${name}(p);`).join('\n')}
    (void)i;
    return fxk_final(p);
  }
${indent(code, 2)}
};
`;
  });
  const wgsl = all.map((fx) => `inline constexpr const char* kWgsl_${fx.slug} =\n${rawChunks(fx.wgsl)};\n`).join('\n');
  const [vMajor, vMinor, vPatch] = String(CONFIG.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  return `// GENERATED by fxkit.mjs from fx/*.fx — do not edit.
#pragma once
#define FXK_PLUGIN_ID ${cstr(PLUGIN_ID)}
#define FXK_PLUGIN_NAME ${cstr(CONFIG.name || PLUGIN_ID)}
#define FXK_VERSION_MAJOR ${vMajor}
#define FXK_VERSION_MINOR ${vMinor}
#define FXK_VERSION_PATCH ${vPatch}
#include <premation_fxkit/runtime.hpp>

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wconversion"
#pragma clang diagnostic ignored "-Wimplicit-float-conversion"
#pragma clang diagnostic ignored "-Wimplicit-int-float-conversion"
#pragma clang diagnostic ignored "-Wfloat-conversion"
#pragma clang diagnostic ignored "-Wsign-conversion"
#pragma clang diagnostic ignored "-Wshadow"
#pragma clang diagnostic ignored "-Wshadow-field"
#pragma clang diagnostic ignored "-Wunused-variable"
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wfloat-equal"
#endif

namespace fxk::kit {

inline constexpr const char* kPreludeWgsl =
${rawChunks(PRELUDE_WGSL)};
inline constexpr const char* kLibWgsl =
${rawChunks(LIB_WGSL)};

${wgsl}
${fxs.join('')}

#define FXK_EFFECTS(X) \\
${all.map((fx) => `  X(${fx.slug})`).join(' \\\n')}

}  // namespace fxk::kit

#if defined(__clang__)
#pragma clang diagnostic pop
#endif
`;
}

function expandExpr(fx) {
  // "expand": "radius * 2 + 4" — an expression over the effect's params (already in world px).
  return fx.meta.expand.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    if (/^(max|min|abs|sqrt)$/.test(name)) return `fxk::${name}`;
    if (!fx.layout.fields.find((f) => f.key === name)) fail(fx.slug, `expand: unknown param '${name}'`);
    return `static_cast<float>(prm.${name})`;
  }).replace(/(?<![\w.])(\d+\.\d*|\d+)(?![\w.])/g, (n) => (n.includes('.') ? `${n.endsWith('.') ? `${n}0` : n}F` : `${n}.0F`));
}

const indent = (s, n) => s.split('\n').map((l) => (l.trim() ? ' '.repeat(n) + l : l)).join('\n');

// ── the WGSL prelude (bindings + the texture helpers; the C++ twin is in include/premation_fxkit/runtime.hpp) ─

/** One texel / bilinear / B-spline helper per texture binding (see prelude.wgsl for why). */
function textureHelpers() {
  const out = ['// ── generated by fxkit.mjs: per-texture helpers ──'];
  for (const n of ['src', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'pa', 'pb', 'aux']) {
    out.push(`fn fxk_tex_${n}(i: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(t_${n}));
  if (i.x < 0 || i.y < 0 || i.x >= d.x || i.y >= d.y) { return vec4f(0.0); }
  return textureLoad(t_${n}, i, 0);
}
fn fxk_bil_${n}(q: vec2f) -> vec4f {
  let g = q - vec2f(0.5);
  let f0 = floor(g);
  let f = g - f0;
  let i = vec2i(f0);
  return mix(mix(fxk_tex_${n}(i), fxk_tex_${n}(i + vec2i(1, 0)), f.x), mix(fxk_tex_${n}(i + vec2i(0, 1)), fxk_tex_${n}(i + vec2i(1, 1)), f.x), f.y);
}`);
    if (/^l\d$/.test(n)) {
      out.push(`fn fxk_bsp_${n}(q: vec2f) -> vec4f {
  let g = q - vec2f(0.5);
  let f0 = floor(g);
  let f = g - f0;
  let i = vec2i(f0);
  let wx = fxk_bweights(f.x);
  let wy = fxk_bweights(f.y);
  var acc = vec4f(0.0);
  for (var y = 0; y < 4; y++) {
    var row = vec4f(0.0);
    for (var x = 0; x < 4; x++) {
      row += fxk_tex_${n}(i + vec2i(x - 1, y - 1)) * fxk_w4(wx, x);
    }
    acc += row * fxk_w4(wy, y);
  }
  return acc;
}`);
    }
  }
  return out.join('\n');
}

const PRELUDE_WGSL = fs.readFileSync(path.join(KIT, 'prelude.wgsl'), 'utf8').replace(/\r\n/g, '\n') + '\n' + textureHelpers() + '\n';
const projectLib = path.join(FX, '_lib.fx');
const LIB_SRC = (fs.readFileSync(path.join(KIT, 'std.fx'), 'utf8')
  + (fs.existsSync(projectLib) ? `\n// ── fx/_lib.fx ──\n${fs.readFileSync(projectLib, 'utf8')}` : '')).replace(/\r\n/g, '\n');
const LIB_WGSL = LIB_SRC;

function entryPoints(fx) {
  const passes = fx.meta.passes || [];
  return `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}
@fragment fn fs_down(@builtin(position) pos: vec4f) -> @location(0) vec4f { return fxk_down(vec2i(pos.xy)); }
// NaN / inf never leave a pass (a NaN compares false, so it becomes 0) — the CPU twin does the same in write_px.
fn fxk_clean(c: vec4f) -> vec4f { return select(vec4f(0.0), c, abs(c) < vec4f(3.0e38)); }
${passes.map((n, i) => `@fragment fn fs_p${i}(@builtin(position) pos: vec4f) -> @location(0) vec4f { return fxk_clean(${n}(pos.xy)); }`).join('\n')}
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  if (fr.debug > 0.5) { return vec4f(0.0, 1.0, 0.0, 1.0); }
  return fxk_clean(fxk_final(pos.xy));
}
`;
}

// ── catalogue for the panels ─────────────────────────────────────────────

function apiValue(p, v) {
  if (p.type === 'checkbox') return { kind: 'bool', value: !!v };
  if (p.type === 'popup') {
    const label = typeof v === 'string' ? v : p.choices[Math.max(1, Math.min(p.choices.length, Math.round(v))) - 1];
    return { kind: 'choice', value: label };
  }
  if (p.type === 'color') {
    const c = Array.isArray(v) ? v : hexToRgb(v);
    return { kind: 'color', value: { r: c[0], g: c[1], b: c[2], a: c[3] ?? 1 } };
  }
  return { kind: 'scalar', value: Number(v) };
}

function presetValues(fx, values, where) {
  const manifest = {};
  const api = [];
  for (const [key, v] of Object.entries(values || {})) {
    const p = fx.params.find((q) => q.key === key);
    if (!p || !VALUE_TYPES.has(p.type) || p.type === 'layer') {
      fail(where, `preset value for unknown key '${key}'`);
      continue;
    }
    if (p.type === 'point') {
      if (!Array.isArray(v)) { fail(where, `point '${key}' needs [dx, dy]`); continue; }
      manifest[`p${p.id}`] = v;
      api.push({ path: `p${p.id}X`, value: { kind: 'scalar', value: v[0] } }, { path: `p${p.id}Y`, value: { kind: 'scalar', value: v[1] } });
      continue;
    }
    if (p.type === 'popup' && !(typeof v === 'number' || p.choices.includes(v))) fail(where, `'${key}': not a choice`);
    if (['float', 'int', 'angle'].includes(p.type) && typeof v !== 'number') fail(where, `'${key}' must be a number`);
    if (['float', 'int'].includes(p.type) && (v < p.min || v > p.max)) fail(where, `'${key}' = ${v} is outside ${p.min}..${p.max}`);
    if (p.type === 'color' && !(Array.isArray(v) || hexToRgb(v))) fail(where, `'${key}' must be #rrggbb`);
    manifest[`p${p.id}`] = v;
    api.push({ path: `p${p.id}`, value: apiValue(p, v) });
  }
  return { manifest, api };
}

function catalogue(all, looks) {
  const effects = all.map((fx) => ({
    slug: fx.slug,
    matchName: `${PLUGIN_ID}.${fx.slug}`,
    name: fx.meta.name,
    family: fx.meta.family,
    summary: fx.meta.summary,
    tags: fx.meta.tags || [],
    generator: !!fx.meta.generator,
    animated: !!fx.meta.animated,
    transition: !!fx.meta.transition,
    params: fx.params.filter((p) => !p.hidden).map((p) => ({
      id: p.id, key: `p${p.id}`, name: p.name, type: p.type, def: p.default, min: p.min, max: p.max, smin: p.smin, smax: p.smax,
      precision: p.precision, unit: p.unit, choices: p.choices, desc: p.desc, collapsed: p.collapsed, show: p.show ? `@@${showExpr(fx.slug, p.show, fx.params, 'js')}@@` : undefined,
      wkey: p.key,
    })),
    presets: (fx.meta.presets || []).map((ps) => ({ name: ps.name, thumb: `${fx.slug}--${slugify(ps.name)}`, values: presetValues(fx, ps.values, `${fx.slug} preset '${ps.name}'`).api })),
  }));
  const bySlug = new Map(all.map((fx) => [fx.slug, fx]));
  const lk = (looks || []).map((l) => ({
    name: l.name, family: l.family, summary: l.summary, thumb: `look--${slugify(l.name)}`,
    stack: l.stack.map((s) => {
      const fx = bySlug.get(s.fx);
      if (!fx) { fail(`look '${l.name}'`, `unknown effect '${s.fx}'`); return null; }
      return { slug: s.fx, matchName: `${PLUGIN_ID}.${s.fx}`, values: presetValues(fx, s.values, `look '${l.name}' ▸ ${s.fx}`).api };
    }).filter(Boolean),
  }));
  const json = JSON.stringify({ version: BASE.version, effects, looks: lk }, null, 1)
    .replace(/"@@(.*?)@@"/g, (_, body) => `(v) => (${JSON.parse(`"${body}"`)})`);
  return `// GENERATED by fxkit.mjs from fx/*.fx and looks/looks.json — do not edit.\n'use strict';\nconst fxkitNum = (v, k) => (typeof v[k] === 'number' ? v[k] : v[k] === true ? 1 : v[k] === false ? 0 : 0);\nwindow.FXKIT = ${json};\n`;
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── main ──────────────────────────────────────────────────────────────────

const BASE = { ...CONFIG };
delete BASE.fxkit;  // the kit's own options are not part of the manifest
const FAMILY_ORDER = KIT_OPTS.families || [];
const familyRank = (f) => (FAMILY_ORDER.includes(f) ? FAMILY_ORDER.indexOf(f) : FAMILY_ORDER.length);

const files = fs.readdirSync(FX).filter((f) => f.endsWith('.fx') && !f.startsWith('_')).sort();
const all = [];
for (const f of files) {
  const fx = readFx(path.join(FX, f));
  if (!fx) continue;
  const m = fx.meta;
  if (!m.name) fail(fx.slug, 'meta.name required');
  if (FAMILY_ORDER.length && !FAMILY_ORDER.includes(m.family)) fail(fx.slug, `meta.family must be one of ${FAMILY_ORDER.join(', ')}`);
  if (m.summary && m.summary.length > 220) fail(fx.slug, 'meta.summary is at most 220 chars');
  if (!/^[a-z][a-z0-9_]*$/.test(fx.slug)) fail(fx.slug, 'file name must be lower_snake_case');
  if (!/\bfn\s+effect\s*\(\s*p\s*:\s*vec2f\s*\)\s*->\s*vec4f/.test(fx.code)) fail(fx.slug, 'needs fn effect(p: vec2f) -> vec4f');
  for (const pass of m.passes || []) {
    if (!new RegExp(`\\bfn\\s+${pass}\\s*\\(\\s*p\\s*:\\s*vec2f\\s*\\)\\s*->\\s*vec4f`).test(fx.code)) fail(fx.slug, `pass '${pass}' needs fn ${pass}(p: vec2f) -> vec4f`);
  }
  if ((m.passes || []).length > 2) fail(fx.slug, 'at most 2 passes before the final one');
  if (m.pyramid && (m.pyramid < 1 || m.pyramid > 6)) fail(fx.slug, 'pyramid is 1..6 levels');
  fx.params = checkParams(fx.slug, m);
  fx.layout = layout(fx.params);
  if (fx.layout.bytes > 768) fail(fx.slug, `params need ${fx.layout.bytes} bytes; the limit is 768`);
  fx.about = `${m.name}${m.summary ? ` — ${m.summary}` : ''} (${BASE.name} ${BASE.version})`;
  fx.wgsl = `${PRELUDE_WGSL}\n${wgslParams(fx)}\n${LIB_WGSL}\n// ── fx/${fx.slug}.fx ──\n${fx.code}\n${finalFn(fx)}${entryPoints(fx)}`;
  all.push(fx);
}
all.sort((a, b) => familyRank(a.meta.family) - familyRank(b.meta.family) || a.meta.name.localeCompare(b.meta.name));

const looksFile = path.join(ROOT, 'looks', 'looks.json');
const looks = fs.existsSync(looksFile) ? JSON.parse(fs.readFileSync(looksFile, 'utf8')).looks : [];

transpile('_lib', LIB_SRC);  // lint the library too
const libCpp = transpile('_lib', LIB_SRC);

const manifest = { ...BASE };
manifest.effects = all.map((fx) => ({ matchName: `${PLUGIN_ID}.${fx.slug}`, name: fx.meta.name, category: category(fx.meta.family) }));
manifest.presets = [];
for (const fx of all) {
  for (const ps of fx.meta.presets || []) {
    const { manifest: values } = presetValues(fx, ps.values, `${fx.slug} preset '${ps.name}'`);
    manifest.presets.push({ name: ps.name, category: category(fx.meta.name), effect: `${PLUGIN_ID}.${fx.slug}`, values });
  }
}
if (manifest.presets.length > 512) fail('manifest', `${manifest.presets.length} presets; the engine reads 512`);

const reportProblems = () => {
  if (!problems.length) return;
  console.error(problems.map((p) => `  ✗ ${p}`).join('\n'));
  console.error(`gen: ${problems.length} problem(s)`);
  process.exit(1);
};
reportProblems();

// A plain-JSON catalogue for the Python tools (thumbnails, checks): manifest-form values.
const toolCatalog = {
  effects: all.map((fx) => {
    const completion = fx.params.find((p) => p.key === 'completion');
    return {
      slug: fx.slug, matchName: `${PLUGIN_ID}.${fx.slug}`, name: fx.meta.name, family: fx.meta.family,
      generator: !!fx.meta.generator, transition: !!fx.meta.transition, animated: !!fx.meta.animated,
      completion: completion ? `p${completion.id}` : null,
      presets: (fx.meta.presets || []).map((ps) => ({ name: ps.name, thumb: `${fx.slug}--${slugify(ps.name)}`, values: presetValues(fx, ps.values, ps.name).manifest })),
    };
  }),
  looks: looks.map((l) => ({
    name: l.name, thumb: `look--${slugify(l.name)}`,
    stack: l.stack.map((s) => ({ matchName: `${PLUGIN_ID}.${s.fx}`, values: presetValues(all.find((f) => f.slug === s.fx), s.values, l.name).manifest })),
  })),
};

const outputs = {
  [path.join(GEN, 'catalog.json')]: JSON.stringify(toolCatalog, null, 1) + '\n',
  [path.join(GEN, 'fx_gen.hpp')]: emitCpp(all),
  [path.join(GEN, 'lib.inc')]: `// GENERATED by fxkit.mjs from std.fx + fx/_lib.fx — do not edit. Members of kit::Ctx.\n${libCpp}\n`,
  [path.join(ROOT, 'premation-plugin.json')]: JSON.stringify(manifest, null, 2) + '\n',
  ...(KIT_OPTS.catalogJs ? { [path.join(ROOT, KIT_OPTS.catalogJs)]: catalogue(all, looks) } : {}),
};
// The swizzle tables are the same for every project: they ship with the kit (include/premation_fxkit),
// and --check also holds them to the generator.
if (CHECK) {
  for (const [k, v] of Object.entries(swizzles())) {
    const file = path.join(KIT, 'include', 'premation_fxkit', k);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (old !== v) {
      console.error(`gen --check: the kit's ${k} differs from the generator's swizzles`);
      process.exit(1);
    }
  }
}
// Emitting the C++ lints every kernel (transpile → lint): report what that found before writing.
reportProblems();
let stale = 0;
for (const [file, text] of Object.entries(outputs)) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old === text) continue;
  stale++;
  if (!CHECK) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
if (CHECK && stale) {
  console.error(`gen --check: ${stale} generated file(s) out of date; run node fxkit.mjs`);
  process.exit(1);
}
const presetCount = manifest.presets.length;
console.log(`gen: ${all.length} effects, ${presetCount} presets, ${looks.length} looks${CHECK ? ' (up to date)' : `, ${stale} file(s) written`}`);
