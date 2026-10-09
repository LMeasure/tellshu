/**
 * Service 层单测（Node 环境 → 自动落到 noop 实现）
 * ------------------------------------------------------------------
 * 验证三件事：
 *   1. 无浏览器 API 时能力探测优雅降级（按钮该隐藏就隐藏，而不是运行时报错）
 *   2. `speakAsync` 必须 **resolve**（listenSession 的推进依赖它），且听书循环在
 *      没有真实语音时也能跑完 —— 这是「可单测」的关键设计
 *   3. 录音会话不支持时 start() 明确 reject，不静默成功
 *
 * 运行：npx tsx scripts/test_services.ts
 */
import { speechService } from '../src/services/speech'
import { noopSpeechLog, resetNoopSpeechLog } from '../src/services/speech/noop'
import { recordingService, isRecordingSupported } from '../src/services/recording'
import {
  isSpeechSupported,
  isRecognitionSupported,
  speakFocused,
  pronunciationScore,
  normalizeSpoken,
} from '../src/lib/speech'
import { ListenSession, type ListenUnit } from '../src/lib/listenSession'
import { fmtDuration, fmtSize, recitationTitle } from '../src/lib/recorder'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed++
  }
}

async function main() {
  console.log('[speech] Node 环境降级')
  assert(speechService.driver === 'none', `无 Web Speech API 时选中空实现（实际 ${speechService.driver}）`)
  assert(!isSpeechSupported(), 'isSpeechSupported() 返回 false')
  assert(!isRecognitionSupported(), 'isRecognitionSupported() 返回 false')
  assert(speechService.speak('hello') === false, 'speak() 返回 false，不抛错')

  resetNoopSpeechLog()
  let rejected = false
  try {
    await speechService.listen({ lang: 'en-US' })
  } catch {
    rejected = true
  }
  assert(rejected, 'listen() 在不支持时 reject（调用方得以提示用户）')

  console.log('[speech] speakAsync 语义')
  resetNoopSpeechLog()
  await speechService.speakAsync('apple', { slow: true })
  assert(noopSpeechLog.spoken.length === 1, 'speakAsync 记录了一次朗读（resolve 而非 reject）')
  assert(noopSpeechLog.spoken[0].rate === 0.6, `slow=true → 0.6 倍速（实际 ${noopSpeechLog.spoken[0].rate}）`)
  await speechService.speakAsync('banana', { rate: 99 })
  assert(noopSpeechLog.spoken[1].rate === 4, 'rate 被收敛到上限 4')

  speechService.cancel()
  assert(noopSpeechLog.cancelled === 1, 'cancel() 透传到实现')

  console.log('[speech] speakFocused 走 audioBus 但不发声')
  const focused = await speakFocused('hello')
  assert(focused === false, '不支持时 speakFocused 返回 false（按钮状态据此显示）')

  console.log('[listenSession] 无真实语音也能跑完（noop 下 resolve）')
  const units: ListenUnit[] = [
    { text: 'A', para: 0 },
    { text: 'B', para: 0 },
    { text: 'C', para: 1 },
  ]
  await new Promise<void>((resolve, reject) => {
    const session = new ListenSession({
      rate: () => 1,
      onEnd: () => resolve(),
    })
    session.start(units)
    setTimeout(() => reject(new Error('听书循环卡住了（speakAsync 未 resolve？）')), 3000)
  })
  assert(true, '三句依次读完并触发 onEnd')

  console.log('[recording] Node 环境降级')
  assert(recordingService.driver === 'none', `无 MediaRecorder 时选中空实现（实际 ${recordingService.driver}）`)
  assert(!isRecordingSupported(), 'isRecordingSupported() 返回 false')
  const session = recordingService.createSession()
  assert(session.isRecording === false, '会话默认未在录音')
  let startRejected = false
  try {
    await session.start()
  } catch {
    startRejected = true
  }
  assert(startRejected, 'start() 明确 reject，不静默成功')
  session.cancel()
  session.dispose()
  assert(true, 'cancel/dispose 在不支持时是安全的空操作')

  console.log('[recorder] 纯展示函数')
  assert(fmtDuration(83000) === '01:23', 'fmtDuration 正确')
  assert(fmtSize(0) === '—', 'fmtSize(0) → —')
  assert(fmtSize(512) === '512 B', 'fmtSize 字节')
  assert(fmtSize(2048) === '2 KB', 'fmtSize KB')
  assert(fmtSize(3 * 1024 * 1024) === '3.0 MB', 'fmtSize MB')
  assert(
    /^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}$/.test(recitationTitle(60000, new Date(2026, 9, 3).getTime())),
    'recitationTitle 年-月-日-时长',
  )

  console.log('[speech] 跟读评分纯逻辑')
  assert(normalizeSpoken('Hello, World!') === 'hello world', '归一化去标点、小写')
  assert(pronunciationScore('apple', 'apple') === 100, '完全一致 → 100')
  assert(pronunciationScore('apple', '') === 0, '空输入 → 0')
  const near = pronunciationScore('apple', 'aple')
  assert(near > 60 && near < 100, `近音得到中间分（实际 ${near}）`)

  console.log('')
  if (failed) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('Service 层单测全部通过 ✓')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
