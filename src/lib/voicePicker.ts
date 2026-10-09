/**
 * 嗓音挑选（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 需求：中文 voice 和英文 voice 分开选，**不要用默认 voice**。
 *
 * 「不要用默认」是硬要求，原因是这样：不同系统的默认嗓音千差万别，
 * Windows 上很可能默认是中文嗓，于是整篇英文会被念成中文腔；
 * 反之亦然。必须显式按语言指定，才谈得上「中文听得懂、英文听得懂」。
 *
 * 其次是 `localService` 的取舍：
 *   localService === false —— 云端嗓音（如 Google 的网络语音），音质明显更好、
 *                            更自然，但**需要联网**；
 *   localService === true  —— 系统自带嗓音，离线可用，但机械感重。
 *
 * 述树是离线优先的产品，所以策略是：
 *   有网 → 优先云端嗓音（听感优先）
 *   断网 → 优先本地嗓音（可用性优先，否则一句也念不出来）
 * 两端都在找不到时才逐级放宽，最后退回「任意匹配该语言的嗓音」，
 * 而不是返回空让引擎用系统默认。
 */

export type VoicePref = 'zh' | 'en'

export interface VoiceLike {
  name: string
  lang: string
  /** false = 云端嗓音（需联网、音质好）；true = 系统本地嗓音（离线可用） */
  localService: boolean
}

/** 语言标签归一：'EN_us' → 'en-us'，用于大小写不敏感的前缀比较 */
function normLang(lang: string): string {
  return lang.replace(/_/g, '-').toLowerCase()
}

/** 该嗓音是否属于目标语言；顺便给出匹配度，越小越贴切 */
function langScore(voice: VoiceLike, pref: VoicePref): number {
  const l = normLang(voice.lang)
  if (pref === 'zh') {
    if (l.startsWith('zh-cn') || l.startsWith('zh-hans')) return 0
    if (l.startsWith('zh-hant') || l.startsWith('zh-tw') || l.startsWith('zh-hk')) return 1
    if (l.startsWith('zh') || l.startsWith('cmn')) return 2
    return Number.POSITIVE_INFINITY
  }
  if (l.startsWith('en-us')) return 0
  if (l.startsWith('en-gb')) return 1
  if (l.startsWith('en-au') || l.startsWith('en-ca') || l.startsWith('en-in')) return 2
  if (l.startsWith('en')) return 3
  return Number.POSITIVE_INFINITY
}

/**
 * 按优先级排出嗓音列表（第一个就是最佳选择）。
 * @param online 是否认为此刻联网 —— 决定先选云端嗓音还是本地嗓音
 */
export function rankVoices(
  voices: readonly VoiceLike[],
  pref: VoicePref,
  online: boolean,
): VoiceLike[] {
  const wanted = online ? false : true
  const unwanted = !wanted

  return voices
    .map((v) => ({ v, score: langScore(v, pref) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      // 语言贴合度相同时：先按 localService 偏好，再按名字稳定排序（结果可复现）
      const pa = a.v.localService === wanted ? 0 : a.v.localService === unwanted ? 2 : 1
      const pb = b.v.localService === wanted ? 0 : b.v.localService === unwanted ? 2 : 1
      if (pa !== pb) return pa - pb
      return a.v.name.localeCompare(b.v.name)
    })
    .map((x) => x.v)
}

/** 选出最佳嗓音；一个都没有则返回 undefined（调用方自行决定是否放弃朗读） */
export function pickVoice(
  voices: readonly VoiceLike[],
  pref: VoicePref,
  online: boolean,
): VoiceLike | undefined {
  return rankVoices(voices, pref, online)[0]
}

/**
 * 按 BCP-47 精确口音标签挑嗓音（en-gb / en-us）。
 * 单词详情页的「英音 / 美音」切换用它：先要**正好是这个口音**的嗓音，
 * 找不到再由调用方退回 pickVoice 的通用英文策略（宁可口音近似也不哑）。
 * 排序规则与 rankVoices 一致：localService 偏好 → 名字稳定排序（结果可复现）。
 */
export function pickVoiceByTag(
  voices: readonly VoiceLike[],
  /** 归一后的小写标签，如 'en-gb' / 'en-us' */
  tag: string,
  online: boolean,
): VoiceLike | undefined {
  const wanted = online ? false : true
  const unwanted = !wanted
  return voices
    .filter((v) => normLang(v.lang).startsWith(tag))
    .sort((a, b) => {
      const pa = a.localService === wanted ? 0 : a.localService === unwanted ? 2 : 1
      const pb = b.localService === wanted ? 0 : b.localService === unwanted ? 2 : 1
      if (pa !== pb) return pa - pb
      return a.name.localeCompare(b.name)
    })[0]
}
