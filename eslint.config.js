import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ADR-002 rule 1: hail-core never reads the wall clock, sleeps or sets a timeout.
// Time reaches it only through the injected Clock port, so a replay is byte-identical.
const useClock = 'hail-core reads time only through the injected Clock port (ADR-002 rule 1).';

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['packages/hail-core/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: useClock },
        { object: 'performance', property: 'now', message: useClock },
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
    },
  },
);
