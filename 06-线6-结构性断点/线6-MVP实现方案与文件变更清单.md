# 线6-MVP实现方案与文件变更清单（先入架、后全文 最小闭环）

> 责任：线6（主线第二部分）唯一执行 Worker，task_id=task-3
> 状态：只读 PREP（未写任何源码）。GO 由 Orchestrator 在负责人会签卡 B-B7 选「先入架后全文」后发出。
> 红线：不编造正文/释义；查不到显示「未收录/待接入」；空数据走 EmptyState；平台 API 只在 src/services/*/web.ts；技术栈版本不动；图标按钮带 aria-label+title；本轮只做离线侧 Dexie 关联，正文阅读留待线4/PG。

---

## 一、断点事实核对（已读源码确认）

| # | 事实 | 源码证据 |
|---|------|----------|
| 1 | 找书卡片无 onClick | src/components/discover/BookSearchPanel.tsx L168-186：命中卡是纯展示 div，无 onClick/按钮 |
| 2 | 导入书在 Dexie(readings 表，实体名 ReadingDoc) | src/services/storage/web.ts L135-143（readings 表 v2/v3/v12 均有 on_shelf 索引）；src/domain/types.ts L113-148 ReadingDoc；src/domain/learning.ts L296-338 saveReading |
| 3 | 发现书在 PG(discovered_books)，唯一键 (source_site, source_id) | server/sql/002_discover.sql L33-64 |
| 4 | 无 user_books 关联 | 全仓 grep user_books 无结果；书架 = readings 表 type=book 且 on_shelf（getShelfBooks src/domain/learning.ts L362-365） |
| 5 | /api/discover 响应只有 book_id（= discovered_books.id 字符串），不含 source_site/source_id | api/retrieve.py L36-51（SELECT b.id AS book_id）；api/main.py L405-414（results 映射）；src/data/discoverClient.ts L42-51（DiscoverResultItem.book_id） |
| 6 | 域层 BookHit 丢弃了 book_id/chunk_id | src/domain/discover/search.ts L27-36（BookHit 无 bookId）、L73-82（toBookHit 未映射 book_id） |
| 7 | 平台 API 客户端（discover）已存在，位于 src/data/discoverClient.ts（历史既有，本轮不动） | src/data/discoverClient.ts L145-155 |

**关键结论**：本轮「入架」动作纯离线写 Dexie，不新增任何平台 API 调用；「找书检索」沿用既有 /api/discover（不在本轮范围）。因此「平台 API 只在 src/services/*/web.ts」约束本轮不触发新代码，仅在文档备注：将来「按 source_id 拉全文」（线4/PG）必须落在 src/services/*/web.ts。

---

## 二、source_site / source_id 关联口径（快照 + 入架动作）

### 2.1 字段语义（写入 ReadingDoc 的行内可选字段）

| 字段 | 类型 | 取值 | 说明 |
|------|------|------|------|
| source_site | string? | 'gutenberg' | 发现书来源站点快照。有值即判定为「发现书」（正文待接入） |
| source_id | string? | = /api/discover 返回的 book_id | 发现书来源唯一标识快照（PG discovered_books.id 的字符串） |
| author | string? | API 返回的 author | 作者（书架卡片展示用；导入书无此字段） |

**决策边界（已知，如实标注，不阻断）**：
- 当前 /api/discover 只透出 book_id（PG 内部 id），不返回真正的 Gutenberg source_id 与 source_site。本轮前端能拿到的稳定标识就是 book_id，因此 source_id 快照 = book_id。
- source_site 前端固定常量 'gutenberg'，与 server/src/scripts/crawl-books.ts L26 的 SOURCE_SITE='gutenberg.org'、找书面板「来自 Project Gutenberg 公版库」文案一致。
- 未来（线4/PG）若需真正的 Gutenberg source_id，可在 api/retrieve.py 的 SELECT 追加 b.source_site, b.source_id 两列投影（不改 FROM/JOIN/WHERE/ORDER/LIMIT），无需改动本轮 Dexie 字段（字段本就是通用命名）。

### 2.2 幂等（重复入架不产生重复行）

- 稳定主键：discovered:<source_site>:<source_id>（如 discovered:gutenberg:7）。
- 通过 getReading(稳定id) 主键查询判定「是否已入架」，不新增索引、不升 Dexie 版本。
- 重复入架 = 覆盖更新（保留 created_at/pinned_at/booklists 等），与 saveReading 现有「同 id 覆盖保留进度」语义一致。

---

## 三、文件变更清单（精确路径 + 改动点）

### 新增（1 个）

| 路径 | 用途 |
|------|------|
| scripts/test_book_shelf.ts | 入架闭环单测（fake-indexeddb），验证幂等/字段快照/书架可见性/发现书判定 |

### 修改（8 个）

| # | 路径 | 改动点 |
|---|------|--------|
| 1 | src/domain/discover/search.ts | ① BookHit 增加 bookId: string、chunkId: number；② toBookHit 映射 book_id→bookId、chunk_id→chunkId；③ 新增导出常量 DISCOVER_SOURCE_SITE = gutenberg |
| 2 | src/domain/types.ts | ReadingDoc 增加行内可选字段 source_site?、source_id?、author?（不碰 StorageSchema 映射——readings: ReadingDoc 已是接口，自动生效） |
| 3 | src/domain/learning.ts | ① saveReading 输入与 doc 构造透传 source_site/source_id/author（?? prev?.xxx 保留覆盖语义）；② 新增 discoveredDocId(source_site, source_id)、shelveDiscoveredBook({title,author,source_site,source_id})、isBookShelved(source_site, source_id)、isDiscoveredBook(doc) |
| 4 | src/components/discover/BookSearchPanel.tsx | 每张命中卡加「入架」按钮（图标按钮带 aria-label+title）；点击调 shelveDiscoveredBook；组件内 shelved:Set<bookId> 记录已入架（按钮态「入架/已在书架」）；成功后 toast「已加入书架，可在首页书架查看（正文待接入）」 |
| 5 | src/components/home/Bookshelf.tsx | 发现书（isDiscoveredBook）卡片：封面左上角加「待接入」角标；副标题改显示 author（无作者则「待接入」）替代「0 词」；点击仍 navigate(/reader/:id)（统一行为，提示下沉到阅读器） |
| 6 | src/pages/Reader.tsx | 在 doc===null 分支旁加 3 行防御性早退：isDiscoveredBook(doc) 且 doc.content 为空 → EmptyState「正文待接入」（描述：来自发现书库，全文阅读待线4/PG 接入，当前仅支持入架收藏） |
| 7 | scripts/test_discover.ts | 域层成功映射断言补 outcome.hits[0].bookId === '7'（okBody 夹具已有 book_id:'7'） |
| 8 | package.json | test 链尾部追加 && tsx scripts/test_book_shelf.ts |

### 明确不改（防越界）

- src/services/storage/web.ts：不升 Dexie 版本、不加索引（新字段为行内可选，等价于 chapters/bookmarks/pinned_at 的先例）。
- src/data/discoverClient.ts：book_id 已具备，无需改。
- api/retrieve.py / api/main.py / 任何 Python：本轮不碰后端（「检索 SQL 不重写」红线；source_id 透出留待线4）。
- src/pages/Search.tsx：那是「单词搜索」页，与找书闭环无关，不动。

---

## 四、功能闭环（先入架、后全文）

1. 用户进 发现 → 找书（Discover.tsx tab books → BookSearchPanel），语义检索命中卡片。
2. 卡片「入架」按钮 → 域层 shelveDiscoveredBook → readings 表写入 {type:book, on_shelf:true, content:'', source_site:gutenberg, source_id:book_id, title, author}。
3. 我的书架可见：首页 Bookshelf（getShelfBooks 过滤 type=book 且 on_shelf）自动展示，带「待接入」角标 + 作者名。
4. 点该书 → /reader/:id → Reader 早退渲染「正文待接入」EmptyState（不进入空正文的翻页/听书/默写）。
5. 空数据/异常：找书沿用既有 EmptyState/ErrorState（未改）；入架无正文即 content=''，不编造。

---

## 五、「正文待接入」提示位置（定稿）

- 主提示（唯一事实源）：src/pages/Reader.tsx 的 doc===null 分支旁早退，EmptyState 标题「正文待接入」。
  - 覆盖所有入口：首页书架点书、导入页「我的素材」点书、直接输 URL。
- 提前信号（书架层）：src/components/home/Bookshelf.tsx 发现书卡片「待接入」角标 + 作者名副标题。
- 入架回执：BookSearchPanel 入架成功 toast 明示「（正文待接入）」。

---

## 六、四件套验证方式（收到 GO 后执行）

| 套 | 命令 | 覆盖点 |
|----|------|--------|
| 类型 | npx tsc --noEmit（或 npm run typecheck） | 新增字段/函数/组件类型全绿 |
| 单测 | npm test（链式 35 个 tsx 脚本，含新增 test_book_shelf.ts、改动的 test_discover.ts） | 入架幂等、字段快照、书架可见、发现书判定、bookId 映射 |
| 构建 | npm run build（= tsc --noEmit && vite build） | Vite5.4 + PWA 产物全绿 |
| PWA | python scripts/check_pwa.py | manifest/service-worker 校验通过 |

> 脚本已确认存在：scripts/check_pwa.py、scripts/test_discover.ts、scripts/test_readings.ts、scripts/test_bookschema_migration.ts（glob 命中）。

---

## 七、新增测试要点（scripts/test_book_shelf.ts）

1. shelveDiscoveredBook 写入 type=book 且 on_shelf===true 且 content==='' 且 source_site==='gutenberg' 且 source_id==='7'。
2. 同 (source_site,source_id) 重复入架 → 行数不增（幂等），created_at 保留。
3. getShelfBooks() 包含该书；isBookShelved('gutenberg','7')===true。
4. isDiscoveredBook 对发现书 true、对 saveReading（无 source_site）的导入书 false。
5. discoveredDocId 确定性（同一输入同一 id）。

---

## 八、结构化回报

agent=line6-mvp
task_id=task-3
status=PREP_DONE
files_touched=NONE
verification=tsc:N/A,test:N/A,build:N/A,pwa:N/A
evidence=《线6-MVP实现方案与文件变更清单.md》
decision_needed=
