/**
 * 学习稿生成单测（Phase 2 M2）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. validateStudyNotePayload：四要素收敛、坏项丢弃、缺 pos 回退空串、
 *      重复词去重、全空判败、仅有词汇也算通过、中文素材形态（中英双译）
 *   2. matchVocabularyContext：命中记 context/segment_start、未命中不硬造、
 *      已有值不动、大小写不敏感
 *   3. generateAndSaveStudyNote（fetch 打桩 SSE）：
 *      delta+done 全链路落库 / SSE error 透传 / 503 未接入 /
 *      done 非法 payload / 流无 done 事件 / 二次生成同 id 覆盖
 * 运行：npx tsx scripts/test_study_note_generate.ts
 * 注意：Node 无 IndexedDB，storage 自动选内存驱动；import.meta.env 为
 * undefined（llmClient 已用可选链，基址回落 /api）。
 */

import { storage } from '@/services/storage'
import {
  generateAndSaveStudyNote,
  matchVocabularyContext,
  validateStudyNotePayload,
} from '@/domain/studyNote/generate'
import { getStudyNoteByTranscriptId } from '@/domain/transcript/store'
import type { Transcript } from '@/domain/transcript/types'

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

const TRANSCRIPT: Transcript = {
  id: 'job-sn-1',
  language: 'en',
  duration: 6,
  segments: [
    { start: 0, end: 1.5, text: 'Hello there' },
    { start: 1.5, end: 3.25, text: 'general Kenobi' },
    { start: 3.25, end: 6, text: 'You are a bold one' },
  ],
}

const NOTE = {
  summary: '两个角色互相致意。',
  bilingual_notes: [
    { en: 'Hello there', zh: '你好。' },
    { en: 'general Kenobi', zh: '肯诺比将军。' },
  ],
  key_points: ['There 用于引起注意'],
  vocabulary: [
    { word: 'bold', pos: 'adjective', gloss: '大胆的' },
    { word: 'reluctant', pos: 'adjective', gloss: '不情愿的' },
  ],
}

/* ------------------------------------------------------------------ */
/* fetch 打桩（SSE 流）                                               */
/* ------------------------------------------------------------------ */

const realFetch = globalThis.fetch

/** 服务端 SSE 协议事件（routes/ai.ts）：delta 逐字 / done 完成。 */
function sseDelta(text: string): string {
  return `data: ${JSON.stringify({ type: 'delta', text })}\n\n`
}

function sseDone(note: unknown): string {
  return `data: ${JSON.stringify({ type: 'done', note })}\n\n`
}

function okSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return { ok: true, status: 200, body: stream } as unknown as Response
}

function errorJsonResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { code: 'service_unavailable', message } }),
  } as unknown as Response
}

function installOkStream(lines: string[]): void {
  globalThis.fetch = (async () => okSseResponse(lines)) as typeof fetch
}

function installErrorStatus(status: number, message: string): void {
  globalThis.fetch = (async () => errorJsonResponse(status, message)) as typeof fetch
}

function restoreFetch(): void {
  globalThis.fetch = realFetch
}

/** 完整 SSE：delta 两段 + done 事件（服务端协议）。 */
function noteSseLines(): string[] {
  return [sseDelta('{"summary":'), sseDelta('"两个角色互相致意。"}'), sseDone(NOTE)]
}

/* ------------------------------------------------------------------ */
/* 1. 契约校验                                                        */
/* ------------------------------------------------------------------ */

console.log('validateStudyNotePayload: 收敛与拒收')

function testValidate(): void {
  const good = validateStudyNotePayload(structuredClone(NOTE))
  assert(good !== null, '完整四要素通过')
  assert(JSON.stringify(good) === JSON.stringify(NOTE), '内容原样保留')

  const repaired = validateStudyNotePayload({
    summary: 's',
    bilingual_notes: [{ en: 'ok', zh: '好' }, { en: '缺译文' }],
    key_points: ['保留', 42],
    vocabulary: [
      { word: 'bold', gloss: '大胆的' },
      { word: 'BOLD', pos: 'adjective', gloss: '重复' },
      { word: '缺释义' },
    ],
  })
  assert(repaired !== null, '混合坏数据仍收敛')
  eq(repaired?.bilingual_notes.length, 1, '缺 zh 的双语条被丢弃')
  eq(repaired?.key_points.length, 1, '非字符串要点被丢弃')
  eq(repaired?.vocabulary.length, 1, '重复词去重、缺 gloss 丢弃')
  eq(repaired?.vocabulary[0].pos, '', '缺 pos 回退空串（词不丢）')

  assert(validateStudyNotePayload({}) === null, '空对象判败')
  assert(validateStudyNotePayload({ summary: '', bilingual_notes: [], key_points: [], vocabulary: [] }) === null, '四要素全空判败')
  const partial = validateStudyNotePayload({ vocabulary: [{ word: 'x', pos: 'noun', gloss: '某' }] })
  assert(partial !== null && partial.summary === '', '仅有词汇也通过（summary 空串）')

  // 中文素材形态（决策 2026-10-22 中英双译）：en=英译、zh=中文原句、
  // vocabulary 恒空数组——契约与存储不变，方向由 prompt 决定
  const ZH_NOTE = {
    summary: '一段中文欢迎词。',
    bilingual_notes: [{ en: 'Hello, welcome to ShuTree.', zh: '你好，欢迎来到述树。' }],
    key_points: ['欢迎语的使用场景'],
    vocabulary: [],
  }
  const zhParsed = validateStudyNotePayload(structuredClone(ZH_NOTE))
  assert(
    zhParsed !== null && JSON.stringify(zhParsed) === JSON.stringify(ZH_NOTE),
    '中文素材形态（en 英译/zh 原句/词汇空数组）原样通过',
  )
}

/* ------------------------------------------------------------------ */
/* 2. 语境回匹                                                        */
/* ------------------------------------------------------------------ */

console.log('matchVocabularyContext: 命中 / 未命中 / 不覆盖已有值')

function testMatch(): void {
  const vocab = NOTE.vocabulary
  const matched = matchVocabularyContext(vocab, TRANSCRIPT.segments)
  eq(matched[0].context, 'You are a bold one', 'bold 命中第 3 段原句')
  eq(matched[0].segment_start, 3.25, 'bold 记段起点秒')
  assert(matched[1].context === undefined && matched[1].segment_start === undefined, 'reluctant 未命中：不硬造')

  const preset = matchVocabularyContext(
    [{ word: 'hello', pos: 'noun', gloss: '已有值', context: '自定义', segment_start: 99 }],
    TRANSCRIPT.segments,
  )
  eq(preset[0].segment_start, 99, '已有 segment_start 不被覆盖')

  const cased = matchVocabularyContext([{ word: 'KENOBI', pos: 'noun', gloss: '将军' }], TRANSCRIPT.segments)
  eq(cased[0].segment_start, 1.5, '大小写不敏感命中')
}

/* ------------------------------------------------------------------ */
/* 3. 生成编排（fetch 打桩）                                          */
/* ------------------------------------------------------------------ */

console.log('generateAndSaveStudyNote: SSE 全链路与失败分类')

async function testGenerateHappy(): Promise<void> {
  installOkStream(noteSseLines())
  const seen: number[] = []
  const record = await generateAndSaveStudyNote(TRANSCRIPT, {
    onDelta: (full) => seen.push(full.length),
  })
  restoreFetch()
  eq(record.status, 'ready', '落库 status=ready')
  eq(record.summary, NOTE.summary, 'summary 落库')
  eq(record.bilingual_notes.length, 2, 'bilingual_notes 结构化数组落库')
  eq(record.vocabulary[0].segment_start, 3.25, 'vocabulary 回匹后落库')
  assert(seen.length >= 1 && seen[0] < seen[seen.length - 1], 'onDelta 累加递增')

  const stored = await getStudyNoteByTranscriptId('job-sn-1')
  eq(stored?.id, record.id, '按 transcript_id 可读回')
}

async function testGenerateIdempotent(): Promise<void> {
  installOkStream(noteSseLines())
  const again = await generateAndSaveStudyNote(TRANSCRIPT)
  restoreFetch()
  const first = await getStudyNoteByTranscriptId('job-sn-1')
  eq(again.id, first?.id, '二次生成：同 id 原地重置（无孤儿）')
  eq(await storage.table('studyNotes').count(), 1, '覆盖后仍 1 行')
}

async function testGenerateSseError(): Promise<void> {
  installOkStream([
    sseDelta('半截'),
    `data: ${JSON.stringify({ type: 'error', code: 'timeout_first_token', message: '首 token 超时' })}\n\n`,
  ])
  let code = ''
  let message = ''
  try {
    await generateAndSaveStudyNote(TRANSCRIPT)
  } catch (e) {
    code = (e as { code?: string }).code ?? ''
    message = (e as Error).message
  }
  restoreFetch()
  eq(code, 'timeout_first_token', 'SSE error：code 透传（timeout_first_token）')
  eq(message, '首 token 超时', 'SSE error：message 透传')
}

async function testGenerateNotConfigured(): Promise<void> {
  installErrorStatus(503, 'AI 学习稿生成服务未接入：请配置 AI_BASE_URL / AI_API_KEY / AI_MODEL')
  let status = 0
  let message = ''
  try {
    await generateAndSaveStudyNote(TRANSCRIPT)
  } catch (e) {
    status = (e as { status?: number }).status ?? 0
    message = (e as Error).message
  }
  restoreFetch()
  eq(status, 503, '503 未接入：HTTP status 透出（UI 走空态引导）')
  assert(message.includes('未接入'), '503 文案含「未接入」')
}

async function testGenerateInvalidPayload(): Promise<void> {
  // done 事件的 note 是裸字符串：契约校验拒收（服务端已 parse，这里是纵深防御）
  installOkStream([sseDelta('这不是 JSON'), sseDone('这不是 JSON')])
  let code = ''
  try {
    await generateAndSaveStudyNote(TRANSCRIPT)
  } catch (e) {
    code = (e as { code?: string }).code ?? ''
  }
  restoreFetch()
  eq(code, 'invalid_payload', 'done 内容非合法契约：invalid_payload')
}

async function testGenerateIncompleteStream(): Promise<void> {
  // 只给 delta 不给 done（服务端异常断开）
  installOkStream([sseDelta('半截')])
  let code = ''
  try {
    await generateAndSaveStudyNote(TRANSCRIPT)
  } catch (e) {
    code = (e as { code?: string }).code ?? ''
  }
  restoreFetch()
  eq(code, 'incomplete_stream', '流关闭无 done：incomplete_stream')
}

async function main(): Promise<void> {
  await storage.clearAll()
  testValidate()
  testMatch()
  await testGenerateHappy()
  await testGenerateIdempotent()
  await testGenerateSseError()
  await testGenerateNotConfigured()
  await testGenerateInvalidPayload()
  await testGenerateIncompleteStream()
  restoreFetch()

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('study note generate 单测全部通过 ✓')
}

main().catch((e) => {
  restoreFetch()
  console.error(e)
  process.exit(1)
})
