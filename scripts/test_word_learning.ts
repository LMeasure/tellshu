/**
 * 单词学习进度 · 持久化单测（fake-indexeddb 真实库，非 mock）
 * ------------------------------------------------------------------
 * 对应 2026-10-31 修的两个 Bug：
 *   Bug 1 进度重置 —— 队列 / 位置 / 完成状态必须落库，退出重进要从中断处继续；
 *   Bug 2 的连带风险 —— 队列只存 id（不存内容），恢复时按 id 回查词包拿释义，
 *                      绝不能出现「词回来了、释义没了」。
 *
 * 覆盖：
 *   1. 新建会话：完整队列顺序落库
 *   2. 学一个词 → 退出 → 再进入：位置与完成态正确恢复（Bug 1 核心回归）
 *   3. 学多个词 → 退出 → 再进入：从上次中断位置继续
 *   4. 已完成词不重复计数（进 / 退反复横跳也不重复）
 *   5. 前进到底 / 后退到头的边界不越界、不空白
 *   6. 新建时跳过已在生词本的词（用户 2026-10-31 拍板）
 *   7. 词包换版：失效 id 剔除、新词追加、位置按锚点词保留（不回退到 0）
 *   8. 重学 group / all（唯一清进度的路径）
 *   9. 分组口径与「组内最后一张 / 最后一组」
 *   10. 计数一致：已完成 + 剩余 = 队列长度
 *   11. 库里文档异常（position 越界）时能自愈到合法位置
 *   12. 老库无会话 → 新建不报错、不影响 vocab 既有数据
 *
 * 运行：tsx scripts/test_word_learning.ts
 */

import 'fake-indexeddb/auto'
import {
  applyMove,
  buildQueue,
  clampPosition,
  completedCount,
  currentId,
  groupOf,
  isFinished,
  isLastGroup,
  isLastInGroup,
  loadOrCreateSession,
  markCurrentCompleted,
  reconcileQueue,
  remainingCount,
  resolveQueue,
  restart,
  saveSession,
  sessionIdOf,
  type WordLearningSession,
} from '../src/domain/wordLearning'
import { addManyToVocab } from '../src/domain/learning'
import { storage } from '../src/services/storage'
import type { ContentWord } from '../src/data/types'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: boolean, msg: string) {
  if (cond) passed += 1
  else {
    failed += 1
    failures.push(msg)
    console.error(`  ❌ ${msg}`)
  }
}

function eq<T>(actual: T, expected: T, msg: string) {
  ok(actual === expected, `${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`)
}

async function group(name: string, fn: () => Promise<void> | void) {
  console.log(`\n▶ ${name}`)
  await fn()
}

/** 造一个最小 ContentWord（只填队列与回查需要的字段） */
function w(id: string, word = id): ContentWord {
  return {
    id,
    word,
    difficulty_level: 2,
    topic_id: 'CET4',
    book: 'CET4',
    definition_zh: `${word} 的中文释义`,
    ipa: `${word}-ipa`,
    pos: 'n.',
  } as ContentWord
}

const WORDS = [w('oe-a', 'a'), w('oe-b', 'b'), w('oe-c', 'c'), w('oe-d', 'd'), w('oe-e', 'e')]
const BOOK = 'CET4'
const BATCH = 2

async function resetDb() {
  await storage.table('wordLearningSessions').clear()
  await storage.table('vocab').clear()
}

async function main() {
  /* ---------------------------------------------------------------- */
  await group('1. 新建会话：完整队列顺序落库', async () => {
    await resetDb()
    const { session, created, skippedLearned } = await loadOrCreateSession({
      book: BOOK,
      level: null,
      words: WORDS,
      batchSize: BATCH,
    })
    eq(created, true, '首次进入 = 新建会话')
    eq(skippedLearned, 0, '生词本为空时不跳过任何词')
    eq(session.queue.length, 5, '队列长度 = 词表长度')
    eq(session.queue.join(','), 'oe-a,oe-b,oe-c,oe-d,oe-e', '队列顺序与传入顺序一致')
    eq(session.position, 0, '新会话从第一个词开始')
    eq(session.completed.length, 0, '新会话无已完成词')
    eq(sessionIdOf(BOOK, null), session.id, '会话 id 口径 = 词本::难度档')

    // 真的写进了库（不是只在内存里）
    const reread = await storage.table('wordLearningSessions').get(session.id)
    eq(reread?.queue.join(','), session.queue.join(','), '库里读回的队列顺序一致')
  })

  /* ---------------------------------------------------------------- */
  await group('2. 学一个词 → 退出 → 再进入：恢复位置（Bug 1 核心）', async () => {
    await resetDb()
    const first = await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })
    const moved = applyMove(first.session, 1)
    eq(moved.position, 1, '前进一格')
    ok(moved.completed.includes('oe-a'), '离开的词被标记为已完成')
    await saveSession(moved)

    // 模拟「退出页面 / 刷新浏览器」：重新走一遍完整载入
    const again = await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })
    eq(again.created, false, '第二次进入 = 恢复已有会话（不是新建）')
    eq(again.session.position, 1, '位置恢复到上次中断处')
    eq(currentId(again.session), 'oe-b', '当前词 = 上次中断的词')
    ok(again.session.completed.includes('oe-a'), '完成态一并恢复')
    eq(again.session.completed.length, 1, '完成态没有重复')
  })

  /* ---------------------------------------------------------------- */
  await group('3. 学多个词 → 退出 → 再进入：从中断位置继续', async () => {
    await resetDb()
    let s = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })).session
    s = applyMove(s, 1)
    s = applyMove(s, 1)
    s = applyMove(s, 1)
    eq(s.position, 3, '连学三个词后位置 = 3')
    eq(completedCount(s), 3, '已完成 3 个')
    await saveSession(s)

    const again = await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })
    eq(again.session.position, 3, '重进后位置仍是 3')
    eq(currentId(again.session), 'oe-d', '当前词 = 第 4 个')
    eq(completedCount(again.session), 3, '已完成数一致（没有被重置）')
  })

  /* ---------------------------------------------------------------- */
  await group('4. 已完成词不重复计数（反复横跳）', async () => {
    await resetDb()
    let s = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })).session
    s = applyMove(s, 1)
    s = applyMove(s, -1) // 右滑回去看
    eq(s.position, 0, '后退回到第 1 个词')
    eq(completedCount(s), 1, '后退不清掉已完成标记')
    s = applyMove(s, 1)
    s = applyMove(s, -1)
    s = applyMove(s, 1)
    eq(completedCount(s), 1, '反复进出同一个词，完成数仍是 1（幂等）')
    const m1 = markCurrentCompleted(s)
    const m2 = markCurrentCompleted(m1)
    eq(m2.completed.length, m1.completed.length, 'markCurrentCompleted 幂等（重复标记不涨）')
    ok(m1 !== s, '第一次标记确实写入了新文档')
    eq(m2, m1, '第二次标记返回同一引用（无变化）')
  })

  /* ---------------------------------------------------------------- */
  await group('5. 边界：到头 / 到底不越界、不空白', async () => {
    await resetDb()
    let s = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })).session
    eq(applyMove(s, -1), s, '第一个词再右滑：原地不动（返回同一引用）')
    let cursor = s
    for (let i = 0; i < 10; i++) cursor = applyMove(cursor, 1)
    eq(cursor.position, 4, '连续前进最多停在最后一个词')
    eq(applyMove(cursor, 1), cursor, '最后一个词再左滑：原地不动')
    eq(currentId(cursor), 'oe-e', '最后位置始终能取到词（不空白）')
    eq(clampPosition(99, 5), 4, '越界位置夹紧到末位')
    eq(clampPosition(-3, 5), 0, '负位置夹紧到 0')

    const lastDone = markCurrentCompleted(cursor)
    ok(isFinished(lastDone), '站上最后一个词且标记完成后 = 已学完')
    ok(!isFinished(cursor), '只是站在最后一个词、还没标记完成 ≠ 已学完')
  })

  /* ---------------------------------------------------------------- */
  await group('6. 新建时跳过已在生词本的词', async () => {
    await resetDb()
    await addManyToVocab([
      { id: 'oe-a', word: 'a', book: 'CET4' },
      { id: 'oe-b', word: 'b', book: 'CET4' },
    ])
    const { session, skippedLearned, created } = await loadOrCreateSession({
      book: BOOK,
      level: null,
      words: WORDS,
      batchSize: BATCH,
    })
    eq(created, true, '仍然是新建会话')
    eq(skippedLearned, 2, '已在生词本的 2 个词被标为已完成')
    eq(session.position, 2, '位置落在第一个没学过的词（oe-c）')
    eq(currentId(session), 'oe-c', '当前词 = 第一个没学过的词')
    eq(session.queue.length, 5, '已学过的词仍留在队列里（右滑可回看）')
    eq(remainingCount(session), 3, '剩余 = 5 - 2')
  })

  /* ---------------------------------------------------------------- */
  await group('7. 词包换版：剔除失效 id / 追加新词 / 位置锚定', async () => {
    await resetDb()
    const s = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })).session
    let cur = applyMove(s, 1)
    cur = applyMove(cur, 1) // 停在 oe-c（下标 2）
    await saveSession(cur)

    // 新词包：oe-b 消失，新增 oe-f
    const nextWords = [w('oe-a', 'a'), w('oe-c', 'c'), w('oe-d', 'd'), w('oe-e', 'e'), w('oe-f', 'f')]
    const res = await loadOrCreateSession({ book: BOOK, level: null, words: nextWords, batchSize: BATCH })
    eq(res.dropped, 1, '剔除 1 个失效 id')
    eq(res.session.queue.join(','), 'oe-a,oe-c,oe-d,oe-e,oe-f', '原顺序保留、新词追加到队尾')
    eq(currentId(res.session), 'oe-c', '位置按锚点词保留，不回退到 0')
    ok(!res.session.completed.includes('oe-b'), '已完成集合里的失效 id 也被剔除')

    // 锚点词本身消失时：位置夹紧，绝不越界
    const g = await loadOrCreateSession({
      book: 'CET6',
      level: 2,
      words: WORDS,
      batchSize: BATCH,
    })
    const broken = { ...g.session, position: 999 }
    await saveSession(broken)
    const fixed = await loadOrCreateSession({ book: 'CET6', level: 2, words: WORDS, batchSize: BATCH })
    eq(fixed.session.position, 4, '越界位置被夹到末位（自愈）')
  })

  /* ---------------------------------------------------------------- */
  await group('8. 重学：唯一清进度的路径', async () => {
    await resetDb()
    const base = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })).session

    // 学到组内第 2 张（位置 1，oe-a 已完成）→ 重学本组（第 0 组 = oe-a/oe-b）
    const at1 = applyMove(base, 1)
    const backGroup = restart(at1, 'group')
    eq(backGroup.position, 0, '回到本组第 1 张')
    eq(completedCount(backGroup), 0, '本组（oe-a / oe-b）的完成态被清掉')

    // 学到第 2 组（位置 2，完成 oe-a/oe-b）→ 重学本组只清 oe-c/oe-d，前面的保留
    const at2 = applyMove(at1, 1)
    const g2 = restart(at2, 'group')
    eq(g2.position, 2, '回到第 2 组第 1 张（下标 2）')
    eq(completedCount(g2), 2, '前面那组的完成态（oe-a/oe-b）不被清')

    const all = restart(at2, 'all')
    eq(all.position, 0, '整本重学回到 0')
    eq(completedCount(all), 0, '整本重学清空完成态')
    eq(all.queue.length, 5, '队列不变（不重建词表）')
  })

  /* ---------------------------------------------------------------- */
  await group('9. 分组口径：组内最后一张 / 最后一组', async () => {
    await resetDb()
    const s = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: 2 })).session
    const g0 = groupOf(s)
    eq(g0.index, 0, '第 0 组')
    eq(g0.total, 3, '5 词 / 每组 2 = 3 组')
    eq(g0.start, 0, '组起点')
    eq(g0.end, 2, '组终点（不含）')
    eq(isLastInGroup(s), false, '组内第 1 张不是最后一张')

    const at1 = applyMove(s, 1)
    eq(isLastInGroup(at1), true, '组内第 2 张 = 组内最后一张')
    eq(isLastGroup(at1), false, '还不是最后一组')

    const at4 = applyMove(applyMove(applyMove(applyMove(s, 1), 1), 1), 1)
    eq(at4.position, 4, '走到队列末尾')
    eq(isLastGroup(at4), true, '最后一组')
    eq(isLastInGroup(at4), true, '队列末尾也算组内最后一张')

    // 改每组词数：位置不动，只换分组口径
    const bigger = { ...at4, batch_size: 5 }
    eq(groupOf(bigger).index, 0, '改成每组 5 词后落在第 0 组')
    eq(isLastInGroup(bigger), true, '仍是组内最后一张')
  })

  /* ---------------------------------------------------------------- */
  await group('10. 计数一致：已完成 + 剩余 = 队列长度', async () => {
    await resetDb()
    let s = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })).session
    for (let i = 0; i < 3; i++) s = applyMove(s, 1)
    eq(completedCount(s) + remainingCount(s), s.queue.length, '已完成 + 剩余 = 队列长度')

    // 历史残留（completed 里有队列外的 id）不能把计数算虚高
    const dirty: WordLearningSession = { ...s, completed: [...s.completed, 'oe-gone'] }
    eq(completedCount(dirty), 3, '队列外的 id 不计入已完成')
    eq(remainingCount(dirty), 2, '剩余数按队列长度算')
  })

  /* ---------------------------------------------------------------- */
  await group('11. 队列内容回查：词与释义一起回来（不是只有词）', async () => {
    await resetDb()
    const s = (await loadOrCreateSession({ book: BOOK, level: null, words: WORDS, batchSize: BATCH })).session
    const resolved = resolveQueue(s, WORDS)
    eq(resolved.length, 5, '队列全部解析成功')
    eq(resolved[0].definition_zh, 'a 的中文释义', '按 id 回查拿到完整释义')
    eq(resolved[0].ipa, 'a-ipa', '音标一并恢复')
    const partial = resolveQueue(s, [w('oe-a', 'a'), w('oe-c', 'c')])
    eq(partial.length, 2, '解析不出的 id 直接剔除（不占位、不空白）')
    eq(partial.map((x) => x.id).join(','), 'oe-a,oe-c', '剩余项保持原顺序')
  })

  /* ---------------------------------------------------------------- */
  await group('12. 兼容：老库无会话 / 脏数据不影响既有数据', async () => {
    await resetDb()
    await addManyToVocab([{ id: 'oe-a', word: 'a', book: 'CET4' }])
    const vocabBefore = await storage.table('vocab').toArray()
    const { created } = await loadOrCreateSession({
      book: 'TOEFL',
      level: 3,
      words: WORDS,
      batchSize: BATCH,
    })
    eq(created, true, '换词本/难度档 = 另一份会话，互不干扰')
    const vocabAfter = await storage.table('vocab').toArray()
    eq(vocabAfter.length, vocabBefore.length, '生词本数据一行没动')

    // 脏会话（字段缺失）也能被校正到可用
    const broken = {
      id: sessionIdOf('GRE8000', null),
      book: 'GRE8000',
      level: null,
      queue: ['oe-x', 'oe-a', 'oe-a'],
      position: 7,
      completed: ['oe-x'],
      batch_size: 0,
      created_at: 1,
      updated_at: 1,
      owner: 'guest',
    } as unknown as WordLearningSession
    await saveSession(broken)
    const patched = await loadOrCreateSession({
      book: 'GRE8000',
      level: null,
      words: WORDS,
      batchSize: BATCH,
    })
    eq(
      patched.session.queue.join(','),
      'oe-a,oe-b,oe-c,oe-d,oe-e',
      '重复 id 去重、失效 id 剔除，再按当前词表补齐（原顺序保留）',
    )
    eq(patched.session.position, 0, '越界位置夹到合法值')
    eq(patched.session.batch_size, 2, '非法 batch_size 被修正')

    // reconcileQueue 直接覆盖：脏队列（重复 + 失效）→ 按当前词表补齐
    const dirty2 = {
      ...patched.session,
      queue: ['oe-a', 'oe-a', 'oe-x'],
      position: 3,
      completed: ['oe-x', 'oe-a'],
    } as WordLearningSession
    const rebuilt = reconcileQueue(dirty2, WORDS, 2)
    eq(rebuilt?.queue.join(',') ?? '', 'oe-a,oe-b,oe-c,oe-d,oe-e', 'reconcile 把队列补齐到当前词表且去重')
    eq(rebuilt?.completed.join(',') ?? '', 'oe-a', '已完成里的失效 id 被剔除')
    eq(rebuilt?.position ?? -1, 3, '锚点词失效时位置夹紧（不回退、不越界）')
    eq(reconcileQueue(patched.session, WORDS, 2), null, '无差异时返回 null（不必回写）')
  })

  /* ---------------------------------------------------------------- */
  await group('13. buildQueue 去重与空表', () => {
    eq(buildQueue([{ id: 'a' }, { id: 'a' }, { id: 'b' }]).join(','), 'a,b', '重复 id 去重')
    eq(buildQueue([]).length, 0, '空词表返回空队列')
    eq(buildQueue([{ id: '' }, { id: 'x' }]).join(','), 'x', '空 id 丢弃')
  })

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.error('\n失败清单：')
    for (const f of failures) console.error(`  · ${f}`)
    process.exit(1)
  }
}

void main()
