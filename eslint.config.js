import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'prisma/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'eqeqeq': ['error', 'always'],
      'no-unused-vars': 'off',
      // TypeScript resolves identifiers itself (Express/NodeJS namespaces, DOM
      // globals like URL/fetch) — typescript-eslint recommends disabling this.
      'no-undef': 'off',
    },
  },
  // Architecture: Prisma lives in *.service.ts only. Routers and the Telegram
  // bot talk to services; type-only imports from @prisma/client are fine.
  {
    files: ['src/bot/**/*.ts', 'src/**/*.routes.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message: 'Prisma belongs in *.service.ts — import types only (import type …).',
              allowTypeImports: true,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.type='Identifier'][object.name=/^(prisma|tx)$/]",
          message: 'No Prisma calls here — move the query into a *.service.ts.',
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.property.name=/^(prisma|tx)$/]",
          message: 'No Prisma calls here — move the query into a *.service.ts.',
        },
      ],
    },
  },
];
