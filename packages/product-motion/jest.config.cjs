/** Jest config for the framework-independent AI tool registry. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '^@motion/design-system$': '<rootDir>/../design-system/src/index.ts',
    '^@motion/ai-tools$': '<rootDir>/../ai-tools/src/index.ts',
    '^@motion/technique-library$': '<rootDir>/../technique-library/src/index.ts',
  },
  testMatch: ['**/*.test.ts'],
};
