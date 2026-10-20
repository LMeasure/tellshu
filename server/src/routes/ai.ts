// =============================================================================
// AI 学习稿生成（Phase 2 M2）
// -----------------------------------------------------------------------------
// POST /api/ai/study-notes  body: { transcript: canonical 字幕 JSON }
//   200 text/event-stream（SSE）：
//     data: {"type":"delta","text":"..."}                              逐字增量
//     data: {"type":"done","note":{summary,bilingual_notes,...}}      完成
//     data: {"type":"error","code":"...","message":"..."}             失败
//        code 取值与 LlmError.kind 对齐：unconfigured / unavailable /
//        timeout_first_token / timeout_stream / upstream / aborted / internal
//   400 请求体不符 / 字幕为空 / 段数超上限（AI_MAX_SEGMENTS）
//   503 AI 未接入（缺少 AI_BASE_URL / AI_API_KEY / AI_MODEL）
//
// 错误分层：未接入/请求体错误发生在写 SSE 头之前，走 ApiError 统一 JSON 响应；
// 头写之后的失败只能以 SSE error 事件回吐（HTTP 状态已定，code 承载语义）。
// 客户端断开（res 'close' 且未正常结束）-> AbortController 中断上游，
// 不再回事件（写了也没人收，还白烧 token）。
// =============================================================================

import { Router } from 'express';
import type { AiConfig } from '../config';
import { ApiError, asyncHandler } from '../http/errors';
import { createIpRateLimiter } from '../http/rateLimit';
import type { Response } from 'express';
import { LlmError, isAiConfigured } from '../llm';
import { parseStudyNoteRequest, runStudyNoteGeneration } from '../llmStudyNote';
import type { StudyNoteEvent } from '../types';

export interface AiRouteDeps {
  config: AiConfig;
  /** 仅测试注入的打桩 fetch（默认走 globalThis.fetch 真实调云端 LLM）。 */
  fetchImpl?: typeof fetch;
}

/** 与 ASR 一致：10 次/小时/IP（云端 LLM 计费调用，从紧）。 */
const studyNoteRateLimit = createIpRateLimiter({
  windowMs: 60 * 60 * 1_000,
  maxRequests: 10,
});

/** 写一条 SSE 事件；连接已断/已结束时静默跳过（返回 false）。 */
function writeEvent(res: Response, event: StudyNoteEvent): boolean {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}

export function createAiRouter(deps: AiRouteDeps): Router {
  const router = Router();

  router.post(
    '/ai/study-notes',
    studyNoteRateLimit,
    asyncHandler(async (req, res) => {
      // ── 1) 未接入优先判定（写 SSE 头之前，走统一 JSON 错误响应） ──
      if (!isAiConfigured(deps.config)) {
        throw ApiError.serviceUnavailable(
          'AI 学习稿生成服务未接入：请在 server/.env 配置 AI_BASE_URL / AI_API_KEY / AI_MODEL',
        );
      }

      // ── 2) 请求体 / 段数校验（同样是写头之前的 400） ──
      const parsed = parseStudyNoteRequest(req.body);
      if (!parsed.ok) {
        throw ApiError.badRequest(`学习稿请求无效：${parsed.message}`);
      }
      const segmentCount = parsed.request.transcript.segments.length;
      if (segmentCount > deps.config.maxSegments) {
        throw ApiError.badRequest(
          `字幕段数 ${segmentCount} 超过单次上限 ${deps.config.maxSegments}，请分段生成`,
        );
      }

      // ── 3) SSE 头 + 客户端断开监听 ──
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // 防反代缓冲（nginx 等）把流攒着不吐
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const abortController = new AbortController();
      // 底层连接错误（客户端强杀）可能以 'error' 事件到达，未监听会抛未捕获异常
      res.on('error', () => abortController.abort());
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });

      // ── 4) 生成 + SSE 转发 ──
      try {
        const note = await runStudyNoteGeneration(parsed.request, {
          config: deps.config,
          signal: abortController.signal,
          fetchImpl: deps.fetchImpl,
          onToken: (token) => {
            if (!writeEvent(res, { type: 'delta', text: token })) {
              abortController.abort(); // 连接已断：立刻停上游，别白烧 token
            }
          },
        });
        writeEvent(res, { type: 'done', note });
      } catch (error) {
        if (error instanceof LlmError) {
          if (error.kind === 'aborted') {
            res.end(); // 客户端自己断的：不发事件，直接收
            return;
          }
          writeEvent(res, { type: 'error', code: error.kind, message: error.message });
        } else {
          // 编排层非预期异常：不把内部细节透出前端
          writeEvent(res, { type: 'error', code: 'internal', message: '生成失败，请稍后重试' });
        }
      }
      res.end();
    }),
  );

  return router;
}
