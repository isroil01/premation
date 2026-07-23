/** Jest config for the framework-independent Workspace Engine. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    // Runtime resolution for the sibling scene package (gizmo3d uses its
    // Project3D/Matrix4Math at runtime, not just its types).
    '^@motion/scene$': '<rootDir>/../scene/src/index.ts',
  },
  testMatch: ['**/*.test.ts'],
};
