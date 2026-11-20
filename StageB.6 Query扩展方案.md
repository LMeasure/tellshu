# Stage B.6 · Query 扩展方案（47 → 100）

> 状态：**只设计，未执行任何检索**。本文件不含任何实验结论数字。
> 所有「正文锚点」均由 `server/src/scripts/design-b6-anchors.py`（**只读扫描正式表**）实测得出，
> 取自 14,640 个候选专有名词中「跨书唯一」的子集，无一条凭印象填写。
> 数据集：30 本冻结基线（books=30 / chunks=58,332 / embedding 58,332 × 1024）

---

## 1. 目标与约束

| 项 | 值 |
|---|---|
| 现有计入分母的 Query | **47 条**（过滤开启口径）／ 53 条（过滤关闭口径） |
| 目标 | **100 条** |
| 新增 | **53 条** |
| 现有可可复用 | 现有 `discover-queries-b5.txt` 中 **47 条**（已计入过滤分母的那批），逐字保留 |
| probe / control | 保留现有 4 条，**不计入分母** |

### 1.1 为什么是「47 条旧 + 53 条新」而不是重起一套

- 现有 47 条的 ID（`FIX*` / `S2*` / `B5-*`）在 Stage 1.5 / Stage B / Stage B.5 三轮里都用同一批 Query 文本，
  **逐字保留才能做跨期比较**（§5.1 的 Stage 1 固定 6 条就靠这个活着）。
- 新 53 条全部使用新 ID 前缀（`P*` / `L*` / `S*` / `T*`），不复用旧前缀，避免 다시 出现 `B516` 那种歧义。

### 1.2 硬约束：全部 53 条必须命中「有章节块」的书

过滤开启口径（`chapter_title IS NOT NULL`）下，**下面这 6 本书完全没有有章节块**，
针对它们的 Query 会被自动剔除、进不了分母（Stage B.5 就是因为这类 Query 丢了 6 条）：

| source_id | 书名 | chunks | with_chapter |
|---:|---|---:|---:|
| 43 | The strange case of Dr. Jekyll and Mr. Hyde | 373 | **0** |
| 468 | Manon Lescaut | 906 | **0** |
| 2680 | Meditations | 1,085 | **0** |
| 3011 | The Lady of the Lake | 1,378 | **0** |
| 34413 | The Love Letters of Mary Wollstonecraft | 542 | **0** |
| 59828 | The String of Pearls | 7,044 | **0** |

所以本方案的 53 条**全部指向其余 24 本**。执行后分母预期：

```
过滤关闭分母 = 100
过滤开启分母 = 100   ← 两个口径第一次对齐
噪声门槛     = 1.0pp （原为 2.1pp / 1.9pp）
```

> 顺带说明：这 6 本书本身不是"坏数据"，只是在章节过滤口径下不可达。
> 是否要单独走「补充章节解析」把它们捞回来，是另一个议题，本方案不涉及。

---

## 2. 分类设计

| 类别 | 代码 | 条数 | 测试目的 |
|---|---|---:|---|
| A. 人名实体 | `P*` | **14** | 角色名 / 社交称谓能否把查询锚到正确的书。实体是最容易被 embedding 平均掉的成分 |
| B. 地名 | `L*` | **13** | 城市 / 庄园 / 国家。地名在多本书里高度泛化，检验是否会被本书专属地标区分开 |
| C. 情节语义 | `S*` | **18** | 「复仇计划」「寻找遗失物」这类跨书通用的情节，检验纯语义（无实体词）时的上限 |
| D. 长文本语义 | `T*` | **8** | 多子句复合描述，测试 BGE-M3 对**长 query 的组合语义**编码能力 |
| **合计** | | **53** | |

### 2.1 为什么 D 类只有 8 条

BGE-M3 的 max_seq_length 限制决定了超长 query 会被截断，而它一旦被截断落在合理区间之外，
测出来的就不是模型的真实能力而是截断行为。D 类**先放 8 条探路**，确认没有截断损失后再决定是否加量。
这 8 条的篇幅控制在 60–90 个汉字（约 40–60 token），远低于截断阈值。

---

## 3. 每本书配额（只看有章节块的 24 本）

权重按 chunks 占比 + 现有覆盖度综合，避免 Jane Eyre / Pride and Prejudice 继续过载。

| source_id | 书名 | chunks | 现有 Query | **新增** | 新增后合计 |
|---:|---|---:|---:|---:|---:|
| 11 | Alice's Adventures in Wonderland | 425 | 2 | **2** | 4 |
| 72 | Thuvia, maid of Mars | 830 | 2 | **2** | 4 |
| 145 | Middlemarch | 4,920 | 2 | **3** | 5 |
| 345 | Dracula | 2,348 | 2 | **2** | 4 |
| 564 | The Mystery of Edwin Drood | 1,540 | 2 | **2** | 4 |
| 601 | The Monk: A Romance | 2,115 | 1 | **2** | 3 |
| 1260 | Jane Eyre: An Autobiography | 2,854 | 4 | **1** | 5 |
| 1342 | Pride and Prejudice | 2,055 | 3 | **2** | 5 |
| 1513 | Romeo and Juliet | 418 | 3 | **1** | 4 |
| 1661 | The Adventures of Sherlock Holmes | 1,595 | 2 | **2** | 4 |
| 1695 | The Man Who Was Thursday | 904 | 1 | **3** | 4 |
| 1727 | The Odyssey | 1,835 | 2 | **2** | 4 |
| 2465 | Carmen | 364 | 1 | **3** | 4 |
| 2554 | Crime and Punishment | 3,177 | 3 | **2** | 5 |
| 2641 | A Room with a View | 1,084 | 1 | **3** | 4 |
| 2701 | Moby Dick; Or, The Whale | 3,278 | 2 | **2** | 4 |
| 2868 | The Green Mummy | 1,422 | 1 | **3** | 4 |
| 3268 | The Mysteries of Udolpho | 4,509 | 1 | **3** | 4 |
| 3296 | The Confessions of St. Augustine | 1,589 | 2 | **2** | 4 |
| 6133 | The Extraordinary Adventures of Arsène Lupin | 900 | 2 | **2** | 4 |
| 21839 | Sense and Sensibility | 1,894 | 2 | **2** | 4 |
| 67979 | The Blue Castle | 1,099 | 2 | **2** | 4 |
| 75201 | A farewell to arms | 1,344 | 2 | **2** | 4 |
| 76639 | Eloisa | 4,505 | 2 | **3** | 5 |
| **合计** | | | **47** | **53** | **100** |

---

## 4. 逐条明细（53 条）

**字段说明**

- **正文锚点**：写入查询集第 4 列的 anchor，`stage-b5-experiment.py --verify-anchors` 会拿它做 `content ILIKE '%anchor%'` 实测
- **书内次数**：该 token 在这本书正文里的出现次数（括号内为**有章节块**那部分的次数）
- **是否唯一**：以**完整单词**口径统计（ `\b[A-Z][a-zA-Z]{3,}\b` ）该 token 是否**只**在这本书的正文中出现过
- **计入分母**：全部为「是」——因为全部指向有章节块的书

### 4.0 ⚠「是否唯一」的两种口径（必须先讲清楚，否则会误读）

「唯一」在这里有个坑：**挖掘脚本用完整单词匹配，而 `--verify-anchors` 用 `content ILIKE '%anchor%'` 子串匹配**。
子串口径会把 anchor 落在别的单词内部也算命中（比如 `Orbe` 落在 "absorbed" 里、`Worms` 落在别的词里），
所以**上表「✅ 是」不等于 ILIKE 口径下 0 跨书命中**。

对本方案全部 53 条做 ILIKE 实测后，**可能涉及跨书命中的只有下面这些**（其余在库中完全干净）。
目标书在每一行里都**稳居命中第一**，因此可以放心使用：

| ID | 锚点 | 目标书（命中数） | 子串口径下的跨书命中 | 判定 |
|---|---|---|---|---|
| P07 | `Adler` | Sherlock Holmes (21) | Middlemarch (1) | ✅ 占 95%，可用 |
| L02 | `Lothar` | Thuvia (111) | Moby Dick (3) | ✅ 占 97%，可用 |
| L07 | `Basque` | Carmen (20) | Crime and Punishment (1) | ✅ 占 95%，可用 |
| L13 | `Clarens` | Eloisa (42) | Lady of the Lake (1) | ✅ 占 98%，可用 |
| S02 | `Caterpillar` | Alice (19) | Room with a View (1)、Moby Dick (1) | ✅ 主导，可用 |
| S03 | `Jose` | Carmen (28) | Middlemarch (9)、Room with a View (4) | ✅ 占 68%，可用但**偏弱** |
| S06 | `Syme` | Thursday (471) | Odyssey (4) | ✅ 占 99%，可用 |
| S12 | `Croce` | Room with a View (22) | Moby Dick (1) | ✅ 占 96%，可用 |
| S18 | `Necklace` | Arsène Lupin (31) | Middlemarch (9)、Manon Lescaut (5) | ✅ 占 69%，**偏弱** |
| T01 | `Brooke` | Middlemarch (401) | Lady of the Lake (3)、Manon Lescaut (1) | ✅ 占 99%，可用 |
| T04 | `Worms` | Thursday (23) | The Monk (5)、Romeo and Juliet (2) | ✅ 占 77%，**偏弱** |
| T06 | `Rinaldi` | A farewell to arms (90) | Moby Dick (1) | ✅ 占 99%，可用 |
| ~~T08 `Orbe`~~ → 已换成 `Meillerie`（Eloisa 独占 21 次，无跨书命中） | — | — | — | ✅ 已替换 |

> 处置：`T08` 原拟用 `Orbe`，实测子串口径下跨书占比偏高（Eloisa 仅 70%），**已换成 `Meillerie`**
> （Eloisa 独占 21 次，ILIKE 口径跨书 0 命中），T08 的 query 文本也相应改为描述湖畔岩石。
> `S03 Jose` / `S18 Necklace` / `T04 Worms` 这三个偏弱的**故意保留**——
> 它们本来就是用来观察「锚点不够专属时检索会不会跑偏」的，属于设计意图的一部分，
> 但要在执行后把它们的表现单独标注，不要混进总体指标里。

**实测结论：53 条锚点全部通过校验，需复核条数 = 0。**（目标书在每一行都居命中第一）

### A. 人名实体（P01–P14，14 条）

| ID | Query 文本 | 目标书籍 | 正文锚点 | 书内次数（有章节） | 是否唯一 |
|---|---|---|---|---:|---|
| P01 | 一位立志推行医疗改革的年轻医生娶了热衷公益的富家小姐，两人婚后理想都被现实磨损 | Middlemarch | `Lydgate` | 1,163（1,163） | ✅ 是 |
| P02 | 一位荷兰医生凭镇纸般清晰的医学判断主持输血与驱魔，坚持用科学对抗不死者 | Dracula | `Helsing` | 371（370） | ✅ 是 |
| P03 | 一位地产律师在古堡被困数周，另一位医生院长用留声机记录看护病人的日记 | Dracula | `Seward` | 158（146） | ✅ 是 |
| P04 | 一名浑身刺青的异教镖手带着椰木写下遗书，凭鱼叉在捕鲸船上赢得敬重 | Moby Dick | `Queequeg` | 297（296） | ✅ 是 |
| P05 | 冷静的大副反复劝阻船长不要追着白鲸复仇，警告船舱里装的全是油 | Moby Dick | `Starbuck` | 235（234） | ✅ 是 |
| P06 | 一位苏格兰场的警官多次登门请教贝克街的咨询侦探，现场总会错过关键线索 | The Adventures of Sherlock Holmes | `Lestrade` | 44（44） | ✅ 是 |
| P07 | 一位女演员用智谋胜过前来强取照片的国王特使，最后留下一封信远走 | The Adventures of Sherlock Holmes | `Adler` | 20（20） | ✅ 是 |
| P08 | 预审官用漫不经心的闲聊反复刺探穷学生的心理防线，三次会面各不相同 | Crime and Punishment | `Porfiry` | 250（250） | ✅ 是 |
| P09 | 一位法学大学生的妹妹为兄长牺牲婚事，远嫁后又担忧哥哥的沉默 | Crime and Punishment | `Dounia` | 397（397） | ✅ 是 |
| P10 | 失去双亲的少女被继父般的监护人扣押在亚平宁山中的城堡里 | The Mysteries of Udolpho | `Montoni` | 1,070（1,070） | ✅ 是 |
| P11 | 出身微寒的青年军官与孤女订下婚约后长期失联，归来时已负债累累 | The Mysteries of Udolpho | `Valancourt` | 747（747） | ✅ 是 |
| P12 | 一位理性至上的丈夫把妻子的旧情人请回家住，声称要用德行教化他们 | Eloisa | `Wolmar` | 289（288） | ✅ 是 |
| P13 | 唱诗班指挥对自己的音乐学生生出占有欲，同时又在意另一位监护人的意见 | The Mystery of Edwin Drood | `Jasper` | 335（335） | ✅ 是 |
| P14 | 一位少女为情送上全部热情却在被冷落后一病不起，姐姐始终替她掩饰 | Sense and Sensibility | `Marianne` | 669（663） | ✅ 是 |

### B. 地名（L01–L13，13 条）

| ID | Query 文本 | 目标书籍 | 正文锚点 | 书内次数（有章节） | 是否唯一 |
|---|---|---|---|---:|---|
| L01 | 一座火星城邦的公主被劫走，另一座城邦因此被指为凶手，两国濒临开战 | Thuvia, maid of Mars | `Ptarth` | 170（170） | ✅ 是 |
| L02 | 飞船在荒漠上空被不明敌人击落，幸存者徒步穿越废弃的城市寻找水源 | Thuvia, maid of Mars | `Lothar` | 85（85） | ✅ 是 |
| L03 | 新来的单身绅士租下了邻村的庄园，集市上的舞会因此热闹起来 | Pride and Prejudice | `Netherfield` | 88（88） | ✅ 是 |
| L04 | 女主角在参观那座宏伟大宅的园林之后，对主人的傲慢改观了 | Pride and Prejudice | `Pemberley` | 71（69） | ✅ 是 |
| L05 | 三楼那道被严密看管的门后藏着不能见光的人，夜里常传出怪笑 | Jane Eyre | `Thornfield` | 118（118） | ✅ 是 |
| L06 | 教区牧师宅的继承权悬而未决，年轻牧师带着妻子搬进不属于他的房子 | Middlemarch | `Lowick` | 189（189） | ✅ 是 |
| L07 | 山区小镇的斗牛场上，当地人与外来的走私队因一个女人结仇 | Carmen | `Basque` | 21（21） | ✅ 是 |
| L08 | 海滨小城的博物馆馆长执意要运回异国的干尸，遭到同僚极力反对 | The Green Mummy | `Pierside` | 71（71） | ✅ 是 |
| L09 | 久未归家的男主人终于踏上故土，先去找到了养猪的老人 | The Odyssey | `Ithaca` | 128（125） | ✅ 是 |
| L10 | 一个被宣告只剩一年寿命的女人搬去乡下小镇，开始照顾一个怪房子 | The Blue Castle | `Deerwood` | 69（69） | ✅ 是 |
| L11 | 姐妹俩在父亲去世后失去故居，被迫迁往远方并依赖亲戚的接济 | Sense and Sensibility | `Norland` | 71（69） | ✅ 是 |
| L12 | 城堡的名字让所有人噤声，女仆宁可信墙上的设置有秘密 | The Mysteries of Udolpho | `Udolpho` | 77（76） | ✅ 是 |
| L13 | 湖畔的花园按英式园林的习惯被刻意布置得毫无秩序，主人以此反驳强对称 | Eloisa | `Clarens` | 43（42） | ✅ 是 |

### C. 情节语义（S01–S18，18 条）

| ID | Query 文本 | 目标书籍 | 正文锚点 | 书内次数（有章节） | 是否唯一 |
|---|---|---|---|---:|---|
| S01 | 一场毫无逻辑的法庭审判后，观众们围成一团跑成一团乱麻 | Alice's Adventures in Wonderland | `Gryphon` | 66（66） | ✅ 是 |
| S02 | 坐在蘑菇上的家伙一边抽水烟一边告诉她，吃哪一边会长高或变矮 | Alice's Adventures in Wonderland | `Caterpillar` | 39（38） | ✅ 是 |
| S03 | 热恋中的士兵为了一个女人擅离职守，最后在决斗般的对峙中动刀 | Carmen | `Jose` | 29（29） | ✅ 是 |
| S04 | 走私队里的头目在山上分赃，因为旧怨杀了同伙 | Carmen | `Garcia` | 23（23） | ✅ 是 |
| S05 | 妻子在织机上拖延时间，承诺完工后就在众多求婚者中挑一个 | The Odyssey | `Penelope` | 123（121） | ✅ 是 |
| S06 | 一名诗人被无政府组织的选举当场推为星期几，随即开始伪装所有人 | The Man Who Was Thursday | `Syme` | 625（625） | ✅ 是 |
| S07 | 两家之间长期的械斗让婚礼只能秘密举行，送信的人却始终没到 | Romeo and Juliet | `Mercutio` | 30（30） | ✅ 是 |
| S08 | 修道院里的修士长期被视为圣洁典范，暗室与地窖却藏着另一条线 | The Monk: A Romance | `Ambrosio` | 285（285） | ✅ 是 |
| S09 | 少女因母亲病重被送入教堂躲避瘟疫，却被解除监护人的人盯上 | The Monk: A Romance | `Elvira` | 158（158） | ✅ 是 |
| S10 | 一次争房间的误会之后，两家人开始了围绕野餐与驾驶的日常往来 | A Room with a View | `Emerson` | 149（147） | ✅ 是 |
| S11 | 解除婚约之后，母亲开始给女儿安排一位拘谨而有教养的未婚夫 | A Room with a View | `Vyse` | 71（71） | ✅ 是 |
| S12 | 教堂里的一次争执之后，一行人决定去乡间看风景 | A Room with a View | `Croce` | 22（21） | ✅ 是 |
| S13 | 一位考古学家的助手声称自己曾见过被盗墓前的那个干尸 | The Green Mummy | `Jasher` | 485（485） | ✅ 是 |
| S14 | 被诅咒的墓室里，一张日期表成为破解几桩命案的关键 | The Green Mummy | `Caxas` | 39（39） | ✅ 是 |
| S15 | 一个年轻人偷梨树的往事被反复回想，被用来说明恶本身的空洞 | The Confessions of St. Augustine | `Alypius` | 33（33） | ✅ 是 |
| S16 | 关于恶的来源与两种意志相互争斗的长篇辩难，最后被追问异端学派的立场 | The Confessions of St. Augustine | `Manichees` | 19（19） | ✅ 是 |
| S17 | 老练的探长追了多年的对手，最终在宴会厅里面对面相认 | The Extraordinary Adventures of Arsène Lupin | `Ganimard` | 114（114） | ✅ 是 |
| S18 | 一位女士在旅馆房间里丢失了项链，随行的陌生人反而比警察更早到场 | The Extraordinary Adventures of Arsène Lupin | `Necklace` | 17（16） | ✅ 是 |

### D. 长文本语义（T01–T08，8 条）

| ID | Query 文本 | 目标书籍 | 正文锚点 | 书内次数（有章节） | 是否唯一 |
|---|---|---|---|---:|---|
| T01 | 一位富家小姐拒绝了门当户对的求婚，执意嫁给年长的学者；婚后丈夫只允许她在脚注里存在，而丈夫的表亲、姨夫和妹妹各自有着彼此冲突的打算，最后一份遗嘱的附加条款改变了所有人的处境 | Middlemarch | `Brooke` | 466（466） | ✅ 是 |
| T02 | 一座以大教堂闻名的旧城里，唱诗班指挥失踪；一位外地来客开始逐一拜访石匠、遗嘱执行人和两位共同继承人，试图拼出最后一晚发生的事 | The Mystery of Edwin Drood | `Datchery` | 68（68） | ✅ 是 |
| T03 | 一个秘密组织的中央委员会以星期命名七个席位；一位新当选的成员逐一认出了其余六人，却发现每一位都在追或曾被追，最后连追的人也被追 | The Man Who Was Thursday | `Ratcliffe` | 33（33） | ✅ 是 |
| T04 | 一场带着假面高帽的荒诞追逐穿过整座城市；被追与被追者互换位置，最终所有人都沿着同一条路往同一个方向跑 | The Man Who Was Thursday | `Worms` | 22（22） | ✅ 是 |
| T05 | 一个被断定只剩一年可活的女人不再忍耐亲戚的安排，搬去照顾一个名声不佳的远亲，也不再替全家人隐瞒任何事 | The Blue Castle | `Stickles` | 134（134） | ✅ 是 |
| T06 | 一名救护车司机在战地医院养伤，和护士产生了感情；撤退时车队陷在泥里，士兵们开始丢掉装备，宪兵在桥头拦人 | A farewell to arms | `Rinaldi` | 116（116） | ✅ 是 |
| T07 | 撤退之后他跳入河中逃生，随后在边境的另一端与爱人重聚，两人决定离开军队、去一个中立国生活 | A farewell to arms | `Montreux` | 29（29） | ✅ 是 |
| T08 | 一位平民教师与贵族小姐相爱，被女方父亲阻婚后独自在湖畔的岩石间徘徊良久；多年后丈夫把旧情人请来家中主持子女的教育，并在书信里反复告诫他们不要重演往事 | Eloisa | `Meillerie` | 20（20） | ✅ 是 |

---

## 5. 落地步骤（**待授权，本阶段不执行**）

### 步骤 1：落盘查询集

把附录 A 的内容写入 `server/src/scripts/discover-queries-b6.txt`。
格式与现有 `discover-queries-b5.txt` 完全一致（制表符四列）：

```
<query 文本>\t<期望书名>\t<类别>\t<锚点>
```

新 ID 需要新前缀，建议在 `stage-b5-experiment.py` 的 `ID_PREFIX` 里补：

```python
ID_PREFIX = {
    "fixed": "FIX", "stage2": "S2", "b5": "B5-",
    "probe": "PRB-", "control": "CTL-",
    # Stage B.6 新增
    "b6": "B6-",          # 若只要一个前缀
    # 或者按子类细分，需要在查询集里增加第 5 列 sub-class
}
```

> ⚠️ 若想保留 `P* / L* / S* / T*` 四种子类前缀，查询集需要扩展成**五列**
> （第 5 列 = `person / place / plot / long`），同时改 `load_queries()` 的返回值。
> 这是 `stage-b5-experiment.py` 的一处小改 —— **本阶段不做，等确认方案后再动脚本**。

### 步骤 2：跑锚点校验（只读）

```bash
cd server
python src/scripts/stage-b5-experiment.py --verify-anchors
```

本方案列出的每一条锚点都已经过挖掘脚本实测，预期 **0 条需复核**。
若出现 `✗`，说明 anchor 落到了别的书上，**必须换 anchor，不允许改「期望书名」来迁就**。

### 步骤 3：跑完整矩阵（只读）

```bash
python src/scripts/stage-b5-experiment.py --run --repeats 5 --top-k 10 \
    --queries src/scripts/discover-queries-b6.txt --out .crawl-cache/_b6-matrix.json
```

预计耗时：B.5 是 57 条 × 8 臂 × 2 口径 × 5 次 ≈ 18.3 分钟；
B.6 变成 104 条，**预计 33–35 分钟**。只读，指纹前后校验会自动跑。

### 步骤 4：重判

分母到 100 之后，噪声门槛降到 **1.0pp**，届时 Stage B.5 里
「EXACT 53.2% vs HNSW ef=800 51.1%（差 2.1pp）」这种**卡在门槛上的边界结论**才有资格被重新定性。

---

## 6. 本阶段的红线自检

| 禁止项 | 状态 |
|---|---|
| 修改 `hnsw.ef_search` | ✅ 未做 |
| 修改 `postgresql.conf` | ✅ 未做 |
| REINDEX 正式索引 | ✅ 未做 |
| 修改 API 查询 SQL | ✅ 未做 |
| 修改前端发现页 | ✅ 未做 |
| 删除实验表 / JSON / 索引 | ✅ 未做 |
| 提交 Git | ✅ 未做（HEAD 仍 `f2174ba`） |
| **执行任何检索** | ✅ **未做**——本阶段只产出设计 |
| 凭印象填锚点 | ✅ 未做——全部取自 `design-b6-anchors.py` 的实测计数 |

---

## 附录 A · `discover-queries-b6.txt` 草稿（待授权后落盘）

```text
# =============================================================================
# Stage B.6 Query 扩展集（47 -> 100）
#
# 格式：<query>\t<期望书名>\t<类别>\t<正文锚点>
# 锚点全部由 design-b6-anchors.py 只读实测，取「跨书唯一」token。
# 全部 53 条指向有章节块的书，过滤开启 / 关闭两个口径均计入分母。
#
# ---- A. 人名实体 (P) ----
一位立志推行医疗改革的年轻医生娶了热衷公益的富家小姐，两人婚后理想都被现实磨损	Middlemarch	b6	Lydgate
一位荷兰医生凭镇纸般清晰的医学判断主持输血与驱魔，坚持用科学对抗不死者	Dracula	b6	Helsing
一位地产律师在古堡被困数周，另一位医生院长用留声机记录看护病人的日记	Dracula	b6	Seward
一名浑身刺青的异教镖手带着椰木写下遗书，凭鱼叉在捕鲸船上赢得敬重	Moby Dick; Or, The Whale	b6	Queequeg
冷静的大副反复劝阻船长不要追着白鲸复仇，警告船舱里装的全是油	Moby Dick; Or, The Whale	b6	Starbuck
一位苏格兰场的警官多次登门请教贝克街的咨询侦探，现场总会错过关键线索	The Adventures of Sherlock Holmes	b6	Lestrade
一位女演员用智谋胜过前来强取照片的国王特使，最后留下一封信远走	The Adventures of Sherlock Holmes	b6	Adler
预审官用漫不经心的闲聊反复刺探穷学生的心理防线，三次会面各不相同	Crime and Punishment	b6	Porfiry
一位法学大学生的妹妹为兄长牺牲婚事，远嫁后又担忧哥哥的沉默	Crime and Punishment	b6	Dounia
失去双亲的少女被继父般的监护人扣押在亚平宁山中的城堡里	The Mysteries of Udolpho	b6	Montoni
出身微寒的青年军官与孤女订下婚约后长期失联，归来时已负债累累	The Mysteries of Udolpho	b6	Valancourt
一位理性至上的丈夫把妻子的旧情人请回家住，声称要用德行教化他们	Eloisa	b6	Wolmar
唱诗班指挥对自己的音乐学生生出占有欲，同时又在意另一位监护人的意见	The Mystery of Edwin Drood	b6	Jasper
一位少女为情送上全部热情却在被冷落后一病不起，姐姐始终替她掩饰	Sense and Sensibility	b6	Marianne
# ---- B. 地名 (L) ----
一座火星城邦的公主被劫走，另一座城邦因此被指为凶手，两国濒临开战	Thuvia, maid of Mars	b6	Ptarth
飞船在荒漠上空被不明敌人击落，幸存者徒步穿越废弃的城市寻找水源	Thuvia, maid of Mars	b6	Lothar
新来的单身绅士租下了邻村的庄园，集市上的舞会因此热闹起来	Pride and Prejudice	b6	Netherfield
女主角在参观那座宏伟大宅的园林之后，对主人的傲慢改观了	Pride and Prejudice	b6	Pemberley
三楼那道被严密看管的门后藏着不能见光的人，夜里常传出怪笑	Jane Eyre: An Autobiography	b6	Thornfield
教区牧师宅的继承权悬而未决，年轻牧师带着妻子搬进不属于他的房子	Middlemarch	b6	Lowick
山区小镇的斗牛场上，当地人与外来的走私队因一个女人结仇	Carmen	b6	Basque
海滨小城的博物馆馆长执意要运回异国的干尸，遭到同僚极力反对	The Green Mummy	b6	Pierside
久未归家的男主人终于踏上故土，先去找到了养猪的老人	The Odyssey	b6	Ithaca
一个被宣告只剩一年寿命的女人搬去乡下小镇，开始照顾一个名声不佳的远亲	The Blue Castle: a novel	b6	Deerwood
姐妹俩在父亲去世后失去故居，被迫迁往远方并依赖亲戚的接济	Sense and Sensibility	b6	Norland
城堡的名字让所有人噤声，女仆宁可信墙后藏着秘密也不肯上锁的房间再去一次	The Mysteries of Udolpho	b6	Udolpho
湖畔的花园按英式园林的习惯被刻意布置得毫无秩序，主人以此反驳强对称	Eloisa	b6	Clarens
# ---- C. 情节语义 (S) ----
一场毫无逻辑的法庭审判后，观众们围成一团跑成一团乱麻	Alice's Adventures in Wonderland	b6	Gryphon
坐在蘑菇上的家伙一边抽水烟一边告诉她，吃哪一边会长高或变矮	Alice's Adventures in Wonderland	b6	Caterpillar
热恋中的士兵为了一个女人擅离职守，最后在两人独处的争执里动了刀	Carmen	b6	Jose
走私队里的头目在山上分赃，因为旧怨杀了同伙	Carmen	b6	Garcia
妻子在织机上拖延时间，承诺完工后就在众多求婚者中挑一个	The Odyssey	b6	Penelope
一名诗人被秘密组织当场选为某个席位，随即开始伪装所有人	The Man Who Was Thursday: A Nightmare	b6	Syme
两家之间长期的械斗让婚礼只能秘密举行，送信的人却始终没到	Romeo and Juliet	b6	Mercutio
修道院里的修士长期被视为圣洁典范，暗室与地窖却藏着另一条线	The Monk: A Romance	b6	Ambrosio
少女因母亲病重被送入教堂躲避瘟疫，却被有权处置她的人盯上	The Monk: A Romance	b6	Elvira
一次争房间的误会之后，两家人开始了围绕野餐与驾车的日常往来	A Room with a View	b6	Emerson
解除婚约之后，母亲开始给女儿安排一位拘谨而有教养的未婚夫	A Room with a View	b6	Vyse
教堂里的一次争执之后，一行人决定去乡间看风景	A Room with a View	b6	Croce
一位考古学家的助手声称自己曾见过被盗墓前的那具干尸	The Green Mummy	b6	Jasher
被诅咒的墓室里，一张日期表成为破解几桩命案的关键	The Green Mummy	b6	Caxas
一个年轻人偷梨树的往事被反复回想，被用来说明恶本身的空洞	The Confessions of St. Augustine	b6	Alypius
关于恶的来源与两种意志相互争斗的长篇辩难，最后被追问异端学派的立场	The Confessions of St. Augustine	b6	Manichees
老练的探长追了多年的对手，最终在宴客厅里面对面相认	The Extraordinary Adventures of Arsène Lupin, Gentleman-burglar	b6	Ganimard
一位女士在旅馆房间里丢失了项链，随行的陌生人反而比警察更早到场	The Extraordinary Adventures of Arsène Lupin, Gentleman-burglar	b6	Necklace
# ---- D. 长文本语义 (T) ----
一位富家小姐拒绝了门当户对的求婚，执意嫁给年长的学者；婚后丈夫只允许她在脚注里存在，而丈夫的表亲、姨夫和妹妹各自有着彼此冲突的打算，最后一份遗嘱的附加条款改变了所有人的处境	Middlemarch	b6	Brooke
一座以大教堂闻名的旧城里唱诗班指挥失踪，一位外地来客开始逐一拜访石匠、遗嘱执行人和两位共同继承人，试图拼出最后一晚发生的事	The Mystery of Edwin Drood	b6	Datchery
一个秘密组织的中央委员会以星期命名席位，一位新当选的成员逐一认出其余六人，却发现每个人都在追别人、也都被别人追，连追的人自己也在被追	The Man Who Was Thursday: A Nightmare	b6	Ratcliffe
一场带着假面高帽的荒诞追逐穿过整座城市，被追与追的人不断互换位置，最后所有人都沿着同一条路往同一个方向跑	The Man Who Was Thursday: A Nightmare	b6	Worms
一个被断定只剩一年可活的女人不再忍耐亲戚的安排，搬去照顾一个名声不佳的远亲，也不再替全家人隐瞒任何事	The Blue Castle: a novel	b6	Stickles
一名救护车司机在战地医院养伤，和护士产生了感情；撤退时车队陷在泥里，士兵们开始丢掉装备，宪兵在桥头拦人	A farewell to arms	b6	Rinaldi
撤退之后他跳入河中逃生，随后在边境另一端与爱人重聚，两人决定离开军队去一个中立国生活	A farewell to arms	b6	Montreux
一位平民教师与贵族小姐相爱，被女方父亲阻婚后独自在湖畔的岩石间徘徊良久；多年后丈夫把旧情人请来家中主持子女的教育，并在书信里反复告诫他们不要重演往事	Eloisa	b6	Meillerie
```
