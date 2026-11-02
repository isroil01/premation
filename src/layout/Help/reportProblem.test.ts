/**
 * Help ▸ Report a Problem: what leaves the machine. The dialog promises "no
 * project contents or file paths unless you tick the box"; these pin it.
 */

import { buildReportForm, projectDetails, safeProjectFacts, validateDraft, viewportRect, type ProjectSource, type ReportDraft } from './reportProblem';

const project: ProjectSource = {
  projectPath: 'C:\\Users\\noor\\Client\\launch.prm',
  items: new Map([
    ['c1', { kind: 'comp', name: 'Launch film', path: '', missing: false }],
    ['f1', { kind: 'footage', name: 'interview.mov', path: 'D:\\Shoot\\interview.mov', missing: true }],
  ]),
  comps: new Map([['c1', { layers: ['l1', 'l2', 'l3'] }]]),
  layerErrors: (comp) => (comp === 'c1' ? [{ stage: 'decode', message: 'cannot open D:\\Shoot\\interview.mov' }] : []),
};

const draft: ReportDraft = {
  category: 'rendering',
  impact: 'blocker',
  summary: 'Viewer goes black',
  description: 'After adding a light',
  steps: '',
  email: '',
  includeProject: false,
};

async function payloadOf(form: FormData): Promise<Record<string, unknown>> {
  return JSON.parse(String(form.get('payload')));
}

describe('report payload', () => {
  it('counts the project without naming anything', () => {
    const facts = safeProjectFacts(project)!;
    expect(facts).toEqual({ comps: 1, layers: 3, itemKinds: { comp: 1, footage: 1 }, missingFootage: 1, layerErrorStages: { decode: 1 } });
    expect(JSON.stringify(facts)).not.toMatch(/noor|Client|interview|Shoot|Launch/);
  });

  it('sends no project details without the opt-in', async () => {
    const p = await payloadOf(buildReportForm({ draft, diagnostics: { app: { version: '1.0.4' } }, project, screenshot: null }));
    expect(p.includeProject).toBe(false);
    expect(p.projectInfo).toBeUndefined();
    expect(JSON.stringify(p)).not.toMatch(/noor|interview|Shoot/);
    expect((p.diagnostics as { app: { version: string } }).app.version).toBe('1.0.4');
  });

  it('sends paths and messages only when the box is ticked', async () => {
    const p = await payloadOf(buildReportForm({ draft: { ...draft, includeProject: true }, diagnostics: {}, project, screenshot: null }));
    expect(p.projectInfo).toEqual(projectDetails(project));
    expect(JSON.stringify(p.projectInfo)).toContain('interview.mov');
  });

  it('attaches the screenshot as a file beside the payload', () => {
    const form = buildReportForm({ draft, diagnostics: {}, project: null, screenshot: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) });
    expect(form.get('screenshot')).toBeInstanceOf(Blob);
  });

  it('validates the fields the dialog marks', () => {
    expect(validateDraft(draft)).toEqual({});
    expect(Object.keys(validateDraft({ ...draft, summary: 'x', description: ' ', email: 'not-mail' })).sort()).toEqual(['description', 'email', 'summary']);
  });

  it('finds no viewport rectangle when no viewer is mounted', () => {
    expect(viewportRect(document)).toBeNull();
  });
});
