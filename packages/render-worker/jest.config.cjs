/** Jest config for the render worker's Electron-free helpers (engineRender.cjs). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/electron'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
  },
  testMatch: ['**/*.test.ts'],
};
