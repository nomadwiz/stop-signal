import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// ADR-002 rule 1: hail-core never reads the wall clock, sleeps or sets a timeout.
// Time reaches it only through the injected Clock port, so a replay is byte-identical.
const useClock = 'hail-core reads time only through the injected Clock port (ADR-002 rule 1).';
const banned = (object, ...properties) => properties.map((property) => ({ object, property, message: useClock }));

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['packages/hail-core/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...banned('Date', 'now'),
        ...banned('performance', 'now'),
        ...banned('process', 'hrtime', 'uptime'),
        ...banned('globalThis', 'setTimeout', 'setInterval'),
      ],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: useClock },
        { name: 'setInterval', message: useClock },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: useClock },
        { selector: "CallExpression[callee.name='Date']", message: useClock },
      ],
      // #47's adapter-import ban belongs in this same list: a later block setting this rule replaces it.
      'no-restricted-imports': [
        'error',
        {
          paths: ['timers', 'timers/promises', 'node:timers', 'node:timers/promises'].map((name) => ({ name, message: useClock })),
        },
      ],
    },
  },
);
