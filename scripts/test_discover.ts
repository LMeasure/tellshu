/**
 * 书籍检索 client + 域层单测（M4 之后接入）
 * ------------------------------------------------------------------
 * 验证点：
 *   1. client 默认基址拼接 /api/discover，snake_case 逐字透传
 *   2. client 200 非 JSON（SPA 回退误接）→ 明确报错，null 不流进上层
 *   3. client 4xx/5xx → ApiRequestError 带 status
 *   4. 域层空 query 本地拦截，不发请求
 *   5. 域层成功映射（camelCase + e2eMs）；合法 book_id '7' 仍可入架
 *   6. 域层契约校验：meta.returned 不符 / 缺 title / 缺或空白 book_id → bad_response
 *   7. 域层重试口径：5xx 共 3 次尝试后 server_error；503/400 不重试
 *   8. 域层超时与外部取消映射为 timeout
 * 运行：npx tsx scripts/test_discover.ts
 */
import {
  searchBooks as requestSearchBooks,
  DISCOVER_API_BASE,
} from '../src/data/discoverClient'
import { ApiRequestError } from '../src/data/asrClient'
import {
  searchBooks,
  BookSearchError,
  DISCOVER_SOURCE_SITE,
  isShelfableBookId,
} from '../src/domain/discover/search'

type MockRes = { ok: boolean; status: number; body: unknown }

let calls: { url: string; body: unknown }[] = []
let responder: () => Promise<MockRes> = async () => ({
  ok: true,
  status: 200,
  body: {},
})

const realFetch = globalThis.fetch
const realError = console.error
const realWarn = console.warn
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    realError('  ✗', msg)
    failed++
  }
}

function resetScenario() {
  calls = []
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : String(input)
  let body: unknown = null
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = null
    }
  }
  calls.push({ url, body })
  const r = await responder()
  return {
    ok: r.ok,
    status: r.status,
    text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
  } as unknown as Response
}) as typeof fetch

/** 合法检索响应夹具（字段逐字对照 api/main.py 契约） */
function okBody() {
  return {
    results: [
      {
        chunk_id: 101,
        book_id: '7',
        title: 'Crime and Punishment',
        author: 'Fyodor Dostoyevsky',
        chapter_title: 'PART I',
        chunk_index: 12,
        content: 'Raskolnikov continued to sit...',
        score: 0.587612,
      },
    ],
    latency: { encode_ms: 19.31, retrieve_ms: 8.61, e2e_ms: 27.86 },
    meta: {
      top_k: 10,
      returned: 1,
      ef_search: '800',
      iterative_scan: 'strict_order',
      include_front_matter: false,
      explain_sampled: false,
      sampled_plan_type: null,
    },
  }
}

async function expectThrows(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

async function main() {
  console.error = () => undefined // 静音预期的失败日志
  console.warn = () => undefined

  // ---- 1. 基址拼接 ----
  resetScenario()
  responder = async () => ({ ok: true, status: 200, body: okBody() })
  await requestSearchBooks('为爱复仇的贵族青年')
  assert(
    calls[0].url === `${DISCOVER_API_BASE.replace(/\/+$/, '')}/discover`,
    `默认基址拼接 /discover（实际 ${calls[0].url}）`,
  )
  assert(
    JSON.stringify(calls[0].body) ===
      JSON.stringify({ query: '为爱复仇的贵族青年', top_k: 10 }),
    '请求体含 query 与 top_k=10',
  )

  // ---- 2. snake_case 逐字透传 ----
  const body = await requestSearchBooks('test')
  assert(
    body.results[0].chunk_id === 101 && body.results[0].chapter_title === 'PART I',
    '响应 snake_case 字段逐字透传（client 不改写）',
  )

  // ---- 3. 200 非 JSON → 明确报错 ----
  resetScenario()
  responder = async () => ({ ok: true, status: 200, body: '<!doctype html>' })
  const htmlErr = await expectThrows(() => requestSearchBooks('x'))
  assert(
    htmlErr instanceof ApiRequestError &&
      (htmlErr as Error).message.includes('不是 JSON'),
    '200 + HTML（SPA 回退误接）→ 明确报错而非 null 进上层',
  )

  // ---- 4. 域层：空 query 不发请求 ----
  resetScenario()
  responder = async () => ({ ok: true, status: 200, body: okBody() })
  const emptyErr = await expectThrows(() => searchBooks('   '))
  assert(
    emptyErr instanceof BookSearchError && (emptyErr as BookSearchError).kind === 'empty_query',
    '空白 query → empty_query',
  )
  assert(calls.length === 0, `空 query 不发请求（实际 ${calls.length} 次）`)

  // ---- 5. 域层：成功映射 ----
  resetScenario()
  responder = async () => ({ ok: true, status: 200, body: okBody() })
  const outcome = await searchBooks('拉斯柯尔尼科夫')
  assert(outcome.hits.length === 1 && outcome.hits[0].title === 'Crime and Punishment',
    '成功映射为 BookHit（title）')
  assert(outcome.hits[0].chapterTitle === 'PART I' && outcome.hits[0].chunkIndex === 12,
    'snake_case → camelCase 映射（chapterTitle / chunkIndex）')
  assert(outcome.hits[0].bookId === '7', "bookId 映射自 book_id（okBody 夹具 book_id:'7'）")
  assert(
    isShelfableBookId(outcome.hits[0].bookId) &&
      `discovered:${DISCOVER_SOURCE_SITE}:${outcome.hits[0].bookId}` === 'discovered:gutenberg:7',
    "合法 book_id '7' 仍可入架（稳定主键 discovered:gutenberg:7）",
  )
  assert(outcome.hits[0].chunkId === 101, 'chunkId 映射自 chunk_id')
  assert(outcome.e2eMs === 27.86, 'e2eMs 取自 latency.e2e_ms')

  // ---- 6. 域层：契约校验 ----
  resetScenario()
  responder = async () => {
    const b = okBody()
    b.meta.returned = 99
    return { ok: true, status: 200, body: b }
  }
  const badMeta = await expectThrows(() => searchBooks('x'))
  assert(
    badMeta instanceof BookSearchError && (badMeta as BookSearchError).kind === 'bad_response',
    'meta.returned 与结果条数不符 → bad_response',
  )
  resetScenario()
  responder = async () => {
    const b = okBody() as { results: Array<Record<string, unknown>> }
    delete b.results[0].title
    return { ok: true, status: 200, body: b }
  }
  const badItem = await expectThrows(() => searchBooks('x'))
  assert(
    badItem instanceof BookSearchError && (badItem as BookSearchError).kind === 'bad_response',
    '结果项缺 title → bad_response',
  )

  // book_id：缺省 / null / 空串 / 纯空白都是 bad_response，不映射、不重试。
  // 这些值不得进入 toBookHit，因此也不会被拼成 discovered:gutenberg:undefined。
  async function assertBadBookId(bookId: unknown, label: string) {
    resetScenario()
    responder = async () => {
      const b = okBody() as { results: Array<Record<string, unknown>> }
      b.results[0].book_id = bookId
      return { ok: true, status: 200, body: b }
    }
    const err = await expectThrows(() => searchBooks('x'))
    assert(
      err instanceof BookSearchError && (err as BookSearchError).kind === 'bad_response',
      `${label} → bad_response`,
    )
    assert(calls.length === 1, `${label} 不重试、不进入映射（实际 ${calls.length} 次）`)
  }
  await assertBadBookId(undefined, '结果项缺少 book_id')
  await assertBadBookId(null, '结果项 book_id 为 null')
  await assertBadBookId('', '结果项 book_id 为空串')
  await assertBadBookId('   ', '结果项 book_id 为纯空白')
  await assertBadBookId('\t\n', '结果项 book_id 为空白字符')

  resetScenario()
  responder = async () => {
    const b = okBody() as {
      results: Array<Record<string, unknown>>
      meta: { returned: number }
    }
    b.results.push({ ...b.results[0], book_id: '' })
    b.meta.returned = b.results.length
    return { ok: true, status: 200, body: b }
  }
  const mixed = await expectThrows(() => searchBooks('x'))
  assert(
    mixed instanceof BookSearchError && (mixed as BookSearchError).kind === 'bad_response',
    '混有空 book_id 时整包 bad_response，不返回半截命中',
  )

  assert(isShelfableBookId(undefined) === false, 'undefined book_id 不可入架')
  assert(isShelfableBookId(null) === false, 'null book_id 不可入架')
  assert(isShelfableBookId('') === false, '空串 book_id 不可入架')
  assert(isShelfableBookId('   ') === false, '纯空白 book_id 不可入架')
  assert(isShelfableBookId(7) === false, '非字符串 book_id 不可入架')
  assert(isShelfableBookId('7') === true, "合法 book_id '7' 通过入架闸门")

  // ---- 7. 域层：重试口径 ----
  resetScenario()
  responder = async () => ({ ok: false, status: 500, body: { error: { message: 'boom' } } })
  const serverErr = await expectThrows(() => searchBooks('x'))
  assert(calls.length === 3, `5xx 共 3 次尝试（实际 ${calls.length}）`)
  assert(
    serverErr instanceof BookSearchError && (serverErr as BookSearchError).kind === 'server_error',
    '5xx 重试后仍失败 → server_error',
  )

  resetScenario()
  responder = async () => ({
    ok: false,
    status: 503,
    body: { error: { code: 'service_unavailable', message: '服务尚未就绪' } },
  })
  const unavail = await expectThrows(() => searchBooks('x'))
  assert(calls.length === 1, `503 不重试，只发 1 次（实际 ${calls.length}）`)
  assert(
    unavail instanceof BookSearchError && (unavail as BookSearchError).kind === 'unavailable',
    '503 → unavailable（服务未启动引导）',
  )

  resetScenario()
  responder = async () => ({
    ok: false,
    status: 400,
    body: { error: { code: 'bad_request', message: 'query 过长' } },
  })
  const badReq = await expectThrows(() => searchBooks('x'))
  assert(calls.length === 1, `400 不重试，只发 1 次（实际 ${calls.length}）`)
  assert(
    badReq instanceof BookSearchError && (badReq as BookSearchError).kind === 'bad_request',
    '400 → bad_request',
  )

  // ---- 8. 域层：超时与外部取消 ----
  resetScenario()
  responder = async () => {
    throw new DOMException('aborted', 'AbortError')
  }
  const timeoutErr = await expectThrows(() => searchBooks('x'))
  assert(
    timeoutErr instanceof BookSearchError && (timeoutErr as BookSearchError).kind === 'timeout',
    'AbortError（超时）→ timeout',
  )
  assert(calls.length === 3, `超时按 status 0 重试口径共 3 次尝试（实际 ${calls.length}）`)

  resetScenario()
  responder = async () => {
    throw new DOMException('aborted', 'AbortError')
  }
  const controller = new AbortController()
  controller.abort()
  const cancelErr = await expectThrows(() => searchBooks('x', { signal: controller.signal }))
  assert(
    cancelErr instanceof BookSearchError &&
      (cancelErr as BookSearchError).kind === 'timeout' &&
      (cancelErr as Error).message === '已取消本次检索',
    '外部 signal 已 aborted → 直接取消，不进重试',
  )

  globalThis.fetch = realFetch
  console.error = realError
  console.warn = realWarn

  console.log('')
  if (failed > 0) {
    console.error(`✗ test_discover 失败 ${failed} 项`)
    process.exit(1)
  }
  console.log('✓ test_discover 全部通过')
}

void main()
