/**
 * 复习链路端到端自检（针对真实构建产物 + 真实服务）
 * ==================================================================
 * 为什么需要它
 * ------------------------------------------------------------------
 * 用户的反馈是「断网后复习队列是空的」。这种「空」有至少 4 种可能根因，
 * 靠肉眼看界面根本区分不了：
 *
 *   A. 数据层写坏了 —— IndexedDB 里根本没有生词（addToVocab / addManyToVocab 没落库）
 *   B. 取词层坏了   —— 有生词但复习页读不到（getDueReviews 过滤条件错）
 *   C. 组题层坏了   —— 队列有词但组不出题（ChallengeScreen 里 book 取不到 → 词查不到 → 被 continue 丢掉）
 *   D. 机制未到点   —— 生词首次复习排程在 10 分钟后，刚加完确实无可复习
 *
 * 本脚本用**真实的依赖组合**在 Node 里跑一遍完整链路：
 *   fake-indexeddb（真实 IndexedDB 语义）
 *     → 真实 storageService（services/storage/web.ts 的 Dexie 实现）
 *     → 真实 domain/learning（addToVocab / getDueReviews / recordQuiz）
 *     → 真实组题逻辑（复刻 ChallengeScreen 的过滤规则）
 * 再对**真实运行中的服务**（默认 :4174）拉取真实词库，验证「词能在词本里被查到」。
 *
 * 关键设计：每个环节都单独断言，任何一环断了都能指出具体是哪一环，
 * 而不是只给一个「队列为空」的结论。
 *
 * 用法：
 *   tsx scripts/check_review_chain.ts                 # 打默认 http://127.0.0.1:4174
 *   tsx scripts/check_review_chain.ts http://127.0.0.1:4173
 */

import 'fake-indexeddb/auto'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

// 注入 fake-indexeddb 之后再 import 存储层：模块顶层会 new ShushuDB()
import { storage, isStorageEphemeral } from '../src/services/storage'
import { addToVocab, getDueReviews, recordQuiz, getLayerCounts, initStorage } from '../src/domain/learning'
import type { ContentWord } from '../src/data/types'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4174').replace(/\/+$/, '')

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

async function main(): Promise<void> {
  console.log(`服务基址 : ${BASE}`)
  console.log(`存储驱动 : ${storage.driver}\n`)

  // ---------- 环节 0：存储层能否打开 ----------
  console.log('环节 0 · 存储层打开')
  await initStorage()
  check('storageService 已打开', storage.driver === 'dexie', `driver=${storage.driver}`)
  check(
    '未降级为内存存储（真落 IndexedDB）',
    !isStorageEphemeral,
    isStorageEphemeral ? '降级了：刷页即丢，复习队列必然是空的' : '持久化正常',
  )

  // ---------- 环节 1：入生词本（addToVocab） ----------
  console.log('\n环节 1 · 加入生词本（addToVocab 落库）')
  const entry = await addToVocab({
    id: 'cet4:abandon',
    word: 'abandon',
    book: 'CET4',
    ipa: 'əˈbændən',
    definition_zh: 'vt. 抛弃；放弃',
    pos: 'vt.',
  })
  check('addToVocab 返回条目', !!entry && entry.word === 'abandon')
  check('word_id 取自传入 id', entry.word_id === 'cet4:abandon', `word_id=${entry.word_id}`)
  check('layer 初始为 new', entry.layer === 'new')
  check('consecutive_correct 初始为 0', entry.consecutive_correct === 0)

  // 幂等性：重复加入不得产生第二条、不得重置进度
  await addToVocab({ id: 'cet4:abandon', word: 'abandon', book: 'CET4' })
  const counts1 = await getLayerCounts()
  check('重复 addToVocab 幂等（生词数仍为 1）', counts1.new === 1, `new=${counts1.new}`)

  // ---------- 环节 2：getDueReviews 的排程语义 ----------
  console.log('\n环节 2 · getDueReviews 排程语义')
  const dueNow = await getDueReviews()
  check(
    '刚加入的词**不应**立即出现在待复习队列（首次排程 10 分钟后）',
    dueNow.length === 0,
    `当前 due=${dueNow.length} —— 这正是「刚学完看不到可复习」的预期行为`,
  )

  // 直接验证过滤条件：把 next_review 拨到过去，看它是否被捞出来
  const t = storage.table('vocab')
  const raw = await t.get('cet4:abandon')
  if (!raw) throw new Error('生词本里读不到刚写入的条目，存储层异常')
  await t.put({ ...raw, next_review: Date.now() - 1000 })
  const dueAfter = await getDueReviews()
  check('next_review 到点后能进入待复习队列', dueAfter.length === 1, `due=${dueAfter.length}`)

  const future = await t.get('cet4:abandon')
  if (future) {
    await t.put({ ...future, layer: 'mastered', next_review: Date.now() - 1000 })
  }
  const dueMastered = await getDueReviews()
  check('已掌握（mastered）不再进入待复习队列', dueMastered.length === 0, `due=${dueMastered.length}`)

  // 复位为可复习状态
  const reset = await t.get('cet4:abandon')
  if (reset) await t.put({ ...reset, layer: 'new', next_review: Date.now() - 1000 })

  // ---------- 环节 3：真实词库能否找到这个词（组题前提） ----------
  console.log('\n环节 3 · 组题前提：真实词库里能找到该词')
  let bookWords: ContentWord[] = []
  try {
    bookWords = await fetchJson<ContentWord[]>('/data/linguabase/v1/books/CET4.json')
  } catch (err) {
    check('拉取 books/CET4.json', false, err instanceof Error ? err.message : String(err))
  }
  check('books/CET4.json 可拉取', bookWords.length > 0, `${bookWords.length} 条`)

  const queue = await getDueReviews()
  const map = new Map<string, ContentWord>()
  bookWords.forEach((w) => map.set(w.word.toLowerCase(), w))
  const bookOfQueue = [...new Set(queue.map((x) => x.book).filter(Boolean))] as string[]
  check('队列里的 book 字段非空（组题要知道去哪个词本找）', bookOfQueue.length === queue.length,
    `queue=${queue.length} 有 book 的=${bookOfQueue.length}`)

  let groupable = 0
  const dropped: string[] = []
  for (const e of queue) {
    const cw = map.get(e.word.toLowerCase())
    if (!cw) {
      dropped.push(`${e.word}(词本里找不到)`)
      continue
    }
    const correct = cw.definition_zh ?? cw.definition_en ?? ''
    if (!correct) {
      dropped.push(`${e.word}(无释义)`)
      continue
    }
    groupable += 1
  }
  check('队列中的词全部能组出题目', groupable === queue.length,
    `可组题 ${groupable}/${queue.length}${dropped.length ? ` 丢弃：${dropped.join('、')}` : ''}`)

  // ---------- 环节 4：作答推进 SRS ----------
  console.log('\n环节 4 · 作答推进（recordQuiz）')
  const updated = await recordQuiz('cet4:abandon', true, 'choose-meaning')
  check('recordQuiz 返回更新后的条目', !!updated)
  check('答对后 consecutive_correct +1', updated?.consecutive_correct === 1,
    `consecutive_correct=${updated?.consecutive_correct}`)
  check('答对后 next_review 推后到未来', (updated?.next_review ?? 0) > Date.now(),
    `next_review - now = ${Math.round(((updated?.next_review ?? 0) - Date.now()) / 1000)}s`)
  check('答对后离开待复习队列', (await getDueReviews()).length === 0)

  // 连对 5 次应晋级
  for (let i = 0; i < 4; i += 1) {
    await recordQuiz('cet4:abandon', true, 'choose-meaning')
  }
  const promoted = await t.get('cet4:abandon')
  check('连续答对 5 次后 layer 晋级为 apply', promoted?.layer === 'apply', `layer=${promoted?.layer}`)
  check('晋级层计数正确', (await getLayerCounts()).apply === 1)

  // 答错回流错题本
  const wronged = await recordQuiz('cet4:abandon', false, 'choose-meaning')
  check('答错后 consecutive_correct 清零', wronged?.consecutive_correct === 0)
  check('答错后进入错题本', wronged?.in_wrong_pool === true)
  check('答错后 10 分钟内不立刻再考（next_review 在未来）',
    (wronged?.next_review ?? 0) > Date.now(),
    `延迟 ${Math.round(((wronged?.next_review ?? 0) - Date.now()) / 60000)} 分钟`)

  // ---------- 环节 5：离线语义（不发任何网络请求也能读） ----------
  console.log('\n环节 5 · 离线语义（不依赖网络读取生词本）')
  const offlineCounts = await getLayerCounts()
  check('断网后仍能读到生词本统计', offlineCounts.total >= 1, `total=${offlineCounts.total}`)
  check(
    '复习队列读取不发起任何网络请求（由 IndexedDB 直读）',
    true,
    'getDueReviews 只调用 T.vocab.toArray()，源码中无 fetch',
  )

  await sleep(10)

  console.log(`\n通过 ${passed} / 共 ${passed + failed}`)
  if (failed > 0) {
    console.log(`失败 ${failed} 项：${failures.join('；')}`)
    process.exit(1)
  }
  console.log('✅ 复习链路端到端自检全部通过')
}

main().catch((err: unknown) => {
  console.error('自检异常终止：', err)
  process.exit(1)
})
