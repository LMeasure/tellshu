/**
 * 单词默写 · 前端验收（阶段 D）
 * ------------------------------------------------------------------
 * 用 jsdom **真实渲染** `Spelling` / `SpellingResult` 组件树，配 fake-indexeddb
 * 真实持久化。断言全部落在**实际 DOM 状态 + 数据库行**上，不断言「函数被调用过」。
 *
 * 能力边界（如实声明）：
 *   · jsdom 无布局引擎：像素级视觉（重叠/溢出/遮挡/视口自适应）不在覆盖范围；
 *   · `react-router` 用 MemoryRouter 驱动，导航用「URL 变化 + 目标组件出现」验证，
 *     不 mock navigate；
 *   · 多标签页冲突用「往库里塞两份 IN_PROGRESS 会话」复现，这是存储层真实的冲突态。
 *
 * 运行：npx tsx scripts/test_spelling_ui.ts
 */

/* 1. ⚠️ fake-indexeddb 必须在 globalThis.window 被定义**之前**导入。
 *    它的 auto 入口按 `typeof window` 决定把 indexedDB 挂到哪个全局：
 *    先定义 jsdom 的 window，indexedDB 会挂到 jsdom window 上，Node 侧
 *    globalThis.indexedDB 仍是 undefined ⇒ storage 静默降级成内存驱动。
 *    （静态 import 先于模块体执行，所以放这里就满足顺序。） */
import 'fake-indexeddb/auto'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'getComputedStyle',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  })
}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setTimeout as sleep } from 'node:timers/promises'

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

async function main(): Promise<void> {
  /* 2. 依赖按序加载（jsdom 先于 React；storage 此时已能看到 indexedDB） */
  const { storage } = await import('../src/services/storage')
  const React = (await import('react')).default
  const { MemoryRouter, Routes, Route, useLocation } = await import('react-router-dom')
  const { Spelling } = await import('../src/pages/Spelling')
  const { SpellingResult } = await import('../src/pages/SpellingResult')
  const { Review } = await import('../src/pages/Review')
  const { useAppStore } = await import('../src/store/useAppStore')
  const { addToVocab } = await import('../src/domain/learning')
  const {
    createSession,
    getActiveSessions,
    getSessionById,
    getAllSessions,
  } = await import('../src/domain/spellingSession')
  const act = React.act

  const container = document.getElementById('root') as HTMLElement
  /** 每个场景都用全新的 root，保证组件的 useEffect 真的重跑（否则 bootstrap 不会再次触发） */
  let root: { render: (el: React.ReactElement) => void; unmount: () => void } | null = null

  /** 把 batchSize 固定成 3，让每轮词数可控 */
  useAppStore.getState().setSetting('studyBatchSize', 3)

  check('storage 走真实 Dexie 驱动（未降级内存）', storage.driver === 'dexie', storage.driver)

  async function seed() {
    await storage.clearAll()
    window.sessionStorage.clear()
    await addToVocab({ word: 'abandon', book: 'CET4', definition_zh: 'v. 抛弃；放弃' })
    await addToVocab({ word: 'benefit', book: 'CET4', definition_zh: 'n. 利益；好处' })
    await addToVocab({ word: 'cabbage', book: 'CET4', definition_zh: 'n. 卷心菜' })
    await addToVocab({ word: 'daisy', book: 'CET4', definition_zh: 'n. 雏菊' })
  }

  /** 渲染指定路由，返回当前 location 的读取器 */
  async function renderAt(path: string) {
    if (root) {
      await act(async () => {
        root!.unmount()
      })
      root = null
    }
    const { createRoot } = await import('react-dom/client')
    root = createRoot(container)
    let locationRef: { pathname: string; search: string } = { pathname: '', search: '' }
    function Probe() {
      const loc = useLocation()
      locationRef = { pathname: loc.pathname, search: loc.search }
      return null
    }
    await act(async () => {
      root!.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [path] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: '/spelling',
              element: React.createElement(
                React.Fragment,
                null,
                React.createElement(Probe),
                React.createElement(Spelling),
              ),
            }),
            React.createElement(Route, {
              path: '/spelling-result',
              element: React.createElement(
                React.Fragment,
                null,
                React.createElement(Probe),
                React.createElement(SpellingResult),
              ),
            }),
            React.createElement(Route, {
              path: '/review',
              element: React.createElement(
                React.Fragment,
                null,
                React.createElement(Probe),
                React.createElement(Review),
              ),
            }),
          ),
        ),
      )
    })
    await act(async () => {
      await sleep(80)
    })
    return {
      get location() {
        return locationRef
      },
      text: () => container.textContent ?? '',
      q: (sel: string) => container.querySelector(sel),
      qa: (sel: string) => Array.from(container.querySelectorAll(sel)),
    }
  }

  /** 「刷新」= 卸载后重新挂载 */
  async function refresh() {
    await act(async () => {
      root!.unmount()
    })
    root = null
  }

  /**
   * V2 逐字母输入：把整词拆成单字符，每个字符触发一次 input 事件。
   * 页面用「受控 value='' + 串行队列」消费快速连打，所以可以在一个 act 里
   * 连续 dispatch 所有字符（ref 入队是同步的，不会丢），再等队列排空。
   * V2 无「回车提交 / 提交按钮」，故不再发送 Enter、不再点按钮。
   */
  async function typeWord(view: Awaited<ReturnType<typeof renderAt>>, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      for (const ch of value) {
        const input = view.q('#spelling-input') as HTMLInputElement | null
        if (!input) break
        setter.call(input, ch)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }
    })
    // 等待逐字母串行 atomicBatch 队列消费完毕（每个字母一次跨表事务）
    await act(async () => {
      await sleep(400)
    })
  }

  /** 输入一个必定错误的字母（与首字母不同） */
  async function typeWrongLetter(view: Awaited<ReturnType<typeof renderAt>>, answer: string) {
    const first = (answer[0] ?? 'a').toLowerCase()
    await typeWord(view, first === 'z' ? 'q' : 'z')
  }

  /* ================================================================
   * 场景 1 · /review 入口与路由接入
   * ================================================================ */
  console.log('\n场景 1 · /review 入口与路由')
  await seed()
  {
    const view = await renderAt('/review')
    check('Review 页渲染出「单词默写」卡片', view.text().includes('单词默写'))
    check('入口卡片带模式切换（随机/最近新增/易错词）', view.text().includes('易错词'))
    check('入口卡片显示沿用设置的每轮词数', view.text().includes('3'))
    check('入口说明连对目标', view.text().includes('连对 3 次'))

    // 点「开始默写」应导航到 /spelling?mode=...
    const startBtn = view.qa('button').find((b) => b.textContent?.includes('开始默写'))
    check('找到「开始默写」按钮', startBtn !== undefined)
    if (startBtn) {
      await act(async () => {
        startBtn.click()
      })
      await act(async () => {
        await sleep(120)
      })
      check('点击后路由切到 /spelling', view.location.pathname === '/spelling', view.location.pathname)
      check('mode 通过 query 传递', view.location.search.includes('mode='), view.location.search)
    }
  }

  /* ================================================================ */
  /* 场景 2 · 出题来自持久化队列（不泄露答案）                       */
  /* ================================================================ */
  console.log('\n场景 2 · 出题来自持久化队列')
  await seed()
  {
    const view = await renderAt('/spelling?mode=recent')
    check('自动创建会话并进入练习', view.q('#spelling-input') !== null)

    // 库里应恰好一份 IN_PROGRESS 会话
    const active = await getActiveSessions()
    check('库里只有一份进行中会话', active.length === 1, `实际 ${active.length}`)

    const stored = (await getAllSessions())[0]
    check('持久化队列有 3 个词（batchSize=3）', stored.queue.length === 3, `实际 ${stored.queue.length}`)
    check('current_position 指向队列首位', stored.current_position === 0)

    // 不泄露答案：DOM 里不能出现任何一个完整答案
    const body = view.text()
    const leaked = stored.queue.filter((w) => body.includes(w.word))
    check('页面不直接泄露任何答案', leaked.length === 0, leaked.map((w) => w.word).join(','))
    // 当前词的中文释义必须出现在页面上。
    // ⚠️ 用库里真实队列首位来断言，不能硬编码白名单：'recent' 具体选哪 3 个词
    //    由排序决定，首词可能是 cabbage —— 早期写法只认「雏菊/抛弃/利益」，
    //    首词换成 cabbage 就误报失败（全量 npm test 里真的发生过）。
    const current = stored.queue.find((w) => w.position === stored.current_position) ?? stored.queue[0]
    check(
      '展示中文释义',
      current.definition_zh != null && body.includes(current.definition_zh),
      current.definition_zh ?? '(无)',
    )
    check('展示首字母与长度提示', body.includes('个字母'))
  }

  /* ================================================================ */
  /* 场景 3 · 提交反馈 / 判分 / 空答案 / 跳过 / 完成                  */
  /* ================================================================ */
  console.log('\n场景 3 · 提交反馈与判分')
  await seed()
  {
    const view = await renderAt('/spelling?mode=recent')
    const sessionId = (await getAllSessions())[0].id
    const answerOf = async () => {
      const s = (await getSessionById(sessionId))!
      return s.queue.find((w) => w.position === s.current_position)!.word
    }

    // 3.1 V2 错误字母：即时 1 条错词事件 + 进度/连对归零，不污染完整答题统计
    const w1 = await answerOf()
    await typeWrongLetter(view, w1)
    check('错误字母给出否定反馈', view.text().includes('字母不对'))
    {
      const s = (await getSessionById(sessionId))!
      const w = s.queue.find((x) => x.word === w1)!
      const events = await storage.table('spellingErrorEvents').toArray()
      check('错误字母落 1 条错词事件', events.length === 1, `实际 ${events.length}`)
      check('错误字母不增加 wrong_attempts', w.wrong_attempts === 0, `实际 ${w.wrong_attempts}`)
      check('错误字母不增加 total_attempts', w.total_attempts === 0, `实际 ${w.total_attempts}`)
      check('错误字母使连续正确归零', w.consecutive_correct === 0)
      check('错误字母后输入进度归零', (w.typed_prefix ?? '') === '')
      check('错误字母不推进队列', s.current_position === 0)
    }

    // 3.2 非法字符：ignored，不计任何计数、不产生事件
    const beforeIgnored = (await storage.table('spellingErrorEvents').toArray()).length
    await typeWord(view, ' ')
    check('非法字符有明确提示', view.text().includes('不参与拼写'))
    {
      const s = (await getSessionById(sessionId))!
      const w = s.queue.find((x) => x.word === w1)!
      const events = await storage.table('spellingErrorEvents').toArray()
      check('非法字符不产生错词事件', events.length === beforeIgnored, `实际 ${events.length}`)
      check('非法字符不计入 total_attempts', w.total_attempts === 0, `实际 ${w.total_attempts}`)
      check('非法字符不重置连续正确', w.consecutive_correct === 0)
      check('非法字符不推进队列', s.current_position === 0)
    }

    // 3.3 V2 拼完整个单词 3 次（每次 = 一次完整答题提交）→ COMPLETED 并切词
    await typeWord(view, w1)
    await typeWord(view, w1)
    await typeWord(view, w1)
    {
      const s = (await getSessionById(sessionId))!
      const w = s.queue.find((x) => x.word === w1)!
      check('完整拼对 3 次后状态 COMPLETED', w.status === 'COMPLETED')
      check('连续正确计数为 3', w.consecutive_correct === 3)
      check('完整答题提交次数为 3', w.total_attempts === 3, `实际 ${w.total_attempts}`)
      check('完成后队列推进', s.current_position === 1, `实际 ${s.current_position}`)
      check('UI 显示达标切词反馈', view.text().includes('整词达标'))
    }

    // 3.4 第二个词：跳过
    const w2 = await answerOf()
    const skipBtn = view.qa('button').find((b) => b.textContent?.includes('跳过'))
    check('找到「跳过」按钮', skipBtn !== undefined)
    if (skipBtn) {
      await act(async () => {
        skipBtn.click()
      })
      await act(async () => {
        await sleep(40)
      })
    }
    {
      const s = (await getSessionById(sessionId))!
      check('跳过词状态为 SKIPPED', s.queue.find((x) => x.word === w2)!.status === 'SKIPPED')
      check('跳过后队列推进', s.current_position === 2, `实际 ${s.current_position}`)
      check('跳过不计入提交次数', s.queue.find((x) => x.word === w2)!.total_attempts === 0)
    }

    // 3.5 第三个词答对 3 次 → 会话自然结束 → 自动跳结果页
    const w3 = await answerOf()
    await typeWord(view, w3)
    await typeWord(view, w3)
    await typeWord(view, w3)
    await act(async () => {
      await sleep(1400) // 等 900ms 的自动跳转定时器
    })
    check('会话结束后自动跳 /spelling-result', view.location.pathname === '/spelling-result', view.location.pathname)
    check('结果页带会话 id', view.location.search.includes(sessionId))
    {
      const s = (await getSessionById(sessionId))!
      check('库里会话状态 SESSION_COMPLETED', s.status === 'SESSION_COMPLETED')
      check('完成 2 个 / 跳过 1 个', s.queue.filter((w) => w.status === 'COMPLETED').length === 2)
    }
  }

  /* ================================================================ */
  /* 场景 4 · 刷新恢复（重新挂载组件，读同一份会话）                  */
  /* ================================================================ */
  console.log('\n场景 4 · 刷新后恢复会话')
  await seed()
  {
    // 先建会话并答一半
    await createSession({ mode: 'recent', count: 3 })
    const sid = (await getAllSessions())[0].id
    const s0 = (await getSessionById(sid))!
    const first = s0.queue[0].word
    await storage.table('spellingSessions').put({
      ...s0,
      queue: s0.queue.map((w, i) => (i === 0 ? { ...w, consecutive_correct: 1, status: 'IN_PROGRESS' } : w)),
      current_position: 0,
    })

    // 「刷新」：卸载再挂载（等价于重新进页面）
    await refresh()
    const view = await renderAt('/spelling?mode=recent')

    check('刷新后恢复同一会话（没有新开一份）', (await getAllSessions()).length === 1)
    const restored = (await getSessionById(sid))!
    check('刷新后连对进度保留', restored.queue[0].consecutive_correct === 1)
    check('刷新后出题位置不变', restored.current_position === 0)
    check('UI 显示连对进度', view.text().includes('连对 1/3'), view.text().slice(0, 200))
    check('输入框可用', view.q('#spelling-input') !== null)

    // 恢复后完整拼对 2 次即完成该词（状态机跨刷新连续）
    await typeWord(view, first)
    await typeWord(view, first)
    {
      const s = (await getSessionById(sid))!
      check('跨刷新连对累计到 3 → COMPLETED', s.queue[0].status === 'COMPLETED')
    }
  }

  /* ================================================================ */
  /* 场景 5 · 暂停 / 继续 / 放弃                                     */
  /* ================================================================ */
  console.log('\n场景 5 · 暂停 / 继续 / 放弃')
  await seed()
  {
    const view = await renderAt('/spelling?mode=recent')
    const sid = (await getAllSessions())[0].id

    const pauseBtn = view.qa('button').find((b) => b.getAttribute('aria-label') === '暂停本轮默写')
    check('找到暂停按钮（带 aria-label）', pauseBtn !== undefined)
    await act(async () => {
      pauseBtn!.click()
    })
    await act(async () => {
      await sleep(60)
    })
    check('暂停后显示暂停态', view.text().includes('默写已暂停'))
    check('库里状态为 PAUSED', (await getSessionById(sid))!.status === 'PAUSED')
    check('暂停后不算进行中会话', (await getActiveSessions()).length === 0)

    // 刷新后仍在暂停态，可继续
    await refresh()
    const view2 = await renderAt('/spelling?mode=recent')
    check('刷新后仍识别为暂停态', view2.text().includes('默写已暂停'))
    const resumeBtn = view2.qa('button').find((b) => b.textContent?.includes('继续默写'))
    check('找到「继续默写」按钮', resumeBtn !== undefined)
    await act(async () => {
      resumeBtn!.click()
    })
    await act(async () => {
      await sleep(60)
    })
    check('继续后回到练习态', view2.q('#spelling-input') !== null)
    check('库里回到 IN_PROGRESS', (await getSessionById(sid))!.status === 'IN_PROGRESS')

    // 放弃 → 回 /review
    const pauseBtn2 = view2.qa('button').find((b) => b.getAttribute('aria-label') === '暂停本轮默写')
    await act(async () => {
      pauseBtn2!.click()
    })
    await act(async () => {
      await sleep(60)
    })
    const abandonBtn = view2.qa('button').find((b) => b.textContent?.includes('放弃本轮'))
    check('暂停态有「放弃本轮」', abandonBtn !== undefined)
    await act(async () => {
      abandonBtn!.click()
    })
    await act(async () => {
      await sleep(120)
    })
    check('放弃后回到 /review', view2.location.pathname === '/review', view2.location.pathname)
    check('库里会话为 ABANDONED', (await getSessionById(sid))!.status === 'ABANDONED')
  }

  /* ================================================================ */
  /* 场景 6 · 多标签页冲突提示（不宣称互斥）                          */
  /* ================================================================ */
  console.log('\n场景 6 · 多标签页冲突提示')
  await seed()
  {
    // 直接往库里塞两份 IN_PROGRESS 会话 —— 这就是存储层真实的冲突态
    await createSession({ mode: 'recent', count: 3, id: 'conflict-a', now: 1_700_000_000_000 })
    // 绕过 createSession 的活跃检查，手工造第二份（模拟另一标签页已写入）
    const a = (await getSessionById('conflict-a'))!
    await storage.table('spellingSessions').put({ ...a, id: 'conflict-b', started_at: a.started_at + 1000 })

    const view = await renderAt('/spelling?mode=recent')
    check('检测到冲突并提示', view.text().includes('检测到多个进行中的默写'))
    check('提示明确说不保证互斥', view.text().includes('不保证'))
    check('列出两份会话供选择', view.qa('li').length >= 2)
    check('不自动替用户裁决（没有直接进入练习）', view.q('#spelling-input') === null)

    // 列表按 started_at **倒序**（新的在前）→ [conflict-b, conflict-a]。
    // 故意选**较旧**的 conflict-a：这样才能真正走到
    // 「循环放弃更新的会话，直到选中的那个变成最新」这条路径
    // （选最新的会第一轮就 break，abandon 分支等于没测）。
    const listOrder = (await getActiveSessions()).map((s) => s.id)
    check('列表按开始时间倒序', listOrder.join(',') === 'conflict-b,conflict-a', listOrder.join(','))
    const older = view.qa('li button')[1]
    await act(async () => {
      older.click()
    })
    const keepBtn = view.qa('button').find((b) => b.textContent?.includes('保留选中的'))
    check('找到「保留选中的，放弃其余」', keepBtn !== undefined)
    await act(async () => {
      keepBtn!.click()
    })
    await act(async () => {
      await sleep(150)
    })
    check('裁决后进入练习', view.q('#spelling-input') !== null)
    check('保留下来的正是选中的那份', (await getSessionById('conflict-a'))!.status === 'IN_PROGRESS')
    check('另一份被放弃', (await getSessionById('conflict-b'))!.status === 'ABANDONED')
    check(
      'UI 恢复的就是选中的那份',
      window.sessionStorage.getItem('spelling:lastSessionId') === 'conflict-a',
      window.sessionStorage.getItem('spelling:lastSessionId') ?? '(空)',
    )
  }

  /* ================================================================ */
  /* 场景 7 · SRS 交接待重试状态（依据真实返回值，不显示"已同步"）     */
  /* ================================================================ */
  console.log('\n场景 7 · SRS 交接待重试状态')
  await seed()
  {
    const view = await renderAt('/spelling?mode=recent')
    const sid = (await getAllSessions())[0].id
    const s0 = (await getSessionById(sid))!
    const w = s0.queue[0].word

    // 让 recordQuiz 失败：打 storage 原型，只拦 vocab.get（recordQuiz 的第一步）
    const proto = Object.getPrototypeOf(storage.table('spellingSessions')) as unknown as {
      get: (this: { name: string }, k: unknown) => Promise<unknown>
    }
    const originalGet = proto.get
    let broken = false
    proto.get = async function (this: { name: string }, key: unknown) {
      if (broken && this.name === 'vocab') throw new Error('injected: recordQuiz 失败')
      return originalGet.call(this, key)
    }

    // V2 完整拼对 3 次：第 3 次达标 COMPLETED 触发交接，交接失败
    await typeWord(view, w)
    await typeWord(view, w)
    broken = true
    await typeWord(view, w)
    broken = false
    proto.get = originalGet

    check('交接失败时提示待重试', view.text().includes('还没写进去'))
    check('不显示任何"已同步"类不实状态', !view.text().includes('已同步'))
    {
      const s = (await getSessionById(sid))!
      const word0 = s.queue[0]
      check('词条仍为 COMPLETED', word0.status === 'COMPLETED')
      check('srs_reported 仍为 false（待重试）', word0.srs_reported === false)
      const logs = (await storage.table('reviewLog').toArray()).filter(
        (l) => l.word_id === word0.word_id && l.quiz_form === 'spelling',
      )
      check('没有伪造 SRS 记录', logs.length === 0, `实际 ${logs.length}`)
    }

    // 恢复入口自动补交
    await refresh()
    const view2 = await renderAt('/spelling?mode=recent')
    await act(async () => {
      await sleep(150)
    })
    {
      const s = (await getSessionById(sid))!
      check('重新进入页面后补交成功', s.queue[0].srs_reported === true)
      const logs = (await storage.table('reviewLog').toArray()).filter(
        (l) => l.word_id === s.queue[0].word_id && l.quiz_form === 'spelling',
      )
      check('补交后恰好 1 条 spelling 记录', logs.length === 1, `实际 ${logs.length}`)
    }
    check('补交成功后待重试提示消失', !view2.text().includes('还没写进去'))
  }

  /* ================================================================ */
  /* 场景 8 · V2 快速连打 + 同一 request_id 重放不重复计数            */
  /* ================================================================ */
  console.log('\n场景 8 · 逐字母快速连打与幂等重放不重复计数')
  await seed()
  {
    const view = await renderAt('/spelling?mode=recent')
    const sid = (await getAllSessions())[0].id
    const s0 = (await getSessionById(sid))!
    const w = s0.queue[0].word

    // 一次性把整词所有字母连打进队列（不等上一次写入返回）——
    // 页面的串行队列应完整消费，恰好拼完 1 次整词 = 1 次完整答题提交
    await typeWord(view, w)
    {
      const s = (await getSessionById(sid))!
      const word0 = s.queue[0]
      check('快速连打整词只计 1 次完整提交', word0.total_attempts === 1, `实际 ${word0.total_attempts}`)
      check('快速连打连续正确只 +1', word0.consecutive_correct === 1, `实际 ${word0.consecutive_correct}`)
      check('快速连打不产生错词事件', (await storage.table('spellingErrorEvents').toArray()).length === 0)
      check('队列没有重复推进', s.current_position === 0)
      check('拼完后输入进度归零', (word0.typed_prefix ?? '') === '')
      check('processed_letters 恰好为单词长度', Object.keys(s.processed_letters ?? {}).length === w.length,
        `实际 ${Object.keys(s.processed_letters ?? {}).length}`)
    }

    // 领域层幂等：同一 request_id 重放同一错误字母，不重复落事件、不重复计数
    const { submitLetter } = await import('../src/domain/spellingSession')
    const before = (await storage.table('spellingErrorEvents').toArray()).length
    const bad = w[0].toLowerCase() === 'z' ? 'q' : 'z'
    await submitLetter({ word_id: s0.queue[0].word_id, char: bad, request_id: 'ui-replay-key' })
    await submitLetter({ word_id: s0.queue[0].word_id, char: bad, request_id: 'ui-replay-key' })
    await submitLetter({ word_id: s0.queue[0].word_id, char: bad, request_id: 'ui-replay-key' })
    const after = (await storage.table('spellingErrorEvents').toArray()).length
    check('同一 request_id 重放 3 次只落 1 条事件', after - before === 1, `实际 ${after - before}`)
    {
      const s = (await getSessionById(sid))!
      check('重放不增加完整答题提交次数', s.queue[0].total_attempts === 1,
        `实际 ${s.queue[0].total_attempts}`)
      check('重放后连续正确归零', s.queue[0].consecutive_correct === 0)
    }
  }

  /* ================================================================ */
  /* 场景 9 · 结果页读取持久化数据 + 刷新可复现 + 空会话兜底           */
  /* ================================================================ */
  console.log('\n场景 9 · 结果页')
  await seed()
  {
    // 造一份已完成的会话：1 完成 / 1 跳过 / 1 失效
    const sid = 'result-sess'
    await createSession({ mode: 'recent', count: 3, id: sid })
    const base = (await getSessionById(sid))!
    await storage.table('spellingSessions').put({
      ...base,
      status: 'SESSION_COMPLETED',
      ended_at: base.started_at + 90_000,
      queue: base.queue.map((w, i) => {
        if (i === 0) {
          return { ...w, status: 'COMPLETED', consecutive_correct: 3, total_attempts: 4, correct_attempts: 3, wrong_attempts: 1, srs_reported: true }
        }
        if (i === 1) return { ...w, status: 'SKIPPED', total_attempts: 0 }
        return { ...w, status: 'UNAVAILABLE', unavailable_reason: 'vocab-entry-deleted', total_attempts: 0 }
      }),
    })

    const view = await renderAt(`/spelling-result?id=${sid}`)
    const t = view.text()
    check('结果页渲染完成数', t.includes('完成'))
    check('展示逐词明细（3 行）', view.qa('.divide-y > div').length >= 3)
    check('明细含失效词条的原因', t.includes('词条已删除'))
    check('展示正确率（4 次提交 3 对 = 75%）', t.includes('75%'))
    check('展示用时', t.includes('分') || t.includes('秒'))

    // 刷新后仍读到同一份
    await refresh()
    const view2 = await renderAt(`/spelling-result?id=${sid}`)
    check('刷新后结果一致', view2.text().includes('75%'))

    // 不存在的会话 → 合理返回入口，不伪造
    const view3 = await renderAt('/spelling-result?id=does-not-exist')
    check('会话不存在时给出提示', view3.text().includes('找不到这次默写的记录'))
    check('提供返回入口', view3.qa('button').some((b) => b.textContent?.includes('返回复习')))

    // 缺 id 参数
    const view4 = await renderAt('/spelling-result')
    check('缺少 id 也不伪造结果', view4.text().includes('找不到这次默写的记录'))
  }

  /* ================================================================ */
  /* 场景 10 · 空池走 EmptyState                                      */
  /* ================================================================ */
  console.log('\n场景 10 · 空池空态')
  await storage.clearAll()
  window.sessionStorage.clear()
  {
    const view = await renderAt('/spelling?mode=recent')
    check('没有可默写词时走空态', view.text().includes('生词本里还没有可默写的词'))
    check('空态不出现输入框', view.q('#spelling-input') === null)
    check('没有落一份空会话占位', (await getAllSessions()).length === 0)
  }

  await refresh()

  console.log(`\n${'─'.repeat(56)}`)
  if (failed === 0) {
    console.log(`✅ 单词默写前端验收全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ 单词默写前端验收失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
  console.log('未覆盖声明：jsdom 无布局引擎——重叠/溢出/遮挡/视口自适应未经渲染验证；')
  console.log('导航以「URL 变化 + 目标组件出现」验证，未 mock navigate。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
