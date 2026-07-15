module.exports = {
  projects: ['<rootDir>', '<rootDir>/packages/*'],
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleNameMapper: {
    // CSS Modules → stub (must precede path aliases).
    '\\.(css|less|scss|sass)$': '<rootDir>/jest.styleMock.cjs',
    // Path aliases — keep in sync with tsconfig.json "paths".
    '^@motion/scene$': '<rootDir>/packages/scene/src/index.ts',
    '^@motion/animation$': '<rootDir>/packages/animation/src/index.ts',
    '^@motion/renderer$': '<rootDir>/packages/renderer/src/index.ts',
    '^@motion/workspace$': '<rootDir>/packages/workspace/src/index.ts',
    '^@motion/timeline$': '<rootDir>/packages/timeline/src/index.ts',
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
