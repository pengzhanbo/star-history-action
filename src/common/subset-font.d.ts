/**
 * Minimal type declarations for `subset-font` (CJS, no bundled types).
 *
 * `subset-font` 未内置类型声明，这里补充本项目用到的最小声明。
 */
declare module 'subset-font' {
  interface SubsetFontOptions {
    /** 输出格式，默认 sfnt（TrueType/OpenType） */
    targetFormat?: 'sfnt' | 'woff' | 'woff2'
    /** 保留的 name 表 id */
    preserveNameIds?: number[]
    /** 保留的 OpenType feature tags */
    keepFeatures?: string[]
    /** 是否跳过 GSUB 布局闭合 */
    noLayoutClosure?: boolean
    /** 是否保留 PostScript glyph 名 */
    glyphNames?: boolean
    /** 是否丢弃 hinting 指令 */
    noHinting?: boolean
    /** 需要丢弃的 SFNT 表 */
    dropTables?: string[]
  }

  /**
   * 按给定文本从源字体创建子集。
   *
   * @param buffer - SFNT/woff/woff2 字体源
   * @param text - 需要保留的字形对应的文本
   * @param options - 子集化选项
   * @returns 子集化后的字体 Buffer
   */
  function subsetFont(
    buffer: Buffer | Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ): Promise<Buffer>

  export default subsetFont
}
