// Unit test configuration — no database connections, no MongoDB binary download
const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.json');

module.exports = {
  preset:          'ts-jest',
  testEnvironment: 'node',
  roots:           ['<rootDir>/tests/unit'],
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    prefix: '<rootDir>/',
  }),
  // No setupFilesAfterEnv — unit tests need no database
  testTimeout: 15000,
  verbose:     true,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig:    './tsconfig.json',
      diagnostics: false,
    }],
  },
  testMatch: ['**/tests/unit/**/*.test.ts'],
};
