# 发现书籍链路 · Stage 1 前置：RDF 实际结构确认

> 生成时间：2026-10-07
> 依据：**真实 HTTP 响应原文**，非口令示例、非推测。
> 样本：`pg2701`（单作者）、`pg1184`（双作者）、`pg51252`（无 creator，仅译者 marcrel:trl）、`pg831`（有 creator 但无卒年 + 译者有卒年）。
> 覆盖项：`dcterms:title` / `dcterms:creator` / `dcterms:rights` / `dcterms:language` / `dcterms:issued`，以及实际存在且对本任务有用的其余字段。

---

## 0. 抓取方式

```
GET https://www.gutenberg.org/cache/epub/<id>/pg<id>.rdf
Content-Type: application/rdf+xml
```

四份均 HTTP 200，实体来源真实。

---

## 1. 命名空间（真实，逐个样本身上确认）

```xml
xmlns:dcterms="http://purl.org/dc/terms/"
xmlns:pgterms="http://www.gutenberg.org/2009/pgterms/"
xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
xmlns:cc="http://web.resource.org/cc/"
xmlns:dcam="http://purl.org/dc/dcam/"
xmlns:marcrel="http://id.loc.gov/vocabulary/relators/"   ← 仅部分书有
```

⚠️ **重要：`xmlns` 声明顺序在不同书目间不一致**（`pg2701` 没有 marcrel，`pg51252` 的 xmlns 顺序与 `pg2701` 不同）。
→ 实现上禁止依赖属性顺序或字符串下标，必须按**标签名**做提取。

根节点：

```xml
<rdf:RDF xml:base="http://www.gutenberg.org/">
  <pgterms:ebook rdf:about="ebooks/2701"> ... </pgterms:ebook>
</rdf:RDF>
```

---

## 2. `dcterms:title` —— 直接文本子节点

```xml
<dcterms:title>Moby Dick; Or, The Whale</dcterms:title>
```

- 单值，无 datatype 属性，文本可能含 `&amp;` 等实体 → 必须 XML 反转义。
- 副标题用 `;` / `:` 直接拼在同一串里，不做二次切分（不猜测）。

---

## 3. `dcterms:creator` —— **可重复**，多作者即多个同级元素

这是本次最关键的真实结构事实。`pg1184`（基督山伯爵）实测：

```xml
<dcterms:creator>
  <pgterms:agent rdf:about="2009/agents/492">
    <pgterms:name>Dumas, Alexandre</pgterms:name>
    <pgterms:birthdate rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">1802</pgterms:birthdate>
    <pgterms:deathdate rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">1870</pgterms:deathdate>
    <pgterms:alias>Dumas, Alexander</pgterms:alias>
    <pgterms:alias>Dumas, Alexandre, pere</pgterms:alias>
    <pgterms:webpage rdf:resource="https://en.wikipedia.org/wiki/Alexandre_Dumas,_père"/>
  </pgterms:agent>
</dcterms:creator>
<dcterms:creator>
  <pgterms:agent rdf:about="2009/agents/3930">
    <pgterms:name>Maquet, Auguste</pgterms:name>
    <pgterms:birthdate rdf:datatype="...#integer">1813</pgterms:birthdate>
    <pgterms:deathdate rdf:datatype="...#integer">1888</pgterms:deathdate>
    <pgterms:webpage rdf:resource="https://en.wikipedia.org/wiki/Auguste_Maquet"/>
  </pgterms:agent>
</dcterms:creator>
```

确认要点：

| 项 | 真实结构 |
|---|---|
| 多作者 | **多个并列的 `<dcterms:creator>` 元素**，不是单个元素里塞多个 agent |
| 姓名 | `pgterms:name`，「姓, 名」格式 |
| 生年 | `pgterms:birthdate`，`xsd:integer`，**可缺失** |
| **卒年** | `pgterms:deathdate`，`xsd:integer`，**可缺失** |
| 别名 | `pgterms:alias`，0~N 个（不参与版权判断） |
| agent id | `rdf:about="2009/agents/<n>"`（稳定，可用于去重） |

### 3.1 卒年缺失是真会发生的

`pg831`（Chrétien de Troyes 著《Four Arthurian Romances》）实测 creative agent **完全没有 birthdate / deathdate 节点**：

```xml
<dcterms:creator>
  <pgterms:agent rdf:about="2009/agents/435">
    <pgterms:name>Chrétien, de Troyes, active 12th century</pgterms:name>
    <pgterms:alias>Troyes, Chrétien de</pgterms:alias>
    <pgterms:webpage rdf:resource="https://en.wikipedia.org/wiki/Chr%C3%A9tien_de_Troyes"/>
  </pgterms:agent>
</dcterms:creator>
```

按你的规则：缺失 → 跳过，**不用 "12 世纪" 去推断卒年**。

### 3.2 `marcrel:*` 是真会出现的独立角色（且可能比 creator 更全）

`marcrel`（Additional Relator Role）下的 `<pgterms:agent>` 结构与 creator 内的 agent **完全一致**。

`pg831`（译者）：

```xml
<marcrel:trl>
  <pgterms:agent rdf:about="2009/agents/436">
    <pgterms:name>Comfort, William Wistar</pgterms:name>
    <pgterms:birthdate ...>1874</pgterms:birthdate>
    <pgterms:deathdate ...>1955</pgterms:deathdate>
  </pgterms:agent>
</marcrel:trl>
```

**极端情况 `pg51252`**：`<dcterms:creator>` 数量 = **0**，只有一个 `<marcrel:trl>`（Burton, Richard Francis, Sir，1821–1890）。
即：这本书在 RDF 里**没有任何 dcterms:creator，只有译者**。

> **决策点（我按更保守口径执行，如实报备）**
> 版权过滤除 `dcterms:creator` 外，我一并检查 `marcrel:*` 下的贡献者（译者/编者等），理由是英文译本的**译作本身也有著作权**，只查作者不够覆盖「中美双清」。
> 同时：`dcterms:creator` 数量为 0 的书，视为**作者不可确认 → 跳过**，不用「空集合恒真」把它放进来。
> 若你希望放宽到「只查 dcterms:creator」，说一声我改。

---

## 4. `dcterms:rights` —— 直接文本，逐字原样

真实值（四份样本一致）：

```xml
<dcterms:rights>Public domain in the USA.</dcterms:rights>
```

注意：是 **"in the USA"**，不是全球 PD。已在 Stage 0 报告中作为核心风险记录。

---

## 5. `dcterms:license` —— 自闭合资源引用，相对 URI

```xml
<dcterms:license rdf:resource="license"/>
```

结合根节点 `xml:base="http://www.gutenberg.org/"` → 解析为 `https://www.gutenberg.org/license`。
Stage 0 已实测 `https://www.gutenberg.org/policy/license.html` 返回 **200**。

⚠️ 另一处容易误读的：

```xml
<cc:Work rdf:about="">
  <cc:license rdf:resource="https://creativecommons.org/publicdomain/zero/1.0/"/>
  <rdfs:comment>Archives containing the RDF files for *all* our books can be downloaded at ...</rdfs:comment>
</cc:Work>
```

这个 CC0 声明挂在 `<cc:Work>` 上且原文注释说的是 **RDF 归档文件本身**，**不是书籍正文**。
→ **不会**把它当作该书的 license 写入（那属于把 metadata 许可误标成正文许可，是伪造）。
`license_url` 只写 PG 许可页，并保留 `rights` 原文一字不改。

---

## 6. `dcterms:language` —— **嵌套两层**，不是直接文本

```xml
<dcterms:language>
  <rdf:Description rdf:nodeID="N594e2aea2ac846518bdddd5b02d3da81">
    <rdf:value rdf:datatype="http://purl.org/dc/terms/RFC4646">en</rdf:value>
  </rdf:Description>
</dcterms:language>
```

必须取 `dcterms:language` → `rdf:Description` → `rdf:value` 才是 `en`。
直接读 `<dcterms:language>` 的 textContent 只会得到空白 —— **这是最容易踩的一处**。

---

## 7. `dcterms:issued` —— `xsd:date`，是 PG 上线日期，不是原书出版年

```xml
<dcterms:issued rdf:datatype="http://www.w3.org/2001/XMLSchema#date">2001-07-01</dcterms:issued>
```

仅记录，不用于版权判断。

---

## 8. 其余实际存在且对本任务有用的字段（真实摘录）

| 字段 | 结构 | 用途 | 处置 |
|---|---|---|---|
| `dcterms:alternative` | 直接文本 | 原书名（`Le comte de Monte-Cristo. English`） | 记录为 `alternative_title`，不参与展示标题 |
| `dcterms:description` | **可出现多次** | 第一条常是无用的 `"Wikipedia page about this book: <url>"` | 不用第一条做简介 |
| `pgterms:marc520` | 直接文本 | PG 官方摘要，含 `(This is an automatically generated summary.)` 尾注 | **用作 description 首选来源**，如实保留该尾注，不删不改写 |
| `dcterms:subject` | 可重复，嵌套 `rdf:Description/rdf:value`，带 `dcam:memberOf`（LCSH / LCC） | 分类 | 按 memberOf 拆分：`subjects_lcsh` / `classification_lcc` |
| `pgterms:bookshelf` | 可重复，嵌套 `rdf:value` | PG 书架标签 | 记录为 `bookshelves` |
| `dcterms:tableOfContents` | 直接文本（`pg831`：`Erec et Enide -- Cliges -- Yvain -- Lancelot`） | **正文章节的交叉校验基准** | 记录为 `toc_from_rdf` 并用于章节数核对 |
| `dcterms:hasFormat` / `pgterms:file` | 可重复，`rdf:about` 为绝对 URL，内含 `dcterms:extent`（字节数）与 `dcterms:format/rdf:value` | **封面 URL 的唯一可靠来源**；文本预期大小 | 见下节 |
| `pgterms:downloads` | `xsd:integer` | 热度 | 只用于榜单排序，不入库检索 |
| `pgterms:marc508` | 制作志愿者 | 非作者，**不参与版权判断** | 不入库 |
| `pgterms:marc908` | 可读性评分 | 与目标用户（英语学习者）相关 | 记录为 `reading_ease` |

---

## 9. `hasFormat` —— 封面与正文格式清单（真实列出）

四份样本各自扫描出的 `hasFormat` 条目数：14 / 14 / 14 / 16。

### 9.1 封面

可靠存在形式：

```xml
<pgterms:file rdf:about="https://www.gutenberg.org/cache/epub/2701/pg2701.cover.medium.jpg">
  <dcterms:extent rdf:datatype="...#integer">27483</dcterms:extent>
  <dcterms:format><rdf:Description><rdf:value rdf:datatype="...IMT">image/jpeg</rdf:value></rdf:Description></dcterms:format>
</pgterms:file>
```

还有 `pg<id>.cover.small.jpg`。
→ **规则：只在 `hasFormat` 里真实出现 `.cover.medium.jpg` 条目时才写 `cover_url`，否则写 `null`。不生成占位封面、不猜 URL。**

### 9.2 纯文本

⚠️ **关键事实：`hasFormat` 里没有 `cache/epub/<id>/pg<id>.txt` 这一条**。它列出的是：

```
https://www.gutenberg.org/ebooks/<id>.txt.utf-8
https://www.gutenberg.org/files/<id>/<id>-0.txt
```

但 `cache/epub/<id>/pg<id>.txt` **确实可达**（本次实测 5 本全部 200）：

```
GET /cache/epub/2701/pg2701.txt   → 200  accept-ranges: bytes  content-length: 1276267
GET /cache/epub/1342/pg1342.txt   → 200  accept-ranges: bytes  content-length:  772386
GET /cache/epub/1184/pg1184.txt   → 200  accept-ranges: bytes  content-length: 2787124
GET /cache/epub/51252/pg51252.txt → 200  accept-ranges: bytes  content-length: 1042814
GET /cache/epub/831/pg831.txt     → 200  accept-ranges: bytes  content-length: 1040991
```

→ 正文抓取采用 `cache/epub/<id>/pg<id>.txt`（该路径已在 Stage 0 的 robots 合规检查中确认不在 Disallow 内），并把 `hasFormat` 中记载的 `dcterms:extent` 作为**参考预期大小**（advisory，不作为唯一判据——文件可能被 PG 重新生成而大小变化）。

### 9.3 HTTP Range / 206 —— 实测可用（续传前提成立）

```
GET /cache/epub/2701/pg2701.txt
Range: bytes=0-99

HTTP/1.1 206 Partial Content
accept-ranges: bytes
content-length: 100
content-range: bytes 0-99/1276267
```

`206` + `content-range` 齐全 —— 你要求的 HTTP Range 续传能力**具备，可实施**。

---

## 10. 正文起止标记（真实原文，用于完整性校验）

以 `pg1342` 完整正文为例：`*** START ...` 在第 27 行，`*** END ...` 在第 14565 行。

```
27:  *** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***
     ...（正文）...
14565:*** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***
```

注意第 1 行是 `The Project Gutenberg eBook of Pride and Prejudice`（**不是** START 标记），头尾各有约 26 行 / 350 行的许可证 boilerplate。
→ 正文必须按标记切，不能按行号估算。

---

## 11. 章节形式：真样本已证明「单一正则必漏」

对 `pg1342` 全文逐行扫描，**正好 61 处以 Chapter/CHAPTER 起始的行**（= 小说真实的 61 章），但写成 **4 种不同形式**：

| 形式 | 出现次数 | 实例（行号） |
|---|---|---|
| `CHAPTER <罗马数字>.` | 55 | `CHAPTER II.` (838)、`CHAPTER XXXIV.` (7495) |
| `CHAPTER <罗马数字>`（无句点） | 2 | `CHAPTER XIII` (2969)、`CHAPTER XIV` (3161) |
| `Chapter <罗马数字>.`（混合大小写） | 1 | `Chapter XLVI.` (10273) |
| `Chapter <罗马数字>.]`（录入手误/目录残页） | 1 | `Chapter I.]` (701) |
| `Chapter <数字>.` | **0** | —— |

再加「我凭空想当然」的另一种——很多别的书是 `CHAPTER 1. Loomings.`（阿拉伯数字 + 标题同行）。

✅ 上下文特征可用：这本样本里所有真章节行**前后均为空行**（不代表所有书都如此，仅作为一条辅助证据）。实测前后文：

```
837|''               → 空行
838|'CHAPTER II.'    → 章节行
839|''               → 空行
```

→ 实现方案：**多模式正则 + 空行隔离 + 序号单调性校验 + 与 RDF 的 TOC 交叉核对**，任一步不可靠就写 `null`。

---

## 12. 结论

| # | 确认项 | 结果 |
|---|---|---|
| 1 | `dcterms:title` 结构 | ✅ 直接文本，需 XML 反转义 |
| 2 | `dcterms:creator` 结构 | ✅ 可重复；多作者 = 多个同级元素，每个内含一个 `<pgterms:agent>` |
| 3 | 卒年字段 | ✅ `pgterms:deathdate`（xsd:integer），**确实会缺失** |
| 4 | `marcrel:*` 贡献者 | ✅ 真实存在（译者/编者），结构同 `pgterms:agent`；存在 creator=0 的书 |
| 5 | `dcterms:rights` | ✅ 直接文本 `"Public domain in the USA."` |
| 6 | `dcterms:license` | ✅ 自闭合 `rdf:resource="license"` 相对 URI；CC0 声明属 RDF 归档，不挪用 |
| 7 | `dcterms:language` | ✅ **嵌套两层**，叶节点 `rdf:value` datatype=RFC4646 |
| 8 | `dcterms:issued` | ✅ `xsd:date`，PG 上线日期 |
| 9 | 封面来源 | ✅ 仅从 `hasFormat` 取 `pg<id>.cover.medium.jpg`，缺失写 null |
| 10 | 正文 URL 与 Range | ✅ `cache/epub/<id>/pg<id>.txt` 可达，支持 Range/206 |
| 11 | 起止标记 | ✅ `*** START OF THE PROJECT GUTENBERG EBOOK` / `*** END OF ...` |
| 12 | 章节形式 | ⚠️ **同书内 4 种写法并存**，必须多模式 + 交叉校验 |

**结构体确认完毕，可以开始编写 `crawl-books.ts`。**
实现将严格以上述真实结构为依据，不引入任何未在响应中出现过的假设。
