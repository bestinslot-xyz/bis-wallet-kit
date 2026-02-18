import antfu from '@antfu/eslint-config'
import tsParser from '@typescript-eslint/parser'

export default antfu(
  // Configures for antfu's config
  {
    ignores: ['dist', 'node_modules', 'src/**/*.d.ts', '**/*.vue', 'examples/*', '**/*.json', '**/*.md', '**/*.txt', '**/*.config.*'],
    rules: {},
    languageOptions: {
      ecmaVersion: 2022,
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: new URL('.', import.meta.url).pathname,
        sourceType: 'module',
      },
    },
  },
  {
    rules: {
      'no-console': 'warn',
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          "selector": "variable",
          "format": ["camelCase"]
        },
        {
          "selector": "parameter",
          "format": ["camelCase"],
          "leadingUnderscore": "allow"
        },
        {
          "selector": "variable",
          "modifiers": ["const"],
          "format": ["UPPER_CASE"],
          "filter": { "regex": "^([A-Z_]+)$", "match": true } // only top-level consts
        },
        {
          "selector": "function",
          "format": ["camelCase"]
        },
        {
          "selector": "typeLike",
          "format": ["PascalCase"]
        },
        {
          "selector": "enumMember",
          "format": ["UPPER_CASE"]
        }
      ]
    },
  },
)
