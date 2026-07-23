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
  // No setupFilesAfterEnv — unit tests need no database.
  //
  // `.env` IS loaded, though: `src/config/env.ts` calls `process.exit(1)` on a
  // missing variable, and it is pulled in transitively by anything that touches
  // `lib/embeddings` (rag.utils.test.ts does). Without this the whole unit run
  // dies at that import rather than reporting failures — env loading happens in
  // `src/index.ts` at runtime, which no unit test goes through.
  setupFiles: ['dotenv/config'],
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
