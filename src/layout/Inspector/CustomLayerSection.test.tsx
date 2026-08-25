/**
 * The inspector a plugin never wrote.
 *
 * A plugin declares types, ranges, labels and enum values; the host picks the
 * widget. That boundary is worth testing rather than trusting, because the two
 * ways it fails are both quiet:
 *
 *   • An INERT layer rendering an empty panel — the user concludes the layer
 *     lost its settings, when in fact every value is still there.
 *   • An inert layer rendering LIVE-looking controls — worse, because the user
 *     makes changes and loses them with nothing saying why.
 *
 * And one leak worth catching early: declared props are stored and animated
 * under a `plugin.` path, which is an internal track key. If it ever reaches a
 * label, every author's property is suddenly named after our plumbing.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { CustomLayerSection } from './CustomLayerSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { buildCustomLayerNode, customLayerComponent } from '@core/plugins/customLayers';
import {
  registerLayerKinds,
  resetLayerKindsForTests,
  unregisterLayerKinds,
} from '@core/plugins/layerKindRegistry';
import { usePluginStore } from '@stores/pluginStore';
import { useAssetStore } from '@stores/assetStore';
import type { LayerKindContribution } from '@core/plugins/layerKindSchema';

const PLUGIN = 'studio.acme.lab';

const KIND: LayerKindContribution = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    samples: { type: 'number', default: 8, min: 1, max: 64, step: 1 },
    // No `label`: the host humanises the prop name rather than showing `edgeFeather`.
    edgeFeather: { type: 'number', default: 2 },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
    invert: { type: 'boolean', default: false },
    tint: { type: 'color', default: '#ff8800' },
    source: { type: 'asset', default: null, assetKind: 'image' },
  },
};

/** Put the plugin in the store, so the section resolves it as installed. */
function install(enabled = true): void {
  usePluginStore.getState().put({
    manifest: {
      id: PLUGIN, name: 'Acme Lab', version: '1.0.0', description: 'x',
      apiVersion: 3, main: 'main.js', permissions: [],
      contributes: { commands: [], panels: [], layerKinds: [KIND], effects: [] },
      activationEvents: ['onStartup'],
    },
    granted: [], enabled, files: {}, binaries: {}, installedAt: 0, source: 'file',
  } as never);
  registerLayerKinds(PLUGIN, 'Acme Lab', [KIND]);
}

beforeEach(async () => {
  await usePluginStore.getState().hydrate();
  for (const p of [...usePluginStore.getState().plugins]) usePluginStore.getState().remove(p.manifest.id);
  resetLayerKindsForTests();
  // `seedDefaultScene` seeds; it does not clear.
  defaultSceneGraph.clear();
  seedDefaultScene();
  defaultSceneGraph.addNode(buildCustomLayerNode('n1', PLUGIN, KIND, {
    props: { focal: 72, mode: 'displace', invert: true, tint: '#00aaff' },
  }));
});

describe('rendered from the schema', () => {
  beforeEach(() => install());

  it('shows every declared property under its declared label', () => {
    const { container } = render(<CustomLayerSection nodeId="n1" />);
    for (const label of ['Focal', 'Samples', 'Mode', 'Invert', 'Tint']) {
      // `getAll`: a keyframable row is a scrubber AND an input, both labelled.
      expect(screen.getAllByLabelText(new RegExp(`^${label}$`, 'i')).length).toBeGreaterThan(0);
    }
    // The asset slot is a real control now, so it is labelled like the rest.
    expect(container.textContent).toContain('Source');
    expect(screen.getByLabelText('Source')).toBeTruthy();
  });

  describe('the asset picker', () => {
    /*
      This row was read-only until the picker landed, which made the type close
      to useless: a plugin could SET an asset, but the user it was declared for
      could not choose one.
    */
    beforeEach(() => {
      useAssetStore.setState({
        assets: [
          { id: 'a_img', name: 'Backdrop.png', type: 'image', src: 'blob:1', size: 1 },
          { id: 'a_img2', name: 'Logo.png', type: 'image', src: 'blob:2', size: 1 },
          { id: 'a_vid', name: 'Clip.mp4', type: 'video', src: 'blob:3', size: 1 },
          { id: 'a_aud', name: 'Track.mp3', type: 'audio', src: 'blob:4', size: 1 },
        ],
      } as never);
    });

    it('offers the images in the project', () => {
      render(<CustomLayerSection nodeId="n1" />);
      const select = screen.getByLabelText('Source') as HTMLSelectElement;
      const options = [...select.options].map((o) => o.textContent);
      expect(options).toContain('Backdrop.png');
      expect(options).toContain('Logo.png');
    });

    it('★ offers ONLY images, because that is the only kind the schema allows', () => {
      // `assetKind` can only be 'image'. Listing a video here would be a slot
      // the user can fill with something the plugin can never be handed.
      render(<CustomLayerSection nodeId="n1" />);
      const select = screen.getByLabelText('Source') as HTMLSelectElement;
      const options = [...select.options].map((o) => o.textContent);
      expect(options).not.toContain('Clip.mp4');
      expect(options).not.toContain('Track.mp3');
    });

    it('starts on None, since an asset prop has no default by rule', () => {
      render(<CustomLayerSection nodeId="n1" />);
      expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('');
    });

    it('writes the chosen asset id to the layer', () => {
      render(<CustomLayerSection nodeId="n1" />);
      const select = screen.getByLabelText('Source') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'a_img2' } });

      const comp = customLayerComponent(defaultSceneGraph.getNode('n1')!);
      expect((comp!.props as Record<string, unknown>).source).toBe('a_img2');
    });

    it('★ keeps an asset that has gone missing, marked, rather than silently clearing it', () => {
      // A reference that quietly becomes empty is a property the user has to
      // notice was lost. One that says "missing" is a property they can fix.
      render(<CustomLayerSection nodeId="n1" />);
      fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'a_img2' } });

      useAssetStore.setState({ assets: [] } as never);
      render(<CustomLayerSection nodeId="n1" />);

      const selects = screen.getAllByLabelText('Source') as HTMLSelectElement[];
      const live = selects[selects.length - 1]!;
      expect(live.value).toBe('a_img2');
      expect([...live.options].map((o) => o.textContent).join()).toContain('missing');
    });
  });

  it('humanises a prop name when the schema declares no label', () => {
    render(<CustomLayerSection nodeId="n1" />);
    // `edgeFeather` → "Edge feather", not `edgeFeather` and not `plugin.edgeFeather`.
    expect(screen.getByLabelText('Edge feather')).toBeTruthy();
  });

  it('never leaks the plugin. track prefix into the UI', () => {
    // It is an internal key. If it reaches a label, every author's property is
    // named after our plumbing.
    const { container } = render(<CustomLayerSection nodeId="n1" />);
    expect(container.textContent).not.toMatch(/plugin\./);
    for (const el of container.querySelectorAll('[aria-label]')) {
      expect(el.getAttribute('aria-label')).not.toMatch(/plugin\./);
    }
  });

  it('drives the widget from the declared type and constraints', () => {
    render(<CustomLayerSection nodeId="n1" />);

    // A non-animatable number carries its own min/max/step.
    const samples = screen.getByLabelText('Samples') as HTMLInputElement;
    expect(samples.type).toBe('number');
    expect(samples.min).toBe('1');
    expect(samples.max).toBe('64');
    expect(samples.step).toBe('1');

    // An enum renders exactly its declared values, and nothing else.
    const mode = screen.getByLabelText('Mode') as HTMLSelectElement;
    expect([...mode.options].map((o) => o.value)).toEqual(['parallax', 'displace']);
    expect(mode.value).toBe('displace');

    // A boolean is a checkbox, showing the authored value.
    expect((screen.getByLabelText('Invert') as HTMLInputElement).checked).toBe(true);
  });

  it('renders an animatable number through the shared keyframe row', () => {
    // Same component a native property uses. Nothing here reimplements
    // keyframing, easing or auto-keyframe — if it did, they would drift.
    const { container } = render(<CustomLayerSection nodeId="n1" />);
    // The scrubber the native rows use, carrying this property's own range …
    const scrubber = container.querySelector('[data-numeric="true"][aria-label="Focal"]')!;
    expect(scrubber.getAttribute('aria-valuemin')).toBe('0');
    expect(scrubber.getAttribute('aria-valuemax')).toBe('100');
    // … showing the AUTHORED value, not the schema default.
    expect(scrubber.getAttribute('aria-valuenow')).toBe('72');
  });
});

describe('an inert layer', () => {
  it('is read-only with a banner when the plugin is not installed', () => {
    render(<CustomLayerSection nodeId="n1" />);

    expect(screen.getByRole('status').textContent).toMatch(/not installed/i);
    // Read-only means NO editable control, not a missing panel.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('still shows every authored value, so nothing looks lost', () => {
    // The failure this prevents: an empty panel, from which a user reasonably
    // concludes their layer's settings are gone.
    const { container } = render(<CustomLayerSection nodeId="n1" />);
    expect(container.textContent).toContain('72');
    expect(container.textContent).toContain('displace');
    expect(container.textContent).toContain('#00aaff');
  });

  it('says DISABLED rather than missing when the user turned the plugin off', () => {
    // Different sentence, different fix: enable versus install.
    install(false);
    render(<CustomLayerSection nodeId="n1" />);
    expect(screen.getByRole('status').textContent).toMatch(/is disabled/i);
  });

  it('goes read-only the moment the plugin is unregistered under it', () => {
    install();
    const { rerender } = render(<CustomLayerSection nodeId="n1" />);
    expect(screen.getByLabelText('Mode')).toBeTruthy();

    // Uninstalling while the layer is selected must flip the panel, not leave
    // live controls behind that write into nothing.
    unregisterLayerKinds(PLUGIN);
    usePluginStore.getState().remove(PLUGIN);
    rerender(<CustomLayerSection nodeId="n1" />);

    expect(screen.queryByLabelText('Mode')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders nothing at all for a native layer', () => {
    const { container } = render(<CustomLayerSection nodeId="comp_root" />);
    expect(container.firstChild).toBeNull();
  });
});
