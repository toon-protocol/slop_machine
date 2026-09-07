import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
    },
  },
  // Relaxed rules for test files
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      // The devnet's generated directory. Since `pnpm demo` it holds the
      // MPEG-TS segments a viber bought, and an HLS segment's `.ts` extension
      // is TypeScript's — so linting it means parsing video as source. The
      // `.ts` collision CLAUDE.md warns about; ignored by DIRECTORY, never by
      // extension.
      'deploy/devnet/run/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      '.claude/**',
    ],
  }
);
