// =============================================================================
// 入库编排：把 OCR 归一化页按 page_kind 分派给对应 parser
//
// 【为什么单独成文件】
// 旧实现这套分派逻辑只存在于 OcrPipeline 内部。本机实测发现「清洗脏库后重跑」
// 是刚需（解析器一旦修好，就要拿库里留存的原始 OCR JSON 重放一遍），
// 如果重跑脚本再抄一份，两边必然漂移。这里抽成唯一实现：
//   · 实时扫描（OcrPipeline）
//   · 离线重跑（scripts/reparse.ts）
//   · 人工确认入库（scripts/confirm.ts）
// 共用同一套分派规则。
//
// 【两段式（2026-10-06）】
//   parseIngestPages  纯解析：OCR 页 -> 结构化草稿（EntryDraft/TocDraft/GrammarRuleDraft），
//                     不碰数据库。
//   applyParsedDrafts 确认入库：草稿 -> upsert 正式三表。
// 实时管线与重跑脚本在解析后只把草稿暂存到 scan_records.parsed_drafts
// （status='parsed'），等人工 `npm run db:review` 核对、`npm run db:confirm`
// 确认后才调用 applyParsedDrafts —— 「识别后先检查数据是否正确，正确再入库」。
// =============================================================================

import type { DictionaryRepository } from '../db/repository';
import { classifyPage } from '../parsers/classify';
import { parseEntryPages } from '../parsers/entry';
import { parseInstructionPages } from '../parsers/instruction';
import { collectTables, mapIrregularVerbs } from '../parsers/table';
import { parseTocPages } from '../parsers/toc';
import {
  EMPTY_PARSER_RULES,
  type OcrPage,
  type PageKind,
  type ParsedDrafts,
  type ParserRules,
  type ScanProcessSummary,
  type ScanPurpose,
  type TocDraft,
} from '../types';

export interface IngestInput {
  pages: readonly OcrPage[];
  sourceBook: string;
  purpose: ScanPurpose;
  /** 提交时指定的页面类型；unknown 时逐页自动分类 */
  requestedKind: PageKind;
  sourcePage: number | null;
  /** 该书「使用说明」页已沉淀的规则；同一批内会被 instruction 页持续更新 */
  initialRules?: ParserRules;
}

export interface ParsedIngest {
  summary: ScanProcessSummary;
  /** 本批结束后生效的解析规则（有 instruction 页则为最新规则，否则为输入值） */
  rules: ParserRules;
  /** 解析出的全部草稿（尚未入库） */
  drafts: ParsedDrafts;
}

export interface ApplyDraftsInput {
  drafts: ParsedDrafts;
  sourceBook: string;
  /**
   * 目录 order_index 起始偏移。
   * 目录页往往有多张，每张内部的 order_index 都从 0 开始，直接入库会让多张目录
   * 的条目交错显示。确认入库时按批次累加偏移，保证同一本书内全局有序。
   */
  tocOrderOffset?: number;
}

function newSummary(pageKind: PageKind): ScanProcessSummary {
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

/** 兼容旧名（scripts/ 里还在用）：空摘要 */
export const emptySummary = newSummary;

/** 把目录草稿的 order_index 整体平移（用于多张目录页拼接排序）。 */
function shiftTocOrder(drafts: TocDraft[], offset: number): TocDraft[] {
  if (offset <= 0) return drafts;
  return drafts.map((draft) => ({ ...draft, orderIndex: draft.orderIndex + offset }));
}

/**
 * 纯解析：按页类型分派 parser，产出结构化草稿。不写任何表。
 * unknown 页保留原始 OCR 交人工复核，绝不猜测入库。
 */
export function parseIngestPages(input: IngestInput): ParsedIngest {
  const summary = newSummary(input.requestedKind);
  for (const page of input.pages) {
    summary.blocks += page.blocks.length;
    summary.tables += page.tables.length;
  }

  let rules: ParserRules = input.initialRules ?? EMPTY_PARSER_RULES;
  const drafts: ParsedDrafts = { entries: [], toc: [], grammar: [] };
  if (input.pages.length === 0) return { summary, rules, drafts };

  for (const page of input.pages) {
    const pageKind =
      input.requestedKind === 'unknown'
        ? classifyPage(page, { purpose: input.purpose })
        : input.requestedKind;

    switch (pageKind) {
      case 'material':
        break;

      case 'instruction': {
        rules = parseInstructionPages([page], rules);
        summary.parserRulesUpdated = true;
        break;
      }

      case 'toc': {
        drafts.toc.push(...parseTocPages([page]));
        break;
      }

      case 'entry': {
        drafts.entries.push(...parseEntryPages([page], rules, () => input.sourcePage));
        break;
      }

      case 'table': {
        drafts.grammar.push(
          ...mapIrregularVerbs(collectTables([page]), { sourcePage: input.sourcePage }),
        );
        break;
      }

      case 'unknown':
        break;
    }
  }

  summary.entriesUpserted = drafts.entries.length;
  summary.tocUpserted = drafts.toc.length;
  summary.grammarUpserted = drafts.grammar.length;
  return { summary, rules, drafts };
}

/** 确认入库：把（人工核对过的）草稿 upsert 进正式三表。 */
export async function applyParsedDrafts(
  repository: DictionaryRepository,
  input: ApplyDraftsInput,
): Promise<ScanProcessSummary> {
  const summary = newSummary('unknown');
  summary.entriesUpserted = await repository.upsertEntries(input.drafts.entries, input.sourceBook);
  summary.tocUpserted = await repository.upsertToc(
    shiftTocOrder(input.drafts.toc, input.tocOrderOffset ?? 0),
    input.sourceBook,
  );
  summary.grammarUpserted = await repository.upsertGrammarRules(
    input.drafts.grammar,
    input.sourceBook,
  );
  return summary;
}
