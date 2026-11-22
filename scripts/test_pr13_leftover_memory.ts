/**
 * PR #13 遗留修复 · 内存驱动。
 * 故意不加载 fake-indexeddb，storage 会选中 memoryStorage。
 * 运行：npx tsx scripts/test_pr13_leftover_memory.ts
 */
import { runPr13LeftoverCases } from './pr13_leftover_cases'

runPr13LeftoverCases('memory').catch((err) => {
  console.error(err)
  process.exit(1)
})
