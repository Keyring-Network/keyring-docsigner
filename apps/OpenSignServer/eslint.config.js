import js from '@eslint/js';
import babelParser from '@babel/eslint-parser';

const nodeGlobals = {
  Buffer: 'readonly',
  FormData: 'readonly',
  Parse: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
};

const jasmineGlobals = {
  afterAll: 'readonly',
  beforeAll: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  fail: 'readonly',
  it: 'readonly',
};

const recommendedWarnings = Object.fromEntries(
  Object.keys(js.configs.recommended.rules).map(ruleName => [ruleName, 'warn'])
);

export default [
  {
    ignores: ['coverage/**', 'node_modules/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
      },
      globals: nodeGlobals,
    },
    rules: {
      ...recommendedWarnings,
      indent: ['warn', 2, { SwitchCase: 1 }],
      'linebreak-style': ['warn', 'unix'],
      'no-await-in-loop': 'warn',
      'no-multiple-empty-lines': 'warn',
      'no-trailing-spaces': 'warn',
      'no-useless-escape': 'off',
      'no-var': 'warn',
      'prefer-const': 'warn',
      'require-atomic-updates': 'off',
      'space-in-parens': ['warn', 'never'],
      'space-infix-ops': 'warn',
    },
  },
  {
    files: ['spec/**/*.js'],
    languageOptions: {
      globals: jasmineGlobals,
    },
    rules: {
      'no-console': 'off',
      'no-var': 'error',
    },
  },
];
