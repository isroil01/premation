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
    '^@motion/engine-api$': '<rootDir>/../engine-api/src/index.ts',
  },
  testMatch: ['**/*.test.ts'],
};
