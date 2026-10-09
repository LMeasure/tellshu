# 数据源校验报告 — Linguabase 下载包（v0.1）

> 背景：Phase 0 开发启动后，用户提供了 Linguabase 数据包的 README（总说明 + 9 个子集说明，共 14.2KB）。本文档基于真实 README 内容做的现实校验，用于修正 PRD 中"内容唯一来源是 Linguabase 下载包"的乐观假设。
> 原则：**不创造虚拟数据**。以下结论全部基于已读 README 与已实现的接入管线（`scripts/linguabase_ingest.py` + `src/data/repository.ts`），未对 parquet 实际抽样（parquet 尚未上传）。

## 0. Linguabase 是什么

- 发布方：IDEA.org（非营利），许可 **CC0 1.0 公共领域**——可商用、无需署名、无版税。
- 性质：**英语词义关系图谱**（非语言教材）。描述英文单词如何相互关联：哪些词相关、相反、同根、有哪些义项、如何定义、如何分类。
- 规模：13 张表、约 **2.5 亿** 词-词关系；约 200 万词（core 40 万精选 + full 200 万全集）。
- 结构：**星型模式**，`vocabulary` 为脊柱表，其余表通过 `word` 主键关联；另有 4 张不以单词为键的表（opposite_pairs / categories / category_antonyms / topics）。
- 格式：每个表提供 `.parquet`（列式、zstd）与 `.tsv.gz`（可读、pipe 分隔多值）两种格式，内容相同。

## 1. 各子集字段速览（来自 README）

| 子集 | 主键 | 核心字段 | core 体积 |
|---|---|---|---|
| vocabulary | word | familiarity_score(0-1), familiarity_rank(1=最熟), in_core, core_rank, is_mwe, n_chars, n_words | 6MB |
| definitions | word | definition（英文段落 45-65 词，{braces}=斜体例句） | 48MB |
| senses | word | sense_labels（义项标签列表） | 4MB |
| associations | word | associates（排名关联词云，最强在前） | 154MB |
| antonyms | (word, axis) | opposites（term:rating，1-7） | 126MB |
| word_families | word | relatives（形态/词源亲属） | 12MB |
| opposites_pairs | pair | topic_a/b + 成员词池（单级） | 47MB |
| categories | category | topic → member 反向索引（单级） | — |
| category_antonyms | (category, axis) | opposite_names/members（name:rating） | 34MB |
| topics | (headword, sense) | description, members, verdict, content_rating, 受众分级 | 90MB |
| scores_labels | word | sensitivity, content_rating（敏感词过滤） | — |
| clues / sense_associations | word(/sense) | 谜面类型 / 义项级关联（MVP 暂不需要） | — |

## 2. MVP 字段需求 vs Linguabase 实际覆盖

> 需求字段见 04-页面清单 附录 A + 06 数据模型 §2。

| 需求字段 | 覆盖度 | 说明 |
|---|---|---|
| `word` | ✅ | vocabulary 主键 |
| `frequency_rank` | ✅ 替代 | `familiarity_rank`/`core_rank` 可直接映射为频率排序（core_rank 1=最熟悉） |
| `definition_en` | ✅ | definitions.definition（英文段落，偏长，需裁剪） |
| `root` | ⚠️ 近似 | word_families.relatives（词族，非严格词根） |
| `difficulty_level` | ⚠️ 间接 | 无直接字段；可按 core_rank 分桶近似（前 N=难度1，类推） |
| `ipa` | ❌ 缺失 | 全包无任何音标/音素信息 |
| `definition_zh` | ❌ 缺失 | 纯英文数据集，无中文 |
| `audio_path` | ❌ 缺失 | 不含任何音频文件 |
| 字母表/音标表 | ❌ 缺失 | 非教材，无字母、音标教学内容 |
| 句型表 | ❌ 缺失 | 无 pattern/structure_note/sample_sentences |
| 诊断题库 | ❌ 缺失 | 无 difficulty_level 分梯度的现成测验题 |
| 课程/主题元数据 | ⚠️ 部分 | topics/categories 有主题分类，但偏"猜词游戏"向，需筛选 |

## 3. 致命缺口（零基础闭环无法绕过）

1. **无中文释义**：产品定位"中文母语、零基础、必须中文辅助"，但包内全英文。
2. **无音标（IPA）**：7 天学字母+基础发音的闭环无法由该包驱动。
3. **无发音音频**：学习卡片"点读/慢速/跟读"依赖音频，该包零音频。

## 4. Linguabase 的真实可用价值

- **真实高频词表 + 熟悉度排序**：`vocabulary.core`（40 万词，带 core_rank）可按熟悉度筛出"最该先学的 300–500 词"，作为 frequency_rank 数据底座。此为**真实数据**，非虚拟编造。
- **词义关系网络**：associations/antonyms 可自动生成"选词义"练习的干扰项；word_families 可支持"相同词根尽量放一起"的聚合展示。
- **敏感词过滤**：scores_labels / topics.content_rating 可用于面向受众的内容过滤（MVP 面向成人，但需防暴粗）。

## 5. 修正后的内容来源方案（已落地，见 12-数据接入管线.md）

Linguabase 只能担任 **「词表 + 频率排序 + 关系网络」底座**；缺口已用**真实、非虚拟**的方式补齐，全部由 `scripts/linguabase_ingest.py` 实现：

| 需求字段 | 来源决策 | 实现 | 状态 |
|---|---|---|---|
| `word` / `frequency_rank` | Linguabase `vocabulary.core`（真实） | core_rank 直接映射 | ✅ |
| `difficulty_level` | 由真实 `core_rank` 分桶（前 25%=L2 基础词，其余 L3 进阶） | 确定性、可复现 | ✅ |
| `definition_en` | Linguabase `definitions.core`（真实英文段落，去 `{braces}`） | 文本清洗 | ✅ |
| `example_en` | Linguabase `definitions` 中首个 `{braces}` 用例（真实） | 正则抽取 | ✅ |
| `related` | Linguabase `associations.core`（真实关联词，裁剪到 core 内） | 取前 8 | ✅ |
| `antonyms` | Linguabase `antonyms.core`（真实，解析 `term:rating`，取强度≥6） | 取前 6 | ✅ |
| `relatives` | Linguabase `word_families.core`（真实同根/词族，裁剪到 core 内） | 取前 8 | ✅ |
| `ipa` 音标 | 若系统装有 **espeak-ng**，离线真实生成美式 IPA；否则留 `null`（待生成） | 沙箱当前未装 espeak-ng | ⏳ pending |
| `audio_path` 音频 | **不伪造**：前端运行时用 Web Speech API 实时合成英文发音（`src/lib/speech.ts`） | MVP 兜底，Phase 2 换预生成 TTS | ✅ 运行时 |
| `definition_zh` / `example_zh` | 外部合规 EN-ZH 词典灌入（脚本 `--zh-dict` 接口） | 缺则留 `null`，按 04 附录 A 降级显示英文 | ⏳ 待用户提供 |
| 字母/音标/句型/诊断题 | 教材内容层，独立于 Linguabase，人工编排 | 不在本管线产出 | — |

> 关键：本管线**不编造任何单词、释义或音频**。Linguabase 缺的字段一律 `null`，由外部内容层/运行时补齐；无任何虚拟词进入交付物（已用临时夹具端到端验证后清空）。

## 6. 下一步行动清单（需用户提供真实材料）

1. **词表底座（真实抽取）**：把 Linguabase core parquet 放到某目录（至少含 `vocabulary.core.parquet`，仅 6MB）。沙箱已装 pyarrow 23 / pandas 3，可直接真实读取。
   ```bash
   python3 scripts/linguabase_ingest.py --data-dir <你的目录> --top 2000
   ```
   生成 `public/data/linguabase/words.json`（前端自动加载）+ `manifest.json`（字段来源与状态清单）。
2. **中文释义（可选但推荐）**：提供合规 EN-ZH 词典 TSV（`word\t中文`），用 `--zh-dict` 灌入 `definition_zh` / `example_zh`。
3. **音标（可选）**：在部署/构建机装 `espeak-ng`，重跑脚本即可真实生成 IPA；不装则留空、由音频按钮兜底。
4. **教材内容层**：字母/音标/句型/诊断题属"内容层"，需另按教学大纲编排（300 词级别可手工完成），不在 Linguabase 管线内。

## 7. 对现有文档的影响

- PRD §4/§5、04 附录 A、06 数据模型 §2 中"内容唯一来源是 Linguabase 下载包"表述**已修订**为"Linguabase 提供词表排序与关系网络底座，中文释义/音标/音频/教材内容由独立内容层或运行时补齐"。
- Phase 0 骨架的 `repository.ts` 已从「空仓库」升级为「**真实 bundle 加载器**」：bundle 存在即真实加载并映射，缺失则回落空集合（仍零虚拟数据）。页面与组件无需改动。

## 8. OpenEtymology 内容层（已接入，补齐致命缺口）

用户提供了 OpenEtymology 开源词本（CET4/CET6/TEM8/TOEFL/GRE8000，CC BY-SA 4.0）。其 EPUB 是官方词库生成的富文本，**单个来源即补齐第 3 节的三处致命缺口**：

| 致命缺口 | OpenEtymology 提供（真实） | 字段 |
|---|---|---|
| 无中文释义 | 中文释义（带词性） | `Definitions` → `definition_zh` |
| 无音标 IPA | UK 音标 | `pronunciation` → `ipa`（无需 espeak-ng） |
| 无发音音频 | 音频仍走 Web Speech API 实时合成 | `audio_path=null` |
| （原缺）词源/词根 | 词源段落 + 词根词缀 | `Etymology`/`Morphemes` → `etymology`/`morphemes` |
| （原缺）双语例句 | 英文+中文例句 | `Examples` → `examples` |

解析脚本 `scripts/openetymology_ingest.py` 用 `zipfile + BeautifulSoup` 抽取五个词本 EPUB，按词本独立保留 **共 22,791 条**（CET4 4515 / CET6 2217 / TEM8 3826 / TOEFL 4510 / GRE8000 7723；跨词本共现词在各本各存一份），**按词本分片**输出 `public/data/linguabase/index.json`（~1KB 索引，首屏加载）+ `books/CET4.json…GRE8000.json`（单本 2.8–10.8MB，按需懒加载）。`difficulty_level` 按词本梯度：CET4=L2 基础，其余=L3 进阶；`topic_id`=词本名，可直接做课程/路径分组。

> 可选增强：若同时提供 Linguabase core parquet（用 `--linguabase-data-dir`），对两源重合的词补入 `frequency_rank`(core_rank) 与 `related/antonyms/relatives` 关系网络。

### ⚠️ 许可约束（做产品必须注意）
- 词本文件（.txt/.pdf/.epub）为 **CC BY-SA 4.0**：可商用，但须**署名 OpenEtymology** 且**衍生内容以相同协议共享**。
- 产出 `manifest.json` 已写入 `attribution` 与 `license` 字段；产品内须保留署名与许可声明。
- OpenEtymology 完整 SQLite 词典**不在授权内、未使用**；仅用已授权的 EPUB。
- 若产品形态要求内容闭源，则需更换数据源或取得额外授权——这是上线前的法务卡点。

## 9. 当前真实内容落地状态

- ✅ 中文释义 / 音标 / 双语例句 / 词源 / 词根词缀：来自 OpenEtymology（已落地，22,791 条，按词本分片）。
- ✅ 词表排序 / 关系网络：来自 Linguabase（需你提供 core parquet 后 `--linguabase-data-dir` 增强）。
- ✅ 发音：Web Speech API 运行时合成（真实，无伪造）。
- ⏳ 字母/音标/句型/诊断题库：教材内容层，需按教学大纲另行编排（不在上述两源内）。
