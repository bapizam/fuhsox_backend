// jest.config.js
// Uses ts-jest's pathsToModuleNameMapper to automatically derive all
// TypeScript path aliases from tsconfig.json so Jest can resolve them.
// This means if tsconfig paths change, the Jest config updates automatically.

const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.json');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  // Use ts-jest to transpile TypeScript — inherits tsconfig.json settings
  preset: 'ts-jest',

  testEnvironment: 'node',

  // Roots: where Jest looks for test files
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  // Map all TypeScript path aliases to their actual filesystem locations.
  // pathsToModuleNameMapper converts tsconfig paths to Jest regex patterns.
  // The { prefix } option prepends <rootDir>/ to each mapped path.
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    prefix: '<rootDir>/',
  }),

  // Run setup.ts after the test framework is installed so beforeAll/afterAll
  // hooks defined in setup.ts are available in every test file.
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],

  // Per-test timeout — integration tests hit real databases so need headroom.
  testTimeout: 30000,

  // Only collect coverage from source — skip type-definition files and entry point.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/types/**',
    '!src/index.ts',
  ],

  // Show a brief summary of each test file during a run
  verbose: true,

  // ts-jest configuration
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: './tsconfig.json',
      // Faster: skip type checking during tests (tsc --noEmit catches errors separately)
      diagnostics: false,
    }],
  },

  // Pattern to find test files
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/*.test.ts',
    '**/*.spec.ts',
  ],

  // Don't transform files in node_modules
  transformIgnorePatterns: ['node_modules/'],
};
