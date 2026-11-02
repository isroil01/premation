/** The MCP tool surface: the registry minus the exclusions, plus the MCP-only tools. */

import { ALL_TOOL_DEFS, MEDIA_TOOL_DEFS, applyLayerStyleDef, createPuppetRigDef, createSkeletonRigDef, poseSkeletonDef, selectSubjectDef, setPuppetPinKeyframesDef } from './tools';
import { MCP_APPROVAL_TOOLS, MCP_EXCLUDED_TOOLS, MCP_ONLY_TOOL_DEFS, MCP_SERVER_INSTRUCTIONS, isMcpTool, mcpToolDefs } from './mcp';
import { ToolRegistry } from './registry';
import type { AiTool, AiToolDef } from './types';

describe('mcpToolDefs', () => {
  const defs = mcpToolDefs(ALL_TOOL_DEFS);
  const names = defs.map((d) => d.name);

  it('offers every registry tool except the excluded ones, and every MCP-only tool', () => {
    for (const d of ALL_TOOL_DEFS) expect(names.includes(d.name)).toBe(!(d.name in MCP_EXCLUDED_TOOLS));
    for (const d of MCP_ONLY_TOOL_DEFS) expect(names).toContain(d.name);
  });

  it('has unique names, none colliding with the registry', () => {
    expect(new Set(names).size).toBe(names.length);
    const registry = new Set(ALL_TOOL_DEFS.map((d) => d.name));
    for (const d of MCP_ONLY_TOOL_DEFS) expect(registry.has(d.name)).toBe(false);
  });

  it('only excludes tools that exist (a renamed tool must not slip back in)', () => {
    const registry = new Set(ALL_TOOL_DEFS.map((d) => d.name));
    for (const name of Object.keys(MCP_EXCLUDED_TOOLS)) expect(registry.has(name)).toBe(true);
  });

  it('describes every tool with an object schema', () => {
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.inputSchema.type).toBe('object');
    }
  });

  it('answers isMcpTool the same way the list does', () => {
    const has = (n: string): boolean => ALL_TOOL_DEFS.some((d) => d.name === n);
    expect(isMcpTool('describe_scene', has)).toBe(true);
    expect(isMcpTool('render_frame', has)).toBe(true);
    expect(isMcpTool('generate_video', has)).toBe(false);
    expect(isMcpTool('export_video', has)).toBe(true);
    expect(isMcpTool('rm_rf', has)).toBe(false);
  });

  it('offers the footage tools (stream E) and gates transcribe behind Allow', () => {
    for (const d of MEDIA_TOOL_DEFS) expect(names).toContain(d.name);
    expect([...MCP_APPROVAL_TOOLS]).toEqual(expect.arrayContaining(['transcribe', 'import_media', 'export_video']));
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/select_subject/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/track_point/);
  });

  it('render_frame takes a composition, a solo, a crop, a zoom or an asset', () => {
    const rf = MCP_ONLY_TOOL_DEFS.find((d) => d.name === 'render_frame')!;
    expect(Object.keys(rf.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['time', 'maxSize', 'compId', 'layerIds', 'region', 'zoom', 'assetId']));
  });
});

/** The schemas reject what the handlers cannot do, and accept the forms the handlers take. */
describe('footage, rig and style schemas', () => {
  const reg = new ToolRegistry();
  const bind = (def: AiToolDef): AiTool => ({ ...def, handler: (input) => ({ ok: true, content: JSON.stringify(input) }) });
  for (const d of [...MEDIA_TOOL_DEFS, createPuppetRigDef, createSkeletonRigDef, setPuppetPinKeyframesDef, poseSkeletonDef, applyLayerStyleDef]) reg.register(bind(d));

  it('create_skeleton_rig takes the skin mesh settings, preserveVolume included', () => {
    expect(reg.coerce('create_skeleton_rig', { layerId: 'l', bones: [{ id: 'b', length: 10 }], mesh: { density: 16, mode: 'silhouette', traceAccuracy: 80, alphaThreshold: 40, preserveVolume: true } }).ok).toBe(true);
    expect(reg.coerce('create_skeleton_rig', { layerId: 'l', bones: [{ id: 'b', length: 10 }], mesh: { alphaThreshold: 300 } }).ok).toBe(false);
  });

  it('select_subject takes labelled points, a box or a candidate, in footage px', () => {
    expect(reg.coerce('select_subject', { layerId: 'v1', points: [{ x: 10, y: 20 }, { x: 30, y: 40, label: 'not' }], name: 'Rider' }).ok).toBe(true);
    expect(reg.coerce('select_subject', { layerId: 'v1', box: { x: 0, y: 0, w: 100, h: 50 } }).ok).toBe(true);
    expect(reg.coerce('select_subject', { layerId: 'v1', candidate: 2 }).ok).toBe(true);
    const bad = reg.coerce('select_subject', { layerId: 'v1', points: [{ x: 1, y: 2, label: 'maybe' }] });
    expect(bad.ok).toBe(false);
    expect(selectSubjectDef.description).toMatch(/footage|top-left|points/i);
  });

  it('refine_subject takes strokes as polylines with a tool, an op and a radius, plus edge settings', () => {
    const r = reg.coerce('refine_subject', { layerId: 'v1', strokes: [{ points: [[1, 2], [3, 4]], op: 'subtract', tool: 'refine', radius: 20 }], edge: { feather: 4, choke: -2, invert: true } });
    expect(r.ok).toBe(true);
    expect(reg.coerce('refine_subject', { layerId: 'v1', strokes: [{ points: [[1]] }] }).ok).toBe(false);
    expect(reg.coerce('refine_subject', { layerId: 'v1', edge: { feather: 999 } }).ok).toBe(false);
  });

  it('attach_to_track names its modes; follow_subject and transcribe can wait or run as jobs', () => {
    expect(reg.coerce('attach_to_track', { trackId: 'track_1', mode: 'createNull' }).ok).toBe(true);
    expect(reg.coerce('attach_to_track', { trackId: 'track_1', mode: 'parent' }).ok).toBe(false);
    expect(reg.coerce('follow_subject', { layerId: 'v1', wait: true }).ok).toBe(true);
    expect(reg.coerce('transcribe', { createCaptions: true, maxWords: 100 }).ok).toBe(true);
    expect(reg.coerce('get_job_status', { jobId: 'x', cancel: true }).ok).toBe(true);
  });

  it('apply_subject_style lists every preset and the background switches', () => {
    const def = MEDIA_TOOL_DEFS.find((d) => d.name === 'apply_subject_style')!;
    const styles = def.inputSchema.properties!.style!.enum as string[];
    expect(styles).toEqual(expect.arrayContaining(['sticker', 'neon', 'spotlight', 'splash', 'duotone', 'comic', 'halo', 'dashes', 'portrait', 'warm', 'bgImage', 'background_blur', 'remove_background', 'keep_background']));
    expect(def.inputSchema.properties!.fit!.enum).toEqual(['fill', 'fit', 'stretch']);
  });

  it('create_puppet_rig takes pin kinds, scale, overlap, mesh settings and append', () => {
    const r = reg.coerce('create_puppet_rig', {
      layerId: 'l', append: true,
      pins: [{ name: 'wrist', x: 10, y: -20, kind: 'bend', scale: 1.2, overlap: 30 }, { name: 'torso', x: 0, y: 0, kind: 'starch' }],
      mesh: { density: 20, mode: 'silhouette', solver: 'arap', expansion: 4, maxRotationDeg: 45, traceAccuracy: 60, alphaThreshold: 32 },
    });
    expect(r.ok).toBe(true);
    expect(reg.coerce('create_puppet_rig', { layerId: 'l', pins: [{ name: 'p', x: 0, y: 0 }], mesh: { traceAccuracy: 101 } }).ok).toBe(false);
    expect(reg.coerce('create_puppet_rig', { layerId: 'l', pins: [{ name: 'p', x: 0, y: 0, kind: 'magnet' }] }).ok).toBe(false);
    expect(createPuppetRigDef.description).not.toMatch(/canvas pin drags/);
  });

  it('set_puppet_pin_keyframes takes many pins with eases and spatial tangents, and the old single-pin form', () => {
    const many = reg.coerce('set_puppet_pin_keyframes', {
      layerId: 'l',
      pins: [
        { pinId: 'pin_1', keyframes: [{ timeSec: 0, x: 0, y: 0, easing: 'easeOut', tangentOut: [20, -10] }, { timeSec: 1, x: 50, y: 0, bezier: [0.2, 0, 0.1, 1], tangentIn: [-20, -10] }] },
        { pinId: 'pin_2', keyframes: [{ timeSec: 0.5, x: 1, y: 1 }] },
      ],
    });
    expect(many.ok).toBe(true);
    expect(reg.coerce('set_puppet_pin_keyframes', { layerId: 'l', pinId: 'pin_1', keyframes: [{ timeSec: 0, x: 0, y: 0 }] }).ok).toBe(true);
    expect(reg.coerce('set_puppet_pin_keyframes', { layerId: 'l', pins: [{ pinId: 'p', keyframes: [{ timeSec: 0, x: 0, y: 0, tangentIn: [1] }] }] }).ok).toBe(false);
  });

  it('pose_skeleton makes rotation optional and takes IK goal, pole and switch keys with eases', () => {
    const r = reg.coerce('pose_skeleton', {
      layerId: 'l',
      bonePoses: [{ boneId: 'arm', timeSec: 0, x: 3, easing: 'easeIn' }],
      ikPoses: [{ boneId: 'hand', timeSec: 0, x: 100, y: 200, poleX: 50, poleY: 10, ik: true, easing: 'hold' }],
    });
    expect(r.ok).toBe(true);
    // The IK/FK switch is a 0..1 blend: `ik` keys 1 / 0, `ikBlend` any value between.
    expect(reg.coerce('pose_skeleton', { layerId: 'l', ikPoses: [{ boneId: 'hand', timeSec: 1, ikBlend: 0.5 }] }).ok).toBe(true);
    expect(reg.coerce('pose_skeleton', { layerId: 'l', ikPoses: [{ boneId: 'hand', timeSec: 1, ikBlend: 2 }] }).ok).toBe(false);
    expect(reg.coerce('pose_skeleton', { layerId: 'l', bonePoses: [{ boneId: 'arm', timeSec: 0, easing: 'bouncy' }] }).ok).toBe(false);
  });

  it('apply_layer_style covers every Photoshop-style layer style and glass', () => {
    const types = applyLayerStyleDef.inputSchema.properties!.styleType!.enum as string[];
    expect(types).toEqual(['drop_shadow', 'inner_shadow', 'outer_glow', 'inner_glow', 'satin', 'bevel', 'color_overlay', 'gradient_overlay', 'stroke', 'glass']);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'glass', glass: { blur: 12, rimColor: '#ffffff', grain: 0.1 } }).ok).toBe(true);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'bevel', depth: 200, direction: 'down', altitude: 45 }).ok).toBe(true);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'stroke', color: '#fff', size: 3, position: 'inside' }).ok).toBe(true);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'glass', glass: { surface: 'dome', thickness: 30, ior: 1.5, dispersion: 0.2, caustic: 1, fresnel: 0.5 } }).ok).toBe(true);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'glass', glass: { surface: 'layer', bumpLayerId: 'layer_3' } }).ok).toBe(true);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'glass', glass: { surface: 'cube' } }).ok).toBe(false);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'glass', glass: { blurriness: 1 } }).ok).toBe(false);
    expect(reg.coerce('apply_layer_style', { nodeId: 'n', styleType: 'bevel', direction: 'sideways' }).ok).toBe(false);
  });
});
