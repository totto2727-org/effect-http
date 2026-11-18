import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

export default defineConfig({
  fmt: {
    ignorePatterns,
    arrowParens: 'always',
    experimentalSortImports: {
      ignoreCase: true,
      newlinesBetween: true,
      order: 'asc',
    },
    experimentalSortPackageJson: true,
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
  },
  lint: {
    ignorePatterns,
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ['src/**/*.ts'],
        rules: {
          'no-restricted-globals': [
            'error',
            { name: 'Error', message: 'Define custom errors with Effect Data.TaggedError.' },
            { name: 'TypeError', message: 'Define configuration errors with Effect Data.TaggedError.' },
            { name: 'Map', message: 'Use Effect HashMap for keyed state.' },
            { name: 'Set', message: 'Use Effect HashSet for unique values.' },
          ],
          'no-restricted-properties': [
            'error',
            { object: 'Object', property: 'entries', message: 'Use Effect Record.toEntries.' },
            { object: 'Object', property: 'fromEntries', message: 'Use Effect Record.fromEntries.' },
            { object: 'Object', property: 'keys', message: 'Use Effect Record.keys.' },
            { object: 'Object', property: 'create', message: 'Use Effect Record.empty or tagged constructors.' },
            { object: 'JSON', property: 'parse', message: 'Decode JSON with Effect Schema.' },
            { object: 'JSON', property: 'stringify', message: 'Encode JSON with Effect Schema.' },
          ],
        },
      },
      {
        files: ['src/**/*.test.ts'],
        rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
      },
    ],
  },
  test: { include: ['src/**/*.test.ts'] },
  pack: { entry: ['src/index.ts'], format: ['esm'], platform: 'neutral', dts: true, clean: true },
  run: {
    tasks: {
      build: {
        command: 'vp pack',
        cache: {
          input: [{ auto: true }, '!dist/**'],
          output: ['dist/**'],
        },
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
})
