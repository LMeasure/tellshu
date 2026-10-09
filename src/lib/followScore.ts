/**
 * 跟读评分（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 两条路，UI 上必须区分显示，不许把模拟分说成真实评分：
 *   1. **真实评分**：浏览器支持语音识别时，走 `lib/speech.ts` 的
 *      `pronunciationScore(target, spoken)`（归一化 + 编辑距离），这是真比对。
 *   2. **模拟评分**：不支持识别时（iOS Safari / 离线 / 未授权），
 *      用「录音时长 vs 句子长度的语速合理性」给一个体验分。
 *      ⚠️ 它衡量的是**说得流不流畅、快不快**，不是发音准不准 —— UI 必须标注「模拟」。
 */

/** 常速朗读的经验语速（词/秒）；约 150 wpm */
export const NORMAL_WPS = 2.5

/** 模拟分取值区间：不给满分也不给零分，避免看起来像真实评测 */
export const MOCK_SCORE_MIN = 40
export const MOCK_SCORE_MAX = 98

/** 语速偏离的惩罚系数（越大越严格） */
const PACE_PENALTY = 30

/** 句子里的英文单词数（中文不计，例句都是英文） */
export function countWords(text: string): number {
  const m = text.match(/[A-Za-z][A-Za-z'-]*/g)
  return m ? m.length : 0
}

/**
 * 模拟跟读分。
 * @param target     目标句子（英文）
 * @param durationMs 实际录音时长
 * @returns 0 表示这次录音无效（太短 / 句子为空），调用方应提示重录而不是显示 0 分
 */
export function mockFollowScore(target: string, durationMs: number): number {
  const words = countWords(target)
  if (words === 0 || !Number.isFinite(durationMs) || durationMs < 300) return 0
  const expectedMs = (words / NORMAL_WPS) * 1000
  const ratio = durationMs / expectedMs
  const penalty = Math.abs(Math.log(ratio)) * PACE_PENALTY
  const raw = Math.round(MOCK_SCORE_MAX - 2 - penalty)
  return Math.min(MOCK_SCORE_MAX, Math.max(MOCK_SCORE_MIN, raw))
}

/** 分数档位文案（真实分与模拟分共用） */
export function scoreRemark(score: number): string {
  if (score >= 90) return '很棒，几乎挑不出毛病'
  if (score >= 80) return '不错，个别音再清晰一点'
  if (score >= 70) return '还行，慢一点把每个词读全'
  if (score >= 60) return '有点赶，试着放慢节奏'
  return '再听一遍原句，然后跟着读'
}

/** 时长展示：1.8s */
export function formatSeconds(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0.0s'
  return `${(durationMs / 1000).toFixed(1)}s`
}
