// =============================================================================
// OCR 扫描流水线：提交 -> 轮询 -> 下载 JSONL -> 归一化 -> 解析 -> 入库
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { DictionaryRepository } from '../db/repository';
import { ApiError } from '../http/errors';
import { extractOcrPagesFromJsonLines } from '../parsers/adapter';
import { PaddleOcrClient, describePaddleError } from '../paddle/client';
import { parseIngestPages } from './ingest';
import type { IncomingImage } from './storage';
import { saveImage } from './storage';
import {
  EMPTY_PARSER_RULES,
  type OcrPage,
  type PageKind,
  type ParsedDrafts,
  type ParserRules,
  type ScanPurpose,
  type ScanStatus,
  type ScanProcessSummary,
} from '../types';
import type { ScanRow } from '../db/repository';

/** raw_ocr_json 最多保留的结果条数，避免单条记录撑爆 jsonb。 */
const MAX_RAW_RESULTS = 20;

/** 旁路 OCR（如格式转换结果→文章）的总等待上限；超过即判定超时。 */
const OCR_TOTAL_TIMEOUT_MS = 90_000;
/** 旁路 OCR 轮询 Paddle 任务状态的间隔。 */
const OCR_POLL_INTERVAL_MS = 1_500;

export interface SubmitScanInput {
  images: readonly IncomingImage[];
  purpose: ScanPurpose;
  pageKind: PageKind;
  sourceBook: string;
  pageNumbers?: readonly (number | null)[];
}

export interface SubmittedScan {
  scanId: string;
  jobId: string | null;
  status: ScanStatus;
  imagePath: string | null;
  error: { code: string; message: string } | null;
}

export interface SubmitScanResult {
  batchId: string;
  scans: SubmittedScan[];
}

export interface SyncScanResult {
  scanId: string;
  batchId: string;
  jobId: string | null;
  status: ScanStatus;
  sourceBook: string;
  pageKind: PageKind;
  text: string | null;
  summary: ScanProcessSummary | null;
  error: { code: string; message: string } | null;
}

export interface SyncBatchResult {
  batchId: string;
  total: number;
  byStatus: Record<ScanStatus, number>;
  processed: number;
  summary: ScanProcessSummary;
  scans: SyncScanResult[];
}

function emptySummary(pageKind: PageKind): ScanProcessSummary {
  return {
    pageKind,
    entriesUpserted: 0,
    tocUpserted: 0,
    grammarUpserted: 0,
    blocks: 0,
    tables: 0,
    parserRulesUpdated: false,
  };
}

function mergeSummary(target: ScanProcessSummary, source: ScanProcessSummary): void {
  target.entriesUpserted += source.entriesUpserted;
  target.tocUpserted += source.tocUpserted;
  target.grammarUpserted += source.grammarUpserted;
  target.blocks += source.blocks;
  target.tables += source.tables;
  target.parserRulesUpdated = target.parserRulesUpdated || source.parserRulesUpdated;
}

function emptyStatusCounts(): Record<ScanStatus, number> {
  return { queued: 0, pending: 0, running: 0, parsed: 0, done: 0, failed: 0 };
}

/** 把 JSONL 文本解析成归一化页，同时保留原始结果（截断）用于归档。 */
function parseJsonl(jsonl: string): { pages: OcrPage[]; rawResults: unknown[] } {
  const pages: OcrPage[] = [];
  const rawResults: unknown[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (rawResults.length < MAX_RAW_RESULTS) rawResults.push(parsed);
    pages.push(...extractOcrPagesFromJsonLines(trimmed));
  }
  return { pages, rawResults };
}

function pagesToText(pages: readonly OcrPage[]): string {
  const chunks: string[] = [];
  for (const page of pages) {
    if (page.markdown.trim() !== '') {
      chunks.push(page.markdown);
      continue;
    }
    chunks.push(page.blocks.map((block) => block.text).join('\n'));
  }
  return chunks.filter((chunk) => chunk.trim() !== '').join('\n\n');
}

export class OcrPipeline {
  constructor(
    private readonly paddle: PaddleOcrClient,
    private readonly repository: DictionaryRepository,
    private readonly storageDir: string,
  ) {}

  /** 落盘 + 建记录 + 提交 Paddle 任务。 */
  async submit(input: SubmitScanInput): Promise<SubmitScanResult> {
    const batchId = randomUUID();
    const scans: SubmittedScan[] = [];

    for (let index = 0; index < input.images.length; index += 1) {
      const image = input.images[index];
      if (!image) continue;
      const pageNumber = input.pageNumbers?.[index] ?? null;

      let stored: { relativePath: string } | null = null;
      try {
        const saved = await saveImage(this.storageDir, image);
        stored = { relativePath: saved.relativePath };
        const scanId = await this.repository.insertScan({
          batchId,
          sourceBook: input.sourceBook,
          purpose: input.purpose,
          pageKind: input.pageKind,
          imagePath: saved.relativePath,
          imageName: saved.originalName,
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
          pageNumber,
        });

        try {
          const submitted = await this.paddle.submitJob({
            buffer: image.buffer,
            fileName: `${scanId}.jpg`,
            mimeType: image.mimeType,
            batchId,
          });
          await this.repository.markScanSubmitted(scanId, submitted.jobId);
          scans.push({
            scanId,
            jobId: submitted.jobId,
            status: 'pending',
            imagePath: saved.relativePath,
            error: null,
          });
        } catch (error) {
          const message = describePaddleError(error);
          await this.repository.markScanFailed(scanId, 'paddle_submit_failed', message);
          scans.push({
            scanId,
            jobId: null,
            status: 'failed',
            imagePath: saved.relativePath,
            error: { code: 'paddle_submit_failed', message },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        scans.push({
          scanId: '',
          jobId: null,
          status: 'failed',
          imagePath: stored?.relativePath ?? null,
          error: { code: 'store_failed', message },
        });
      }
    }

    return { batchId, scans };
  }

  /**
   * 直接对一批内存图片做 OCR，按页码顺序返回拼接文本。
   *
   * 与 `submit()` 不同：不落 OCR 扫描表、不持久化图片，专为「调用方已持有图片字节」的旁路场景设计
   * （如格式转换结果 → 文章）。上游（PaddleOCR）不可用时抛 503；单页失败整体抛 502；
   * 全程不编造/不跳过任何页，保证文本真实。同步阻塞直到全部完成或超时（适合用户主动触发的「保存」动作）。
   */
  async ocrBuffersToText(
    images: readonly IncomingImage[],
  ): Promise<{ text: string; pages: number }> {
    if (images.length === 0) return { text: '', pages: 0 };
    if (!this.paddle.configured) {
      throw ApiError.serviceUnavailable('OCR 服务未接入（PaddleOCR 未配置，无法提取文字）');
    }

    const batchId = randomUUID();
    const jobs: Array<{ index: number; jobId: string }> = [];
    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      if (!image) continue;
      const submitted = await this.paddle.submitJob({
        buffer: image.buffer,
        fileName: `${batchId}-${i}.png`,
        mimeType: image.mimeType,
        batchId,
      });
      jobs.push({ index: i, jobId: submitted.jobId });
    }

    const texts: Array<string | null> = new Array(images.length).fill(null);
    const deadline = Date.now() + OCR_TOTAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let pending = 0;
      for (const job of jobs) {
        if (texts[job.index] !== null) continue;
        const status = await this.paddle.getJobStatus(job.jobId);
        if (status.state === 'done') {
          const jsonUrl = status.resultUrl?.jsonUrl;
          if (jsonUrl === undefined || jsonUrl === null || jsonUrl === '') {
            throw ApiError.upstream(`OCR 第 ${job.index + 1} 页完成但未返回结果地址`);
          }
          const jsonl = await this.paddle.downloadJsonl(jsonUrl);
          const { pages } = parseJsonl(jsonl);
          texts[job.index] = pagesToText(pages);
        } else if (status.state === 'failed') {
          throw ApiError.upstream(`OCR 第 ${job.index + 1} 页识别失败：${status.errorMsg ?? '未知错误'}`);
        } else {
          pending += 1;
        }
      }
      if (pending === 0) break;
      await new Promise((resolve) => setTimeout(resolve, OCR_POLL_INTERVAL_MS));
    }

    if (texts.some((t) => t === null)) {
      throw ApiError.serviceUnavailable('OCR 处理超时，请稍后重试或减小文件页数');
    }
    const text = texts.filter((t): t is string => t !== null).join('\n\n');
    return { text, pages: texts.length };
  }

  /** 轮询单个扫描：done 后归档原始 JSON 并按 page_kind 解析入库。 */
  async syncScan(scanId: string): Promise<SyncScanResult> {
    const scan = await this.repository.getScan(scanId);
    if (scan === null) {
      throw ApiError.notFound(`扫描记录不存在：${scanId}`);
    }
    return this.syncScanRow(scan);
  }

  private async syncScanRow(scan: ScanRow): Promise<SyncScanResult> {
    const base: SyncScanResult = {
      scanId: scan.id,
      batchId: scan.batch_id,
      jobId: scan.job_id,
      status: scan.status,
      sourceBook: scan.source_book,
      pageKind: scan.page_kind,
      text: scan.result_text,
      summary: null,
      error:
        scan.error_code === null ? null : { code: scan.error_code, message: scan.error_message ?? '' },
    };

    if (scan.status === 'done' || scan.status === 'failed') return base;
    if (scan.job_id === null) return base;

    let status;
    try {
      status = await this.paddle.getJobStatus(scan.job_id);
    } catch (error) {
      const message = describePaddleError(error);
      // 查询失败不终结任务，保留原状态并透出原因
      return { ...base, error: { code: 'paddle_poll_failed', message } };
    }

    if (status.state === 'pending' || status.state === 'running') {
      await this.repository.markScanStatus(scan.id, status.state);
      return { ...base, status: status.state };
    }

    if (status.state === 'failed') {
      const code = status.errorCode === null ? 'paddle_job_failed' : `paddle_${status.errorCode}`;
      const message = status.errorMsg ?? 'OCR 任务失败';
      await this.repository.markScanFailed(scan.id, code, message);
      return { ...base, status: 'failed', error: { code, message } };
    }

    // done：立即下载 JSONL
    const jsonUrl = status.resultUrl?.jsonUrl;
    if (jsonUrl === undefined || jsonUrl === null || jsonUrl === '') {
      const message = 'OCR 任务完成但未返回结果地址';
      await this.repository.markScanFailed(scan.id, 'paddle_result_missing', message);
      return { ...base, status: 'failed', error: { code: 'paddle_result_missing', message } };
    }

    let jsonl: string;
    try {
      jsonl = await this.paddle.downloadJsonl(jsonUrl);
    } catch (error) {
      const message = describePaddleError(error);
      await this.repository.markScanFailed(scan.id, 'paddle_download_failed', message);
      return { ...base, status: 'failed', error: { code: 'paddle_download_failed', message } };
    }

    const { pages, rawResults } = parseJsonl(jsonl);
    const text = pagesToText(pages);

    // material 用途：没有结构化草稿，识别文本即最终产物，完成即 done（历史行为不变）
    if (scan.purpose !== 'dictionary') {
      await this.repository.completeScan(scan.id, {
        resultText: text,
        rawOcrJson: { lineResults: rawResults },
        parserRules: null,
      });
      return { ...base, status: 'done', text };
    }

    // dictionary 用途：解析出结构化草稿后【暂存待确认】，不直接写正式表。
    // 人工 `npm run db:review` 核对 -> `npm run db:confirm` 后才 upsert。
    try {
      const processed = await this.parsePages(pages, scan);
      await this.repository.stageParsedScan(scan.id, {
        resultText: text,
        rawOcrJson: { lineResults: rawResults },
        parserRules: processed.parserRules,
        drafts: processed.drafts,
      });
      return { ...base, status: 'parsed', text, summary: processed.summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 解析失败：保留原文与原始 JSON（status=done + parse_failed），无草稿可确认
      await this.repository.completeScan(scan.id, {
        resultText: text,
        rawOcrJson: { lineResults: rawResults },
        parserRules: null,
      });
      return {
        ...base,
        status: 'done',
        text,
        error: { code: 'parse_failed', message },
      };
    }
  }

  /** 按 page_kind 分派解析器，产出【未入库】的草稿；unknown 会逐页自动分类。
   *  分派规则统一收敛在 ocr/ingest.ts，实时管线与离线重跑共用同一份实现。 */
  private async parsePages(
    pages: readonly OcrPage[],
    scan: ScanRow,
  ): Promise<{
    summary: ScanProcessSummary;
    parserRules: ParserRules | null;
    drafts: ParsedDrafts;
  }> {
    const sourcePage = scan.page_number;
    const initialRules =
      scan.purpose === 'dictionary'
        ? (await this.repository.getParserRules(scan.source_book)) ?? EMPTY_PARSER_RULES
        : EMPTY_PARSER_RULES;

    const outcome = parseIngestPages({
      pages,
      sourceBook: scan.source_book,
      purpose: scan.purpose,
      requestedKind: scan.page_kind,
      sourcePage,
      initialRules,
    });

    return {
      summary: outcome.summary,
      parserRules: outcome.summary.parserRulesUpdated ? outcome.rules : null,
      drafts: outcome.drafts,
    };
  }

  /** 轮询整批：逐条 syncScan，聚合摘要。 */
  async syncBatch(batchId: string): Promise<SyncBatchResult> {
    const rows = await this.repository.listScansByBatch(batchId);
    if (rows.length === 0) {
      throw ApiError.notFound(`批次不存在或为空：${batchId}`);
    }

    const byStatus = emptyStatusCounts();
    const summary = emptySummary('unknown');
    const scans: SyncScanResult[] = [];
    let processed = 0;

    for (const row of rows) {
      const result = await this.syncScanRow(row);
      scans.push(result);
      byStatus[result.status] += 1;
      if (result.status === 'done') processed += 1;
      if (result.summary !== null) mergeSummary(summary, result.summary);
    }

    const firstKind = rows[0]?.page_kind ?? 'unknown';
    summary.pageKind = firstKind;

    return { batchId, total: rows.length, byStatus, processed, summary, scans };
  }
}
