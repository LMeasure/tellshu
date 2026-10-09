import 'fake-indexeddb/auto'
import {
  addToVocab,
  getDueReviews,
  getVocabByLayer,
  getWrongPool,
  getLayerCounts,
  recordQuiz,
  type VocabEntry,
} from '../src/domain/learning'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

async function run() {
  // 初始：加 abandon 到生词本
  const e1 = await addToVocab({
    word: 'abandon',
    book: 'CET4',
    ipa: 'əˈbændən',
    definition_zh: 'v. 抛弃；放弃',
    pos: 'vt.',
  })
  assert(e1.layer === 'new', '新词 layer 应为 new')
  assert(e1.consecutive_correct === 0, '新词连续答对数 0')
  assert(!e1.in_wrong_pool, '新词不应在错题本')
  console.log('✅ addToVocab → new 层')

  // 刚加入时 next_review = now + 10min，现在不应到点；20 分钟后应到点
  const dueNow = await getDueReviews()
  assert(dueNow.length === 0, '刚加入，现在不应到点')
  const dueFuture = await getDueReviews(Date.now() + 20 * 60 * 1000)
  assert(dueFuture.length === 1, '20 分钟后应有 1 个待复习')
  assert(dueFuture[0].word === 'abandon', '待复习词为 abandon')
  console.log('✅ SRS 排程：10 分钟后到点')

  // 连续答对 5 次 → 从 new 升 apply
  for (let i = 0; i < 5; i++) {
    const after = await recordQuiz(e1.word_id, true, 'choose-meaning')
    assert(after !== null, `第 ${i + 1} 次记录失败`)
    if (i < 4) assert(after.layer === 'new', '前 4 次仍在 new')
    if (i === 4) assert(after.layer === 'apply', '第 5 次升 apply')
  }
  console.log('✅ 连续对 5 次：new → apply')

  // 再连续答对 5 次 → 从 apply 升 mastered
  for (let i = 0; i < 5; i++) {
    const after = await recordQuiz(e1.word_id, true, 'choose-meaning')
    if (i === 4) assert(after!.layer === 'mastered', '第 10 次升 mastered')
  }
  console.log('✅ 连续对 10 次：apply → mastered')

  // 掌握后不在待复习队列
  const dueAfterMaster = await getDueReviews(Date.now() + 30 * 24 * 60 * 60 * 1000)
  assert(dueAfterMaster.every((v) => v.word_id !== e1.word_id), '掌握后不再复习')
  console.log('✅ mastered 不再进入复习队列')

  // 加一个新词，答错一次 → 进错题本
  const e2 = await addToVocab({
    word: 'ability',
    book: 'CET4',
    definition_zh: 'n. 能力',
  })
  const wrong = await recordQuiz(e2.word_id, false, 'choose-meaning')
  assert(wrong!.in_wrong_pool === true, '答错应进错题本')
  assert(wrong!.consecutive_correct === 0, '答错清零')
  assert(wrong!.layer === 'new', '答错不晋级')
  console.log('✅ 答错：清零 + 错题本回流')

  // 错题本统计
  const counts = await getLayerCounts()
  assert(counts.new === 1, `new 计数应为 1，实际 ${counts.new}`)
  assert(counts.mastered === 1, `mastered 计数应为 1，实际 ${counts.mastered}`)
  assert(counts.wrong === 1, `wrong 计数应为 1，实际 ${counts.wrong}`)
  assert(counts.total === 2, `total 应为 2，实际 ${counts.total}`)
  console.log('✅ 统计：new=1, mastered=1, wrong=1, total=2')

  // 掌握层查询
  const mastered = await getVocabByLayer('mastered')
  assert(mastered.length === 1 && mastered[0].word === 'abandon', '掌握层含 abandon')
  const wrongPool = await getWrongPool()
  assert(wrongPool.length === 1 && wrongPool[0].word === 'ability', '错题本含 ability')
  console.log('✅ getVocabByLayer + getWrongPool 正确')

  console.log('\n🎉 学习闭环本地逻辑测试全部通过')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
