import antfu from '@antfu/eslint-config'

export default antfu(
  // Configures for antfu's config
  {
    // Prettier owns formatting; ESLint checks code quality only.
    stylistic: false,
    ignores: ['dist', 'node_modules'],
    rules: {
      'no-console': 'off',
      // Formatting rules that conflict with Prettier's output.
      'unicorn/number-literal-case': 'off',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          modifiers: ['const'],
          format: ['UPPER_CASE'],
          filter: { regex: '^([A-Z0-9_]+)$', match: true }, // only top-level consts
        },
        {
          selector: 'variable',
          format: ['camelCase'],
        },
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },
      ],
    },
  },
  {
    files: ['**/main.ts'],
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
        },
      ],
      'jsdoc/require-description': 'warn',
      'jsdoc/require-param': 'warn',
      'jsdoc/require-returns': 'warn',
    },
  }
)
