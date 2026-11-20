// =============================================================================
// 学习稿生成编排（Phase 2 M2）
// -----------------------------------------------------------------------------
// 职责：transcript（canonical JSON）-> 构造 prompt -> streamLLM 流式调用 ->
// 全文 JSON 解析 -> 契约校验 -> StudyNotePayload。
// 路由层只负责 SSE 转发与 HTTP 语义；本模块不碰 express、不碰 env。
//
// 契约（拆解文档 §2.2 冻结）：
//   { summary, bilingual_notes[], key_points[], vocabulary[] }
//   - summary 与双语解释拆开，四要素独立可编辑；
//   - vocabulary 项 { word, pos, gloss }：word/gloss 必需，pos 缺失按空串
//     （词是资产，pos 丢了只是前端查不到本地词库，标「AI 生成」即可，不丢词）；
//   - LLM 少给/给错的内容：逐项守卫静默丢弃，绝不编造补齐。
// 校验兜底：四要素全空视为失败（LlmError upstream），前端提示重试。
//
// 语言自适应（决策 2026-10-22 用户确认，中英双译）：
//   transcript.language 以 zh 开头（中文素材）时：
//     · bilingual_notes 方向反转——zh 填字幕里的中文原句，en 填该句英译
//       （与英文素材时 en 原句 + zh 翻译对称，存储契约 en/zh 语义不变）；
//     · vocabulary 恒为空数组——中文素材不生成英文词汇（前端词汇区直接省略）。
//   其余语言（en / und / 其它）沿用原英文中心 prompt，行为零变化。
// =============================================================================

import type { AiConfig } from './config';
import { LlmError, streamLLM } from './llm';
import {
  asString,
  isRecord,
  type AsrTranscript,
  type StudyNoteBilingualNote,
  type StudyNotePayload,
  type StudyNoteRequest,
  type StudyNoteVocabulary,
} from './types';

// -----------------------------------------------------------------------------
// Prompt（按字幕语种二选一；契约四要素不变）
// -----------------------------------------------------------------------------

/** 英文素材（默认）：en 填英文原句，zh 填中文翻译/语言点解释。 */
const SYSTEM_PROMPT_EN = `你是一位英语学习材料编辑。用户会给你一份带时间戳的视频字幕，请输出一份结构化学习稿，严格按以下 JSON 格式返回（不要输出任何其他文字，不要用 markdown 代码块包裹）：

{
  "summary": "用 2-4 句中文概括视频内容",
  "bilingual_notes": [
    { "en": "字幕中出现过的英文原句（可截取完整分句）", "zh": "该句的中文翻译或语言点解释" }
  ],
  "key_points": ["用中文写的知识点或要点，每条一句话"],
  "vocabulary": [
    { "word": "值得学习的英文单词或短语（保留原文形态）", "pos": "词性，如 noun/verb/adjective/phrase；无法判断时填空字符串", "gloss": "该词在字幕语境中的中文释义" }
  ]
}

要求：
1. 只输出 JSON 对象本身，不要输出任何解释文字。
2. bilingual_notes 的 en 必须是字幕里出现过的原句，不要自己编造句；选 3-8 个最有学习价值的句子。
3. vocabulary 选 5-15 个最有学习价值的词或短语，宁缺毋滥；gloss 必须结合字幕语境，不要照搬通用词典义。
4. key_points 列 3-8 条，聚焦语言点（语法、句型、地道表达）与内容要点。
5. 四个字段必须全部存在；某类没有内容时输出空数组 []，不要省略字段。`;

/**
 * 中文素材（决策 2026-10-22）：双语解释中英双译——zh 填字幕里的中文原句，
 * en 填该句的英文翻译；vocabulary 恒为空数组（中文素材不生成英文词汇）。
 * summary / key_points 口径与英文素材一致（中文输出）。
 */
const SYSTEM_PROMPT_ZH = `你是一位中文学习材料编辑。用户会给你一份带时间戳的中文视频字幕，请输出一份结构化学习稿，严格按以下 JSON 格式返回（不要输出任何其他文字，不要用 markdown 代码块包裹）：

{
  "summary": "用 2-4 句中文概括视频内容",
  "bilingual_notes": [
    { "zh": "字幕中出现过的中文原句（可截取完整分句）", "en": "该句的英文翻译" }
  ],
  "key_points": ["用中文写的知识点或要点，每条一句话"],
  "vocabulary": []
}

要求：
1. 只输出 JSON 对象本身，不要输出任何解释文字。
2. bilingual_notes 的 zh 必须是字幕里出现过的中文原句，不要自己编造句；选 3-8 个最有学习价值的句子，en 给出准确、自然的英文翻译。
3. vocabulary 恒为空数组 []：这是中文素材的学习稿，不生成英文词条，不要输出任何词汇。
4. key_points 列 3-8 条，聚焦内容要点与中文语言点（修辞、典故、地道表达）。
5. 四个字段必须全部存在；某类没有内容时输出空数组 []，不要省略字段。`;

/** 字幕语种是否中文素材（zh / zh-CN / zh-Hans…；大小写与分隔符宽容）。 */
export function isChineseSource(language: string): boolean {
  return language.trim().toLowerCase().replace('_', '-').startsWith('zh');
}

/** 秒 -> [mm:ss]（>= 1h 用 h:mm:ss）。 */
function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** user 消息：语言 + 逐段 [起–止] 文本（段索引即行号，供前端回溯对照）。 */
function buildTranscriptUserPrompt(transcript: AsrTranscript): string {
  const lines: string[] = [];
  lines.push(`以下是视频字幕（语言：${transcript.language}），共 ${transcript.segments.length} 段，格式为 [开始时间–结束时间] 文本：`);
  lines.push('');
  for (const segment of transcript.segments) {
    lines.push(`[${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)}] ${segment.text}`);
  }
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// 请求体解析（路由层调用；坏输入返回 null 与可读原因）
// -----------------------------------------------------------------------------

/** 请求体 -> StudyNoteRequest；任何字段不符返回 { ok: false, message }。 */
export function parseStudyNoteRequest(
  body: unknown,
): { ok: true; request: StudyNoteRequest } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: '请求体必须是 JSON 对象' };
  const transcriptValue = body['transcript'];
  if (!isRecord(transcriptValue)) {
    return { ok: false, message: '缺少 transcript 字段（canonical 字幕 JSON）' };
  }
  const language = asString(transcriptValue['language']);
  if (language === null) return { ok: false, message: 'transcript.language 必须是非空字符串' };
  const duration = transcriptValue['duration'];
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    return { ok: false, message: 'transcript.duration 必须是非负数字（秒）' };
  }
  const rawSegments = transcriptValue['segments'];
  if (!Array.isArray(rawSegments)) {
    return { ok: false, message: 'transcript.segments 必须是数组' };
  }
  const segments: AsrTranscript['segments'] = [];
  for (const raw of rawSegments) {
    if (!isRecord(raw)) return { ok: false, message: 'transcript.segments 含非对象元素' };
    const start = raw['start'];
    const end = raw['end'];
    const text = asString(raw['text']);
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
      return { ok: false, message: 'transcript.segments[].start 必须是非负数字（秒）' };
    }
    if (typeof end !== 'number' || !Number.isFinite(end) || end < start) {
      return { ok: false, message: 'transcript.segments[].end 必须是不小于 start 的数字（秒）' };
    }
    if (text === null) return { ok: false, message: 'transcript.segments[].text 必须是非空字符串' };
    segments.push({ start, end, text });
  }
  if (segments.length === 0) return { ok: false, message: 'transcript.segments 不能为空' };
  return { ok: true, request: { transcript: { language, duration, segments } } };
}

// -----------------------------------------------------------------------------
// 契约校验（LLM 输出 -> StudyNotePayload；坏项静默丢弃，全空判失败）
// -----------------------------------------------------------------------------

/** 剥 ```json 围栏 + trim；JSON.parse 失败返回 null（不抛，编排层转 LlmError）。 */
function parseLlmJson(text: string): unknown {
  let trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  if (fenced !== null) trimmed = (fenced[1] ?? '').trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** 逐字段守卫收敛 LLM 输出；四要素全空（summary 空且三数组空）才判 null。 */
export function validateStudyNotePayload(value: unknown): StudyNotePayload | null {
  if (!isRecord(value)) return null;

  const summary = asString(value['summary']) ?? '';

  const bilingualNotes: StudyNoteBilingualNote[] = [];
  for (const item of Array.isArray(value['bilingual_notes']) ? value['bilingual_notes'] : []) {
    if (!isRecord(item)) continue;
    const en = asString(item['en']);
    const zh = asString(item['zh']);
    if (en === null || zh === null) continue;
    bilingualNotes.push({ en, zh });
  }

  const keyPoints: string[] = [];
  for (const item of Array.isArray(value['key_points']) ? value['key_points'] : []) {
    const point = asString(item);
    if (point !== null) keyPoints.push(point);
  }

  const vocabulary: StudyNoteVocabulary[] = [];
  const seenWords = new Set<string>();
  for (const item of Array.isArray(value['vocabulary']) ? value['vocabulary'] : []) {
    if (!isRecord(item)) continue;
    const word = asString(item['word']);
    const gloss = asString(item['gloss']);
    if (word === null || gloss === null) continue; // 缺词或缺释义：丢（词没了释义无意义）
    if (seenWords.has(word.toLowerCase())) continue; // LLM 重复给词：去重
    seenWords.add(word.toLowerCase());
    const pos = asString(item['pos']) ?? '';
    vocabulary.push({ word, pos, gloss });
  }

  if (summary === '' && bilingualNotes.length === 0 && keyPoints.length === 0 && vocabulary.length === 0) {
    return null;
  }
  return { summary, bilingual_notes: bilingualNotes, key_points: keyPoints, vocabulary };
}

// -----------------------------------------------------------------------------
// 生成编排
// -----------------------------------------------------------------------------

export interface RunStudyNoteOptions {
  config: AiConfig;
  /** 每个增量 token 的回调（路由层写 SSE delta 事件） */
  onToken?: (token: string, fullText: string) => void;
  /** 客户端断开信号：中断即 abort 上游 */
  signal?: AbortSignal;
  /** 注入用（单测） */
  fetchImpl?: typeof fetch;
}

/**
 * 按字幕语种组装 messages：中文素材走中译英 prompt（词汇恒空），
 * 其余走英文中心 prompt。导出供单测直接断言两种分支。
 */
export function buildStudyNoteMessages(
  request: StudyNoteRequest,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = isChineseSource(request.transcript.language) ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;
  return [
    { role: 'system', content: system },
    { role: 'user', content: buildTranscriptUserPrompt(request.transcript) },
  ];
}

/**
 * 端到端生成学习稿：prompt -> 流式调用 -> 全文 JSON -> 契约校验。
 * 段数上限、请求体形状由路由层负责（400）；这里失败一律 LlmError。
 */
export async function runStudyNoteGeneration(
  request: StudyNoteRequest,
  options: RunStudyNoteOptions,
): Promise<StudyNotePayload> {
  const messages = buildStudyNoteMessages(request);

  const fullText = await streamLLM(messages, (token, full) => {
    options.onToken?.(token, full);
  }, {
    config: options.config,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });

  const parsed = parseLlmJson(fullText);
  const payload = validateStudyNotePayload(parsed);
  if (payload === null) {
    throw new LlmError('upstream', 'LLM 未返回可解析的学习稿结构（JSON 契约校验失败）');
  }
  return payload;
}
