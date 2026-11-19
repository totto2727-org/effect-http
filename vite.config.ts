// oxlint-disable-next-line rules/no-node-imports -- Vite+ runs this configuration on Node.
import { URL } from 'node:url'

import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import preset from '@totto2727/oxlint/preset/library'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

// oxlint-disable-next-line import/no-default-export -- Vite+ loads its configuration from the default export.
export default defineConfig({
  fmt: {
    arrowParens: 'always',
    experimentalSortImports: {
      ignoreCase: true,
      newlinesBetween: true,
      order: 'asc',
    },
    experimentalSortPackageJson: true,
    ignorePatterns,
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
  },
  lint: {
    ...preset,
    globals: { FormData: 'readonly', Request: 'readonly' },
    ignorePatterns,
    options: { ...preset.options, typeCheck: true },
    overrides: [
      ...(preset.overrides ?? []),
      {
        files: ['src/**/*.ts'],
        rules: {
          'no-restricted-globals': [
            'error',
            { message: 'Define custom errors with Effect Data.TaggedError.', name: 'Error' },
            { message: 'Define configuration errors with Effect Data.TaggedError.', name: 'TypeError' },
            { message: 'Use Effect HashMap for keyed state.', name: 'Map' },
            { message: 'Use Effect HashSet for unique values.', name: 'Set' },
          ],
          'no-restricted-properties': [
            'error',
            { message: 'Use Effect Record.toEntries.', object: 'Object', property: 'entries' },
            { message: 'Use Effect Record.fromEntries.', object: 'Object', property: 'fromEntries' },
            { message: 'Use Effect Record.keys.', object: 'Object', property: 'keys' },
            { message: 'Use Effect Record.empty or tagged constructors.', object: 'Object', property: 'create' },
            { message: 'Decode JSON with Effect Schema.', object: 'JSON', property: 'parse' },
            { message: 'Encode JSON with Effect Schema.', object: 'JSON', property: 'stringify' },
          ],
        },
      },
      {
        files: ['src/**/*.test.ts'],
        rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
      },
    ],
  },
  pack: {
    clean: true,
    dts: true,
    entry: [
      'src/accepts.ts',
      'src/cacheControl.ts',
      'src/conditionalRequest.ts',
      'src/csrf.ts',
      'src/responseCache.ts',
      'src/secureHeaders.ts',
    ],
    format: ['esm'],
    platform: 'neutral',
  },
  run: {
    tasks: {
      build: {
        cache: {
          input: [{ auto: true }, '!dist/**'],
          output: ['dist/**'],
        },
        command: 'vp pack',
      },
      check: {
        command: 'vp check',
      },
      ci: {
        command: '',
        dependsOn: ['check', 'test', 'build'],
      },
      fix: {
        command: 'vp check --fix',
      },
      test: {
        command: 'vp test run',
      },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
})
