/**
 * Which project a render belongs to: what scopes the editor's Render Queue and
 * Export tabs to the open project.
 */

import { belongsToProject, cloudProjectIdOf, currentProjectKey } from './renderProject';

describe('belongsToProject', () => {
  it('a cloud project owns the jobs keyed by its id, and no one else\'s', () => {
    const project = { id: 'session-a', path: 'cloud-1' };
    expect(belongsToProject('cloud-1', project)).toBe(true);
    expect(belongsToProject('cloud-2', project)).toBe(false);
  });

  it('a job queued before the first Save stays with the project after it', () => {
    expect(belongsToProject('session:s1', { id: 's1', path: 'C:\\work\\promo.motion' })).toBe(true);
    expect(belongsToProject('session:s1', { id: 's1', path: null })).toBe(true);
    expect(belongsToProject('session:s2', { id: 's1', path: null })).toBe(false);
  });

  it('an unattributed job is shown only when no project is open', () => {
    expect(belongsToProject(undefined, { id: 's1', path: 'cloud-1' })).toBe(false);
    expect(belongsToProject(undefined, { id: 's1', path: null })).toBe(false);
    expect(belongsToProject(undefined, null)).toBe(true);
    expect(belongsToProject('cloud-1', null)).toBe(false);
  });
});

describe('cloudProjectIdOf', () => {
  it('names a cloud id, and nothing the editor could not open by id', () => {
    expect(cloudProjectIdOf('cloud-1')).toBe('cloud-1');
    expect(cloudProjectIdOf('C:\\work\\promo.motion')).toBeNull();
    expect(cloudProjectIdOf('/work/promo.motion')).toBeNull();
    expect(cloudProjectIdOf('session:s1')).toBeNull();
    expect(cloudProjectIdOf(undefined)).toBeNull();
  });
});

describe('currentProjectKey', () => {
  it('is undefined before the core has booted (the dashboard)', () => {
    expect(currentProjectKey()).toBeUndefined();
  });
});
