/**
 * 字幕 / 学习稿持久化单测（Phase 2 M1）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. transcripts：落库 / 同 job_id 幂等覆盖 / 查询 / source 索引
 *   2. studyNotes：upsert 新建 / 同 transcript_id 覆盖不追加 / patch / 删除
 *   3. transcribeAndSave：done 后自动落库（fetch 打桩，intervalMs=0 不真睡）
 * 运行：npx tsx scripts/test_transcript_store.ts
 * 注意：Node 无 IndexedDB，storage 自动选内存驱动（与线上 Dexie 行为对齐：
 *   put 覆盖、whereIndex 校验索引、add 自增口径一致）。
 */

import { storage } from '@/services/storage'
import {
  deleteStudyNote,
  getStudyNoteByTranscriptId,
  getTranscriptRecord,
  listTranscriptRecords,
  patchStudyNote,
  saveTranscriptRecord,
  upsertStudyNote,
} from '@/domain/transcript/store'
import { transcribeAndSave } from '@/domain/transcript/transcribe'
import type {
  AsrJobResponse,
  AsrSubmitResponse,
  StudyNoteVocabulary,
  Transcript,
} from '@/domain/transcript/types'

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
/* 1. transcripts                                                      */
/* ------------------------------------------------------------------ */

console.log('transcripts: save / 幂等覆盖 / 查询 / 索引')

const t1: Transcript = {
  id: 'job-1',
  language: 'en',
  duration: 12.5,
  segments: [
    { start: 0, end: 1.5, text: 'Hello' },
    { start: 1.5, end: 3.25, text: 'world' },
  ],
}

async function testTranscripts(): Promise<void> {
  const saved = await saveTranscriptRecord(t1)
  eq(saved.source, 'asr', '落库记录 source=asr')
  eq(typeof saved.created_at, 'number', 'created_at 为 epoch ms')
  eq(saved.segments.length, 2, 'segments 原样带入')

  const got = await getTranscriptRecord('job-1')
  assert(got !== undefined && got.id === 'job-1', 'get 按 job_id 命中')

  const t1b: Transcript = { ...t1, duration: 20, segments: [t1.segments[0]] }
  await saveTranscriptRecord(t1b)
  const after = await getTranscriptRecord('job-1')
  eq(after?.duration, 20, '同 job_id 重复 done：覆盖不追加（字段已更新）')
  eq(after?.segments.length, 1, '覆盖后 segments 为新值')
  eq(await storage.table('transcripts').count(), 1, '覆盖后表内仍只有 1 行')

  const list = await listTranscriptRecords()
  eq(list.length, 1, 'list 返回全部字幕')

  const bySource = await storage.table('transcripts').whereIndex('source', 'asr')
  eq(bySource.length, 1, 'source 索引可查（v9 索引已接）')
}

/* ------------------------------------------------------------------ */
/* 2. studyNotes                                                       */
/* ------------------------------------------------------------------ */

console.log('studyNotes: upsert / 覆盖不追加 / patch / 删除')

const vocab: StudyNoteVocabulary[] = [
  { word: 'reluctant', pos: 'adj', gloss: '不情愿的；勉强的', context: 'reluctant to admit' },
  { word: 'commit', pos: 'v', gloss: '承诺；投入' },
]

async function testStudyNotes(): Promise<void> {
  const created = await upsertStudyNote({
    transcript_id: 'job-1',
    summary: '第一版摘要',
    bilingual_notes: [{ en: 'Hello', zh: '你好' }],
    key_points: ['要点一'],
    vocabulary: vocab,
  })
  assert(created.id.length > 0, '新建行 id 由服务层生成（uuid）')
  eq(created.status, 'generating', '默认 status=generating')
  eq(created.source, 'ai_generated', '默认 source=ai_generated')
  eq(created.vocabulary[0].pos, 'adj', 'vocabulary 契约字段（含 pos）原样往返')
  assert(created.updated_at >= created.created_at, 'updated_at >= created_at')

  const again = await upsertStudyNote({
    transcript_id: 'job-1',
    summary: '第二版摘要',
    bilingual_notes: [{ en: 'world', zh: '世界' }],
    key_points: ['要点二'],
    vocabulary: [],
    status: 'ready',
  })
  eq(again.id, created.id, '同 transcript_id upsert：id 不变（原地重置）')
  eq(again.created_at, created.created_at, 'created_at 保留（覆盖不是新建）')
  eq(again.summary, '第二版摘要', '内容字段已重置')
  eq(again.status, 'ready', 'status 可由草稿指定')
  eq(again.source, 'ai_generated', '重生成后 source 重置为 ai_generated（评审冻结）')
  eq(await storage.table('studyNotes').count(), 1, '覆盖后仍只有 1 行（无孤儿记录）')

  const byTid = await getStudyNoteByTranscriptId('job-1')
  eq(byTid?.summary, '第二版摘要', '按 transcript_id 索引可查')

  const patched = await patchStudyNote(created.id, {
    summary: '用户改过的摘要',
    status: 'modified',
    source: 'user_modified',
  })
  eq(patched?.summary, '用户改过的摘要', 'patch 局部更新生效')
  eq(patched?.status, 'modified', '用户编辑 -> status=modified')
  assert(patched!.updated_at >= again.updated_at, 'patch 刷新 updated_at')

  const missing = await patchStudyNote('no-such-id', { summary: 'x' })
  eq(missing, undefined, 'patch 不存在的 id 返回 undefined（不编造）')

  await deleteStudyNote(created.id)
  eq(await storage.table('studyNotes').count(), 0, '删除后表为空')
}

/* ------------------------------------------------------------------ */
/* 3. transcribeAndSave（fetch 打桩）                                   */
/* ------------------------------------------------------------------ */

console.log('transcribeAndSave: done 后自动落库')

type MockStep = { ok: boolean; status: number; body: unknown }

const realFetch = globalThis.fetch
function installFetchStub(script: MockStep[]): void {
  const steps = [...script]
  globalThis.fetch = (async () => {
    const step = steps.shift()
    if (step === undefined) throw new Error('fetch 被打断：没有更多桩响应')
    return {
      ok: step.ok,
      status: step.status,
      text: async () => (step.body === null ? '' : JSON.stringify(step.body)),
    } as unknown as Response
  }) as typeof fetch
}
function restoreFetch(): void {
  globalThis.fetch = realFetch
}

const submitOk: MockStep = { ok: true, status: 202, body: { jobId: 'job-2', status: 'queued', error: null } satisfies AsrSubmitResponse }
const pollDone: MockStep = {
  ok: true,
  status: 200,
  body: {
    jobId: 'job-2',
    status: 'done',
    transcript: {
      language: 'zh',
      duration: 5,
      segments: [{ start: 0, end: 2, text: '你好' }],
    },
    error: null,
  } satisfies AsrJobResponse,
}

async function testTranscribeAndSave(): Promise<void> {
  installFetchStub([submitOk, pollDone])
  const result = await transcribeAndSave(
    { file: new Blob(['x']), fileName: 'a.mp3', language: 'auto' },
    {},
    { intervalMs: 0 },
  )
  restoreFetch()
  eq(result.id, 'job-2', '编排返回 Transcript（行为不变）')
  const stored = await getTranscriptRecord('job-2')
  assert(stored !== undefined, 'done 后 transcripts 表已有记录')
  eq(stored?.language, 'zh', '落库内容 = 服务端归一化结果')
  eq(stored?.segments[0]?.text, '你好', 'segments 原样落库')
}

async function main(): Promise<void> {
  await storage.clearAll()
  await testTranscripts()
  await testStudyNotes()
  await testTranscribeAndSave()
  restoreFetch()

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('transcript store 单测全部通过 ✓')
}

main().catch((e) => {
  restoreFetch()
  console.error(e)
  process.exit(1)
})
