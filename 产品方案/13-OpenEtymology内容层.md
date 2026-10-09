# 内容层接入 · 述树 ← OpenEtymology（v0.1）

> 配套代码：`scripts/openetymology_ingest.py`（EPUB 解析/映射）、`src/components/learning/WordCard.tsx`（渲染词源/词根/双语例句）、`src/data/types.ts`（字段扩展）、`src/data/repository.ts`（加载）。
> 数据许可：**CC BY-SA 4.0**（须署名 OpenEtymology，衍生内容同协议共享）。

## 1. 为什么用 OpenEtymology

Linguabase 缺中文/音标/例句/词源（见 11 文档第 3 节）。OpenEtymology 五个词本（CET4/CET6/TEM8/TOEFL/GRE8000）的 **EPUB** 是从官方词库生成的富文本，每个词自带真实字段，恰好补齐：

- `.txt` 只是纯单词列表（无内容），**不可用**；
- `.pdf` 是排版成品，难机器抽取；
- **`.epub` 是 XHTML 压缩包，结构干净、可解析** → 选它。

许可：词本文件 CC BY-SA 4.0（可商用，须署名+ShareAlike）。完整 SQLite 词典不在授权内，未使用。

## 2. EPUB 单词条真实结构（节选自 CET4 chapter-01）

```html
<section class="word-entry" id="abandon">
  <p class="entry-number">1</p>
  <h2>abandon</h2>
  <p class="pronunciation">UK /əˈbændən/</p>          <!-- 真实 IPA -->
  <section><h3>Definitions</h3><ol class="definitions">
    <li><strong>vt.</strong> 抛弃；放弃（责任、计划等）</li>
    <li><strong>n.</strong> 放任；狂热（罕见用法）</li></ol></section>
  <section><h3>Morphemes</h3><ul class="morphemes">   <!-- 词根词缀 -->
    <li><strong>a</strong> 加强</li>
    <li><strong>bandon</strong> 控制 <span class="note">拉丁语 bannum "公告/法令"</span></li></ul></section>
  <section><h3>Etymology</h3><p>最初在古法语中为 abandoner…</p></section>  <!-- 词源 -->
  <section><h3>Examples</h3><ol class="examples">     <!-- 双语例句 -->
    <li><p class="example-en">The crew had to abandon the sinking ship.</p>
        <p class="example-zh">船员不得不弃离沉船。</p></li> …</ol></section>
</section>
```

## 3. 字段映射（真实来源）

| 输出字段 | 来源 | 说明 |
|---|---|---|
| `word` | `h2` | 词头 |
| `ipa` | `p.pronunciation` 首个 `/…/` | 真实 UK 音标 |
| `definition_zh` | `ol.definitions` | 合并「词性+中文」（多义用 ；分隔） |
| `pos` | 首个 `definitions` 的 `<strong>` | 词性 |
| `morphemes` | `ul.morphemes` li | `{form, meaning, note}` 词根词缀+注释 |
| `root` | `morphemes[0].form` | 首词素，用于同根聚合 |
| `etymology` | `section Etymology p` | 词源中文段落 |
| `examples` / `example_en` / `example_zh` | `ol.examples` li | 双语例句（全量 + 首条） |
| `book` / `topic_id` | 词本名 | CET4/CET6/TEM8/TOEFL/GRE8000 |
| `difficulty_level` | 词本梯度 | CET4=L2 基础；其余=L3 进阶 |
| `frequency_rank` | 词本内 entry 序号（Linguabase 增强时覆盖为 core_rank） | 排序 |
| `audio_path` | — | 始终 `null` → 前端 Web Speech API 合成 |
| `related` / `antonyms` / `relatives` | `--linguabase-data-dir`（可选） | Linguabase 关系网络 |

## 4. 用法

```bash
# 自动在 /root/uploads/OpenEtymology-main/OpenEtymology-main 找源码
python3 scripts/openetymology_ingest.py

# 指定源码目录
python3 scripts/openetymology_ingest.py --src-dir /path/to/OpenEtymology-main

# 同时用 Linguabase 增强关系网络（需 core parquet）
python3 scripts/openetymology_ingest.py --linguabase-data-dir /path/to/linguabase
```

实现要点：`zipfile` 读 EPUB 内 `OEBPS/text/chapter-*.xhtml`（按章节号排序）→ `BeautifulSoup` 解析 `section.word-entry` → **按词本分片**输出 `index.json` + `books/<BOOK>.json` + `manifest.json`（含署名与许可）。

> 分片说明：旧方案为单个 19MB `words.json`；现改为 `index.json`（~1KB，首屏仅加载此）+ `books/CET4.json…GRE8000.json`（单本 2.8–10.8MB，进入对应词本时按需懒加载）。旧 `words.json` 已删除。详见 12 第 2 节「首屏加速原理」。

## 5. 运行结果（已执行，真实无虚拟）

- 五个词本按本独立保留，**共 22,791 条**：CET4 4515 / CET6 2217 / TEM8 3826 / TOEFL 4510 / GRE8000 7723（跨词本共现词在各本各存一份，符合「按词本独立加载」语义）。
- 抽样 `abandon`：IPA `əˈbændən`、中文释义含词性、3 条双语例句、词根词缀 `a`/`bandon`、完整词源段落——全部真实。
- `npm run build` 通过；dist 含 `index.json` + `books/`；dev server 实时服务，`Search`（词本切换，默认 CET4）/`LearningFlow`（?book=）按需渲染 `WordCard`（含音标/中文/例句/词根/词源）。

## 6. 已知优化点（非阻塞）

- **体积/首屏**：已按词本分片（见上），首屏仅拉 755B 索引，单本最大 10.8MB 按需加载。若 GRE8000 仍偏重，可进一步按首字母/频率再切片。
- **英文释义**：OpenEtymology 不提供英文释义（`definition_en` 留空）；如需英文辅助，后续可并入 Linguabase `definitions`。
- **去重**：当前按词本独立保留（不去重合并）；如需跨词本合并多释义，可后续扩展。
- **许可**：上线前须在产品内保留 OpenEtymology 署名与 CC BY-SA 4.0 声明；闭源产品需另寻授权。
