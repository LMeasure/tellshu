/**
 * PR #13 遗留修复的回归用例（修复后期望）。
 * ------------------------------------------------------------------
 * 由两个入口分别拉起，禁止在本文件里 import fake-indexeddb：
 *   · scripts/test_pr13_leftover_memory.ts  不加载 IndexedDB，走内存驱动
 *   · scripts/test_pr13_leftover_web.ts     先加载 fake-indexeddb，走 Dexie
 * 断言只看计数、字段和回滚结果。注入失败的桩在 finally 里恢复。
 */
import {
  addAnnotation,
  addRecitation,
  deleteReading,
  getReading,
  saveReading,
  updateReadingProgress,
} from '../src/domain/learning'
import { storage } from '../src/services/storage'
import {
  ensureTranscriptReading,
  patchStudyNote,
  saveTranscriptRecord,
  upsertStudyNote,
} from '../src/domain/transcript/store'
import type { Transcript, TranscriptRecord } from '../src/domain/transcript/types'
import type { StudyNoteRecord } from '../src/domain/transcript/types'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[${storage.driver}] ${msg}`)
}

type Kept = { kept_field?: string }

interface TableProto {
  delete: (this: { name: string }, key: string | number) => Promise<void>
  whereIndex: (
    this: { name: string },
    field: string,
    value: string | number,
  ) => Promise<unknown[]>
}

function tableProto(): TableProto {
  return Object.getPrototypeOf(storage.table('annotations')) as TableProto
}

/** 改原型上的 delete / whereIndex。两个驱动的事务句柄都走这层，打实例无效。 */
async function withProtoStub(
  install: (proto: TableProto, orig: TableProto) => void,
  body: () => Promise<void>,
): Promise<void> {
  const proto = tableProto()
  const orig: TableProto = { delete: proto.delete, whereIndex: proto.whereIndex }
  install(proto, orig)
  try {
    await body()
  } finally {
    proto.delete = orig.delete
    proto.whereIndex = orig.whereIndex
  }
}

async function annCount(docId: string): Promise<number> {
  return (await storage.table('annotations').whereIndex('doc_id', docId)).length
}

async function recCount(docId: string): Promise<number> {
  return (await storage.table('recitations').whereIndex('doc_id', docId)).length
}

async function seedReading(title: string) {
  return saveReading({ title, type: 'article', content: `${title} alpha beta` })
}

async function seedAnn(docId: string, text: string) {
  return addAnnotation({
    doc_id: docId,
    page: 0,
    para: 0,
    start: 0,
    end: text.length,
    text,
    kind: 'underline',
  })
}

async function seedRec(docId: string, title: string) {
  const blob = new Blob([title], { type: 'audio/webm' })
  return addRecitation({
    blob,
    duration_ms: 1000,
    media_type: 'audio/webm',
    title,
    doc_id: docId,
  })
}

const segment = { start: 0, end: 1, text: 'Hello' }

function transcript(id: string, fileName?: string): Transcript {
  return {
    id,
    language: 'en',
    duration: 1,
    segments: [segment],
    ...(fileName !== undefined ? { fileName } : {}),
  }
}

/** DR-1 + DR-4：同一笔事务删掉目标阅读、其批注和其背诵；对照行留下。 */
async function testDeleteSuccess(): Promise<void> {
  console.log(`— DR-1 / DR-4 单事务成功（${storage.driver}）`)
  await storage.clearAll()
  const target = await seedReading('target')
  const control = await seedReading('control')
  await seedAnn(target.id, 't1')
  await seedAnn(target.id, 't2')
  const controlAnn = await seedAnn(control.id, 'c1')
  await seedRec(target.id, 'target-rec')
  const controlRec = await seedRec(control.id, 'control-rec')

  await deleteReading(target.id)

  assert((await getReading(target.id)) === undefined, 'DR-1 目标阅读应已删除')
  const targetAnns = await annCount(target.id)
  assert(targetAnns === 0, `DR-1 目标批注应为 0，实际 ${targetAnns}`)
  const targetRecs = await recCount(target.id)
  assert(targetRecs === 0, `DR-4 目标背诵应为 0，实际 ${targetRecs}`)
  assert((await getReading(control.id))?.title === 'control', 'DR-1 对照阅读应仍在')
  const controlAnns = await annCount(control.id)
  assert(controlAnns === 1, `DR-1 对照批注应为 1，实际 ${controlAnns}`)
  assert(
    (await storage.table('annotations').get(controlAnn.id))?.doc_id === control.id,
    'DR-1 对照批注行应仍可按主键读到',
  )
  const controlRecs = await recCount(control.id)
  assert(controlRecs === 1, `DR-4 对照背诵应为 1，实际 ${controlRecs}`)
  assert(
    (await storage.table('recitations').get(controlRec.id))?.doc_id === control.id,
    'DR-4 对照背诵行应仍可按主键读到',
  )
  const readingsLeft = await storage.table('readings').count()
  assert(readingsLeft === 1, `DR-1 删除后阅读应为 1 行，实际 ${readingsLeft}`)
}

/**
 * DR-2：第 2 次批注 delete 抛错。修复后父行、全部批注、背诵都还在。
 * 桩在 finally 恢复，避免后面的用例接着抛。
 */
async function testDeleteRollsBackOnAnnotationDelete(): Promise<void> {
  console.log(`— DR-2 批注删除中途失败则整笔回滚（${storage.driver}）`)
  await storage.clearAll()
  const target = await seedReading('target')
  const control = await seedReading('control')
  const a1 = await seedAnn(target.id, 't1')
  const a2 = await seedAnn(target.id, 't2')
  const controlAnn = await seedAnn(control.id, 'c1')
  const rec = await seedRec(target.id, 'target-rec')
  const controlRec = await seedRec(control.id, 'control-rec')

  let annDeletes = 0
  let caught: unknown
  await withProtoStub((proto, orig) => {
    proto.delete = async function (key) {
      if (this.name === 'annotations') {
        annDeletes += 1
        if (annDeletes === 2) throw new Error('injected: annotation delete failed')
      }
      return orig.delete.call(this, key)
    }
  }, async () => {
    try {
      await deleteReading(target.id)
    } catch (err) {
      caught = err
    }
  })

  assert(
    caught instanceof Error && caught.message.includes('injected: annotation delete failed'),
    `DR-2 应抛出注入错误，实际 ${caught instanceof Error ? caught.message : String(caught)}`,
  )
  assert(annDeletes === 2, `DR-2 应打到第 2 次批注 delete，实际 ${annDeletes}`)
  assert((await getReading(target.id))?.id === target.id, 'DR-2 回滚后目标阅读应仍在')
  const targetAnns = await annCount(target.id)
  assert(targetAnns === 2, `DR-2 回滚后目标批注应为 2，实际 ${targetAnns}`)
  assert((await storage.table('annotations').get(a1.id)) !== undefined, 'DR-2 第 1 条批注应被回滚回来')
  assert((await storage.table('annotations').get(a2.id)) !== undefined, 'DR-2 第 2 条批注应仍在')
  const targetRecs = await recCount(target.id)
  assert(targetRecs === 1, `DR-2 回滚后目标背诵应为 1，实际 ${targetRecs}`)
  assert((await storage.table('recitations').get(rec.id))?.doc_id === target.id, 'DR-2 目标背诵行应仍在')
  assert((await getReading(control.id))?.id === control.id, 'DR-2 对照阅读应仍在')
  assert((await storage.table('annotations').get(controlAnn.id))?.doc_id === control.id, 'DR-2 对照批注应仍在')
  assert((await storage.table('recitations').get(controlRec.id))?.doc_id === control.id, 'DR-2 对照背诵应仍在')
}

/** DR-3：查批注的 whereIndex 抛错。阅读主行不得先落成已删。 */
async function testDeleteRollsBackOnAnnotationQuery(): Promise<void> {
  console.log(`— DR-3 查询批注失败则整笔回滚（${storage.driver}）`)
  await storage.clearAll()
  const target = await seedReading('target')
  const control = await seedReading('control')
  await seedAnn(target.id, 't1')
  await seedAnn(target.id, 't2')
  const controlAnn = await seedAnn(control.id, 'c1')
  const rec = await seedRec(target.id, 'target-rec')

  let caught: unknown
  await withProtoStub((proto, orig) => {
    proto.whereIndex = async function (field, value) {
      if (this.name === 'annotations') throw new Error('injected: annotations.whereIndex failed')
      return orig.whereIndex.call(this, field, value)
    }
  }, async () => {
    try {
      await deleteReading(target.id)
    } catch (err) {
      caught = err
    }
  })

  assert(
    caught instanceof Error && caught.message.includes('injected: annotations.whereIndex failed'),
    `DR-3 应抛出注入错误，实际 ${caught instanceof Error ? caught.message : String(caught)}`,
  )
  assert((await getReading(target.id))?.id === target.id, 'DR-3 回滚后目标阅读应仍在')
  const targetAnns = await annCount(target.id)
  assert(targetAnns === 2, `DR-3 回滚后目标批注应为 2，实际 ${targetAnns}`)
  const targetRecs = await recCount(target.id)
  assert(targetRecs === 1, `DR-3 回滚后目标背诵应为 1，实际 ${targetRecs}`)
  assert((await storage.table('recitations').get(rec.id)) !== undefined, 'DR-3 目标背诵行应仍在')
  assert((await getReading(control.id))?.id === control.id, 'DR-3 对照阅读应仍在')
  const controlAnns = await annCount(control.id)
  assert(controlAnns === 1, `DR-3 对照批注应为 1，实际 ${controlAnns}`)
  assert((await storage.table('annotations').get(controlAnn.id)) !== undefined, 'DR-3 对照批注行应仍在')
}

/** 桩恢复后，下一次删除必须能走完，不能带着上次的抛错。 */
async function testStubRestored(): Promise<void> {
  console.log(`— 注入桩已恢复（${storage.driver}）`)
  await storage.clearAll()
  const doc = await seedReading('after-stub')
  await seedAnn(doc.id, 'only')
  await seedRec(doc.id, 'after')
  await deleteReading(doc.id)
  assert((await getReading(doc.id)) === undefined, '桩恢复后阅读应能删除')
  const anns = await annCount(doc.id)
  assert(anns === 0, `桩恢复后批注应为 0，实际 ${anns}`)
  const recs = await recCount(doc.id)
  assert(recs === 0, `桩恢复后背诵应为 0，实际 ${recs}`)
}

/**
 * DR-5：删除 t_<id> 这条阅读时，不级联 transcripts / studyNotes。
 * 不调用 backfill——补齐可能把阅读行写回来，那是本轮明确不做的事。
 */
async function testNoCascadeTranscriptAssets(): Promise<void> {
  console.log(`— DR-5 不级联转写与学习稿（${storage.driver}）`)
  await storage.clearAll()
  const kept = transcript('job-keep', 'keep.mp3')
  const dropped = transcript('job-drop', 'drop.mp3')
  await saveTranscriptRecord(kept)
  await saveTranscriptRecord(dropped)
  await ensureTranscriptReading(kept, 'keep.mp3')
  await ensureTranscriptReading(dropped, 'drop.mp3')
  const keptNote = await upsertStudyNote({
    transcript_id: kept.id,
    summary: '留下的稿',
    bilingual_notes: [{ en: 'Hi', zh: '嗨' }],
    key_points: ['k'],
    vocabulary: [],
  })
  await upsertStudyNote({
    transcript_id: dropped.id,
    summary: '被删阅读对应的稿',
    bilingual_notes: [],
    key_points: ['d'],
    vocabulary: [],
  })
  const readingId = `t_${dropped.id}`
  await seedAnn(readingId, 'on-transcript')
  await seedRec(readingId, 'on-transcript')

  await deleteReading(readingId)

  assert((await getReading(readingId)) === undefined, 'DR-5 字幕素材阅读行应已删除')
  const droppedAnns = await annCount(readingId)
  assert(droppedAnns === 0, `DR-5 该阅读的批注应随阅读删除，实际 ${droppedAnns}`)
  const droppedRecs = await recCount(readingId)
  assert(droppedRecs === 0, `DR-5 该阅读的背诵应随阅读删除，实际 ${droppedRecs}`)

  const stillTranscript = await storage.table('transcripts').get(dropped.id)
  assert(stillTranscript?.id === dropped.id, 'DR-5 transcript 必须仍在')
  assert(stillTranscript?.segments[0]?.text === 'Hello', 'DR-5 transcript 内容不得被改写')
  assert(stillTranscript?.fileName === 'drop.mp3', 'DR-5 transcript 文件名不得被删掉')
  const notes = await storage.table('studyNotes').whereIndex('transcript_id', dropped.id)
  assert(notes.length === 1, `DR-5 studyNote 应为 1 行，实际 ${notes.length}`)
  assert(notes[0]?.summary === '被删阅读对应的稿', 'DR-5 studyNote 内容不得被改写')
  assert(notes[0]?.id === (await storage.table('studyNotes').get(notes[0]!.id))?.id, 'DR-5 studyNote 主键应仍在')

  assert((await getReading(`t_${kept.id}`))?.title === 'keep.mp3', 'DR-5 对照阅读应仍在')
  assert((await storage.table('transcripts').get(kept.id))?.fileName === 'keep.mp3', 'DR-5 对照 transcript 应仍在')
  assert(
    (await storage.table('studyNotes').get(keptNote.id))?.summary === '留下的稿',
    'DR-5 对照 studyNote 应仍在',
  )
  const transcriptCount = await storage.table('transcripts').count()
  assert(transcriptCount === 2, `DR-5 transcripts 应为 2 行，实际 ${transcriptCount}`)
  const noteCount = await storage.table('studyNotes').count()
  assert(noteCount === 2, `DR-5 studyNotes 应为 2 行，实际 ${noteCount}`)
}

async function testTranscriptOwner(): Promise<void> {
  console.log(`— TR-1 / TR-2 owner 与 created_at（${storage.driver}）`)
  await storage.clearAll()
  const table = storage.table('transcripts')
  const created = await saveTranscriptRecord(transcript('job-tr', 'clip.mp3'))
  assert(created.owner === 'guest', `TR-1 返回值 owner 应为 guest，实际 ${String(created.owner)}`)
  const stored = await table.get('job-tr')
  assert(stored?.owner === 'guest', `TR-1 落库 owner 应为 guest，实际 ${String(stored?.owner)}`)

  const blankNew = { ...transcript('job-tr-blank'), owner: '' } as Transcript
  const blankSaved = await saveTranscriptRecord(blankNew)
  assert(blankSaved.owner === 'guest', `TR-1 入参空字符串不得写成 owner，实际 ${String(blankSaved.owner)}`)
  assert(
    (await table.get('job-tr-blank'))?.owner === 'guest',
    'TR-1 空字符串入参落库后仍应为 guest',
  )

  await table.put({ ...stored!, owner: 'alice', created_at: 222, kept_field: 'yes' } as TranscriptRecord)
  const { fileName: _omit, ...withoutName } = transcript('job-tr', 'clip.mp3')
  await saveTranscriptRecord({
    ...withoutName,
    duration: 9,
    segments: [{ start: 0, end: 2, text: 'Updated' }],
  })
  const overwritten = (await table.get('job-tr')) as (TranscriptRecord & Kept) | undefined
  assert(overwritten?.owner === 'alice', `TR-2 覆盖后 owner 应为 alice，实际 ${String(overwritten?.owner)}`)
  assert(overwritten?.created_at === 222, `TR-2 created_at 应保留 222，实际 ${String(overwritten?.created_at)}`)
  assert(overwritten?.duration === 9, `TR-2 duration 应更新为 9，实际 ${String(overwritten?.duration)}`)
  assert(overwritten?.segments[0]?.text === 'Updated', 'TR-2 分段文本应更新')
  assert(overwritten?.fileName === 'clip.mp3', `TR-2 未提供的 fileName 应保留，实际 ${String(overwritten?.fileName)}`)
  assert(overwritten?.kept_field === 'yes', `TR-2 其它已有字段应保留，实际 ${String(overwritten?.kept_field)}`)

  await saveTranscriptRecord({
    ...transcript('job-tr'),
    duration: 8,
    fileName: 'other.mp3',
    owner: '',
  } as Transcript)
  const afterBlank = (await table.get('job-tr')) as (TranscriptRecord & Kept) | undefined
  assert(afterBlank?.owner === 'alice', `TR-2 空字符串不得覆盖 alice，实际 ${String(afterBlank?.owner)}`)
  assert(afterBlank?.created_at === 222, `TR-2 空字符串覆盖时 created_at 仍应为 222，实际 ${String(afterBlank?.created_at)}`)
  assert(afterBlank?.duration === 8, `TR-2 空字符串覆盖时内容仍应更新，实际 duration=${String(afterBlank?.duration)}`)
  assert(afterBlank?.fileName === 'other.mp3', 'TR-2 显式 fileName 应更新')
  assert(afterBlank?.kept_field === 'yes', 'TR-2 空字符串覆盖时其它字段仍应保留')
}

async function testStudyNoteOwner(): Promise<void> {
  console.log(`— SN-1 / SN-2 / SN-3 owner（${storage.driver}）`)
  await storage.clearAll()
  const table = storage.table('studyNotes')
  const draft = {
    transcript_id: 'job-sn',
    summary: '第一版',
    bilingual_notes: [{ en: 'Hi', zh: '嗨' }],
    key_points: ['k'],
    vocabulary: [] as [],
  }
  const created = await upsertStudyNote(draft)
  assert(created.owner === 'guest', `SN-1 返回值 owner 应为 guest，实际 ${String(created.owner)}`)
  const rows = await table.whereIndex('transcript_id', 'job-sn')
  assert(rows.length === 1, `SN-1 应按 transcript_id 读到 1 行，实际 ${rows.length}`)
  assert(rows[0]?.owner === 'guest', `SN-1 落库 owner 应为 guest，实际 ${String(rows[0]?.owner)}`)

  const blankCreated = await upsertStudyNote({
    ...draft,
    transcript_id: 'job-sn-blank',
    owner: '',
  } as typeof draft)
  assert(blankCreated.owner === 'guest', `SN-1 草稿空字符串不得写成 owner，实际 ${String(blankCreated.owner)}`)
  const blankRows = await table.whereIndex('transcript_id', 'job-sn-blank')
  assert(blankRows.length === 1 && blankRows[0]?.owner === 'guest', 'SN-1 空字符串草稿落库后仍应为 guest')

  await table.put({
    ...created,
    owner: 'alice',
    created_at: 111,
    updated_at: 111,
    kept_field: 'yes',
  } as StudyNoteRecord)
  const again = await upsertStudyNote({ ...draft, summary: '第二版' })
  assert(again.id === created.id, 'SN-2 upsert 应原地保留 id')
  assert(again.owner === 'alice', `SN-2 覆盖后 owner 应为 alice，实际 ${String(again.owner)}`)
  assert(again.created_at === 111, `SN-2 created_at 应保留 111，实际 ${String(again.created_at)}`)
  assert(again.summary === '第二版', 'SN-2 summary 应更新')
  const overwritten = (await table.get(created.id)) as (StudyNoteRecord & Kept) | undefined
  assert(overwritten?.owner === 'alice', `SN-2 落库 owner 应为 alice，实际 ${String(overwritten?.owner)}`)
  assert(overwritten?.created_at === 111, 'SN-2 落库 created_at 应保留')
  assert(overwritten?.summary === '第二版', 'SN-2 落库 summary 应更新')
  assert(overwritten?.kept_field === 'yes', `SN-2 其它已有字段应保留，实际 ${String(overwritten?.kept_field)}`)
  assert(overwritten!.updated_at !== 111, 'SN-2 updated_at 应刷新')

  await upsertStudyNote({ ...draft, summary: '第三版', owner: '' } as typeof draft)
  const afterBlank = (await table.get(created.id)) as (StudyNoteRecord & Kept) | undefined
  assert(afterBlank?.owner === 'alice', `SN-2 空字符串不得覆盖 alice，实际 ${String(afterBlank?.owner)}`)
  assert(afterBlank?.created_at === 111, 'SN-2 空字符串覆盖时 created_at 应保留')
  assert(afterBlank?.summary === '第三版', 'SN-2 空字符串覆盖时 summary 应更新')
  assert(afterBlank?.kept_field === 'yes', 'SN-2 空字符串覆盖时其它字段应保留')

  const patched = await patchStudyNote(created.id, { summary: 'x' })
  assert(patched?.summary === 'x', 'SN-3 summary 应更新')
  assert(patched?.owner === 'alice', `SN-3 patch 应保留 owner，实际 ${String(patched?.owner)}`)
  const patchedRow = await table.get(created.id)
  assert(patchedRow?.owner === 'alice', `SN-3 落库 owner 应为 alice，实际 ${String(patchedRow?.owner)}`)
  assert(patchedRow?.summary === 'x', 'SN-3 落库 summary 应为 x')
  assert(patchedRow?.created_at === 111, 'SN-3 patch 不得改掉 created_at')
}

/** SR-2：两边都跑。进度更新不得把预先写入的 alice 抹掉。 */
async function testProgressKeepsOwner(): Promise<void> {
  console.log(`— SR-2 updateReadingProgress 保留 owner（${storage.driver}）`)
  await storage.clearAll()
  const doc = await saveReading({ title: 'progress', type: 'article', content: 'alpha beta' })
  const row = await storage.table('readings').get(doc.id)
  await storage.table('readings').put({ ...row!, owner: 'alice' })
  await updateReadingProgress(doc.id, 42)
  const after = await getReading(doc.id)
  assert(after?.scroll_pos === 42, `SR-2 scroll_pos 应为 42，实际 ${String(after?.scroll_pos)}`)
  assert(after?.owner === 'alice', `SR-2 owner 应为 alice，实际 ${String(after?.owner)}`)
}

/** SR-1：只跑内存。Dexie 已有 test_readings.ts 的覆盖用例，这里不复制。 */
async function testMemorySaveReadingKeepsOwner(): Promise<void> {
  if (storage.driver !== 'memory') return
  console.log('— SR-1 内存 saveReading 覆盖保留 owner')
  await storage.clearAll()
  const doc = await saveReading({ title: 'mem', type: 'article', content: 'alpha beta' })
  const row = await storage.table('readings').get(doc.id)
  await storage.table('readings').put({ ...row!, owner: 'alice' })
  const overwritten = await saveReading({
    id: doc.id,
    title: 'mem',
    type: 'article',
    content: doc.content,
  })
  assert(overwritten.owner === 'alice', `SR-1 返回值 owner 应为 alice，实际 ${String(overwritten.owner)}`)
  const stored = await storage.table('readings').get(doc.id)
  assert(stored?.owner === 'alice', `SR-1 落库 owner 应为 alice，实际 ${String(stored?.owner)}`)
}

export async function runPr13LeftoverCases(expected: 'memory' | 'dexie'): Promise<void> {
  assert(storage.driver === expected, `驱动应为 ${expected}，实际 ${storage.driver}`)
  console.log(`\n=== PR13 leftover（${storage.driver}）===`)
  await testDeleteSuccess()
  await testDeleteRollsBackOnAnnotationDelete()
  await testDeleteRollsBackOnAnnotationQuery()
  await testStubRestored()
  await testNoCascadeTranscriptAssets()
  await testTranscriptOwner()
  await testStudyNoteOwner()
  await testProgressKeepsOwner()
  await testMemorySaveReadingKeepsOwner()
  console.log(`✅ PR13 leftover（${storage.driver}）全部通过`)
}
