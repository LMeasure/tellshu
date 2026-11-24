/**
 * PR #13 遗留修复 · Dexie / fake-indexeddb。
 * fake-indexeddb 必须先于领域模块求值，否则 storage 会落到内存驱动。
 * 运行：npx tsx scripts/test_pr13_leftover_web.ts
 */
import 'fake-indexeddb/auto'
import { runPr13LeftoverCases } from './pr13_leftover_cases'

runPr13LeftoverCases('dexie').catch((err) => {
  console.error(err)
  process.exit(1)
})
