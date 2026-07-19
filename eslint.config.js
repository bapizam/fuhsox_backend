/**
 * ESLint 9 flat-config bridge. The ruleset still lives in .eslintrc.json —
 * ESLint 9 dropped eslintrc support at the CLI, which left `npm run lint`
 * broken. FlatCompat translates the legacy config unchanged; `files` is added
 * because flat config only lints .js by default.
 */
const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');
const eslintrc = require('./.eslintrc.json');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.js', 'prisma/migrations/**'] },
  ...compat.config(eslintrc).map((cfg) => ({ ...cfg, files: ['**/*.ts'] })),
];
