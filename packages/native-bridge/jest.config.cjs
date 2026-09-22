/** Jest config for the native bridge (TypeScript fallback + packed-layout tests). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '^@motion/animation$': '<rootDir>/../animation/src/index.ts',
  },
  testMatch: ['**/*.test.ts'],
};
