/**
 * 音视频转字幕单测（Phase 1）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. subtitle 转换：时间码（舍入 / 跨小时 / 边界）+ TXT/SRT/VTT 结构
 *   2. validate：扩展名白名单（大小写）、体积边界（100MB 含等于）
 *   3. transcribe 编排：成功链路 / 提交即败 / 轮询失败 / 503 透出 /
 *      404 / 非 JSON 响应 / 轮询耗尽（fetch 打桩，intervalMs=0 不真睡）
 * 运行：npx tsx scripts/test_transcript.ts
 */
import { formatTimecode, toSrt, toTxt, toVtt } from '../src/domain/transcript/subtitle'
import { MAX_MEDIA_BYTES, validateMediaFile } from '../src/domain/transcript/validate'
import { transcribeMedia } from '../src/domain/transcript/transcribe'
import { ApiRequestError } from '../src/data/asrClient'
import type { AsrJobResponse, AsrSubmitResponse } from '../src/domain/transcript/types'

let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed++
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  assert(actual === expected, `${msg}（实际 ${String(actual)}，期望 ${String(expected)}）`)
}

/* ------------------------------------------------------------------ */
/* 1. subtitle 转换                                                     */
/* ------------------------------------------------------------------ */

console.log('subtitle: formatTimecode')
eq(formatTimecode(0, ','), '00:00:00,000', '0 秒')
eq(formatTimecode(1.5, ','), '00:00:01,500', '1.5 秒 -> 1,500 毫秒')
eq(formatTimecode(61.25, '.'), '00:01:01.250', '61.25 秒进位到分')
eq(formatTimecode(3661.5, ','), '01:01:01,500', '3661.5 秒跨小时进位')
eq(formatTimecode(3599.999, ','), '00:59:59,999', '3599.999 毫秒舍入到 999')
eq(formatTimecode(0.0005, ','), '00:00:00,001', '0.5 毫秒按 Math.round 进 1')
eq(formatTimecode(7200, ','), '02:00:00,000', '整两小时')
eq(formatTimecode(-5, ','), '00:00:00,000', '负数按 0 处理（不抛错）')
eq(formatTimecode(Number.NaN, ','), '00:00:00,000', 'NaN 按 0 处理（不抛错）')

console.log('subtitle: toTxt / toSrt / toVtt')
const segs = [
  { start: 0, end: 1.5, text: 'Hello' },
  { start: 1.5, end: 3.25, text: '  world  ' },
]
eq(toTxt(segs), 'Hello\nworld', 'TXT 每段一行且 Trim')
eq(toTxt([]), '', 'TXT 空输入为空串')
eq(
  toTxt([{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: '   ' }]),
  'a',
  'TXT 跳过空文本段',
)
eq(
  toSrt(segs),
  '1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:01,500 --> 00:00:03,250\nworld\n',
  'SRT 序号/时间线/文本/空行结构',
)
eq(toSrt([]), '', 'SRT 空输入为空串')
eq(toVtt(segs), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n\n00:00:01.500 --> 00:00:03.250\nworld\n', 'VTT 带头与点号时间码')
eq(toVtt([]), 'WEBVTT\n', 'VTT 空输入只保留头')

/* ------------------------------------------------------------------ */
/* 2. validate                                                         */
/* ------------------------------------------------------------------ */

console.log('validate: validateMediaFile')
eq(validateMediaFile('a.mp3', 1024).ok, true, 'mp3 通过')
eq(validateMediaFile('A.MP4', 1024).ok, true, '大写扩展名通过')
eq(validateMediaFile('a.mov', 1024).ok, true, 'mov 通过')
eq(validateMediaFile('a.webm', 1024).ok, true, 'webm 通过')
eq(validateMediaFile('a.m4a', 1024).ok, true, 'm4a 通过')
eq(validateMediaFile('a.wav', 1024).ok, true, 'wav 通过')
eq(validateMediaFile('a.txt', 1024).ok, false, 'txt 拒绝')
eq(validateMediaFile('noextension', 1024).ok, false, '无扩展名拒绝')
eq(validateMediaFile('a.mp3', MAX_MEDIA_BYTES).ok, true, '恰好 100MB 通过（含等于）')
eq(validateMediaFile('a.mp3', MAX_MEDIA_BYTES + 1).ok, false, '100MB+1 拒绝')
eq(validateMediaFile('a.mp3', 0).ok, false, '空文件拒绝')

/* ------------------------------------------------------------------ */
/* 3. transcribe 编排（fetch 打桩）                                      */
/* ------------------------------------------------------------------ */

console.log('transcribe: 编排与错误映射')

type MockStep = { ok: boolean; status: number; body: unknown }

let steps: MockStep[] = []
let calls: string[] = []

const realFetch = globalThis.fetch
function installFetchStub(script: MockStep[]) {
  steps = [...script]
  calls = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const step = steps.shift()
    if (step === undefined) throw new Error(`fetch 被打断：没有更多桩响应（${url}）`)
    return {
      ok: step.ok,
      status: step.status,
      text: async () => (step.body === null ? '' : JSON.stringify(step.body)),
    } as unknown as Response
  }) as typeof fetch
}
function restoreFetch() {
  globalThis.fetch = realFetch
}

const submitOk: MockStep = { ok: true, status: 202, body: { jobId: 'job-1', status: 'queued', error: null } satisfies AsrSubmitResponse }
const pollQueued: MockStep = { ok: true, status: 200, body: { jobId: 'job-1', status: 'queued', transcript: null, error: null } satisfies AsrJobResponse }
const pollRunning: MockStep = { ok: true, status: 200, body: { jobId: 'job-1', status: 'running', transcript: null, error: null } satisfies AsrJobResponse }
const pollDone: MockStep = {
  ok: true,
  status: 200,
  body: {
    jobId: 'job-1',
    status: 'done',
    transcript: {
      language: 'en',
      duration: 12.5,
      segments: [
        { start: 0, end: 1.5, text: 'Hello' },
        { start: 1.5, end: 3.25, text: 'world' },
      ],
    },
    error: null,
  } satisfies AsrJobResponse,
}

async function main() {
  // 成功链路：提交 -> queued -> running -> done
  installFetchStub([submitOk, pollQueued, pollRunning, pollDone])
  const stages: string[] = []
  const transcript = await transcribeMedia(
    { file: new Blob(['x']), fileName: 'a.mp3', language: 'auto' },
    { onStage: (text, status) => stages.push(`${status}:${text}`) },
    { intervalMs: 0 },
  )
  eq(transcript.id, 'job-1', '成功链路：Transcript.id 取服务端 jobId')
  eq(transcript.language, 'en', '成功链路：语言透传')
  eq(transcript.duration, 12.5, '成功链路：时长透传')
  eq(transcript.segments.length, 2, '成功链路：段落数透传')
  eq(calls.length, 4, '成功链路：1 次提交 + 3 次轮询')
  assert(calls[0]?.endsWith('/asr/jobs'), '成功链路：提交打到 /asr/jobs')
  assert(calls[1]?.endsWith('/asr/jobs/job-1'), '成功链路：轮询打到 /asr/jobs/:id')
  eq(stages[0], 'submit:提交中…', '成功链路：阶段回调先报 submit')
  eq(stages[1], 'queued:排队中…', '成功链路：随后报 queued')
  eq(stages[3], 'done:转写完成', '成功链路：最后报 done')
  restoreFetch()

  // 提交即败
  installFetchStub([{ ok: true, status: 202, body: { jobId: 'job-2', status: 'failed', error: { code: 'submit_failed', message: '供应商拒绝了请求' } } }])
  try {
    await transcribeMedia({ file: new Blob(['x']), fileName: 'a.mp3' }, {}, { intervalMs: 0 })
    assert(false, '提交即败：应当抛错')
  } catch (e) {
    assert(e instanceof Error && e.message === '供应商拒绝了请求', '提交即败：原样透出服务端错误消息')
  }
  restoreFetch()

  // 轮询到 failed
  installFetchStub([submitOk, { ok: true, status: 200, body: { jobId: 'job-1', status: 'failed', transcript: null, error: { code: 'provider_failed', message: '识别超时' } } }])
  try {
    await transcribeMedia({ file: new Blob(['x']), fileName: 'a.mp3' }, {}, { intervalMs: 0 })
    assert(false, '轮询失败：应当抛错')
  } catch (e) {
    assert(e instanceof Error && e.message === '识别超时', '轮询失败：原样透出服务端错误消息')
  }
  restoreFetch()

  // 503 未接入：status 必须透出供 UI 显示空态
  installFetchStub([{ ok: false, status: 503, body: { error: { code: 'service_unavailable', message: '未配置 ASR 供应商，转录服务不可用' } } }])
  try {
    await transcribeMedia({ file: new Blob(['x']), fileName: 'a.mp3' }, {}, { intervalMs: 0 })
    assert(false, '503：应当抛错')
  } catch (e) {
    assert(e instanceof ApiRequestError && e.status === 503, '503：ApiRequestError.status === 503')
    assert(e instanceof Error && e.message === '未配置 ASR 供应商，转录服务不可用', '503：错误消息原样透出')
  }
  restoreFetch()

  // 404 任务不存在
  installFetchStub([submitOk, { ok: false, status: 404, body: { error: { code: 'not_found', message: '任务不存在或已过期' } } }])
  try {
    await transcribeMedia({ file: new Blob(['x']), fileName: 'a.mp3' }, {}, { intervalMs: 0 })
    assert(false, '404：应当抛错')
  } catch (e) {
    assert(e instanceof ApiRequestError && e.status === 404, '404：ApiRequestError.status === 404')
  }
  restoreFetch()

  // 200 但非 JSON（SPA 回退场景）
  installFetchStub([{ ok: true, status: 200, body: null }])
  try {
    await transcribeMedia({ file: new Blob(['x']), fileName: 'a.mp3' }, {}, { intervalMs: 0 })
    assert(false, '非 JSON：应当抛错')
  } catch (e) {
    assert(e instanceof Error && e.message.includes('响应不是 JSON'), '非 JSON：明确报错而不是把 null 流进上层')
  }
  restoreFetch()

  // 轮询耗尽
  installFetchStub([submitOk, pollQueued, pollQueued, pollQueued, pollQueued])
  try {
    await transcribeMedia({ file: new Blob(['x']), fileName: 'a.mp3' }, {}, { intervalMs: 0, maxTimes: 3 })
    assert(false, '轮询耗尽：应当抛错')
  } catch (e) {
    assert(e instanceof Error && e.message === '任务仍在服务端处理，请稍后重新提交（结果不保留）', '轮询耗尽：如实告知结果不保留')
  }
  restoreFetch()

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('transcript 单测全部通过 ✓')
}

main().catch((e) => {
  restoreFetch()
  console.error(e)
  process.exit(1)
})
