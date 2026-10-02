import { defineConfig } from 'eslint/config';
import tsParser from '@typescript-eslint/parser';

// ADR-002 rule 1: hail-core never reads the wall clock, sleeps or sets a timeout.
// Time reaches it only through the injected Clock port, so a replay is byte-identical.
// ponytail: matches names, not values, so `const D = Date; D.now()` passes (ADR-015 decision 5).
// Likewise the import regexes see the specifier, not the importer's folder: only the four siblings are banned by name, review covers other `../` escapes,
// and a hail-core subfolder importing its own `../replay/` or `../console/` is wrongly rejected, loudly.
const useClock = 'hail-core reads time only through the injected Clock port (ADR-002 rule 1).';
const inward = 'hail-core reaches only its own files; everything outside reaches it through a port (ADR-012 rule 1).';
const banned = (object, ...properties) => properties.map((property) => ({ object, property, message: useClock }));

// The timers, then the global objects: banning those closes every `globalThis.Date.now()`-style route at once.
const clockGlobals = ['setTimeout', 'setInterval', 'globalThis', 'global', 'window', 'self'].map((name) => ({ name, message: useClock }));
const clockSyntax = [
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: useClock },
  { selector: "CallExpression[callee.name='Date']", message: useClock },
];
const clockImports = ['timers', 'timers/promises', 'process', 'perf_hooks']
  .flatMap((name) => [name, `node:${name}`])
  .map((name) => ({ name, message: useClock }));

export default defineConfig(
  { files: ['**/*.ts'], languageOptions: { parser: tsParser } },
  {
    files: ['packages/hail-core/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...banned('Date', 'now'),
        ...banned('performance', 'now'),
        ...banned('process', 'hrtime', 'uptime'),
      ],
      'no-restricted-globals': [
        'error',
        ...clockGlobals,
        ...['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'process', 'require'].map((name) => ({ name, message: inward })),
      ],
      'no-restricted-syntax': [
        'error',
        ...clockSyntax,
        { selector: 'ImportExpression', message: inward },
        { selector: 'TSImportType', message: inward },
      ],
      // ADR-002's clock modules, then ADR-012 rule 1: anything not starting `./` or `../`, or a path into a sibling package.
      // A later block setting one of these rules replaces it whole, which the test block below relies on.
      'no-restricted-imports': [
        'error',
        {
          paths: clockImports,
          patterns: [
            { regex: '^(?!\\.{1,2}/)', message: inward },
            { regex: '(^|/)(\\.\\.|packages)/(hail-service|feed-capture|replay|console)(/|$)', message: inward },
          ],
        },
      ],
    },
  },
  {
    // Tests must import vitest, so only the import ban is lifted; the clock ban still holds (ADR-002 rule 1).
    files: ['packages/hail-core/**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', ...clockGlobals],
      'no-restricted-syntax': ['error', ...clockSyntax],
      'no-restricted-imports': ['error', { paths: clockImports }],
    },
  },
);
