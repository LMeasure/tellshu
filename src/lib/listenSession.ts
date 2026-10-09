/**
 * 听书会话（逐句朗读 + 可被抢占/恢复 + 句间停顿 + 从句重读）
 * ------------------------------------------------------------------
 * 为什么不是「整段 await 完再下一段」：用户中途点单词要把听书暂停，
 * Web Speech API 一旦 cancel() 就没法从句子中间接着读，只能**整句重读**。
 * 所以听书按**句子**推进，被抢占时记下当前句，恢复时从这句开头重读 ——
 * 粒度细到句子，用户几乎感觉不到跳。
 *
 * 抢占流程（配合 audioBus）：
 *   单词发音 / 音频播放 → audioBus.claim → session.suspend()
 *     → 标记 gen 后 cancel 合成（让 await 的那一句立刻结束，但不推进下标）
 *     → 循环进入 paused，等 resume
 *   → 发音结束 → audioBus.release → session.resume() → 重读当前句继续
 *
 * 【中英文兼容】每个 unit 带 lang，由 unit 自身决定用哪种嗓音：
 *   中文句用中文嗓、英文句用英文嗓 —— 这是「听得懂」的前提，
 *   共用一个嗓音的话两边都会念成无法辨认的声音。
 * 【句间停顿】默认读完一句停 200ms 再读下一句，让句读有呼吸感；
 *   中文单元自带 `pauseAfter`（。！？150 / ，、；：100），以单元自带的为准。
 *   停顿同样可以被抢占打断。
 * 【英文默认】`unit.natural = true` 时把 rate/pitch/voice 全部交还给浏览器（需求【1】）。
 * 【只读这一句】`start(units, from, stopAt)` 读到 stopAt 就收尾（需求【5】）。
 */

import { speechService } from '../services/speech'
import { langTag } from './textLang'
import type { AudioHolder } from './audioBus'

export interface ListenUnit {
  /** 已清洗过的待朗读文本 */
  text: string
  /** 该句所属段落下标（用于高亮） */
  para: number
  /** 该句在所属段落内的句子下标（句子级高亮 / 双击某句重读用） */
  sent?: number
  /** 句内小段下标（中文按标点再切一刀后产生） */
  sub?: number
  /** 该句语言；缺省时由 speechService 按文本字符自行判断 */
  lang?: 'zh' | 'en'
  /**
   * 读完本单元后要停多久（毫秒）。
   * 中文按标点给（。！？ 150 / ，、；： 100，见 listenPlan）；
   * 英文给固定的句间呼吸（200）。**给 0 表示不停** —— 用 `??` 取值才认这个 0。
   */
  pauseAfter?: number
  /**
   * true = 走浏览器默认：不挑嗓音、不设 rate / pitch（只设 lang）。
   * 英文听书用这个（需求【1】）。
   */
  natural?: boolean
  /** 显式倍速；undefined 时用会话的 rate() */
  rate?: number
  /** 显式音调；undefined 时按 1（原调）。感叹句会给 1.15 微调（需求【2】） */
  pitch?: number
}

/** 需求规定的句间停顿（毫秒） */
export const DEFAULT_PAUSE_MS = 200

/** 交给朗读实现的参数（注入 speak 时可见，便于单测断言） */
export interface SpeakPlan {
  rate: number
  pitch: number
  /** true = 浏览器默认（不挑嗓音、不设 rate/pitch） */
  natural: boolean
}

export interface ListenSessionOptions {
  /** 实时取倍速（用户在朗读中改倍速要立刻生效）；英文单元不使用它 */
  rate: () => number
  /** 单元没有自带 pauseAfter 时的停顿毫秒数，默认 200 */
  pauseMs?: number
  onIndex?: (i: number) => void
  onEnd?: () => void
  /** 注入朗读实现（默认走 services/speech），单测用假实现验证抢占/恢复时序 */
  speak?: (unit: ListenUnit, plan: SpeakPlan) => Promise<void>
  /** 注入「中断合成」实现（默认走 services/speech 的 cancel） */
  cancel?: () => void
}

export class ListenSession {
  private units: ListenUnit[] = []
  private i = 0
  private running = false
  private paused = false
  /**
   * 抢占代号：每次 suspend/stop/start 都自增。朗读前后比对这个值，
   * 就能确定这一句是被打断的（不推进下标）还是自然读完的（推进）。
   * 用代号而不是布尔量，是为了避免「resume 先到、被打断的回调后到」的竞态。
   */
  private gen = 0
  private wake: (() => void) | null = null
  private sleepTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 停顿的兑现函数。必须保存它：`suspend()` 会提前掐掉定时器，
   * 如果不同时把 await 放行，loop 会永远卡在「上一句读完、下一句还没起」的状态里
   * —— 既不往下读也收不到新的 resume，等于无声死锁。
   * 放行后 loop 立刻看到 paused=true 转去等 resume，语义仍然正确。
   */
  private sleepResolve: (() => void) | null = null
  /**
   * 「只读这一句」的终点：读到这个下标就自然结束（需求【5】的可选项）。
   * null = 一直读到底。
   */
  private stopAt: number | null = null
  /**
   * 用户主动暂停（区别于被别的音源抢占）。
   * 用户暂停期间，即使别的音源播完把焦点还回来，也**不能自动续读** ——
   * 否则「暂停 → 点个单词查一下 → 听书自己又响了」会很难受。
   */
  private userPaused = false
  private opts: ListenSessionOptions

  /** 交给 audioBus 的身份：挂起/恢复直接委托给会话自己 */
  readonly holder: AudioHolder

  constructor(opts: ListenSessionOptions) {
    this.opts = opts
    this.holder = {
      role: 'book',
      suspend: () => this.suspend(),
      // 焦点归还时：用户主动暂停过就不自作主张恢复
      resume: () => {
        if (!this.userPaused) this.resume()
      },
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 是否处于「暂停」状态（用户暂停或被别的音源抢占）—— 需求【4】据此显示「继续」 */
  get isPaused(): boolean {
    return this.paused
  }

  get index(): number {
    return this.i
  }

  /**
   * 开始朗读；已在跑则替换内容并按 from 指定的句子继续。
   * @param from 从第几句开始（需求【4】恢复 / 需求【5】双击某句 → 从该句重新朗读）
   * @param stopAt 读到这个下标就结束（需求【5】「只读这一句」）；null = 读到底
   */
  start(units: ListenUnit[], from = 0, stopAt: number | null = null): void {
    this.units = units
    const idx = Number.isFinite(from)
      ? Math.max(0, Math.min(Math.trunc(from), units.length - 1))
      : 0
    this.stopAt = stopAt === null || !Number.isFinite(stopAt) ? null : Math.trunc(stopAt)
    // 作废正在朗读的那一句（若有），否则 loop 会把它读完后才跳到新下标
    this.gen += 1
    this.cancelSpeak()
    this.i = idx
    this.paused = false
    this.userPaused = false
    if (!this.running) {
      this.running = true
      void this.loop()
    } else {
      // 已在暂停中：换了内容也要能继续
      this.wake?.()
      this.wake = null
    }
  }

  /** 从指定句子重读（用在「双击某句重读」） */
  seek(index: number, stopAt: number | null = null): void {
    this.start(this.units, index, stopAt)
  }

  /**
   * 用户暂停（需求【4】）。
   * 与 suspend 的区别只在语义：一个是别的音源抢占、一个是用户主动暂停，
   * 实现都是「cancel 掉当前 utterance + 记住下标」，恢复时从这句开头重读。
   * 之所以不用 speechSynthesis.pause()：iOS Safari 上 pause/resume 形同虚设，
   * cancel + 重读是唯一跨平台稳的做法（代价是回退到句子开头，MVP 接受）。
   */
  pause(): void {
    this.userPaused = true
    this.suspend()
  }

  /** 停止并丢弃（用户点「停止」/ 切页 / 卸载） */
  stop(): void {
    this.running = false
    this.paused = false
    this.userPaused = false
    this.stopAt = null
    this.gen += 1
    this.clearSleep()
    this.cancelSpeak()
    this.wake?.()
    this.wake = null
  }

  /** 被抢占：立刻停合成，等 resume 时重读本句 */
  suspend(): void {
    if (!this.running || this.paused) return
    this.paused = true
    this.gen += 1
    this.clearSleep()
    this.cancelSpeak()
  }

  /** 恢复：从当前句开头重读（用户点「继续」，或别的音源播完归还焦点） */
  resume(): void {
    if (!this.running) return
    this.userPaused = false
    this.paused = false
    this.wake?.()
    this.wake = null
  }

  private clearSleep(): void {
    if (this.sleepTimer !== null) {
      clearTimeout(this.sleepTimer)
      this.sleepTimer = null
    }
    const r = this.sleepResolve
    this.sleepResolve = null
    r?.()
  }

  private cancelSpeak(): void {
    if (this.opts.cancel) {
      this.opts.cancel()
      return
    }
    // 默认走语音服务，不直接碰 speechSynthesis（便于换成原生 TTS）
    speechService.cancel()
  }

  private waitWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve
    })
  }

  private async sleepPause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.sleepResolve = resolve
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null
        this.sleepResolve = null
        resolve()
      }, ms)
    })
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.paused) {
        await this.waitWake()
        continue
      }
      const unit = this.units[this.i]
      if (!unit) {
        this.finish()
        return
      }
      this.opts.onIndex?.(this.i)
      const myGen = this.gen
      // 英文单元走 natural（浏览器默认）；中文单元用显式 rate / pitch
      const plan: SpeakPlan = unit.natural
        ? { rate: this.opts.rate(), pitch: 1, natural: true }
        : { rate: unit.rate ?? this.opts.rate(), pitch: unit.pitch ?? 1, natural: false }
      const done = this.opts.speak
        ? this.opts.speak(unit, plan)
        : speechService.speakAsync(unit.text, {
            rate: plan.rate,
            pitch: plan.pitch,
            natural: plan.natural,
            lang: unit.lang ? langTag(unit.lang) : undefined,
          })
      await done
      if (!this.running) return
      if (myGen !== this.gen) {
        // 这一句读到一半被抢占了：下标不动，恢复后从这句开头重读
        continue
      }
      // 「只读这一句」：先把下标推过去，判断越界就收尾（需求【5】）
      if (this.stopAt !== null && this.i >= this.stopAt) {
        this.finish()
        return
      }
      // 走到这里说明本句已读完 —— 先推进下标再进停顿。
      // 顺序很重要：停顿期间被抢占时，本句已经是「读完了」的状态，
      // 不能像半句被打断那样回退重读，否则会念出重复的一句。
      this.i += 1
      // 中文按标点自带停顿；没带的用会话默认（200ms 句间呼吸）
      const pauseMs = unit.pauseAfter ?? this.opts.pauseMs ?? DEFAULT_PAUSE_MS
      if (pauseMs > 0) {
        await this.sleepPause(pauseMs)
        if (!this.running) return
        // 停顿时被抢占 → 回到循环顶部等 resume，之后从下一句开始
        if (this.paused) continue
      }
    }
  }

  private finish(): void {
    this.running = false
    this.opts.onIndex?.(-1)
    this.opts.onEnd?.()
  }
}
