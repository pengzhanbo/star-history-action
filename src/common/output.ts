import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { info } from '@actions/core'

/**
 * Writes a chart file under the output directory and logs its workspace-relative
 * path, returning that path for the commit file list.
 *
 * 将图表文件写入输出目录，记录其相对于工作区的路径，并返回该路径用于
 * 提交文件列表。
 *
 * @param options - Output destination and content / 输出目标与内容
 * @returns Workspace-relative path of the written file / 已写入文件的工作区相对路径
 */
export async function writeOutput(options: {
  /** Output directory (under GITHUB_WORKSPACE) / 输出目录（位于 GITHUB_WORKSPACE 下） */
  outDir: string
  /** GitHub workspace root, used for relative logging / GitHub 工作区根，用于相对路径日志 */
  workspace: string
  /** File name within outDir / outDir 内的文件名 */
  file: string
  /** File content (string is written as UTF-8) / 文件内容（字符串按 UTF-8 写入） */
  content: string | Uint8Array
}): Promise<string> {
  const filePath = join(options.outDir, options.file)
  await writeFile(filePath, options.content)
  info(`wrote ${relative(options.workspace, filePath)}`)
  return relative(options.workspace, filePath)
}
