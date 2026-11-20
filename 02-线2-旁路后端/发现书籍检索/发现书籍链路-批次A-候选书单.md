# 发现书籍链路 · 批次 A 候选书单（待确认，尚未抓取）

生成时间：2026-10-09 21:58（本地时间）
生成方式：`server/src/scripts/plan-candidates.ts` → `.candidate-plan.json` → `render-candidates.py` 渲染

> **本轮没有抓取任何一本书的正文。**
> 只读取了榜单页与每本书的 RDF 元数据（书名 / 作者 / 生卒年 / rights / 语言 / 贡献者 / 正文字节数），
> 没有下载 `pg<id>.txt`，没有写 `.crawl-cache`，没有连数据库，没有生成任何 embedding。
> **以下任一本书，在你点头之前都不会被抓取。**

---

## 1. 数据来源与合规依据

| 项 | 内容 |
|---|---|
| 数据源 | Project Gutenberg（gutenberg.org） |
| 榜单入口 | `https://www.gutenberg.org/browse/scores/top`（去重后 119 个书目，本轮扫描前 41 个条目） |
| 元数据路径 | `https://www.gutenberg.org/cache/epub/<id>/pg<id>.rdf` |
| robots.txt | `https://www.gutenberg.org/robots.txt` —— **仅 `Disallow: /ebooks/search`**，本轮未访问该路径 |
| 请求纪律 | 串行；随机间隔 0.8–2.0s；全局 ≤30 req/min；失败重试 3 次指数退避；真实浏览器 UA；无代理、无多账号、不伪装搜索引擎 |
| 本轮请求结果 | 扫描 31 本（已入库 10 本跳过），RDF 取不到 **0 本** |

### 版权判定口径（沿用已确认的口径 A，一处未改）

| 规则 | 取值 |
|---|---|
| `dcterms:language` | 必须等于 `en` |
| `dcterms:rights` | 必须含 `Public domain in the USA` |
| `dcterms:creator` | 至少一个；**所有**作者必须有真实 `deathdate` |
| `marcrel:*` 贡献者 | 译者 / 插图者 / 编者等**也必须有真实 deathdate** |
| 卒年上限 | 所有卒年最大值 **≤ 1975** |
| 缺失处理 | 任何一项缺失或超限即跳过，**不推断、不补全** |

**关于「美国 PD ≠ 中国 PD」的处理**：`Public domain in the USA.` 只说明在美国的权利状态，
在中国按 `life + 50`（保护至作者死后第 50 年的 12 月 31 日）判断。口径 A 取卒年 ≤ 1975，
即 1975 + 50 = **2025-12-31** 已届满 —— 因此本清单中的书在中美两地均可认为已届满（当前 2026-10）。
**这不是法律意见**，只是我们内部的一致性口径；A 组中标注「需人工复核」的 6 本请特别看第 5 节。

### 判定口径一致性证据

新脚本的解析与判定逻辑与 Stage 1 的 `crawl-books.ts` 是两份代码，为避免口径漂移，
用 Stage 1 已落地的 12 本做了反向交叉验证：

```
交叉验证结果：通过 12，不符 0
  ✓ 1260/1342/1513/1695/1727/2465/2554/2641/3268/59828 → include（与已入库 10 本一致）
  ✓ 62215 → skip（language_not_en，与 Stage 1 失败清单一致）
  ✓ 65238 → skip（death_year_after_limit 1976 > 1975，与 Stage 1 失败清单一致）
```

复现命令：`node dist/src/scripts/plan-candidates.js --cross-check`

---

## 2. A 组：建议纳入 20 本

达到目标「现有 10 本 + 新增 20 本 = 30 本」。排序为榜单排名。

| # | PG ID | 书名 | 作者（生–卒） | 最大卒年 | 预估 chunk | 需人工复核 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [2701](https://www.gutenberg.org/ebooks/2701) | Moby Dick; Or, The Whale | Melville, Herman（1819–1891） | 1891 | 3,610 | — |
| 10 | [2868](https://www.gutenberg.org/ebooks/2868) | The Green Mummy | Hume, Fergus（1859–1932） | 1932 | 1,471 | — |
| 11 | [1661](https://www.gutenberg.org/ebooks/1661) | The Adventures of Sherlock Holmes | Doyle, Arthur Conan（1859–1930） | 1930 | 1,776 | — |
| 12 | [67979](https://www.gutenberg.org/ebooks/67979) | The Blue Castle: a novel | Montgomery, L. M. (Lucy Maud)（1874–1942） | 1942 | 1,170 | — |
| 14 | [34413](https://www.gutenberg.org/ebooks/34413) | The Love Letters of Mary Wollstonecraft to Gilbert Imlay | Wollstonecraft, Mary（1759–1797） | 1936 | 552 | 是 |
| 18 | [345](https://www.gutenberg.org/ebooks/345) | Dracula | Stoker, Bram（1847–1912） | 1912 | 2,546 | — |
| 19 | [11](https://www.gutenberg.org/ebooks/11) | Alice's Adventures in Wonderland | Carroll, Lewis（1832–1898） | 1898 | 442 | — |
| 21 | [21839](https://www.gutenberg.org/ebooks/21839) | Sense and Sensibility | Austen, Jane（1775–1817） | 1921 | 2,018 | 是 |
| 22 | [601](https://www.gutenberg.org/ebooks/601) | The Monk: A Romance | Lewis, M. G. (Matthew Gregory)（1775–1818） | 1818 | 2,377 | — |
| 23 | [43](https://www.gutenberg.org/ebooks/43) | The strange case of Dr. Jekyll and Mr. Hyde | Stevenson, Robert Louis（1850–1894） | 1894 | 413 | — |
| 24 | [6133](https://www.gutenberg.org/ebooks/6133) | The Extraordinary Adventures of Arsène Lupin, Gentleman-Burg | Leblanc, Maurice（1864–1941） | 1941 | 926 | — |
| 27 | [2680](https://www.gutenberg.org/ebooks/2680) | Meditations | Marcus Aurelius, Emperor of Rome（121–180） | 180 | 1,166 | 是（见 §5 第 3 条） |
| 28 | [3011](https://www.gutenberg.org/ebooks/3011) | The Lady of the Lake | Scott, Walter（1771–1832） | 1832 | 1,402 | — |
| 29 | [468](https://www.gutenberg.org/ebooks/468) | Manon Lescaut | Prévost, abbé（1697–1763） | 1763 | 1,082 | — |
| 31 | [76639](https://www.gutenberg.org/ebooks/76639) | Eloisa : $b or, A series of original letters | Rousseau, Jean-Jacques（1712–1778） | 1779 | 5,237 | 是 |
| 32 | [564](https://www.gutenberg.org/ebooks/564) | The Mystery of Edwin Drood | Dickens, Charles（1812–1870） | 1870 | 1,653 | — |
| 34 | [72](https://www.gutenberg.org/ebooks/72) | Thuvia, maid of Mars | Burroughs, Edgar Rice（1875–1950） | 1950 | 863 | 是 |
| 36 | [75201](https://www.gutenberg.org/ebooks/75201) | A farewell to arms | Hemingway, Ernest（1899–1961） | 1961 | 1,479 | 是 |
| 38 | [3296](https://www.gutenberg.org/ebooks/3296) | The Confessions of St. Augustine | Augustine, of Hippo, Saint（354–430） | 1882 | 1,763 | 是 |
| 41 | [145](https://www.gutenberg.org/ebooks/145) | Middlemarch | Eliot, George（1819–1880） | 1880 | 5,301 | — |

**A 组 20 本的 `dcterms:rights` 原文全部为 `Public domain in the USA.`**（无一例外，已入库 10 本同样如此）。
预估 chunk 按 Stage 1 实测「342 字节/chunk」外推，**属估算不是实测**。

---

## 3. B 组：备选 5 本（建议不纳入）

| # | PG ID | 书名 | 作者（生–卒） | 最大卒年 | 预估 chunk | 建议剔除理由 |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | [5197](https://www.gutenberg.org/ebooks/5197) | My Life — Volume 1 | Wagner, Richard（1813–1883） | 1883 | 3,673 | 标题是瓦格纳自传**第 1 卷**，不是完整书 |
| 26 | [42](https://www.gutenberg.org/ebooks/42) | The strange case of Dr. Jekyll and Mr. Hyde | Stevenson, Robert Louis（1850–1894） | 1894 | 479 | 与 #23（PG 43）同书名同作者，Gutenberg 重复版本；建议保留 43 |
| 33 | [47530](https://www.gutenberg.org/ebooks/47530) | Oliver Twist, Vol. 2 (of 3) | Dickens, Charles（1812–1870） | 1878 | 880 | 只是三卷本的**第 2 卷**，不是完整书 |
| 37 | [45839](https://www.gutenberg.org/ebooks/45839) | Dracula | Stoker, Bram（1847–1912） | 1912 | 2,491 | 与 #18（PG 345）同书重复版本；建议保留 345 |
| 40 | [42671](https://www.gutenberg.org/ebooks/42671) | Pride and Prejudice | Austen, Jane（1775–1817） | 1960 | 2,023 | 与已入库的 PG 1342 同书，库内已有 |

> B 组的版权判定**全部是通过的**（都满足口径 A）。放进 B 组是因为重复或非完整卷，
> 是产品判断不是版权判断。**你想保留其中任何一本都可以**，我按你的选择执行。

---

## 4. C 组：未通过版权口径 6 本（不抓取）

| # | PG ID | 书名 / 榜单锚文本 | 判定结果 | 依据（RDF 原文） |
| --- | --- | --- | --- | --- |
| 6 | [65238](https://www.gutenberg.org/ebooks/65238) | The Secret of Chimneys | death_year_after_limit | 最大卒年 1976 > 1975 |
| 16 | [62215](https://www.gutenberg.org/ebooks/62215) | Le Fantôme de l'Opéra | language_not_en | `dcterms:language = fr`，要求 en |
| 25 | [831](https://www.gutenberg.org/ebooks/831) | Four Arthurian Romances | author_deathdate_missing | 缺失卒年的作者：Chrétien, de Troyes, active 12th century |
| 30 | [51252](https://www.gutenberg.org/ebooks/51252) | The Book of the Thousand Nights and a Night — Volume | no_creator | RDF 中没有 `dcterms:creator`，作者不可确认，不推断 |
| 35 | [22541](https://www.gutenberg.org/ebooks/22541) | The Misplaced Battleship | death_year_after_limit | 最大卒年 2012 > 1975 |
| 39 | [7326](https://www.gutenberg.org/ebooks/7326) | The Yeoman Adventurer | author_deathdate_missing | 缺失卒年的作者：Gough, George W. |

---

## 5. 不确定项（必须知情的部分）

脚本自动标注的 6 本 + 我人工复核时额外发现的 2 个问题：

**① 有 marcrel 贡献者（译者/插图/编者卒年同样参与判定）**

| PG ID | 贡献者 | 说明 |
|---|---|---|
| 34413 | Ingpen, Roger [ctb] 卒 **1936** | 作者 Wollstonecraft 卒 1797，但贡献者卒 1936 → 最大卒年取 1936。口径保守，判定通过 |
| 21839 | Dobson, Austin [cmm] 卒 1921 / Thomson, Hugh [ill] 卒 1920 | 同上 |
| 76639 | Kenrick, W. (William) [trl] 卒 1779 | 译本，译者卒年 1779 |
| 3296 | Pusey, E. B. [trl] 卒 **1882** | 奥古斯丁卒 430，最大卒年取译者 1882 |

**② 最大卒年距 1975 阈值较近（中国 life+50 到期日需复核）**

| PG ID | 作者卒年 | 中国保护期至 | 当前是否已届满 |
|---|---|---|---|
| 72 | Burroughs 1950 | 2000-12-31 | ✅ 已届满 |
| 75201 | Hemingway 1961 | 2011-12-31 | ✅ 已届满 |

（42671 的 1960 来自编者 Chapman，已列入 B 组不纳入）

**③ 我人工复核额外发现的两个问题（脚本未覆盖）**

1. **PG 2680《Meditations》**：原著为古希腊文，库内正文是**英译本**，但 RDF **没有 `marcrel:trl` 贡献者** →
   译者身份不可考。口径 A 只检查"有没有贡献者"，检查不到"译本来源不明"这一层。
   建议：保留但标注，或在展示层标明"译本来源未标注"。
2. **PG 76639 标题脏数据**：`Eloisa : $b or, A series of original letters` 中的 `$b` 是 MARC 子字段标记，
   Gutenberg 未清洗。原样入库会很难看。**是否清洗属数据处理决策，我不擅自改**，需要你定：
   - (a) 原样入库（不碰原始数据）
   - (b) 入库时清洗 `$b` 并在数据里记 `title_raw` 与 `title_clean` 两版

---

## 6. 规模预估（外推，非实测）

| 项 | 数值 |
|---|---|
| A 组预估 chunk | 37,247 |
| 现有库内 | 24,244 chunk / 10 本 |
| **纳入 A 组后合计** | **约 61,491 chunk / 30 本** |
| 主表 HNSW 索引（按 7.8KB/chunk 外推） | 约 **480 MB**（现有 189MB） |
| embedding 重算耗时（按 Stage 1 实测 ~2.7 chunk/s） | 约 **4 小时** |
| 正文抓取耗时（31 本、约 21MB，按 Stage 1 限流） | 约 **15–25 分钟** |

以上三个数字全是外推，抓取后以实测为准。

---

## 7. 请你确认

1. **A 组 20 本是否照单抓取？**（或指定剔除某几本）
2. **B 组 5 本**：是否全部剔除？还是把某几本（比如重复版本 42 / 45839）也纳入？
3. **§5 第 3 条的两个问题**：2680 译本来源未标注怎么处理？76639 的 `$b` 清洗与否？
4. 抓取顺序：按榜单排名（现顺序），还是按预估 chunk 从小到大先跑一批？

确认后我才开始抓取正文（约 15–25 分钟），然后入库、切块、embedding（约 4 小时），全程分批报告。
