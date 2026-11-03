#!/usr/bin/env node
// create-premation-plugin — start a Premation native plugin project (docs/PLUGIN_SDK.md
// "Starting a plugin"). Ships with the SDK (share/premation-sdk/).
//
//   node create-premation-plugin.mjs <dir> --id com.you.glow --name "Glow"
//        [--template effect|fx|command] [--vendor "You"]
//
// Templates
//   effect   a C++ effect (CPU smart render, 8/16/32 bpc, rows in parallel)
//   fx       an effect written once in WGSL with fxkit: GPU path + generated C++ CPU twin
//   command  a Plugins-menu command that edits the project through the engine API (one undo step)
//
// Every project gets: CMakeLists.txt (find_package(PremationSdk)), the manifest, tests/cases.json
// for `premation-plugins test` (goldens under tests/golden/), a README, .gitignore and the CI
// workflow that builds Windows / macOS / Linux, packs a signed .pplugin and publishes on a tag.
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES = ['effect', 'fx', 'command'];

function parseArgs(argv) {
  const out = { template: 'effect', vendor: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' || a === '--name' || a === '--template' || a === '--vendor') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else {
      rest.push(a);
    }
  }
  if (rest.length !== 1) throw new Error('give exactly one project folder');
  out.dir = rest[0];
  return out;
}

const usage = 'usage: node create-premation-plugin.mjs <dir> --id com.you.glow --name "Glow" [--template effect|fx|command] [--vendor "You"]';

/** "Glow Pro" → "glow_pro": the CMake target, binary and fxkit file name. */
export function slugOf(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(s) ? s : `p_${s || 'plugin'}`;
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const cstr = (s) => JSON.stringify(String(s));

function binaries(slug) {
  return { 'windows-x64': `${slug}.dll`, 'macos-universal': `lib${slug}.dylib`, 'linux-x64': `lib${slug}.so` };
}

// ── shared files ──────────────────────────────────────────────────────────

function gitignore(template) {
  return ['build/', 'sdk/', 'plugin-key.json', '*.pplugin', '*.pplugin.sig', 'tests/golden/*.actual.pgold',
    ...(template === 'fx' ? [] : [])].join('\n') + '\n';
}

function readme(o) {
  const effectLine = o.template === 'command'
    ? `Run it from Plugins ▸ ${o.name} with layers selected.`
    : `Apply it from Effects ▸ ${o.name}.`;
  const fxSteps = o.template === 'fx'
    ? `
The effect is \`fx/${o.slug}.fx\`: a JSON block (params, presets) and a WGSL kernel. The GPU runs the
WGSL; fxkit transpiles the same text to C++ for the CPU path. After editing it:

\`\`\`sh
node sdk/share/premation-sdk/fxkit/fxkit.mjs .     # regenerate gen/ and premation-plugin.json
\`\`\`

(CMake also runs this when Node is on the PATH.) Commit \`gen/\` so a build without Node still works.
See docs/PLUGIN_SDK.md "Writing effects in WGSL: fxkit" for the kernel API and the WGSL subset.
`
    : '';
  const tests = o.template === 'command'
    ? ''
    : `
## Tests

\`tests/cases.json\` lists renders of your effect; \`tests/golden/\` holds what they should look like.

\`\`\`sh
./sdk/bin/premation-plugins --plugins build/plugins/${o.slug} test tests/cases.json --bless   # once, after checking the look
./sdk/bin/premation-plugins --plugins build/plugins/${o.slug} test tests/cases.json           # every build (CI runs it)
\`\`\`

A failing case writes \`tests/golden/<name>.actual.pgold\` beside the golden.
`;
  return `# ${o.name}

A Premation native plugin (${o.template} template). ${effectLine}

## Build

Unzip the SDK from a Premation release (\`premation-sdk-<platform>.zip\`) to \`./sdk\`, then:

\`\`\`sh
cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$PWD/sdk"
cmake --build build --config Release
./sdk/bin/premation-plugins --plugins build/plugins/${o.slug} list
\`\`\`
${fxSteps}
To try it in the editor, copy \`build/plugins/${o.slug}\` into \`<userData>/native-plugins/\` and use
Effects ▸ Rescan Plugins.
${tests}
## Publish

\`\`\`sh
node sdk/share/premation-sdk/sign-plugin.mjs keygen      # once; back up plugin-key.json, it is the only key that can ship updates
node sdk/share/premation-sdk/pack-plugin.mjs build/plugins/${o.slug} --only-present --key plugin-key.json
\`\`\`

\`.github/workflows/build.yml\` does this for all three platforms and publishes on a \`v*\` tag
(secrets and variables are listed at its top). docs/PLUGIN_STORE.md has the rest.
`;
}

function workflow(o) {
  const testStep = o.template === 'command'
    ? ''
    : `      - name: Golden renders
        shell: bash
        run: ./sdk/bin/premation-plugins --plugins build/plugins/${o.slug} test tests/cases.json
        if: matrix.name != 'macos-universal' || runner.arch == 'ARM64'
`;
  const nodeStep = o.template === 'fx'
    ? `      - uses: actions/setup-node@v4
        with: { node-version: 22 }
`
    : '';
  return `# CI for ${o.name} (created by create-premation-plugin).
#
# Builds the plugin on Windows, macOS (universal) and Linux against the SDK from a Premation
# release, merges the three builds into ONE bundle, packs it into a signed \`.pplugin\`
# (docs/PLUGIN_STORE.md §2) and, on a tag, publishes it to the Premation plugin store.
#
# Secrets:
#   PREMATION_PLUGIN_KEY    the key file \`sign-plugin.mjs keygen\` wrote (its JSON)
#   PREMATION_TOKEN         an access token from your signed-in Premation account
# Variables:
#   PREMATION_SDK_VERSION   the Premation release whose SDK to build against (e.g. v1.1.0)
#   PREMATION_VISIBILITY    public | private (public needs a verified publisher)
#   PREMATION_API           the store's API base URL (the backend origin + /api)

name: plugin

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:

jobs:
  build:
    name: Build \${{ matrix.name }}
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        include:
          - { name: windows-x64, os: windows-latest, sdk: premation-sdk-windows-x64, cmake: '-A x64' }
          - { name: macos-universal, os: macos-latest, sdk: premation-sdk-macos-arm64, cmake: '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64' }
          - { name: linux-x64, os: ubuntu-latest, sdk: premation-sdk-linux-x64, cmake: '' }
    steps:
      - uses: actions/checkout@v4
${nodeStep}      - name: Fetch the SDK
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          gh release download "\${{ vars.PREMATION_SDK_VERSION }}" --repo isroil01/premation --pattern "\${{ matrix.sdk }}.zip"
          unzip -q "\${{ matrix.sdk }}.zip" -d sdk
      - name: Build
        shell: bash
        run: |
          cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$PWD/sdk" \${{ matrix.cmake }}
          cmake --build build --config Release
      - name: Check it loads
        shell: bash
        run: ./sdk/bin/premation-plugins --plugins build/plugins list
        if: matrix.name != 'macos-universal' || runner.arch == 'ARM64'
${testStep}      - uses: actions/upload-artifact@v4
        with:
          name: bundle-\${{ matrix.name }}
          path: build/plugins/${o.slug}/
          if-no-files-found: error

  package:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/download-artifact@v4
        with: { path: parts }
      - name: Merge the platform builds into one bundle
        run: |
          mkdir -p bundle
          for d in parts/bundle-*; do cp -rn "$d"/* bundle/; done
          ls -l bundle
      - name: Fetch the SDK tools
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          gh release download "\${{ vars.PREMATION_SDK_VERSION }}" --repo isroil01/premation --pattern "premation-sdk-linux-x64.zip"
          unzip -q premation-sdk-linux-x64.zip -d sdk
          (cd sdk/share/premation-sdk && npm init -y >/dev/null && npm install fflate@0.8 >/dev/null)
      - name: Pack (and sign on a tag)
        env:
          KEY: \${{ secrets.PREMATION_PLUGIN_KEY }}
        run: |
          if [ -n "$KEY" ]; then printf '%s' "$KEY" > key.json; fi
          node sdk/share/premation-sdk/pack-plugin.mjs bundle --out plugin.pplugin $( [ -f key.json ] && echo --key key.json )
      - uses: actions/upload-artifact@v4
        with:
          name: pplugin
          path: plugin.pplugin*
      - name: Publish to the Premation plugin store
        if: startsWith(github.ref, 'refs/tags/v')
        env:
          TOKEN: \${{ secrets.PREMATION_TOKEN }}
        run: |
          node sdk/share/premation-sdk/sign-plugin.mjs publish plugin.pplugin --key key.json --token "$TOKEN" \\
            --api "\${{ vars.PREMATION_API }}" --visibility "\${{ vars.PREMATION_VISIBILITY || 'private' }}"
`;
}

// ── effect ────────────────────────────────────────────────────────────────

function effectFiles(o) {
  const manifest = {
    manifestVersion: 1, id: o.id, name: o.name, version: '1.0.0', vendor: o.vendor,
    sdk: { major: 1, minor: 2 }, binary: binaries(o.slug),
    effects: [{ matchName: o.id, name: o.name, category: o.vendor || o.name }],
  };
  const cmake = `# ${o.name} — a Premation native plugin (effect template).
#
#   cmake -B build -DCMAKE_PREFIX_PATH=/path/to/premation-sdk
#   cmake --build build --config Release
#   → build/plugins/${o.slug}/{premation-plugin.json, <binary>}
cmake_minimum_required(VERSION 3.25)
project(${o.slug}_plugin LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)

find_package(PremationSdk 1.2 REQUIRED)
premation_add_plugin(${o.slug} SOURCES src/${o.slug}.cpp MANIFEST premation-plugin.json)
# sample_util.hpp: pixel read/write per depth, param helpers, for_rows.
target_include_directories(${o.slug} PRIVATE \${PREMATION_SDK_TOOLS_DIR}/samples/common)
`;
  const cpp = `// ${o.name} — a Premation effect. Starts as a colour tint mixed by Amount: replace the maths in
// render_row() with your own. CPU, smart render, 8/16/32-bit worlds, rows in parallel.
//
// docs/PLUGIN_SDK.md has every selector, param type and host callback; sample_util.hpp (SDK
// share/premation-sdk/samples/common) the pixel and param helpers used here.
#include <premation_sdk/premation_sdk.h>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kAmount = 1, kTint = 2 };

PrErr params_setup(const PrInData* in) {
  if (PrErr e = prs::add_float(in, kAmount, "Amount", 100, 0, 100, 0, 100, 1); e != PR_ERR_NONE) return e;
  return prs::add_simple(in, PR_PARAM_COLOR, kTint, "Tint", {1.0, 0.55, 0.2, 1.0});
}

PrErr smart_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const float k = prs::clamp01(static_cast<float>(prs::num(params, in, kAmount) / 100));
  // Colour params reach the plugin in linear light (SDK 1.2).
  const prs::Px tint{static_cast<float>(prs::num(params, in, kTint, 0)), static_cast<float>(prs::num(params, in, kTint, 1)),
                     static_cast<float>(prs::num(params, in, kTint, 2)), 1.0F};
  auto render_row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const prs::Px p = src == nullptr ? prs::Px{} : prs::read(*src, x, y);
      // Premultiplied: multiplying colour by the tint keeps the coverage.
      const prs::Px tinted{p.r * tint.r, p.g * tint.g, p.b * tint.b, p.a};
      prs::write(*dst, x, y, p * (1 - k) + tinted * k);
    }
  };
  return prs::for_rows(in, dst->height, render_row);
}

PrErr PR_CALL main_entry(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                         void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, ${cstr(`${o.name} 1.0`)}); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SMART_PRE_RENDER: return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
    case PR_CMD_SMART_RENDER: return smart_render(in, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{${cstr(o.id)}, &main_entry}};  // NOLINT(modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, ${cstr(o.id)}, 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
`;
  return {
    'CMakeLists.txt': cmake,
    'premation-plugin.json': json(manifest),
    [`src/${o.slug}.cpp`]: cpp,
    'tests/cases.json': json({
      cases: [
        { name: 'default', effect: o.id },
        { name: 'half-8bpc', effect: o.id, bits: 8, params: { 1: 50 } },
      ],
    }),
  };
}

// ── fx (fxkit) ────────────────────────────────────────────────────────────

function fxFiles(o) {
  const config = {
    manifestVersion: 1, id: o.id, name: o.name, version: '1.0.0', vendor: o.vendor,
    sdk: { major: 1, minor: 2 }, binary: binaries(o.slug),
    fxkit: { category: o.vendor || o.name },
  };
  const cmake = `# ${o.name} — a Premation effect written in WGSL with fxkit (docs/PLUGIN_SDK.md "fxkit").
#
#   cmake -B build -DCMAKE_PREFIX_PATH=/path/to/premation-sdk [-DDAWN_INCLUDE_DIR=<webgpu headers>]
#   cmake --build build --config Release
#   → build/plugins/${o.slug}/{premation-plugin.json, <binary>}
#
# With Node on the PATH the build regenerates gen/ and premation-plugin.json from fx/*.fx first.
# DAWN_INCLUDE_DIR (webgpu/webgpu.h + dawn/dawn_proc_table.h) turns on the GPU path; without it
# the plugin renders on its generated CPU twin.
cmake_minimum_required(VERSION 3.25)
project(${o.slug}_plugin LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(DAWN_INCLUDE_DIR "" CACHE PATH "Dawn's headers, for the GPU path")

find_package(PremationSdk 1.2 REQUIRED)
premation_add_fx_plugin(${o.slug} PROJECT \${CMAKE_CURRENT_SOURCE_DIR} DAWN_INCLUDE_DIR "\${DAWN_INCLUDE_DIR}")
`;
  const fx = `/*@fx
{
  "name": ${cstr(o.name)},
  "summary": "A soft vignette that darkens the layer towards its edges. Replace the kernel with your own.",
  "params": [
    { "id": 1, "key": "amount", "type": "float", "name": "Amount", "default": 60, "min": 0, "max": 100, "precision": 0, "unit": "%" },
    { "id": 2, "key": "radius", "type": "float", "name": "Radius", "default": 70, "min": 1, "max": 200, "smax": 150, "precision": 0, "unit": "%",
      "desc": "Where the darkening starts, as a percentage of the half-diagonal." },
    { "id": 3, "key": "softness", "type": "float", "name": "Softness", "default": 50, "min": 0, "max": 100, "precision": 0, "unit": "%" },
    { "id": 4, "key": "color", "type": "color", "name": "Color", "default": "#000000" }
  ],
  "presets": [
    { "name": "Subtle", "values": { "amount": 35, "softness": 80 } }
  ]
}
*/
// p is in world px (pixel centres); src(p) reads the layer there, premultiplied linear.
// to_layer / layer_size / time_s and the std library (noise, colour, hashes) are in
// docs/PLUGIN_SDK.md "fxkit".
fn effect(p: vec2f) -> vec4f {
  let c = src(p);
  let half = layer_size() * 0.5;
  let d = length(to_layer(p) - half) / max(length(half), 1.0);
  let r = prm.radius * 0.01;
  let soft = max(prm.softness * 0.01, 0.001);
  let k = smoothstep(r - soft * 0.5, r + soft * 0.5, d) * prm.amount * 0.01;
  let tint = prm.color.rgb * c.a;
  return vec4f(mix(c.rgb, tint, k), c.a);
}
`;
  return {
    'CMakeLists.txt': cmake,
    'fxkit.json': json(config),
    [`fx/${o.slug}.fx`]: fx,
    'tests/cases.json': json({
      cases: [
        { name: 'default', effect: `${o.id}.${o.slug}` },
        { name: 'hard-edge-16bpc', effect: `${o.id}.${o.slug}`, bits: 16, params: { 1: 100, 3: 0 } },
      ],
    }),
  };
}

// ── command ───────────────────────────────────────────────────────────────

function commandFiles(o) {
  const manifest = {
    manifestVersion: 1, id: o.id, name: o.name, version: '1.0.0', vendor: o.vendor,
    sdk: { major: 1, minor: 2 }, binary: binaries(o.slug),
    commands: [{ id: o.slug, name: o.name, menu: o.vendor || 'Plugins' }],
  };
  const cmake = `# ${o.name} — a Premation command plugin (Plugins menu; edits through the engine API).
#
#   cmake -B build -DCMAKE_PREFIX_PATH=/path/to/premation-sdk
#   cmake --build build --config Release
#   → build/plugins/${o.slug}/{premation-plugin.json, <binary>}
cmake_minimum_required(VERSION 3.25)
project(${o.slug}_plugin LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)

find_package(PremationSdk 1.2 REQUIRED)
premation_add_plugin(${o.slug} SOURCES src/${o.slug}.cpp MANIFEST premation-plugin.json)
# sample_json.hpp: a small JSON reader/writer for the engine API's requests and answers.
target_include_directories(${o.slug} PRIVATE \${PREMATION_SDK_TOOLS_DIR}/samples/common)
`;
  const cpp = `// ${o.name} — a Premation command (pr_command.h). Starts as "nudge the selected layers 10 px right":
// it reads each selected layer's position with engine_query and writes the new one with
// engine_command. Everything one run does is ONE undo step, named after the command.
//
// args (runPluginCommand's JSON, optional): { "dx": 10, "dy": 0 }
// The engine API's requests and answers: docs/PLUGIN_SDK.md "Commands" and "Engine API".
#include <premation_sdk/premation_sdk.h>

#include <cstdio>
#include <string>

#include "sample_json.hpp"

namespace {

namespace json = prs::json;

void say(PrCommandOut* out, const std::string& msg) { std::snprintf(out->return_msg, sizeof(out->return_msg), "%s", msg.c_str()); }

/// engine_query / engine_command, parsed. False with the engine's message in \`out\`.
bool call(const PrCommandContext* ctx, bool command, const std::string& request, json::Value& result, PrCommandOut* out) {
  const char* reply = nullptr;
  uint32_t len = 0;
  const PrErr e = command ? ctx->engine->engine_command(ctx->host_ref, request.c_str(), &reply, &len)
                          : ctx->engine->engine_query(ctx->host_ref, request.c_str(), &reply, &len);
  json::Value v;
  const bool parsed = reply != nullptr && json::parse(std::string_view(reply, len), v);
  if (e != PR_ERR_NONE) {
    say(out, parsed ? v["message"].str() : std::string("the engine refused the request"));
    return false;
  }
  if (!parsed) {
    say(out, "the engine's answer is not JSON");
    return false;
  }
  result = std::move(v);
  return true;
}

PrErr run(const PrCommandContext* ctx, PrCommandOut* out) {
  json::Value args;
  (void)json::parse(ctx->args_json != nullptr ? ctx->args_json : "{}", args);
  const double dx = args["dx"].num(10.0);
  const double dy = args["dy"].num(0.0);
  if (ctx->selected_layer_count == 0) {
    say(out, "select one or more layers first");
    return PR_ERR_INVALID_PARAM;
  }
  const std::string time = json::number(static_cast<double>(ctx->time));
  std::string props;
  for (uint32_t i = 0; i < ctx->selected_layer_count; ++i) {
    props += (i > 0 ? "," : "") + std::string("{\\"layer\\":") + json::quote(ctx->selected_layers[i]) + ",\\"path\\":\\"transform/position\\"}";
  }
  json::Value values;
  if (!call(ctx, false, "{\\"type\\":\\"getPropertyValues\\",\\"props\\":[" + props + "],\\"time\\":" + time + ",\\"evaluated\\":false}", values, out)) {
    return PR_ERR_INVALID_PARAM;
  }
  int moved = 0;
  for (const json::Value& pv : values["values"].a) {
    const json::Value& v = pv["value"];
    if (v["kind"].str() != "vec2" && v["kind"].str() != "vec3") continue;
    const std::string set = "{\\"type\\":\\"setProperty\\",\\"prop\\":{\\"layer\\":" + json::quote(pv["prop"]["layer"].str()) +
                            ",\\"path\\":\\"transform/position\\"},\\"value\\":{\\"kind\\":\\"vec2\\",\\"value\\":{\\"x\\":" +
                            json::number(v["value"]["x"].num() + dx) + ",\\"y\\":" + json::number(v["value"]["y"].num() + dy) +
                            "}},\\"time\\":" + time + "}";
    json::Value ignored;
    if (!call(ctx, true, set, ignored, out)) return PR_ERR_INVALID_PARAM;
    ++moved;
  }
  say(out, "moved " + std::to_string(moved) + " layer(s)");
  return PR_ERR_NONE;
}

PrErr PR_CALL command_main(PrCommandCmd cmd, const PrCommandContext* ctx, PrCommandOut* out) {
  if (cmd != PR_COMMAND_RUN || ctx == nullptr || out == nullptr) return PR_ERR_UNSUPPORTED;
  if (ctx->struct_size < sizeof(PrCommandContext) || ctx->engine == nullptr) return PR_ERR_BAD_VERSION;
  return run(ctx, out);
}

const PrCommandEntry kCommands[] = {{${cstr(o.slug)}, &command_main}};  // NOLINT(modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, ${cstr(o.id)}, 0, nullptr, 1, kCommands, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
`;
  return { 'CMakeLists.txt': cmake, 'premation-plugin.json': json(manifest), [`src/${o.slug}.cpp`]: cpp };
}

// ── main ──────────────────────────────────────────────────────────────────

/** The project's files, path → text. Exported for the tests. */
export function projectFiles(opts) {
  const o = { ...opts, slug: slugOf(opts.name), vendor: opts.vendor || '' };
  const byTemplate = { effect: effectFiles, fx: fxFiles, command: commandFiles }[o.template](o);
  return {
    ...byTemplate,
    'README.md': readme(o),
    '.gitignore': gitignore(o.template),
    '.github/workflows/build.yml': workflow(o),
  };
}

export function validate(o) {
  if (!o.id || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(o.id)) return '--id must be a reverse-domain id, e.g. com.you.glow';
  if (!o.name || !o.name.trim()) return '--name is required';
  if (!TEMPLATES.includes(o.template)) return `--template is one of ${TEMPLATES.join(', ')}`;
  return null;
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${usage}`);
    process.exit(2);
  }
  const bad = validate(o);
  if (bad) {
    console.error(`${bad}\n${usage}`);
    process.exit(2);
  }
  const root = path.resolve(o.dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    console.error(`${root} is not empty; pick a new folder`);
    process.exit(1);
  }
  const files = projectFiles(o);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  console.log(`created ${o.template} plugin "${o.name}" (${o.id}) in ${root}: ${Object.keys(files).length} files`);
  console.log('next: unzip a Premation SDK to ./sdk, then see README.md');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) main();
