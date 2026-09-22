import { extractTCalls } from './extractT';

describe('extractTCalls', () => {
  it('finds literal calls in any quote style, across lines', () => {
    const src = [
      `const a = t('export.start', 'Start export');`,
      `const b = t("assets.count", "{n} assets", { n });`,
      'const c = t(`x.tpl`, `Plain template`);',
      `const d = t(`,
      `  'rename.prompt',`,
      `  'Rename "{name}"?',`,
      `);`,
    ].join('\n');
    expect(extractTCalls(src)).toEqual([
      { key: 'export.start', english: 'Start export' },
      { key: 'assets.count', english: '{n} assets' },
      { key: 'x.tpl', english: 'Plain template' },
      { key: 'rename.prompt', english: 'Rename "{name}"?' },
    ]);
  });

  it('unescapes quotes inside the fallback', () => {
    expect(extractTCalls(`t('help.whatsNew', 'What\\'s New')`)).toEqual([{ key: 'help.whatsNew', english: "What's New" }]);
  });

  it('ignores non-literal calls, other functions named *t, and interpolated templates', () => {
    const src = [
      't(key, item.label)',
      "set('a.b', 'c')",
      "obj.t('a.b', 'c')",
      "t('a.b')",
      't(`a.${x}`, `B`)',
    ].join('\n');
    expect(extractTCalls(src)).toEqual([]);
  });
});
