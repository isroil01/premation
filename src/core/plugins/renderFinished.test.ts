/**
 * Post-render actions — telling a plugin a render left the queue.
 *
 * The oldest reason anyone reaches for one: the deliverable is ready, so ping a
 * webhook, write a log line, put a badge in a panel. AE has had them forever
 * and this had none, so a plugin could build the composition and then had no
 * idea whether it ever rendered.
 *
 * ── What is deliberately NOT in the payload ─────────────────────────────────
 *
 * The encoded bytes, and the directory. Handing a plugin the file would make
 * "post-render action" mean "exfiltrate the render", which is a different
 * feature needing a different consent screen; handing it the path would tell it
 * where the user keeps their work, which it has no use for and — holding
 * `net:fetch` — could send. So: basename and metadata, nothing else.
 */

import { pluginHost } from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import type { RenderFinishedInfo } from './protocol';
import type { PluginManifest } from './manifest';

const INFO: RenderFinishedInfo = {
  status: 'done',
  compositionName: 'Main Comp',
  fileName: 'Main Comp.mp4',
  format: 'mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 10,
  elapsedMs: 4200,
};

function manifest(id: string, activationEvents: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'A plugin.',
    apiVersion: 2,
    main: 'main.js',
    permissions: ['scene:read'],
    activationEvents,
    contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
  } as unknown as PluginManifest;
}

/** Install `id` in the store with the given grants, and give it a live worker. */
function install(
  id: string,
  opts: { granted?: string[]; enabled?: boolean; activation?: string[]; running?: boolean } = {},
): { posted: unknown[] } {
  const posted: unknown[] = [];
  const entry = {
    manifest: manifest(id, opts.activation ?? ['onRenderFinished']),
    enabled: opts.enabled ?? true,
    granted: opts.granted ?? ['scene:read'],
  };
  usePluginStore.setState((s) => ({ plugins: [...s.plugins.filter((p) => p.manifest.id !== id), entry] } as never));

  if (opts.running !== false) {
    const runtimes = (pluginHost as unknown as { runtimes: Map<string, unknown> }).runtimes;
    runtimes.set(id, {
      info: { status: 'running' },
      worker: { postMessage: (m: unknown) => posted.push(m) },
    });
  }
  return { posted };
}

function reset(): void {
  usePluginStore.setState({ plugins: [] } as never);
  (pluginHost as unknown as { runtimes: Map<string, unknown> }).runtimes.clear();
}

beforeEach(reset);
afterAll(reset);

describe('who hears about it', () => {
  it('delivers to a running plugin that holds scene:read', () => {
    const { posted } = install('studio.a');
    pluginHost.notifyRenderFinished(INFO);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ k: 'renderFinished', render: INFO });
  });

  it('★ says nothing to a plugin without scene:read', () => {
    // Everything in the payload is either the composition's own name and size —
    // which `scene:read` already covers — or the fact a render happened. A
    // plugin the user never let read their project does not get told either.
    const { posted } = install('studio.b', { granted: [] });
    pluginHost.notifyRenderFinished(INFO);
    expect(posted).toHaveLength(0);
  });

  it('★ honours scene:write implying scene:read is NOT assumed', () => {
    // `expandPermissions` is what decides this, and it currently expands
    // `scene:write` to `scene:proxy` only. Pinned so that if an implication
    // involving `scene:read` is ever added, this path picks it up rather than
    // silently keeping its own copy of the rule.
    const { posted } = install('studio.c', { granted: ['scene:write'] });
    pluginHost.notifyRenderFinished(INFO);
    expect(posted).toHaveLength(0);
  });

  it('says nothing to a disabled plugin', () => {
    const { posted } = install('studio.d', { enabled: false });
    pluginHost.notifyRenderFinished(INFO);
    expect(posted).toHaveLength(0);
  });

  it('delivers to several plugins at once', () => {
    const a = install('studio.e');
    const b = install('studio.f');
    pluginHost.notifyRenderFinished(INFO);
    expect(a.posted).toHaveLength(1);
    expect(b.posted).toHaveLength(1);
  });

  it('delivers to a running plugin even if it never declared the activation event', () => {
    // Declaring it is how a plugin asks to be STARTED by a render. One that is
    // already up and listening should still hear it.
    const { posted } = install('studio.g', { activation: ['onStartup'] });
    pluginHost.notifyRenderFinished(INFO);
    expect(posted).toHaveLength(1);
  });
});

describe('a worker that is not there', () => {
  it('does not throw when the plugin has no runtime', () => {
    install('studio.h', { running: false, activation: ['onStartup'] });
    expect(() => pluginHost.notifyRenderFinished(INFO)).not.toThrow();
  });

  it('★ survives a worker that throws on postMessage', () => {
    // The normal case for a plugin terminated between the status check and the
    // send. A render that already succeeded must not fail because of it.
    const runtimes = (pluginHost as unknown as { runtimes: Map<string, unknown> }).runtimes;
    usePluginStore.setState({
      plugins: [{ manifest: manifest('studio.i', ['onStartup']), enabled: true, granted: ['scene:read'] }],
    } as never);
    runtimes.set('studio.i', {
      info: { status: 'running' },
      worker: { postMessage: () => { throw new Error('terminated'); } },
    });
    expect(() => pluginHost.notifyRenderFinished(INFO)).not.toThrow();
  });

  it('does not deliver to a stopped or errored runtime', () => {
    const posted: unknown[] = [];
    for (const status of ['stopped', 'error']) {
      reset();
      usePluginStore.setState({
        plugins: [{ manifest: manifest('studio.j', ['onStartup']), enabled: true, granted: ['scene:read'] }],
      } as never);
      (pluginHost as unknown as { runtimes: Map<string, unknown> }).runtimes.set('studio.j', {
        info: { status },
        worker: { postMessage: (m: unknown) => posted.push(m) },
      });
      pluginHost.notifyRenderFinished(INFO);
    }
    expect(posted).toHaveLength(0);
  });
});

describe('the payload', () => {
  it('★ carries a basename, never a directory', () => {
    const { posted } = install('studio.k');
    pluginHost.notifyRenderFinished(INFO);
    const { render } = posted[0] as { render: RenderFinishedInfo };
    expect(render.fileName).toBe('Main Comp.mp4');
    expect(render.fileName).not.toMatch(/[/\\]/);
  });

  it('carries no encoded bytes, under any key', () => {
    const { posted } = install('studio.l');
    pluginHost.notifyRenderFinished(INFO);
    const { render } = posted[0] as { render: Record<string, unknown> };
    for (const v of Object.values(render)) {
      expect(v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Blob).toBe(false);
    }
  });

  it('reports a failure with its reason, and no file', () => {
    const { posted } = install('studio.m');
    pluginHost.notifyRenderFinished({ ...INFO, status: 'failed', fileName: null, error: 'Encoder died' });
    const { render } = posted[0] as { render: RenderFinishedInfo };
    expect(render.status).toBe('failed');
    expect(render.fileName).toBeNull();
    expect(render.error).toBe('Encoder died');
  });

  it('★ distinguishes skipped from done — a render with no file is not a delivery', () => {
    // The user dismissed the save dialog. The render really happened, and there
    // really is no file; a plugin that uploads on 'done' must not fire here.
    const { posted } = install('studio.n');
    pluginHost.notifyRenderFinished({ ...INFO, status: 'skipped', fileName: null });
    const { render } = posted[0] as { render: RenderFinishedInfo };
    expect(render.status).toBe('skipped');
    expect(render.fileName).toBeNull();
  });
});
