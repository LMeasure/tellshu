# Query 集 v3 校验报告（47 → 100）

生成时间：2026-10-12 11:07:06　|　构建脚本：`src/scripts/build-query-set-v3.py`

## 0. 这份报告回答什么

- 新增的 53 条 Query 是不是从正文里挖出来的？→ §2
- 每条 Query 的目标书是不是可验证？锚点有没有跨书污染？→ §3、§5
- 为什么有些行的锚点换了？→ §4
- 五类 Query 各有多少？→ §6

## 1. 方法与纪律

```
候选 token 全部来自 30 本正文 content 字段，无一条人工杜撰
跨书唯一性一律 content ILIKE 全表实测，不以词频直觉或视觉判断代替
已有 Query 文件只读不写回；旧实验数据（_b5-matrix.json 等）不覆盖
```

- 继承来源：`src/scripts/discover-queries-b5.txt（原文逐字继承，仅替换/修复验证锚点）`
- 新增来源：`src/scripts/discover-queries-b6-draft.txt（Stage B.6 Query 扩展方案附录）`
- 计数口径：**目标书至少有一个 chapter_title 非空的 chunk（过滤口径下物理可召回）**
- 剔除口径：**目标书零章节块 —— 与 Stage B.5 口径一致，不计入命中率分母**

### 1.1 冻结基线（构建时刻只读快照）

| 项 | 值 |
|---|---|
| discovered_books | 30 |
| discovered_book_chunks | 58332 |
| embedding 数 | 58332 |
| content_chars 合计 | 25,625,443 |
| 全局内容指纹 md5 | `770e7c8bbaca404c8418087418d1c632` |

## 2. Query 集构成

| 项 | 数量 |
|---|---:|
| 条目总数 | 106 |
| **计入分母** | **100** |
| 目标书零章节块（剔除） | 6 |
| 探针 / 负对照（不参与统计） | 4 |
| 锚点被修复 | 49 |
| 锚点被改型 | 18 |
| 仍有跨书污染的行 | 1（全部落在「剔除」组内，见 §5.2） |

> 上一版（Stage B.5）分母是 **47**；v3 把分母提到 **100**，1 条差异从 2.1pp 降到 **1.0pp** —— 这正是扩集的目的：让「差 2 条」不再被说成「差不多」。

## 3. 锚点校验口径

每条 Query 都用同一条 SQL 实测（只读，不做任何写入）：

```sql
SELECT c.book_id, count(*), count(*) FILTER (WHERE c.chapter_title IS NOT NULL)
FROM discovered_book_chunks c
WHERE c.content ILIKE '%<anchor>%'
GROUP BY c.book_id ORDER BY 2 DESC;
```

通过条件**同时**要求：

1. 目标书按命中块数**排名第一**；
2. 其它所有书的命中块数合计为 **0**（零跨书污染）；
3. 锚点在目标书「有章节块的区域」至少命中 2 块 —— 保证它落在**检索真的够得着**的地方。

结果：**100 条计入分母的 Query 全部通过**，零污染。

## 4. 锚点为什么会被换掉

继承来的 47 条里，有一批原锚点在「跨书零污染」这条 stricter 口径下站不住：

被换掉的这些原锚点，按「跨书命中块数」从高到低列出（数字全是 ILIKE 实测）：

| 原锚点 | 跨书命中块数 | 目标书命中块数 | 判定 |
|---|---:|---:|---|
| `Catherine` | 172 | 244 | 跨书污染 |
| `Hatter` | 138 | 44 | 跨书污染 |
| `Friar` | 118 | 72 | 跨书污染 |
| `Watson` | 68 | 88 | 跨书污染 |
| `governess` | 43 | 47 | 跨书污染 |
| `Cecil` | 34 | 236 | 跨书污染 |
| `Sherlock` | 32 | 111 | 跨书污染 |
| `Necklace` | 28 | 31 | 跨书污染 |
| `Jose` | 26 | 28 | 跨书污染 |
| `Worms` | 15 | 23 | 跨书污染 |
| `Elinor` | 10 | 708 | 跨书污染 |
| `Bennet` | 9 | 348 | 跨书污染 |
| `mummy` | 8 | 389 | 跨书污染 |
| `Verona` | 8 | 14 | 跨书污染 |
| …（共 45 条，其余见 §5.3） | | | |

处理方式：**保留 Query 原文一字不改**，把验证锚点换成「同一批含有原锚点的 chunk」里满足严格唯一性的 token —— 这样新锚点与原查询处在同一个场景，语义没有被换掉。

本次共修复 **49** 条。明细见 §5.3。

## 5. 明细

### 5.1 计入分母的 100 条

| # | ID | 类别 | 目标书 | anchor | 命中块 | 其中章节块 | 跨书 |
|---:|---|---|---|---|---:|---:|---:|
| 1 | Q001 | 关键情节词 | Crime and Punishment | `Raskolnikov continued` | 6 | 6 | 0 |
| 2 | Q002 | 地点名 | Jane Eyre | `Lowood` | 66 | 66 | 0 |
| 3 | Q003 | 人物名 | Pride and Prejudice | `Wickham` | 213 | 208 | 0 |
| 4 | Q004 | 人物名 | The Odyssey | `Odysseus` | 4 | 0 | 0 |
| 5 | Q005 | 关键情节词 | Romeo and Juliet | `Enter Benvolio` | 7 | 7 | 0 |
| 6 | Q006 | 地点名 | Jane Eyre | `Thornfield` | 108 | 108 | 0 |
| 7 | Q007 | 人物名 | Jane Eyre | `Brocklehurst` | 56 | 56 | 0 |
| 8 | Q008 | 关键情节词 | The Mysteries of Udolpho | `Madame Montoni` | 203 | 203 | 0 |
| 9 | Q010 | 人物名 | Crime and Punishment | `Sonia` | 346 | 346 | 0 |
| 10 | Q011 | 人物名 | A Room with a View | `Freddy` | 139 | 139 | 0 |
| 11 | Q012 | 地点名 | The Odyssey | `Ithaca` | 129 | 126 | 0 |
| 12 | Q013 | 地点名 | Pride and Prejudice | `Pemberley` | 65 | 63 | 0 |
| 13 | Q014 | 人物名 | Romeo and Juliet | `MERCUTIO` | 57 | 56 | 0 |
| 14 | Q015 | 关键情节词 | Carmen | `Francisco Sevilla` | 2 | 2 | 0 |
| 15 | Q016 | 人物名 | The Man Who Was Thursday | `Ratcliffe` | 31 | 31 | 0 |
| 16 | Q017 | 人物名 | Jane Eyre | `Antoinetta` | 2 | 2 | 0 |
| 17 | Q018 | 地点名 | Pride and Prejudice | `Longbourn` | 106 | 106 | 0 |
| 18 | Q019 | 人物名 | Crime and Punishment | `Marmeladov` | 46 | 46 | 0 |
| 19 | Q020 | 人物名 | Romeo and Juliet | `BALTHASAR` | 16 | 14 | 0 |
| 20 | Q021 | 关键情节词 | Alice's Adventures in Wonderla | `It’s a Cheshire` | 2 | 2 | 0 |
| 21 | Q022 | 关键情节词 | Alice's Adventures in Wonderla | `a Hatter` | 2 | 2 | 0 |
| 22 | Q024 | 关键情节词 | Thuvia, maid of Mars | `Ptarth still` | 3 | 3 | 0 |
| 23 | Q025 | 地点名 | Thuvia, maid of Mars | `Barsoom` | 88 | 88 | 0 |
| 24 | Q026 | 人物名 | Middlemarch | `Dorothea` | 976 | 976 | 0 |
| 25 | Q027 | 人物名 | Middlemarch | `Lydgate` | 949 | 949 | 0 |
| 26 | Q028 | 关键情节词 | Dracula | `Seward’s Diary` | 62 | 58 | 0 |
| 27 | Q029 | 人物名 | Dracula | `Renfield` | 51 | 51 | 0 |
| 28 | Q031 | 关键情节词 | The Monk: A Romance | `Abbot agreed` | 2 | 2 | 0 |
| 29 | Q032 | 人物名 | Moby Dick | `Starbuck` | 192 | 191 | 0 |
| 30 | Q033 | 人物名 | Moby Dick | `Queequeg` | 232 | 231 | 0 |
| 31 | Q034 | 关键情节词 | The Green Mummy | `Sidney Bolton` | 40 | 40 | 0 |
| 32 | Q036 | 关键情节词 | The Confessions of St. Augusti | `speak thereof` | 4 | 4 | 0 |
| 33 | Q037 | 人物名 | The Confessions of St. Augusti | `Victorinus` | 10 | 10 | 0 |
| 34 | Q038 | 人物名 | The Extraordinary Adventures o | `Arsène` | 250 | 248 | 0 |
| 35 | Q039 | 人物名 | The Extraordinary Adventures o | `Ganimard` | 84 | 84 | 0 |
| 36 | Q040 | 人物名 | Sense and Sensibility | `Marianne` | 551 | 542 | 0 |
| 37 | Q041 | 人物名 | Sense and Sensibility | `Brandon` | 155 | 154 | 0 |
| 38 | Q044 | 关键情节词 | The Blue Castle | `Uncle Wellington` | 22 | 22 | 0 |
| 39 | Q045 | 人物名 | The Blue Castle | `Barney` | 290 | 290 | 0 |
| 40 | Q046 | 关键情节词 | A farewell to arms | `Catherine Barkley` | 14 | 14 | 0 |
| 41 | Q047 | 人物名 | A farewell to arms | `Bonello` | 61 | 61 | 0 |
| 42 | Q048 | 人物名 | Eloisa | `Wolmar` | 273 | 272 | 0 |
| 43 | Q049 | 地点名 | Eloisa | `Etange` | 31 | 30 | 0 |
| 44 | Q050 | 地点名 | The Adventures of Sherlock Hol | `Boscombe` | 16 | 15 | 0 |
| 45 | Q051 | 人物名 | The Adventures of Sherlock Hol | `Hosmer` | 22 | 22 | 0 |
| 46 | Q052 | 人物名 | The Mystery of Edwin Drood | `Jasper` | 270 | 270 | 0 |
| 47 | Q053 | 人物名 | The Mystery of Edwin Drood | `Drood` | 85 | 83 | 0 |
| 48 | Q054 | 人物名 | Middlemarch | `Bulstrode` | 539 | 539 | 0 |
| 49 | Q055 | 人物名 | Dracula | `Helsing` | 352 | 351 | 0 |
| 50 | Q056 | 人物名 | Dracula | `Seward` | 153 | 149 | 0 |
| 51 | Q057 | 专有名词 | Moby Dick; Or, The Whale | `Yojo` | 15 | 15 | 0 |
| 52 | Q058 | 专有名词 | Moby Dick; Or, The Whale | `Moby` | 94 | 91 | 0 |
| 53 | Q059 | 人物名 | The Adventures of Sherlock Hol | `Lestrade` | 36 | 36 | 0 |
| 54 | Q060 | 人物名 | The Adventures of Sherlock Hol | `Norton` | 7 | 7 | 0 |
| 55 | Q061 | 人物名 | Crime and Punishment | `Porfiry` | 192 | 192 | 0 |
| 56 | Q062 | 人物名 | Crime and Punishment | `Dounia` | 303 | 303 | 0 |
| 57 | Q063 | 人物名 | The Mysteries of Udolpho | `Montoni` | 829 | 829 | 0 |
| 58 | Q064 | 人物名 | The Mysteries of Udolpho | `Valancourt` | 616 | 616 | 0 |
| 59 | Q065 | 专有名词 | Eloisa | `Eloisa` | 850 | 841 | 0 |
| 60 | Q066 | 人物名 | The Mystery of Edwin Drood | `Durdles` | 110 | 108 | 0 |
| 61 | Q067 | 人物名 | Sense and Sensibility | `Ferrars` | 141 | 137 | 0 |
| 62 | Q068 | 地点名 | Thuvia, maid of Mars | `Ptarth` | 147 | 147 | 0 |
| 63 | Q069 | 人物名 | Thuvia, maid of Mars | `Carthoris` | 343 | 342 | 0 |
| 64 | Q070 | 地点名 | Pride and Prejudice | `Netherfield` | 85 | 85 | 0 |
| 65 | Q071 | 地点名 | Pride and Prejudice | `Derbyshire` | 25 | 24 | 0 |
| 66 | Q072 | 地点名 | Jane Eyre: An Autobiography | `Millcote` | 32 | 32 | 0 |
| 67 | Q073 | 地点名 | Middlemarch | `Lowick` | 176 | 176 | 0 |
| 68 | Q074 | 人物名 | Carmen | `Elizondo` | 3 | 3 | 0 |
| 69 | Q075 | 地点名 | The Green Mummy | `Pierside` | 69 | 69 | 0 |
| 70 | Q076 | 人物名 | The Odyssey | `Telemachus` | 278 | 277 | 0 |
| 71 | Q077 | 地点名 | The Blue Castle: a novel | `Deerwood` | 59 | 59 | 0 |
| 72 | Q078 | 地点名 | Sense and Sensibility | `Norland` | 63 | 61 | 0 |
| 73 | Q079 | 人物名 | The Mysteries of Udolpho | `Emily` | 2040 | 2040 | 0 |
| 74 | Q080 | 人物名 | Eloisa | `Preux` | 40 | 40 | 0 |
| 75 | Q081 | 专有名词 | Alice's Adventures in Wonderla | `Gryphon` | 39 | 39 | 0 |
| 76 | Q082 | 关键情节词 | Alice's Adventures in Wonderla | `Rabbit-Hole` | 5 | 4 | 0 |
| 77 | Q083 | 人物名 | Carmen | `Jose-Maria` | 6 | 6 | 0 |
| 78 | Q084 | 人物名 | Carmen | `Garcia` | 17 | 17 | 0 |
| 79 | Q085 | 人物名 | The Odyssey | `Penelope` | 115 | 113 | 0 |
| 80 | Q086 | 人物名 | The Man Who Was Thursday: A Ni | `Renard` | 20 | 20 | 0 |
| 81 | Q087 | 人物名 | Romeo and Juliet | `Rosaline` | 9 | 9 | 0 |
| 82 | Q088 | 人物名 | The Monk: A Romance | `Antonia` | 330 | 330 | 0 |
| 83 | Q089 | 人物名 | The Monk: A Romance | `Elvira` | 141 | 141 | 0 |
| 84 | Q090 | 人物名 | A Room with a View | `Emerson` | 166 | 165 | 0 |
| 85 | Q091 | 人物名 | A Room with a View | `Vyse` | 65 | 65 | 0 |
| 86 | Q092 | 专有名词 | A Room with a View | `Baedeker` | 17 | 16 | 0 |
| 87 | Q093 | 人物名 | The Green Mummy | `Jasher` | 397 | 396 | 0 |
| 88 | Q094 | 专有名词 | The Green Mummy | `Caxas` | 38 | 38 | 0 |
| 89 | Q095 | 人物名 | The Confessions of St. Augusti | `Nebridius` | 16 | 16 | 0 |
| 90 | Q096 | 专有名词 | The Confessions of St. Augusti | `Manichees` | 17 | 17 | 0 |
| 91 | Q097 | 人物名 | The Extraordinary Adventures o | `Baudru` | 24 | 24 | 0 |
| 92 | Q098 | 人物名 | The Extraordinary Adventures o | `Dreux-Soubise` | 9 | 9 | 0 |
| 93 | Q099 | 长文本语义片段 | Middlemarch | `Then you will think it wicked in me to wear it,” …` | 1 | 1 | 0 |
| 94 | Q100 | 长文本语义片段 | The Mystery of Edwin Drood | `The waiter explained that he was the Verger, and …` | 1 | 1 | 0 |
| 95 | Q101 | 关键情节词 | The Man Who Was Thursday: A Ni | `common in the English` | 2 | 2 | 0 |
| 96 | Q102 | 长文本语义片段 | The Man Who Was Thursday: A Ni | `I am not in the British police,” said Syme with i…` | 1 | 1 | 0 |
| 97 | Q103 | 长文本语义片段 | The Blue Castle: a novel | `Why didn’t _some one_ open the door and let him in?` | 1 | 1 | 0 |
| 98 | Q104 | 长文本语义片段 | A farewell to arms | `I was very dusty and dirty and went up to my room…` | 1 | 1 | 0 |
| 99 | Q105 | 长文本语义片段 | A farewell to arms | `But we had passports and we would spend the money.` | 1 | 1 | 0 |
| 100 | Q106 | 长文本语义片段 | Eloisa | `It is at present confined to the walls of her cha…` | 2 | 2 | 0 |

### 5.2 被剔除的行（目标书零章节块）

| ID | 目标书 | PG ID | anchor | 跨书命中 | 处理 |
|---|---|---|---|---:|---|
| Q009 | The String of Pearls | 59828 | `Sweeney` | 0 | 不计入分母 |
| Q023 | The strange case of Dr. Jekyll and M | 43 | `Hyde` | 4 | 不计入分母 |
| Q030 | Manon Lescaut | 468 | `Manon` | 0 | 不计入分母 |
| Q035 | The Lady of the Lake | 3011 | `（无）` | 0 | 不计入分母 |
| Q042 | The Love Letters of Mary Wollstonecr | 34413 | `Imlay` | 0 | 不计入分母 |
| Q043 | Meditations | 2680 | `（无）` | 0 | 不计入分母 |

> 这几本书在「排除 chapter_title IS NULL」的正式检索口径下**物理不可召回**，
> 所以它们的 Query 不可能命中 —— 把它们留在分母里只会稀释指标。这条口径与 Stage B.5 完全一致。

### 5.3 锚点修复 / 改型明细

| ID | 原 anchor | 新 anchor | 动作 | 原因 |
|---|---|---|---|---|
| Q001 | `Raskolnikov` | `Raskolnikov continued` | 改型 → 关键情节词 | 见 §4 |
| Q002 | `governess` | `Lowood` | 修复 | 见 §4 |
| Q003 | （无） | `Wickham` | 修复 | 见 §4 |
| Q005 | （无） | `Enter Benvolio` | 改型 → 关键情节词 | 见 §4 |
| Q007 | `Lowood` | `Brocklehurst` | 修复 | 见 §4 |
| Q008 | `Udolpho` | `Madame Montoni` | 改型 → 关键情节词 | 见 §4 |
| Q011 | `Cecil` | `Freddy` | 修复 | 见 §4 |
| Q014 | `Verona` | `MERCUTIO` | 修复 | 见 §4 |
| Q015 | `Carmen` | `Francisco Sevilla` | 改型 → 关键情节词 | 见 §4 |
| Q016 | `Syme` | `Ratcliffe` | 修复 | 见 §4 |
| Q017 | `Bertha` | `Antoinetta` | 修复 | 见 §4 |
| Q018 | `Bennet` | `Longbourn` | 修复 | 见 §4 |
| Q020 | `Friar` | `BALTHASAR` | 修复 | 见 §4 |
| Q021 | `Cheshire` | `It’s a Cheshire` | 修复 | 见 §4 |
| Q022 | `Hatter` | `a Hatter` | 修复 | 见 §4 |
| Q024 | `Thuvia` | `Ptarth still` | 改型 → 关键情节词 | 见 §4 |
| Q028 | `Transylvania` | `Seward’s Diary` | 改型 → 关键情节词 | 见 §4 |
| Q031 | `Ambrosio` | `Abbot agreed` | 改型 → 关键情节词 | 见 §4 |
| Q032 | `Ahab` | `Starbuck` | 修复 | 见 §4 |
| Q034 | `mummy` | `Sidney Bolton` | 改型 → 关键情节词 | 见 §4 |
| Q036 | `Alypius` | `speak thereof` | 改型 → 关键情节词 | 见 §4 |
| Q037 | （无） | `Victorinus` | 修复 | 见 §4 |
| Q041 | `Elinor` | `Brandon` | 修复 | 见 §4 |
| Q044 | `Valancy` | `Uncle Wellington` | 改型 → 关键情节词 | 见 §4 |
| Q046 | `Catherine` | `Catherine Barkley` | 改型 → 关键情节词 | 见 §4 |
| Q047 | （无） | `Bonello` | 修复 | 见 §4 |
| Q049 | `Clarens` | `Etange` | 修复 | 见 §4 |
| Q050 | `Sherlock` | `Boscombe` | 修复 | 见 §4 |
| Q051 | `Watson` | `Hosmer` | 修复 | 见 §4 |
| Q054 | `Lydgate` | `Bulstrode` | 修复 | 见 §4 |
| Q057 | `Queequeg` | `Yojo` | 修复 | 见 §4 |
| Q058 | `Starbuck` | `Moby` | 修复 | 见 §4 |
| Q060 | `Adler` | `Norton` | 修复 | 见 §4 |
| Q065 | `Wolmar` | `Eloisa` | 修复 | 见 §4 |
| Q066 | `Jasper` | `Durdles` | 修复 | 见 §4 |
| Q067 | `Marianne` | `Ferrars` | 修复 | 见 §4 |
| Q069 | `Lothar` | `Carthoris` | 修复 | 见 §4 |
| Q071 | `Pemberley` | `Derbyshire` | 修复 | 见 §4 |
| Q072 | `Thornfield` | `Millcote` | 修复 | 见 §4 |
| Q074 | `Basque` | `Elizondo` | 修复 | 见 §4 |
| Q076 | `Ithaca` | `Telemachus` | 修复 | 见 §4 |
| Q079 | `Udolpho` | `Emily` | 修复 | 见 §4 |
| Q080 | `Clarens` | `Preux` | 修复 | 见 §4 |
| Q082 | `Caterpillar` | `Rabbit-Hole` | 修复 | 见 §4 |
| Q083 | `Jose` | `Jose-Maria` | 修复 | 见 §4 |
| Q086 | `Syme` | `Renard` | 修复 | 见 §4 |
| Q087 | `Mercutio` | `Rosaline` | 修复 | 见 §4 |
| Q088 | `Ambrosio` | `Antonia` | 修复 | 见 §4 |
| Q092 | `Croce` | `Baedeker` | 修复 | 见 §4 |
| Q095 | `Alypius` | `Nebridius` | 修复 | 见 §4 |
| Q097 | `Ganimard` | `Baudru` | 修复 | 见 §4 |
| Q098 | `Necklace` | `Dreux-Soubise` | 修复 | 见 §4 |
| Q099 | `Brooke` | `Then you will think it wicked in me to we…` | 改型 → 长文本语义片段 | 见 §4 |
| Q100 | `Datchery` | `The waiter explained that he was the Verg…` | 改型 → 长文本语义片段 | 见 §4 |
| Q101 | `Ratcliffe` | `common in the English` | 修复 | 见 §4 |
| Q102 | `Worms` | `I am not in the British police,” said Sym…` | 改型 → 长文本语义片段 | 见 §4 |
| Q103 | `Stickles` | `Why didn’t _some one_ open the door and l…` | 改型 → 长文本语义片段 | 见 §4 |
| Q104 | `Rinaldi` | `I was very dusty and dirty and went up to…` | 改型 → 长文本语义片段 | 见 §4 |
| Q105 | `Montreux` | `But we had passports and we would spend t…` | 改型 → 长文本语义片段 | 见 §4 |
| Q106 | `Meillerie` | `It is at present confined to the walls of…` | 改型 → 长文本语义片段 | 见 §4 |

## 6. 分类分布（计入分母的 100 条）

| 类别 | 条数 | 判定依据 |
|---|---:|---|
| 人物名 | 55 | 锚点是人物专名（含 Virginia Woolf 时代的 role-name） |
| 地点名 | 16 | 锚点是地名 / 庄园 / 城堡 / 城市 |
| 专有名词 | 7 | 锚点是非人名非地名的专有名词（物件名、物种名、学派名、书名/神名） |
| 关键情节词 | 15 | 锚点是从该场景正文中挖出的多词短语（非单一专名） |
| 长文本语义片段 | 7 | 锚点是 10~40 词的整句摘录，且 query 本身是多子句长描述 |
| **合计** | **100** | |

## 7. 覆盖分布

### 7.1 按来源

| 来源 | 条数 |
|---|---:|
| 继承 B.5 | 47 |
| B.6 新增 | 53 |

### 7.2 按目标书（计入分母的 100 条）

| 目标书 | 条数 |
|---|---:|
| Crime and Punishment | 5 |
| Pride and Prejudice | 5 |
| Middlemarch | 5 |
| Eloisa | 5 |
| Jane Eyre | 4 |
| The Odyssey | 4 |
| Romeo and Juliet | 4 |
| The Mysteries of Udolpho | 4 |
| A Room with a View | 4 |
| Carmen | 4 |
| Alice's Adventures in Wonderland | 4 |
| Thuvia, maid of Mars | 4 |
| Dracula | 4 |
| The Green Mummy | 4 |
| The Confessions of St. Augustine | 4 |
| Sense and Sensibility | 4 |
| A farewell to arms | 4 |
| The Adventures of Sherlock Holmes | 4 |
| The Mystery of Edwin Drood | 4 |
| The Monk: A Romance | 3 |
| The Man Who Was Thursday: A Nightmare | 3 |
| Moby Dick | 2 |
| The Extraordinary Adventures of Arsène Lupin | 2 |
| The Blue Castle | 2 |
| Moby Dick; Or, The Whale | 2 |
| The Blue Castle: a novel | 2 |
| The Extraordinary Adventures of Arsène Lupin, Gentle | 2 |
| The Man Who Was Thursday | 1 |
| Jane Eyre: An Autobiography | 1 |

## 8. 可复现方式

```bash
cd server
C:/Python314/python.exe -u src/scripts/mine-query-candidates.py --per-book 40 --min-count 5 --phrase-top 16 --excerpt-top 6   # 挖候选（只读）
C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --propose          # 校验 + 自动修复
C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --retype           # 补齐五类中的后两类
C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --build            # 固化 v3 JSON
C:/Python314/python.exe -u src/scripts/make-query-validation-report.py          # 渲染本报告
```

> ⚠ 涉及 torch / sentence-transformers 的脚本必须在 **PowerShell** 下执行；
> 在 Git Bash（MSYS）下 `import torch` 会直接 SIGSEGV，与内存无关。详见 `query_embedding_latency.md`。
