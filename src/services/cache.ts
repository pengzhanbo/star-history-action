import type { RenderChartDataset } from '../render.js'
import { readFile } from 'node:fs/promises'

/** A `{ date, stars }` record as stored in the cache baseline. */
interface CacheRecord {
  date: string
  stars: number
}

/**
 * Reads the incremental-fetch cache file into a per-repo baseline map when the
 * file exists and parses cleanly; `null` on any failure (missing, unreadable,
 * or structurally invalid JSON) tells the caller to fall back to a full fetch.
 *
 * 读取增量抓取缓存文件为按仓库索引的基线映射；文件缺失、不可读或结构非法的
 * JSON 一律返回 `null`，调用方据此回退为全量抓取。
 *
 * @param filePath - Absolute path of the cache file / 缓存文件的绝对路径
 * @returns Per-repo baseline records, or `null` / 按仓库索引的基线记录，或 `null`
 */
export async function readCacheRecords(
  filePath: string,
): Promise<Map<string, CacheRecord[]> | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const data = JSON.parse(raw) as { repos?: unknown }
    if (!Array.isArray(data?.repos)) {
      return null
    }
    const byRepo = new Map<string, CacheRecord[]>()
    for (const entry of data.repos as Array<{ repo?: unknown; records?: unknown }>) {
      if (typeof entry?.repo !== 'string' || !Array.isArray(entry.records)) {
        return null
      }
      const records = entry.records as CacheRecord[]
      if (records.some((r) => typeof r?.date !== 'string' || !Number.isInteger(r?.stars))) {
        return null
      }
      byRepo.set(entry.repo, records)
    }
    return byRepo
  } catch {
    return null
  }
}

/**
 * Serializes the datasets into the cache file content. No `updatedAt` stamp is
 * written: the bytes only change when the records change, keeping unchanged
 * reruns idempotent (an unchanged cache stages no git diff).
 *
 * 将数据集序列化为缓存文件内容。不写入 `updatedAt` 时间戳：仅当记录变化时
 * 字节才变化，无变化的重复运行保持幂等（不变的缓存不会产生 git 暂存差异）。
 *
 * @param datasets - Fetched datasets, one per repo / 抓取的数据集，每个仓库一条
 * @returns Pretty-printed cache JSON / 格式化后的缓存 JSON
 */
export function serializeCache(datasets: RenderChartDataset[]): string {
  return JSON.stringify(
    { repos: datasets.map(({ repo, records }) => ({ repo, records })) },
    null,
    2,
  )
}
