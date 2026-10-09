/**
 * LWW 合并纯逻辑单测（可单测，不依赖 DOM / 平台 API）
 * 运行：tsx scripts/test_sync.ts  （已并入 npm test 链）
 */
import { mergeEntity } from '../src/domain/sync'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  console.log('ok:', msg)
}

const base = { id: 'a', updated_at: 100, deleted_at: null as number | null }

// 远端更新更新 → 远端胜
assert(
  mergeEntity({ ...base, updated_at: 100 }, { ...base, updated_at: 200 }).updated_at === 200,
  '远端 updated_at 更大 → 远端胜',
)

// 本地更新更新 → 本地胜
assert(
  mergeEntity({ ...base, updated_at: 300 }, { ...base, updated_at: 200 }).updated_at === 300,
  '本地 updated_at 更大 → 本地胜',
)

// 本地为空 → 采用远端
assert(
  mergeEntity(undefined, { ...base, updated_at: 200 }) !== undefined,
  '本地为空 → 采用远端',
)

// 远端删除晚于本地编辑 → 删除胜（墓碑保留）
assert(
  mergeEntity({ ...base, updated_at: 500 }, { ...base, updated_at: 100, deleted_at: 600 })
    .deleted_at === 600,
  '远端删除晚于本地编辑 → 删除胜（墓碑）',
)

// 远端删除早于本地编辑 → 编辑胜（保留本地）
assert(
  mergeEntity({ ...base, updated_at: 500 }, { ...base, updated_at: 100, deleted_at: 400 })
    .updated_at === 500,
  '远端删除早于本地编辑 → 编辑胜',
)

// 本地为空 + 远端删除 → 墓碑保留
assert(
  (mergeEntity(undefined, { ...base, updated_at: 100, deleted_at: 200 })?.deleted_at as number) ===
    200,
  '本地为空 + 远端删除 → 墓碑保留',
)

console.log('test_sync done')
