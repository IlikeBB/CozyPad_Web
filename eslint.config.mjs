import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/app/public/legacy-v2/**',
      'apps/desktop/release*/**',
      'apps/mobile/android/**',
      'lib/**',
      'packages/xterm/**',
      'android/**',
      'ios/**',
      'linux/**',
      'macos/**',
      'windows/**',
      'web/**',
      'build/**',
      'graphify-out/**',
      'scripts/legacy-v2-*.mjs',
      'test/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['apps/app/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', '@capacitor/*', 'ssh2', 'node:*'],
              message:
                'React app 不得直接使用 shell/Node API；一律經由 PlatformBridge（SPEC_V3 3.1）。',
            },
          ],
        },
      ],
    },
  },
);
