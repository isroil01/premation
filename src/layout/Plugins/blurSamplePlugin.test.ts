/**
 * The multi-pass sample, put through the real parser and the real validator.
 *
 * This is the "done when" for multi-pass: a separable Gaussian blur that ships
 * as a two-pass plugin. A sample that does not survive the pipeline every other
 * package goes through is worse than no sample — authors copy it, and every one
 * of them then debugs the same rejection.
 *
 * It is also the only place the WGSL restrictions are exercised against source
 * a human wrote to do a real job, rather than against fragments written to trip
 * a specific rule. The literal-loop-bound rule in particular only bites when
 * someone tries to write a blur, which is exactly what this is.
 */

import { parseManifest } from '@core/plugins/manifest';
import { chainCost, MAX_PASS_COST, composeEffectShader } from '@core/plugins/effectSchema';
import { pluginEffectPlan } from '@core/plugins/pluginEffectMaterial';
import { readPluginZip } from '@core/plugins/pluginPackage';
import { buildBlurSamplePlugin, BLUR_SAMPLE_MANIFEST } from './blurSamplePlugin';

describe('the sample manifest', () => {
  const parsed = () => parseManifest(BLUR_SAMPLE_MANIFEST);

  it('★ validates, with no errors at all', () => {
    // Including the WGSL, which goes through `validateWgsl` per pass. Authors
    // copy this file; a sample that needs fixing before it installs teaches
    // everyone who copies it the wrong thing.
    expect(parsed().errors).toEqual([]);
    expect(parsed().manifest).not.toBeNull();
  });

  it('declares two passes, horizontal then vertical', () => {
    const effect = parsed().manifest!.contributes.effects[0]!;
    expect(effect.passes?.map((p) => p.name)).toEqual(['horizontal', 'vertical']);
  });

  it('fits the cost budget with room left', () => {
    // Two full-scale passes: 2, against 3. Stated as a test because the budget
    // is the constraint an author bumps into first, and a sample sitting
    // exactly on the limit would suggest the limit is the target.
    const effect = parsed().manifest!.contributes.effects[0]!;
    expect(chainCost(effect.passes!)).toBeCloseTo(2);
    expect(chainCost(effect.passes!)).toBeLessThan(MAX_PASS_COST);
  });

  it('requires the capabilities it actually needs', () => {
    /*
      An effect-only plugin on the WebGL2 tier is inert, not degraded — the
      effect renders its input unchanged. `requires: ["webgpu"]` turns that into
      a refused install with a reason, rather than a plugin that looks healthy
      and does nothing.
    */
    expect(parsed().manifest!.requires).toEqual(['effects.multipass', 'webgpu']);
  });

  it('still activates at startup, which an effect-only plugin does not need', () => {
    /*
      A gap, asserted as it actually behaves rather than as it should.

      An effect is data: the host reads it from the manifest, compiles it, and
      draws it whether or not this plugin's JavaScript ever runs. So an
      effect-only plugin has no reason to start a worker at all — and there is
      currently no way for it to say so. `activationEvents: []` is normalised to
      `['onStartup']` on purpose (empty and absent both read as "no opinion",
      and the safe reading of no opinion is the API-1 behaviour), so the sample
      boots a worker that immediately does nothing.

      The cost is one idle worker per effect-only plugin, which is small and
      real. Fixing it needs a way to spell "never" that cannot be confused with
      "unspecified" — out of scope here, and written down so it is a known gap
      rather than a surprise.
    */
    expect(parsed().manifest!.activationEvents).toEqual(['onStartup']);
  });
});

describe('the kernel', () => {
  const effect = () => parseManifest(BLUR_SAMPLE_MANIFEST).manifest!.contributes.effects[0]!;

  it('reads texelSize from the host pass block rather than a constant', () => {
    /*
      The mistake this sample exists to prevent. A blur that hardcodes a
      resolution is correct on the author's composition and wrong on every
      other one, and wrong by an amount that looks like a bad kernel rather
      than a bad assumption.
    */
    for (const pass of effect().passes!) {
      expect(pass.wgsl).toContain('params.texelSize');
    }
  });

  it('separates the axes — one pass per direction', () => {
    const [h, v] = effect().passes!;
    expect(h!.wgsl).toContain('params.texelSize.x, 0.0');
    expect(v!.wgsl).toContain('0.0, params.texelSize.y');
  });

  it('bounds its loop with a literal, as the validator requires', () => {
    /*
      A uniform bound cannot be verified, so the loop runs to a fixed 32 and
      masks the taps past the live radius. If this were rewritten to loop to
      `radius`, `parseManifest` above would already have failed — this asserts
      the SHAPE so the reason survives the next edit.

      A bare `32`, not a `const MAX_R`. The validator reads the loop header with
      a regex rather than parsing WGSL, so it accepts a numeric literal and
      nothing else — including a `const` that WGSL itself resolves at compile
      time. Stricter than necessary, deliberately: the alternative is a
      hand-written WGSL front end fed hostile input.
    */
    for (const pass of effect().passes!) {
      expect(pass.wgsl).toMatch(/for \(var i : i32 = 1; i <= 32;/);
      expect(pass.wgsl).not.toContain('const MAX_R');
    }
  });

  it('handles radius 0 as a copy rather than a divide by zero', () => {
    // At the parameter's lowest setting, sigma would be 0 and every weight NaN
    // — which draws a black layer, at the default nobody changes first.
    for (const pass of effect().passes!) {
      expect(pass.wgsl).toContain('if (radius < 0.5)');
    }
  });
});

describe('what the host will generate for it', () => {
  const effect = () => parseManifest(BLUR_SAMPLE_MANIFEST).manifest!.contributes.effects[0]!;

  it('plans two draws, both at full scale, neither needing origin', () => {
    // A separable blur is a pure chain: each pass reads only the one before it.
    // Nothing here needs the pass-0 input, so no pass gets binding 4.
    expect(pluginEffectPlan('com.example.separable-blur', effect())).toEqual([
      { index: 0, shader: 'com.example.separable-blur.gaussian#horizontal', scale: 1, readsOrigin: false, layout: expect.anything() },
      { index: 1, shader: 'com.example.separable-blur.gaussian#vertical', scale: 1, readsOrigin: false, layout: expect.anything() },
    ]);
  });

  it('puts `radius` after the host pass block, at 96', () => {
    const { layout } = composeEffectShader(effect(), 0);
    expect(layout.layout).toEqual([{ name: 'radius', type: 'number', offset: 96 }]);
  });

  it('gives each pass the standard three bindings and no more', () => {
    for (const p of pluginEffectPlan('com.example.separable-blur', effect())) {
      expect(p.layout.map((b) => b.binding)).toEqual([0, 1, 2]);
    }
  });
});

describe('the package', () => {
  it('reads back through the real zip reader', () => {
    // The format check every installed package passes. A sample that only
    // exists as an object literal has never been through it.
    const { pkg } = readPluginZip(buildBlurSamplePlugin());
    expect(pkg).not.toBeNull();
    expect(Object.keys(pkg!.files).sort()).toEqual(['README.md', 'main.js', 'plugin.json']);
  });

  it('ships a manifest that parses from its own bytes', () => {
    /*
      Round-tripped through JSON rather than asserted against the literal. The
      manifest is serialised into the zip, and a value that survives in memory
      but not through `JSON.stringify` — an `undefined`, a function — would
      install as something subtly different from what this file describes.
    */
    const { pkg } = readPluginZip(buildBlurSamplePlugin());
    const { manifest, errors } = parseManifest(JSON.parse(pkg!.files['plugin.json']!));
    expect(errors).toEqual([]);
    expect(manifest!.contributes.effects[0]!.passes).toHaveLength(2);
  });
});
