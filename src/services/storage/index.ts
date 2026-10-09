/**
 * 存储服务出口
 * ------------------------------------------------------------------
 * 平台选择规则（自上而下）：
 *   1. `VITE_STORAGE_DRIVER=memory` 强制走内存实现（单测 / 演示用）
 *   2. 环境里有 IndexedDB → Dexie 实现
 *   3. 否则 → 内存实现，并打印告警（数据不落盘，但界面能用）
 *
 * 页面与领域代码只 import 这里的 `storage`，不关心下面是哪个实现。
 * 将来接原生壳：新增 `native.ts` 实现 SQLite，在这里加一个分支即可。
 */

import { dexieStorage } from './web'
import { memoryStorage } from './memory'
import type { StorageService } from './types'

export type { StorageService, TableService } from './types'

function pickDriver(): StorageService {
  const forced = import.meta.env?.VITE_STORAGE_DRIVER
  if (forced === 'memory') return memoryStorage
  if (typeof indexedDB !== 'undefined') return dexieStorage
  console.warn(
    '[storage] 当前环境没有 IndexedDB，已降级为内存存储：数据不会持久化（刷新即丢）。',
  )
  return memoryStorage
}

export const storage: StorageService = pickDriver()

/** 是否处于持久化降级状态（设置页可据此提示用户） */
export const isStorageEphemeral = storage.driver === 'memory'
