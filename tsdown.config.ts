import type { Token as JSToken } from 'js-tokens'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import jsTokens from 'js-tokens'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: 'esm',
  fixedExtension: false,
  clean: true,
  exports: true,
  shims: true,
  dts: false,
  async onSuccess() {
    const file = path.join(process.cwd(), 'dist/index.js')
    const content = await fs.promises.readFile(file, 'utf-8')
    const stripped = strip(content)
    await fs.promises.writeFile(file, stripped, 'utf-8')
  },
})

/**
 * 移除代码中的注释，保留代码本身
 * @param code - 要处理的代码
 * @returns 处理后的代码
 */
export function strip(code: string): string {
  let result = ''

  for (const token of jsTokens(code, { jsx: false })) {
    result += stripFromToken(token)
  }

  return result
}

function stripFromToken(token: JSToken): string {
  if (token.type === 'SingleLineComment' || token.type === 'MultiLineComment') {
    return ''
  }

  return token.value
}
