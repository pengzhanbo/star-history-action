import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: 'esm',
  fixedExtension: false,
  clean: true,
  exports: true,
  shims: true,
  dts: false,
})
