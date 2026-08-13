/**
 * The starter template has to actually install.
 *
 * It is the de facto specification: far more plugin authors will copy this
 * package than will read `docs/PLUGINS.md`, so whatever shape it has is the
 * shape the ecosystem gets. And it fails silently — a starter that the editor
 * itself would refuse is not caught by any other test, by the type-checker, or
 * by anyone using the app. It is caught by the first author who downloads it
 * and cannot install it, which is the worst possible discoverer.
 *
 * So it goes through the real reader and the real validator, exactly as a
 * user-picked `.zip` does.
 */

import { readPluginZip } from '@core/plugins/pluginPackage';
import { HOST_API_VERSION } from '@core/plugins/manifest';
import { buildStarterPackage } from './starterPlugin';

describe('the starter template', () => {
  const { pkg, errors } = readPluginZip(buildStarterPackage());

  it('is a package this editor would install', () => {
    expect(errors).toEqual([]);
    expect(pkg).not.toBeNull();
  });

  it('is written against the current host API', () => {
    // A starter pinned to an older API teaches the older API, and every plugin
    // built from it arrives needing a migration nobody asked for.
    expect(pkg?.manifest.apiVersion).toBe(HOST_API_VERSION);
  });

  it('declares its contributions rather than only registering them', () => {
    expect(pkg?.manifest.contributes.commands.map((c) => c.id)).toEqual(['bounce', 'greyscale']);
    expect(pkg?.manifest.contributes.panels.map((p) => p.id)).toEqual(['main']);
  });

  it('demonstrates lazy activation rather than onStartup', () => {
    // The starter is where the default habit is set. If it says `onStartup`,
    // every plugin copied from it spawns a worker at launch, and the thing this
    // phase exists to fix comes straight back.
    expect(pkg?.manifest.activationEvents).not.toContain('onStartup');
    expect(pkg?.manifest.activationEvents).toEqual(
      expect.arrayContaining(['onCommand:bounce', 'onCommand:greyscale', 'onPanel:main']),
    );
  });

  it('every activation event and panel entry resolves', () => {
    // Covered generally by the validator, asserted here because a dangling
    // reference in the STARTER would be copied into every plugin built from it.
    const commandIds = pkg!.manifest.contributes.commands.map((c) => c.id);
    const panelIds = pkg!.manifest.contributes.panels.map((p) => p.id);
    for (const ev of pkg!.manifest.activationEvents) {
      const [kind, id] = ev.split(':');
      if (kind === 'onCommand') expect(commandIds).toContain(id);
      if (kind === 'onPanel') expect(panelIds).toContain(id);
    }
    for (const panel of pkg!.manifest.contributes.panels) {
      expect(pkg!.files[panel.entry]).toBeDefined();
    }
  });

  it('asks for exactly the permissions its code uses', () => {
    // Over-asking is the habit that makes consent screens meaningless, and the
    // starter is where authors learn how much to ask for.
    const main = pkg!.files['main.js']!;
    const asked = new Set(pkg!.manifest.permissions);

    expect(asked.has('assets:read')).toBe(main.includes('assets.getImage'));
    expect(asked.has('assets:write')).toBe(main.includes('assets.createImage'));
    expect(asked.has('scene:write')).toBe(main.includes('scene.createLayer'));
    expect(asked.has('animation:write')).toBe(main.includes('animation.setKeyframes'));
    expect(asked.has('timeline')).toBe(main.includes('timeline.getTime'));
  });

  it('ships a panel that uses the theme instead of hardcoding one', () => {
    const panel = pkg!.files['panel.html']!;
    expect(panel).toContain('pm-button');
    // A hex colour here is a panel that stays dark when the editor goes light,
    // copied into every plugin built from this template.
    expect(panel).not.toMatch(/#[0-9a-f]{6}\b/i);
  });
});
