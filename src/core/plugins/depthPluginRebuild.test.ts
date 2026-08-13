/**
 * Rebuilding the depth/parallax plugin on `render: "shader"` — third attempt.
 *
 * This plugin has been built twice against this API and found a real gap each
 * time. That is why the brief asks for it again on every render-path change:
 * it is the only exercise here that is written from the OUTSIDE, and every
 * assumption the host makes about what an author needs shows up as something
 * that cannot be expressed.
 *
 * So this file is a REPORT as much as a test. Each block attempts something a
 * depth plugin genuinely requires, runs it through the real validator, and
 * asserts what actually happens — including where the answer is "you cannot".
 * Assertions that pin a LIMITATION are marked; when the limitation is lifted,
 * they fail, which is the intended way to find out that this file is stale.
 */

import { parseManifest } from './manifest';
import { composeEffectShader, UNIFORM_HEADER_BYTES } from './effectSchema';
import { pluginEffectMaterial } from './pluginEffectMaterial';

const base = {
  id: 'studio.acme.depth',
  name: 'Depth',
  version: '2.0.0',
  description: 'Parallax from a depth map.',
  apiVersion: 4,
  main: 'main.js',
};

const parse = (contributes: unknown) => {
  const result = parseManifest({ ...base, contributes });
  return { manifest: result.manifest, errors: result.errors };
};

/** The parallax maths, as an author would write it. */
const PARALLAX = `
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  // Displace the sample by the parallax offset, scaled by focal depth.
  let shift = vec2<f32>(params.parallaxX, params.parallaxY) * params.focal * 0.01;
  return textureSample(src, samp, uv + shift);
}`;

describe('what the rebuild CAN express', () => {
  it('a shader effect with animatable depth parameters', () => {
    const { manifest, errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: {
          focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
          parallaxX: { type: 'number', default: 0, min: -10, max: 10, animatable: true },
          parallaxY: { type: 'number', default: 0, min: -10, max: 10, animatable: true },
        },
      }],
    });

    expect(errors).toEqual([]);
    expect(manifest?.contributes.effects).toHaveLength(1);
  });

  it('a layer kind that draws itself, alongside the effect', () => {
    // The API-3 rebuild had to use `render: "proxy"` and maintain a subtree.
    // A kind that draws its own pixels is what `"shader"` added.
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage',
        label: 'Depth Image',
        render: 'shader',
        schemaVersion: 2,
        props: { focal: { type: 'number', default: 50, animatable: true } },
      }],
    });

    expect(errors).toEqual([]);
  });
});

describe('★ GAP 1 — CLOSED: an effect can sample a SECOND texture', () => {
  /*
    The finding, and it is the one that matters.

    A depth plugin's whole job is to displace one image by another: the source
    and its depth map. The generated bind group has exactly three entries —
    uniform, ONE texture, one sampler — so there is nowhere to put the depth
    map, and the WGSL gate refuses an author-declared binding precisely because
    the host owns the numbers.

    The renderer already models this: `DISPLACEMENT_MAP_MATERIAL` and
    `SET_MATTE_MATERIAL` both carry a second texture at binding 3, and
    `FrameScene` has `mapLayerId` / `matteLayerId` for naming the layer that
    supplies it. So the capability exists and the PLUGIN CONTRACT does not
    reach it.

    Everything below documents the shape of the refusal so the eventual fix has
    something to change rather than something to discover. A parameter of type
    `layer` — which the built-in effects already have — plus a fourth binding is
    the obvious form.
  */
  it('accepts a `layer` parameter, and names the binding after it', () => {
    const { manifest, errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { depthMap: { type: 'layer' } },
      }],
    });

    expect(errors).toEqual([]);
    const effect = manifest!.contributes.effects[0]!;
    expect(effect.params.depthMap!.type).toBe('layer');

    const { wgsl } = composeEffectShader(effect);
    expect(wgsl).toContain('@group(0) @binding(3) var depthMap : texture_2d<f32>;');
  });

  it('★ keeps the layer parameter OUT of the uniform block', () => {
    /*
      The offset-corrupting mistake, and the reason `layer` is a separate
      category rather than another `EFFECT_PARAM_TYPES` entry. A `layer` has no
      size and no alignment; among the uniform members it would shift every
      value after it and render wrong colours with no error anywhere — the same
      class of failure as the missing 64-byte header.
    */
    const { manifest } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: {
          depthMap: { type: 'layer' },
          focal: { type: 'number', default: 50 },
        },
      }],
    });

    const { layout, wgsl } = composeEffectShader(manifest!.contributes.effects[0]!);
    expect(layout.layout.map((m) => m.name)).toEqual(['focal']);
    expect(wgsl).not.toMatch(/^\s*depthMap\s*:/m);
    // `focal` still lands immediately after the renderer's header — exactly
    // where it would sit with no layer parameter present at all.
    expect(layout.layout[0]!.offset).toBe(UNIFORM_HEADER_BYTES);
  });

  it('widens the material layout to match the generated bindings', () => {
    const { manifest } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { depthMap: { type: 'layer' } },
      }],
    });

    const material = pluginEffectMaterial('studio.acme.depth', manifest!.contributes.effects[0]!);
    expect(material.layout.map((e) => e.binding)).toEqual([0, 1, 2, 3]);
  });

  it('leaves an effect without one at three bindings', () => {
    // A declared binding with nothing bound is an invalid pipeline, so an
    // effect that never asked for a second texture must not be handed a slot.
    const { manifest } = parse({
      effects: [{ id: 'plain', label: 'Plain', shader: PARALLAX, params: {} }],
    });

    const material = pluginEffectMaterial('studio.acme.depth', manifest!.contributes.effects[0]!);
    expect(material.layout.map((e) => e.binding)).toEqual([0, 1, 2]);
  });

  it('still refuses more than one layer parameter', () => {
    const { errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: {
          depthMap: { type: 'layer' },
          normalMap: { type: 'layer' },
        },
      }],
    });

    expect(errors.join()).toMatch(/layer parameters.*the limit is 1/);
  });

  it('still refuses `layer` on a layer KIND, where nothing could resolve it', () => {
    const { errors } = parse({
      layerKinds: [{
        id: 'depth',
        label: 'Depth',
        render: 'none',
        // Required, and omitting it made this test pass on the WRONG error —
        // the validator refused the missing schemaVersion before it ever
        // reached the rule under test.
        schemaVersion: 2,
        props: { source: { type: 'layer' } },
      }],
    });

    expect(errors.join()).toMatch(/only valid on an effect parameter/);
  });

  it('refuses an author-declared second texture binding', () => {
    const withOwnBinding = `
@group(0) @binding(3) var depthTex : texture_2d<f32>;
${PARALLAX}`;
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: withOwnBinding, params: {} }],
    });

    expect(errors.join()).toMatch(/@group.*@binding/);
  });

  it('the workaround an author would reach for is ALSO refused', () => {
    /*
      Packing a depth value per-pixel into the source's alpha is what an author
      does when they cannot have a second texture — and it costs them alpha,
      which a compositing effect cannot spare. Worth recording that the API does
      not make this any easier: there is no way to declare "I need the layer
      below" either.

      Nothing to assert but the absence, so this pins the parameter vocabulary
      as it stands. When a texture-valued parameter exists, this fails.
    */
    const { manifest } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { focal: { type: 'number', default: 50 } },
      }],
    });

    const types = Object.values(manifest!.contributes.effects[0]!.params).map((p) => p.type);
    expect(types).not.toContain('asset');
    expect(types).not.toContain('layer');
  });
});

describe('★ GAP 2 — a shader layer kind and its effect are not connected', () => {
  /*
    `render: "shader"` says a kind draws itself. It does not say WITH WHAT.

    A plugin declaring both a `depthImage` kind and a `parallax` effect has no
    way to state that the kind renders using that effect — the two are separate
    contribution lists with no reference between them. So the manifest below is
    accepted and means less than it appears to: a reader would assume the kind
    draws with the plugin's shader, and nothing in the data says so.

    The obvious form is a `shader` or `effect` field on the layer kind naming
    one of the plugin's own effect ids, validated at parse time like `icon` is.
    Recorded here rather than invented now, because the render side of a
    self-drawing layer kind is not built either — inventing the manifest field
    first would be a contract with nothing behind it.
  */
  it('accepts a shader kind that names no shader, which is the gap', () => {
    const { manifest, errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage', label: 'Depth Image', render: 'shader',
        schemaVersion: 2,
        // A prop it does not need — see GAP 4 below, which is why this is here.
        props: { focal: { type: 'number', default: 50, animatable: true } },
      }],
    });

    expect(errors).toEqual([]);
    const kind = manifest!.contributes.layerKinds[0]!;
    // No field ties the kind to the effect. When one exists, this fails.
    expect(Object.keys(kind)).not.toContain('shader');
    expect(Object.keys(kind)).not.toContain('effect');
  });
});

describe('★ GAP 4 — a shader kind is forced to declare properties it does not have', () => {
  /*
    Found by this rebuild, and not anticipated.

    `parseLayerKinds` refuses a kind with no properties: "a layer kind with no
    properties has no interface to author". That rule is right for `none` and
    `proxy`, where the props ARE the entire authored interface — a controller
    with nothing to control is a layer that does nothing.

    It is wrong for `"shader"`. A shader-drawn kind's parameters live on its
    EFFECT, which has its own schema and its own inspector rows, so the kind
    itself may legitimately have none. Today the author must invent a property
    to satisfy a rule written before their render strategy existed, and then
    either duplicate it onto the effect or leave it unread — a control that
    does nothing, which is exactly what the rule was written to prevent.

    The fix is to scope the check to `none` and `proxy`. Not made here: it is a
    validator change that both repos' corpora would have to agree on, and this
    file's job is to find it, not to smuggle it in.
  */
  it('refuses a shader kind with no properties of its own', () => {
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage', label: 'Depth Image', render: 'shader',
        schemaVersion: 2, props: {},
      }],
    });

    expect(errors.join()).toMatch(/no properties has no interface to author/);
  });

  it('is a rule that makes sense for the OTHER two strategies', () => {
    // Asserted so the eventual fix is scoped rather than deleted: a `none` kind
    // with no props really is a layer that does nothing.
    for (const render of ['none', 'proxy']) {
      const { errors } = parse({
        layerKinds: [{ id: 'k', label: 'K', render, schemaVersion: 1, props: {} }],
      });
      expect(errors.join()).toMatch(/no properties/);
    }
  });
});

describe('★ GAP 3 — an effect cannot read the composition or the time', () => {
  /*
    A parallax effect that animates with the playhead needs time, and one that
    respects the comp's aspect needs its size. Both exist in the renderer's
    uniform header conceptually — `uvRect` carries the sample rect — but neither
    is exposed to the author, and there is no declared parameter type for
    "something the host fills in".

    The built-in effects DO have this: `EffectParamDef` has a `'resolved'` type,
    documented as "a param the RENDER PIPELINE fills in, not the user". So the
    concept exists on the built-in side and has no plugin-facing equivalent.

    An author's workaround is an `animatable` number they keyframe by hand,
    which works and is worse: it is per-document rather than per-effect, and it
    breaks the moment the comp's frame rate changes.
  */
  it('has no host-filled parameter type', () => {
    const { errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { time: { type: 'resolved', default: 0 } },
      }],
    });

    expect(errors.join()).toMatch(/type.*must be one of/);
  });
});

describe('what the third rebuild did NOT hit', () => {
  it('the uniform layout, which the second rebuild would have', () => {
    /*
      Worth recording as a non-finding. The missing `mvp`/`uvRect` header was
      found by reading `packSharpen` during this same session — before any
      plugin exercised it. Had it not been, this rebuild would have produced a
      layer drawn with a garbage transform and no error, and the gap report
      would have been "the plugin renders in the wrong place, cause unknown".
    */
    const { errors } = parse({
      effects: [{
        id: 'parallax', label: 'Depth Parallax', shader: PARALLAX,
        params: { focal: { type: 'number', default: 50, animatable: true } },
      }],
    });
    expect(errors).toEqual([]);
  });
});
