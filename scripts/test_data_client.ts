/**
 * dataClient 单测（P0 数据外置）
 * ------------------------------------------------------------------
 * 验证点：
 *   1. 基址解析优先级：运行期覆盖 > 构建期 env > 同源回退，且末尾补 `/`
 *   2. 相对路径拼接 + 目录穿越拒绝
 *   3. 成功才入缓存（失败不能被永久缓存，否则网络抖动后刷新前再也拿不到数据）
 *   4. 404/403 不重试；5xx 才重试
 *   5. LRU 有界，不会无限增长
 * 运行：npx tsx scripts/test_data_client.ts
 */
import {
  clearDataCache,
  dataBaseUrl,
  dataCacheSize,
  dataUrl,
  fetchData,
  resetDataBaseUrl,
  DATA_VERSION,
} from '../src/data/dataClient'

type MockRes = { ok: boolean; status: number; body: unknown }
let calls: string[] = []
let responder: (url: string) => MockRes = () => ({ ok: true, status: 200, body: {} })

const realError = console.error
const realWarn = console.warn
let failed = 0

/** 用原始 console.error 打印失败——静音期间也不能吞掉断言结果。 */
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    realError('  ✗', msg)
    failed++
  }
}

/** 每个子场景开始时调用：清缓存 + 清请求计数。 */
function resetScenario() {
  clearDataCache()
  calls = []
}

let consoleMuted = false

function muteConsole() {
  if (consoleMuted) return
  consoleMuted = true
  console.error = () => undefined
  console.warn = () => undefined
}
function unmuteConsole() {
  if (!consoleMuted) return
  consoleMuted = false
  console.error = realError
  console.warn = realWarn
}

const realFetch = globalThis.fetch
function installMock() {
  calls = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const r = responder(url)
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response
  }) as unknown as typeof fetch
}
function restoreFetch() {
  globalThis.fetch = realFetch
}

async function main() {
  console.log('[dataClient] 基址解析')
  resetDataBaseUrl()
  const sameOrigin = dataBaseUrl()
  assert(sameOrigin === `/data/linguabase/${DATA_VERSION}/`, `默认同源回退（实际 ${sameOrigin}）`)

  // 运行期覆盖：末尾缺 / 时自动补上
  ;(globalThis as unknown as { __SHUSHU_DATA_BASE__?: string }).__SHUSHU_DATA_BASE__ =
    'https://data.shushu.app/linguabase/v1'
  resetDataBaseUrl()
  const overridden = dataBaseUrl()
  assert(
    overridden === 'https://data.shushu.app/linguabase/v1/',
    `运行期覆盖并补尾斜杠（实际 ${overridden}）`,
  )
  assert(
    dataUrl('bank/L1.json') === 'https://data.shushu.app/linguabase/v1/bank/L1.json',
    '相对路径拼到外部存储（实际 ' + dataUrl('bank/L1.json') + '）',
  )
  delete (globalThis as unknown as { __SHUSHU_DATA_BASE__?: string }).__SHUSHU_DATA_BASE__
  resetDataBaseUrl()

  console.log('[dataClient] 路径拼接与安全防护')
  assert(
    DATA_VERSION === 'v1',
    `默认数据版本为 v1（实际 ${DATA_VERSION}）—— 版本写进路径，可灰度可回滚`,
  )
  assert(
    dataUrl('index.json') === `/data/linguabase/${DATA_VERSION}/index.json`,
    `普通相对路径带版本号（实际 ${dataUrl('index.json')}）`,
  )
  assert(
    dataUrl('/defs/bank_L1.json') === `/data/linguabase/${DATA_VERSION}/defs/bank_L1.json`,
    '前导 / 会被去掉，不产生双斜杠',
  )
  let threw = false
  try {
    dataUrl('../../package.json')
  } catch {
    threw = true
  }
  assert(threw, '含 .. 的路径直接抛错（防目录穿越）')

  console.log('[dataClient] 缓存与重试')
  installMock()
  muteConsole()

  // 成功 → 只请求一次，第二次命中缓存
  resetScenario()
  responder = () => ({ ok: true, status: 200, body: [1, 2, 3] })
  const a1 = await fetchData<number[]>('bank/L1.json', [])
  const a2 = await fetchData<number[]>('bank/L1.json', [])
  assert(a1.length === 3 && a2.length === 3, '成功返回真实数据')
  assert(calls.length === 1, `成功结果被复用，只发 1 次请求（实际 ${calls.length}）`)

  // 404 → 返回 fallback，且不入缓存（下次会重试）
  resetScenario()
  responder = () => ({ ok: false, status: 404, body: null })
  const b1 = await fetchData<string[]>('defs/nope.json', [])
  assert(b1.length === 0, '404 返回 fallback（空数组，不编造）')
  assert(calls.length === 1, `404 不重试，只发 1 次（实际 ${calls.length}）`)
  const b2 = await fetchData<string[]>('defs/nope.json', [])
  assert(b2.length === 0 && calls.length === 2, '失败结果不入缓存，下次会重新尝试')

  // 500 → 重试 1 次（共 2 次）后返回 fallback
  resetScenario()
  responder = () => ({ ok: false, status: 500, body: null })
  const c1 = await fetchData<string[]>('bank/L2.json', [])
  assert(c1.length === 0, '5xx 重试耗尽后返回 fallback')
  assert(calls.length === 2, `5xx 共发 2 次（首试 + 1 次重试，实际 ${calls.length}）`)

  console.log('[dataClient] LRU 有界')
  resetScenario()
  responder = (url) => ({ ok: true, status: 200, body: { url } })
  for (let i = 0; i < 60; i += 1) {
    await fetchData<unknown>(`themes/t${i}.json`, null)
  }
  assert(
    dataCacheSize() <= 48,
    `缓存条目被限制在上限内（实际 ${dataCacheSize()} ≤ 48）`,
  )
  assert(dataCacheSize() === 48, `连续 60 次请求后缓存为 48（实际 ${dataCacheSize()}）`)

  unmuteConsole()
  restoreFetch()

  console.log('')
  if (failed) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('dataClient 单测全部通过 ✓')
}

main().catch((e) => {
  unmuteConsole()
  restoreFetch()
  console.error(e)
  process.exit(1)
})
