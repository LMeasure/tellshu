// =============================================================================
// parser 单测：覆盖用户给出的四类真实样本
//   1. 目录页（缩进层级 + 引导点页码）
//   2. 词条正文页（词头 / 音标 / 词性 / 英中释义 / 例句 / 同反义 / 短语 / 词根）
//   3. 不规则动词表（markdown -> 二维数组 -> grammar_rules）
//   4. 使用说明页 -> ParserRules
// 另含 PaddleOCR JSONL 适配器与页面分类器的验证。
//
// 运行：cd server && npm test
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractOcrPages, extractOcrPagesFromJsonLines } from '../src/parsers/adapter';
import { classifyPage } from '../src/parsers/classify';
import { parseEntryPage, parseEntryPages } from '../src/parsers/entry';
import { parseInstructionPages } from '../src/parsers/instruction';
import {
  mapIrregularVerbs,
  parseHtmlTables,
  parseIrregularVerbsFromHtml,
  parseMarkdownTables,
} from '../src/parsers/table';
import { buildTocTree, parseTocPage, parseTocPages } from '../src/parsers/toc';
import { EMPTY_PARSER_RULES, type OcrPage } from '../src/types';

/** 把 markdown 包成 PaddleOCR 异步 API 的 JSONL（layoutParsingResults 形态） */
function toJsonLines(markdown: string): string {
  return JSON.stringify({
    result: {
      layoutParsingResults: [{ markdown: { text: markdown }, prunedResult: {} }],
    },
  });
}

function pagesOf(markdown: string): OcrPage[] {
  return extractOcrPagesFromJsonLines(toJsonLines(markdown));
}

// -----------------------------------------------------------------------------
// 0. 适配器
// -----------------------------------------------------------------------------

test('adapter: JSONL -> OcrPage，并自动抽出 markdown 表格', () => {
  const pages = pagesOf('第一章\n| 原形 | 过去式 |\n| --- | --- |\n| go | went |');
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.ok(page);
  assert.equal(page.blocks.length, 1); // 表格行不算普通文本块
  assert.equal(page.tables.length, 1);
  assert.deepEqual(page.tables[0], [
    ['原形', '过去式'],
    ['go', 'went'],
  ]);
});

test('adapter: 形态 A —— layoutParsingResults[].markdown.text + prunedResult', () => {
  const line = JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: { text: '标题\n正文一行' },
          prunedResult: {
            parsing_res_list: [
              { block_label: 'doc_title', block_content: '标题', block_bbox: [10, 20, 300, 60] },
              { block_label: 'text', block_content: '正文一行', block_bbox: [30, 80, 300, 120] },
            ],
          },
        },
      ],
    },
  });
  const pages = extractOcrPagesFromJsonLines(line);
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.ok(page);
  assert.equal(page.markdown, '标题\n正文一行');
  assert.equal(page.blocks.length, 2);
  assert.equal(page.blocks[0]?.label, 'doc_title');
  // bbox -> 左缩进，目录层级判定依赖它
  assert.equal(page.blocks[0]?.indent, 10);
  assert.equal(page.blocks[1]?.indent, 30);
  assert.deepEqual(page.texts, ['标题', '正文一行']);
});

test('adapter: 形态 B —— pages[].layouts[] / tables[]', () => {
  const pages = extractOcrPages({
    result: {
      pages: [
        {
          layouts: [
            { text: '不规则动词表', bbox: [0, 0, 200, 30] },
            { text: '见下表', bbox: [40, 40, 200, 70] },
          ],
          tables: ['| 原形 | 过去式 |\n| --- | --- |\n| go | went |'],
        },
      ],
    },
  });
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.ok(page);
  assert.equal(page.blocks.length, 2);
  assert.equal(page.blocks[1]?.indent, 40);
  assert.equal(page.tables.length, 1);
  assert.deepEqual(page.tables[0], [
    ['原形', '过去式'],
    ['go', 'went'],
  ]);
});

test('adapter: 形态 C —— ocrResults[].prunedResult.rec_texts', () => {
  const pages = extractOcrPages({
    result: {
      ocrResults: [
        {
          prunedResult: {
            rec_texts: ['hello', 'world'],
            rec_boxes: [
              [
                [0, 0],
                [50, 0],
                [50, 20],
                [0, 20],
              ],
              [
                [0, 40],
                [50, 40],
                [50, 60],
                [0, 60],
              ],
            ],
          },
        },
      ],
    },
  });
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.ok(page);
  assert.deepEqual(page.texts, ['hello', 'world']);
  assert.equal(page.blocks.length, 2);
  assert.equal(page.markdown, 'hello\nworld');
  // 多边形 rec_boxes 归一化成 [x0, y0, x1, y1]
  assert.equal(page.blocks[1]?.bbox?.[1], 40);
});

test('adapter: 形态 D —— 顶层直接给出 markdown / text', () => {
  const pages = extractOcrPages({ result: { markdown: '# 单元一\nhello world' } });
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.ok(page);
  assert.equal(page.markdown, '# 单元一\nhello world');
  assert.deepEqual(page.blocks.map((block) => block.text), ['单元一', 'hello world']);
});

test('adapter: 未知形态一律返回空数组，不抛异常', () => {
  assert.deepEqual(extractOcrPages({ result: { foo: 'bar' } }), []);
  assert.deepEqual(extractOcrPages({ result: 'just a string' }), []);
  assert.deepEqual(extractOcrPages(null), []);
  assert.deepEqual(extractOcrPages(undefined), []);
  assert.deepEqual(extractOcrPages(42), []);
  assert.deepEqual(extractOcrPages([1, 2, 3]), []);
});

// -----------------------------------------------------------------------------
// 1. 目录页
// -----------------------------------------------------------------------------

const TOC_MARKDOWN = [
  '第一章  名词 ················ 1',
  '  1.1 名词的分类 ············ 2',
  '    专有名词 ················ 3',
  '    普通名词 ················ 4',
  '  1.2 名词的数 ·············· 5',
  '第二章  动词 ················ 12',
].join('\n');

test('toc: 按缩进还原层级，并抽取页码', () => {
  const drafts = parseTocPages(pagesOf(TOC_MARKDOWN));
  assert.equal(drafts.length, 6);
  assert.deepEqual(
    drafts.map((d) => d.level),
    [1, 2, 3, 3, 2, 1],
  );
  assert.deepEqual(
    drafts.map((d) => d.pageStart),
    [1, 2, 3, 4, 5, 12],
  );
  assert.equal(drafts[0]?.title, '第一章 名词');
});

test('toc: 组装成树并回填 page_end', () => {
  const tree = buildTocTree(parseTocPages(pagesOf(TOC_MARKDOWN)));
  assert.equal(tree.length, 2);
  const chapter1 = tree[0];
  assert.ok(chapter1);
  assert.equal(chapter1.title, '第一章 名词');
  assert.equal(chapter1.pageStart, 1);
  assert.equal(chapter1.pageEnd, 11); // 下一章从第 12 页开始
  assert.equal(chapter1.children.length, 2);

  const section11 = chapter1.children[0];
  assert.ok(section11);
  assert.equal(section11.title, '1.1 名词的分类');
  assert.equal(section11.pageEnd, 4);
  assert.deepEqual(
    section11.children.map((c) => c.title),
    ['专有名词', '普通名词'],
  );
});

// -----------------------------------------------------------------------------
// 2. 词条正文页
// -----------------------------------------------------------------------------

const ENTRY_MARKDOWN = [
  'abandon ★★ [əˈbændən] v. to leave sb 放弃；抛弃',
  '例：He abandoned his car in the snow. 他把车丢在雪地里。',
  '同义词 desert, forsake',
  '反义词 keep, retain',
  '短语 abandon oneself to 沉溺于',
  '词根 a-(去) + bandon(控制)',
  'ability [əˈbɪləti] n. the fact that sb can do sth 能力；才能',
  '例：She has the ability to learn fast. 她有快速学习的能力。',
].join('\n');

test('entry: 分段并抽取全部字段', () => {
  const drafts = parseEntryPages(pagesOf(ENTRY_MARKDOWN), {
    posAbbreviations: {},
    symbols: {},
    synonymMarkers: ['同义词', '近义词', 'syn.', 'synonyms'],
    antonymMarkers: ['反义词', 'ant.', 'antonyms'],
    rootAffixMarkers: ['词根', '词缀', 'root'],
    exampleMarkers: ['例', '例句', '例：', 'e.g.'],
    phraseMarkers: ['短语', '搭配', 'phrase'],
    globalTags: [],
  });

  assert.equal(drafts.length, 2);
  const first = drafts[0];
  assert.ok(first);

  assert.equal(first.word, 'abandon');
  assert.equal(first.wordKey, 'abandon');
  assert.equal(first.phonetic, 'əˈbændən');
  assert.equal(first.pos, 'verb');
  assert.equal(first.definitionEn, 'to leave sb');
  assert.equal(first.definitionZh, '放弃；抛弃');

  assert.equal(first.examples.length, 1);
  assert.equal(first.examples[0]?.en, 'He abandoned his car in the snow.');
  assert.equal(first.examples[0]?.zh, '他把车丢在雪地里。');

  assert.deepEqual(first.synonyms, ['desert', 'forsake']);
  assert.deepEqual(first.antonyms, ['keep', 'retain']);
  assert.deepEqual(first.phrases, [{ text: 'abandon oneself to', meaning: '沉溺于' }]);
  assert.equal(first.rootAffix, 'a-(去) + bandon(控制)');

  // 自动打标签：词性 + 考纲星级 + 词根 + 例句
  assert.ok(first.tags.includes('pos:verb'));
  assert.ok(first.tags.includes('syllabus:2'));
  assert.ok(first.tags.includes('has-root'));
  assert.ok(first.tags.includes('has-example'));

  const second = drafts[1];
  assert.ok(second);
  assert.equal(second.word, 'ability');
  assert.equal(second.pos, 'noun');
  assert.equal(second.definitionZh, '能力；才能');
});

// -----------------------------------------------------------------------------
// 3. 不规则动词表
// -----------------------------------------------------------------------------

const TABLE_MARKDOWN = [
  '| 动词原形 | 过去式 | 过去分词 |',
  '| --- | --- | --- |',
  '| go | went | gone |',
  '| be | was/were | been |',
  '| 原形 | 过去式 | 过去分词 |',
  '| do | did | done |',
].join('\n');

test('table: markdown 表格 -> 二维数组', () => {
  const tables = parseMarkdownTables(TABLE_MARKDOWN);
  assert.equal(tables.length, 1);
  assert.equal(tables[0]?.length, 5); // 表头 + 3 行数据（分隔行已剔除）
  assert.deepEqual(tables[0]?.[1], ['go', 'went', 'gone']);
});

test('table: 映射为 irregular-verb 规则', () => {
  const drafts = mapIrregularVerbs(parseMarkdownTables(TABLE_MARKDOWN), { sourcePage: 42 });
  assert.equal(drafts.length, 3);
  assert.equal(drafts[0]?.type, 'irregular-verb');
  assert.equal(drafts[0]?.baseForm, 'go');
  assert.equal(drafts[0]?.pastTense, 'went');
  assert.equal(drafts[0]?.pastParticiple, 'gone');
  assert.equal(drafts[1]?.baseForm, 'be');
  assert.equal(drafts[1]?.pastTense, 'was/were');
});

// -----------------------------------------------------------------------------
// 4. 使用说明页 -> ParserRules
// -----------------------------------------------------------------------------

const INSTRUCTION_MARKDOWN = [
  '使用说明',
  'n. = 名词',
  'v. = 动词',
  'vt. = 及物动词',
  '★ 表示考纲词汇',
  '同义词 用 syn. 标注',
].join('\n');

test('instruction: 抽取词性缩写与符号语义', () => {
  const rules = parseInstructionPages(pagesOf(INSTRUCTION_MARKDOWN));
  assert.equal(rules.posAbbreviations['n.'], 'noun');
  assert.equal(rules.posAbbreviations['v.'], 'verb');
  assert.equal(rules.posAbbreviations['vt.'], 'verb.transitive');
  assert.equal(rules.symbols['★'], 'syllabus');
  assert.ok(rules.globalTags.includes('syllabus'));
  assert.ok(rules.synonymMarkers.includes('syn.'));
});

// -----------------------------------------------------------------------------
// 5. 真实样本回归（2026-10-06 本机 PP-StructureV3 实测，见 server/data/dump）
//    这些用例全部来自真实 OCR 输出，目的就是锁死本次修的四个 bug 不再复发。
// -----------------------------------------------------------------------------

/** 把一段 markdown 直接当成一页（页面正文不依赖 block 时最贴近真实场景） */
function pageFromMarkdown(markdown: string): OcrPage {
  const page = pagesOf(markdown)[0];
  assert.ok(page, '至少应解析出一页');
  return page;
}

test('entry: 音节间隔号不再截断词头（aba·cus -> abacus）', () => {
  const page = pageFromMarkdown(
    [
      "aba·cus/'aebkas/n.[c] a wooden frame with small balls used for counting 算盘",
      "aban·don /'baendan/ vt.to give up; to leave sb./sth.放弃;抛弃；The sailors abandoned the ship when it was sinking.船员们离开了正在下沉的船。",
    ].join('\n'),
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);

  assert.deepEqual(
    drafts.map((draft) => draft.word),
    ['abacus', 'abandon'],
  );
  // 旧实现会产出 'aba' / 'aban'，两条词条的 word_key 撞在一起
  assert.notEqual(drafts[0]?.wordKey, drafts[1]?.wordKey);
  assert.equal(drafts[0]?.phonetic, "'aebkas");
  assert.equal(drafts[1]?.pos, 'verb.transitive');
  assert.equal(drafts[1]?.definitionZh, '放弃 抛弃；');
  assert.equal(drafts[1]?.examples[0]?.en, 'The sailors abandoned the ship when it was sinking.');
  assert.equal(drafts[1]?.examples[0]?.zh, '船员们离开了正在下沉的船。');
});

test('entry: 一行里挤了多个词条也要逐个切开（abate / abbey 不被吞）', () => {
  const page = pageFromMarkdown(
    [
      "aban·don·ment/'baendanmant/n.[U]1the act of leaving sb./sth.completely抛弃2 the act of giving sth.up放弃;中止：the government's abandonment of its new ",
      "election policy 政府对新选举政策的放弃abate /ə'bert/ v.1(of floods, storms,sounds,pain,etc.)to become less strong; to decrease（洪水、暴风雨、声音、病痛等）减少，减轻，减退:The storm abated at last.暴风雨终于减弱了。abbey/'aebi/n.[C]1a building in which monks or nuns live 修道院",
    ].join('\n\n'),
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);

  assert.deepEqual(
    drafts.map((draft) => draft.word),
    ['abandonment', 'abate', 'abbey'],
  );
  // 旧实现会把「election policy」当成新词条（例句尾巴 + 下一词条拼一起）
  assert.equal(drafts.some((draft) => draft.word === 'election policy'), false);
  assert.equal(drafts[1]?.examples[0]?.en, 'The storm abated at last.');
});

test('entry: 发音规则表里的微型词条不做正文词条（读作/ei/：gate/gert/n.）', () => {
  const page = pageFromMarkdown(
    [
      '## a在重读音节中的读音规则',
      '在开音节中读作/ei/：gate/gert/n.大门；出入口',
      '在闭音节中读作/a/:bad/baed/a.坏的',
      '/w/+a时.a读作/p/:want/wont/v.想要;需要',
    ].join('\n'),
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);
  assert.deepEqual(drafts, []);
});

test('entry: markdown 标题行不会被并进上一条词条的释义', () => {
  const page = pageFromMarkdown(
    [
      "a /,er/★★art.1 one(不定冠词，非特指)一(个、支)：She has an apple.她有一个苹果。",
      '## 用法用a或an的情况',
      'a用在以辅音音素开始的单数可数名词前，如aboy（一个男孩儿)。',
    ].join('\n'),
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);
  assert.equal(drafts.length, 1);
  const first = drafts[0];
  assert.ok(first);
  assert.equal(first.word, 'a');
  assert.equal(first.pos, 'article');
  assert.equal((first.definitionZh ?? '').includes('用法用'), false);
  assert.equal((first.definitionEn ?? '').includes('用法用'), false);
});

test('toc: 整页只有一个 block 时也要按行拆开（旧实现把整页挤成 1 行）', () => {
  const page = extractOcrPages({
    result: {
      layoutParsingResults: [
        {
          markdown: { text: '' },
          prunedResult: {
            parsing_res_list: [
              {
                block_label: 'text',
                block_bbox: [0, 0, 2000, 3000],
                block_content: ['一、关系词的用法 ......................... 1205', '名词性从句 ............................... 1208'].join('\n'),
              },
            ],
          },
        },
      ],
    },
  })[0];
  assert.ok(page);
  assert.equal(page.blocks.length, 1);

  const drafts = parseTocPage(page);
  assert.equal(drafts.length, 2);
  assert.deepEqual(
    drafts.map((draft) => draft.pageStart),
    [1205, 1208],
  );
  assert.equal(drafts[0]?.title, '一、关系词的用法');
});

test('toc: 同行多条目 + 引导点残留只取紧挨页码的那段', () => {
  const drafts = parseTocPage(
    pageFromMarkdown(['21199一、关系词的用法1205', '形容词和副词的比较级和最高级12001207'].join('\n')),
  );
  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ['一、关系词的用法', '形容词和副词的比较级和最高级'],
  );
  assert.deepEqual(
    drafts.map((draft) => draft.pageStart),
    [1205, 1200],
  );
  // 编号前缀是有语义的，不能被当成上一栏页码抹掉
  assert.equal(drafts[0]?.title.startsWith('一、'), true);
});

test('toc: 序号式索引页（1..N 条目序号）不得产出目录行', () => {
  const lines: string[] = [];
  for (let i = 1; i <= 20; i += 1) lines.push(`${i}第${i}个考点`);
  const drafts = parseTocPage(pageFromMarkdown(lines.join('\n')));
  assert.equal(drafts.length, 0);
});

test('toc: 一条页码都没有的页（动物图形图）不得产出目录行', () => {
  const drafts = parseTocPage(
    pageFromMarkdown(['gull 海鸥', 'magpie bear 熊', 'woodpecker 喜鹊', '啄木鸟', 'zebra 斑马giraffe 长颈鹿'].join('\n\n')),
  );
  assert.equal(drafts.length, 0);
});

test('table: pred_html（HTML 表格）-> 二维数组 -> 不规则动词', () => {
  const html =
    '<html><body><table>' +
    '<tr><td>动词原形(Infinitive）</td><td>过去式（Post Tense）</td><td>过去分词（Past Participle）</td></tr>' +
    '<tr><td>abide</td><td>abided,abode</td><td>abided,abode</td></tr>' +
    '<tr><td>be (am,is,are)</td><td>was,were</td><td>been</td></tr>' +
    '<tr><td>beat</td><td>beat</td><td>beaten</td></tr>' +
    '</table></body></html>';

  const tables = parseHtmlTables(html);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0]?.[0], ['动词原形(Infinitive）', '过去式（Post Tense）', '过去分词（Past Participle）']);

  const drafts = parseIrregularVerbsFromHtml(html, { sourcePage: 1216 });
  assert.equal(drafts.length, 3);
  assert.equal(drafts[1]?.baseForm, 'be (am,is,are)');
  assert.equal(drafts[1]?.pastTense, 'was,were');
  // 带括号的写法额外留下可直接检索的短形式
  assert.equal(drafts[1]?.extra['baseFormAlias'], 'be');
  assert.equal(drafts[0]?.extra['sourcePage'], 1216);
});

test('table: 非动词表（名词分类，含 rowspan/colspan）不得产出规则', () => {
  const html =
    '<html><body><table>' +
    '<tr><td rowspan="2">可数名词</td><td rowspan="2">个体名词</td><td>普通名词</td></tr>' +
    '<tr><td>集体名词</td></tr>' +
    '<tr><td colspan="2">专有名词</td><td>Beijing 北京</td></tr>' +
    '</table></body></html>';
  const tables = parseHtmlTables(html);
  assert.equal(tables[0]?.length, 3);
  assert.equal(mapIrregularVerbs(tables).length, 0);
});

test('adapter: table_res_list[].pred_html 会被抽成 page.tables（修复 grammar_rules 恒为 0）', () => {
  const pages = extractOcrPages({
    result: {
      layoutParsingResults: [
        {
          markdown: { text: '不规则动词表' },
          prunedResult: {
            parsing_res_list: [{ block_label: 'text', block_content: '不规则动词表' }],
            table_res_list: [
              {
                pred_html:
                  '<html><body><table><tr><td>动词原形</td><td>过去式</td><td>过去分词</td></tr>' +
                  '<tr><td>go</td><td>went</td><td>gone</td></tr></table></body></html>',
              },
            ],
          },
        },
      ],
    },
  });
  const page = pages[0];
  assert.ok(page);
  assert.equal(page.tables.length, 1);
  assert.deepEqual(page.tables[0]?.[1], ['go', 'went', 'gone']);
});

test('adapter: scan_records 留存的 lineResults 形态也能回放', () => {
  const raw = {
    lineResults: [
      {
        logId: 'x',
        result: {
          layoutParsingResults: [
            { markdown: { text: 'abc /x/ n. 释义' }, prunedResult: { parsing_res_list: [] } },
          ],
        },
      },
    ],
  };
  const pages = extractOcrPages(raw);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.markdown, 'abc /x/ n. 释义');
});

// -----------------------------------------------------------------------------
// 6. 页面分类
// -----------------------------------------------------------------------------

test('classify: 目录页 / 词条页 / 表格页 / 素材页', () => {
  assert.equal(classifyPage(pagesOf(TOC_MARKDOWN)[0]!, { purpose: 'dictionary' }), 'toc');
  assert.equal(classifyPage(pagesOf(ENTRY_MARKDOWN)[0]!, { purpose: 'dictionary' }), 'entry');
  assert.equal(classifyPage(pagesOf(TABLE_MARKDOWN)[0]!, { purpose: 'dictionary' }), 'table');
  assert.equal(
    classifyPage(pagesOf(INSTRUCTION_MARKDOWN)[0]!, { purpose: 'dictionary' }),
    'instruction',
  );
  assert.equal(classifyPage(pagesOf('随便一段英文短文')[0]!, { purpose: 'material' }), 'material');
});

// ---------------------------------------------------------------------------
// 义项分组（2026-10-06：例句挂到所属释义下）
// 样本取自 scan_records.result_text 真实词条页（_entry_1f2915ee 导出）。
// ---------------------------------------------------------------------------

test('entry: 义项按起始数字分组，例句挂进所属释义（真实样本 a）', () => {
  const page = pageFromMarkdown(
    'a /,er/★★art.1 one(不定冠词，非特指)一(个、支、只)：She has an apple and a pear.她有一个苹果和一个梨。' +
      '2a member of a group(某一群体中的一员)：He is a teacher.他是老师。' +
      '3 every;any(不定冠词，非特指)每个;任何一个：A bike has two wheels.(一辆)自行车有两个轮子。' +
      '4 used before sb.\'s name(用于人名之前)某一:A Mr.Smith came to see you.一位姓史密斯的先生来看你。',
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);
  assert.equal(drafts.length, 1);
  const draft = drafts[0];
  assert.ok(draft);
  assert.equal(draft.senses.length, 4);

  assert.equal(draft.senses[0]?.definitionZh.includes('不定冠词'), true);
  assert.equal(draft.senses[0]?.examples[0]?.en, 'She has an apple and a pear.');
  assert.equal(draft.senses[0]?.examples[0]?.zh, '她有一个苹果和一个梨。');

  assert.equal(draft.senses[1]?.definitionEn?.includes('a member of a group'), true);
  assert.equal(draft.senses[1]?.examples[0]?.en, 'He is a teacher.');

  assert.equal(draft.senses[2]?.definitionZh.includes('每个'), true);
  // 真实 OCR 文本里这条例句以 ".(" 结尾（"A bike has two wheels.(一辆)…"），
  // 配对判定按旧规则不认 —— 与旧版扁平抽取行为一致，不额外兜底
  assert.equal(draft.senses[2]?.examples.length, 0);

  assert.equal(draft.senses[3]?.examples[0]?.en, 'A Mr.Smith came to see you.');
  assert.equal(draft.senses[3]?.examples[0]?.zh, '一位姓史密斯的先生来看你。');

  // 顶层扁平例句 = 各义项例句的并集（向后兼容旧前端）
  assert.equal(draft.examples.length, 3);
  // 顶层释义 = 各义项释义拼接（供检索 / 旧展示）
  assert.ok((draft.definitionZh ?? '').includes('每个'));
});

test('entry: 没有义项数字的词条产出单一义项，字段与旧版一致', () => {
  const page = pageFromMarkdown(
    "aba·cus/'aebkas/n.[c] a wooden frame with small balls used for counting 算盘",
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);
  const draft = drafts[0];
  assert.ok(draft);
  assert.equal(draft.senses.length, 1);
  assert.equal(draft.senses[0]?.definitionEn, 'a wooden frame with small balls used for counting');
  assert.equal(draft.senses[0]?.definitionZh, '算盘');
  assert.equal(draft.senses[0]?.examples.length, 0);
  assert.equal(draft.definitionZh, '算盘');
});

test('entry: 中英文句子里的普通数字不会被当成义项标记', () => {
  const page = pageFromMarkdown(
    "aback /ə'bæek/ ad. backwards 向后:She walked aback to pick up her books.她走回去把书捡了起来。" +
      '他有 2 本书。He has two books.他有两本书。',
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);
  const draft = drafts[0];
  assert.ok(draft);
  // 「他有 2 本书」里的 2 不是义项标记：整条只有一个义项
  assert.equal(draft.senses.length, 1);
  assert.equal(draft.senses[0]?.examples.length, 2);
  assert.equal(draft.senses[0]?.examples[0]?.en, 'She walked aback to pick up her books.');
  assert.equal(draft.senses[0]?.examples[1]?.en, 'He has two books.');
});

test('entry: 英文释义型词条按数字分组且不吞英文小句（真实样本 abandonment）', () => {
  const page = pageFromMarkdown(
    "aban·don·ment/'baendanmant/n.[U]1the act of leaving sb./sth.completely抛弃" +
      "2 the act of giving sth.up放弃;中止：the government's abandonment of its new election policy 政府对新选举政策的放弃",
  );
  const drafts = parseEntryPage(page, EMPTY_PARSER_RULES, null);
  const draft = drafts[0];
  assert.ok(draft);
  assert.equal(draft.senses.length, 2);
  assert.equal(draft.senses[0]?.definitionEn, 'the act of leaving sb./sth.completely');
  assert.equal(draft.senses[0]?.definitionZh, '抛弃');
  assert.equal(draft.senses[1]?.definitionEn?.includes('the act of giving sth.up'), true);
  assert.equal(draft.senses[1]?.definitionZh.includes('中止'), true);
  // 英文小句归义项释义，不再混进下一词条
  assert.equal(
    draft.senses[1]?.definitionEn?.includes("the government's abandonment"),
    true,
  );
});
