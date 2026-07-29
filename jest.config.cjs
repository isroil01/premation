module.exports = {
  projects: ['<rootDir>', '<rootDir>/packages/*'],
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  // Git worktrees created INSIDE the repo (agent tooling puts them under
  // .claude/worktrees) contain a second copy of every workspace package, so
  // jest-haste-map finds two providers for `@motion/scene` and refuses to
  // resolve it — every suite that touches the scene graph then fails to run.
  // It also silently doubled the suite count, which reads as new coverage
  // rather than as the same tests running twice.
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/worktrees/'],
  haste: { retainAllFiles: false },
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(test).[jt]s?(x)'
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleNameMapper: {
    // ESM-only render deps → component stub. They ship ESM, this suite is
    // CommonJS, and one of them anywhere in a component tree fails the whole
    // file at parse time — which is what made the editor untestable.
    '^react-markdown$': '<rootDir>/jest.esmComponentMock.cjs',
    // CSS Modules → stub (must precede path aliases).
    '\\.(css|less|scss|sass)$': '<rootDir>/jest.styleMock.cjs',
    // Static assets (brand logos, etc.) → URL-string stub. Must also precede the
    // path aliases, or `@assets/brand/*.png` would resolve to the real binary and
    // Jest would try to parse it as JavaScript.
    '\\.(png|jpe?g|gif|webp|avif|ico|bmp|svg)$': '<rootDir>/jest.fileMock.cjs',
    // `import.meta.url` is ESM-only and these files are parsed as CommonJS, so
    // the module that builds the plugin-sandbox Worker URL is swapped for a
    // stub. Tests inject a fake worker via PluginHost.setWorkerFactory().
    '^\\./spawnPluginWorker$': '<rootDir>/src/core/plugins/spawnPluginWorker.stub.ts',
    // Path aliases — keep in sync with tsconfig.json "paths".
    '^@motion/scene$': '<rootDir>/packages/scene/src/index.ts',
    '^@motion/animation$': '<rootDir>/packages/animation/src/index.ts',
    '^@motion/renderer$': '<rootDir>/packages/renderer/src/index.ts',
    '^@motion/workspace$': '<rootDir>/packages/workspace/src/index.ts',
    '^@motion/timeline$': '<rootDir>/packages/timeline/src/index.ts',
    '^@motion/ai-tools$': '<rootDir>/packages/ai-tools/src/index.ts',
    '^@motion/design-system$': '<rootDir>/packages/design-system/src/index.ts',
    '^@motion/technique-library$': '<rootDir>/packages/technique-library/src/index.ts',
    '^@motion/product-motion$': '<rootDir>/packages/product-motion/src/index.ts',
    '^@motion/caster$': '<rootDir>/packages/caster/src/index.ts',
    '^@motion/audio$': '<rootDir>/packages/audio/src/index.ts',
    '^@core(.*)$': '<rootDir>/src/core$1',
    '^@components(.*)$': '<rootDir>/src/components$1',
    '^@layout(.*)$': '<rootDir>/src/layout$1',
    '^@stores(.*)$': '<rootDir>/src/stores$1',
    '^@hooks(.*)$': '<rootDir>/src/hooks$1',
    '^@styles(.*)$': '<rootDir>/src/styles$1',
    '^@tokens(.*)$': '<rootDir>/src/tokens$1',
    '^@themes(.*)$': '<rootDir>/src/themes$1',
    '^@providers(.*)$': '<rootDir>/src/providers$1',
    '^@app-types(.*)$': '<rootDir>/src/types$1',
    '^@utils(.*)$': '<rootDir>/src/utils$1',
    '^@assets(.*)$': '<rootDir>/src/assets$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
