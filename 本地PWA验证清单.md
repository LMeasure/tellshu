# 本地 PWA 验证清单（Chrome 手动点击版）

> 不装 Playwright，全部用 Chrome 自带 DevTools 完成。  
> 全程约 10 分钟。**每步都有「验收点」，和预期不一致就停下来告诉我，别硬往下走。**

---

## 0. 前置：确认服务在跑，并锁定端口

预览服务走 **4173 或 4174 都行，但必须每次都打开同一个地址**。dev 模式（5173）不行。

> 原因一：`vite.config.ts` 里 `devOptions: { enabled: false }` —— dev 模式**故意不注册 Service Worker**，
> 否则改数据会被缓存挡住，联调会很痛苦。所以 5173 上永远看不到 PWA 效果。
>
> 原因二：**localhost:4173 和 localhost:4174 在浏览器眼里是两个不同的站点**。
> 换端口 = 换站点 = 缓存桶、IndexedDB、Service Worker 全部从零开始。
> 这次验收里 `shushu-index` 只有 3 条、`shushu-data` 有 9 条，且数据响应头是 `basic`（同源），
> 说明缓存本身工作是正常的；但如果你中途换过端口，之前点的内容就都「不算数」了。

```bash
cd "C:/Users/lagom/WorkBuddy/2026-10-02-10-40-40/shutree/述树交付包"
npm run build          # 必须先构建，dist/ 才是带 sw.js 的产物
npm run preview        # 起 4173；如果 4173 被占用，vite 会自动跳到 4174
```

- **验收点**：终端打印 `➜  Local: http://localhost:<端口>/`，**把这个端口号记下来，后面一直用它**。
- 已经开过 preview 且没重 build，先 `Ctrl+C` 停掉再重跑 build + preview，避免测到旧产物。
- 想固定端口：`npm run preview -- --port 4173 --strictPort`（端口被占会直接报错，不静默跳号）。

---

## 1. 用无痕窗口打开（推荐，避免旧 SW 干扰）

`Ctrl + Shift + N` 开无痕窗口 → 访问 `http://localhost:4173/`

- **验收点**：首页正常渲染，底部导航能点，无 console 报错。

---

## 2. `DevTools → Application → Service Workers`

`F12` → 顶部标签切到 **Application** → 左侧 **Service Workers**

- **验收点**：
  - `sw.js` 一行，Status 是绿色圆点 + **「activated and is running」**
  - Source 路径形如 `http://localhost:4174/sw.js`（端口跟你第 0 步记的一致）
- 如果显示 `registered but not active` → 勾上 **Update on reload** 再刷新一次。
- 如果**一行都没有** → 说明打开的是 5173 或没 build，回到第 0 步。

---

## 3. Application → Manifest

左侧 **Manifest**

- **验收点**：
  - Name = `述树 · 零基础英语`，Short name = `述树`
  - **Installability** 区域不报红（最多提示 "No matching service worker detected" 之类已解决项）
  - Icons 区域能预览出 192 / 512 / maskable-512 三张图
- 如果 manifest 报 "could not be fetched" → `dist/manifest.webmanifest` 没生成，重跑 build。

---

## 4. 安装成本地应用

先做一件事：**Console 粘一段诊断**。F12 → Console → 把 `scripts/browser_diagnose.js` 的全部内容粘贴进去 → 回车。
它会直接把「为什么装不上」的每一条原因打出来，比人眼猜快得多。

- **桌面 Chrome**：地址栏最右侧有个 **显示器带下箭头** 的图标 → 点它 → **安装**  
  （找不到就在地址栏右侧 ⋮ 菜单里找「投放、保存和共享」→「安装页面为应用」）
- 装完会弹出独立窗口，标题栏没有地址栏，任务栏/桌面出现述树图标。
- **验收点**：独立窗口能打开、能正常操作，和浏览器里表现一致。

### 装不上时，按这个顺序排查（从最常见开始）

| 顺序 | 原因 | 怎么确认 | 怎么办 |
| --- | --- | --- | --- |
| 1 | **已经装过了，只是找不到图标** | Console 里 `matchMedia('(display-mode: standalone)').matches` 返回 `true`，或 Chrome 有 `chrome://apps` 里能搜到「述树」 | 打开 `chrome://apps` 找图标；或地址栏输入 `chrome://apps` 右键「创建桌面快捷方式」 |
| 2 | **没在真正可安装的窗口里** | 无痕窗口 + DevTools 打开 = 环境干净，最容易成功 | 关掉 DevTools 悬浮窗（改成独立窗口或直接关掉），刷新后看地址栏图标 |
| 3 | **地址栏图标被折叠了** | 地址栏右侧的图标太多时，安装图标会被收进 ⋮ 菜单 | 直接在 ⋮ →「投放、保存和共享」→「安装页面为应用」 |
| 4 | **页面没被 SW 接管** | Console 里 `navigator.serviceWorker.controller` 为 `null` | 刷新一次页面（不是软刷，用 F5 或 Ctrl+R）；仍为 null 就 Application → Service Workers → Unregister 后刷新 |
| 5 | **Manifest 有错** | Application → Manifest 里 Name/Icons 有空或报错 | 用诊断脚本看输出，把结果发我 |
| 6 | **Windows 策略或系统限制** | 上述全绿但仍无安装入口 | 试 Edge（`msedge://`）或 Chrome Canary；再不行告诉我 |

> 补充：Chrome 安装 PWA 的硬性条件只有三条 —— **安全上下文**（https 或 localhost）、
> **有效的 manifest**（name / short_name / start_url / display / 至少一个 192 或 512 图标）、
> **已注册并激活的 Service Worker**。这三条我这边已经全部实测通过（见 `scripts/check_pwa.py` 的 10 项），
> 所以「装不上」绝大多数情况是**浏览器侧的状态问题**（第 1~4 条），而不是产物问题。

> 安装这一步的意义：iOS Safari 对**未添加到主屏幕**的站点，7 天不活跃后会清掉 CacheStorage / IndexedDB。  
> 只有安装成 PWA，离线内容才会长期保留。桌面 Chrome 装上后同理更稳。

---

## 5. 预热缓存（关键，别跳过）

词库 410MB 是**按需缓存**的，不是预加载。所以断网能不能看，取决于你之前点过哪些页面。

在**联网状态**下依次点一遍（每个都等到内容真的显示出来再走）：

1. 首页（Home）
2. **词库**页 —— 进一个词本（比如 CET6），翻两页
3. **发现**页 —— 进一个主题
4. 随便点开 2~3 个词的详情页（英文释义分片会在这里入缓存）

- **验收点**：每一步都有内容出现，没有 loading 卡死。

---

## 6. 看缓存里到底存了什么

DevTools → **Application** → 左侧 **Cache Storage**

- **验收点**：能看到两个桶
  - `shushu-index` —— 小索引（index / manifest / catalog / themes·bank 的 index.json），最多 12 条
  - `shushu-data` —— 数据分片（books / themes / bank / defs），最多 60 条
- 点开 `shushu-data` 能看到刚才访问过的分片 URL 和体积（CET6 那个约 2.8MB）。
- **不要**看到 precache 里混进 410MB 数据 —— 那说明构建配置被改坏了。

顺手看一眼 **Storage** → 底部显示的已用配额，确认没爆。

---

## 7. 断网测试（真正的验收）

保持 DevTools 打开 → **Network** 标签 → 节流下拉框选 **Offline**  
（或直接拔网线 / 开飞行模式，更真实）

然后**刷新页面**（`Ctrl + R`），依次验证：

| #     | 操作                    | 预期                                          |
| ----- | --------------------- | ------------------------------------------- |
| 7.1   | 刷新首页                  | 外壳正常加载（不是白屏、不是 Chrome 小恐龙）                  |
| 7.2   | 进刚才点过的词本              | 词条正常显示                                      |
| 7.3   | 翻到第 5 步**没点过**的一页     | 出现「当前离线。这部分内容还没缓存过…」提示条                     |
| 7.4   | 词库页某个词                | 若英文释义分片没缓存过，标签显示「（离线，英文释义未缓存）」              |
| 7.5   | 发现页未访问过的主题            | 空状态标题变成「离线 · 主题索引未缓存」                       |
| 7.6   | **复习页 / 生词本**（重点补充）    | 见下方专项说明                                     |

- **验收点**：7.1、7.2 通过 —— 说明离线外壳 + 已缓存分片 OK。
- **验收点**：7.3~7.5 必须给出**明确提示**，不能是「空白无解释」—— 这是 6.7 加的文案，正是为了避免用户以为数据丢了。
- 7.1 直接白屏 → 大概率 navigateFallback 没生效或 SW 没接管，停下来告诉我。

### 7.6 复习页专项（对应你反馈的「断网后生词本不能复习」）

先把「空」和「坏」分开。断网后复习页显示「现在没有到点的词」有**两种完全不同**的含义：

| 现象 | 含义 | 是不是 bug |
| --- | --- | --- |
| 复习页显示「生词本 0」 | IndexedDB 里真没数据 | 要查数据为什么没写进去 |
| 复习页显示「生词本 12，待复习队列 0 个」 | 数据在，只是**都没到复习时间** | **不是 bug，是机制** |

关键机制：生词加入后**首次复习排程在 10 分钟后**，不是立刻可复习。
所以你「学习完马上断网去看」，本来就应该是 0 条 —— 这是设计，不是坏了。

**怎么区分**（不看界面，直接问数据）：Console 跑 `scripts/browser_diagnose.js`，
它会打印 `vocab 表条数` 和 `到复习点的条数`，并告诉你缺失的是哪一环。

如果确认是「数据在但没到点」，想立刻就验证复习流程能否跑通，
把诊断脚本输出里提示的那行「提前复习时间」的代码单独粘进 Console 执行，
就会把已有生词的 `next_review` 全部拨到当前时间，然后回复习页 —— 应该立刻能看到队列和闯关入口。

---

## 8. 恢复联网

Network → 改回 **No throttling**（或关飞行模式）→ 刷新

- **验收点**：7.3~7.5 那些页面重新有内容，离线提示条消失。

---

## 9. 顺手跑一下 Lighthouse（可选，30 秒）

DevTools → **Lighthouse** → 只勾 **Progressive Web App** → Analyze page load

- **验收点**：Installable / PWA optimized 两项为绿色。  
  若报 "Does not register a service worker" → 回到第 2 步确认是不是开的同一个端口。

---

## 常见问题速查

| 现象                                | 最可能的原因                     | 怎么办                                                 |
| --------------------------------- | -------------------------- | --------------------------------------------------- |
| Service Workers 面板空               | 打开的是 5173，或没 build         | 回第 0 步，用 preview 的端口                                |
| sw.js 一直 `installing`              | 旧 SW 占坑                    | Application → Service Workers → **Unregister**，再刷新 |
| 地址栏没有安装图标                         | 已装过 / 图标被折叠 / 没被 SW 接管      | 见第 4 步排查表；先跑 `scripts/browser_diagnose.js`          |
| **换过端口后缓存/生词全没了**                 | localhost:4173 与 :4174 是两个不同站点 | 固定一个端口，别换                                            |
| 离线刷新白屏                            | SW 未接管导航                   | 确认 `navigateFallback: 'index.html'` 还在；先联网刷新一次再断网   |
| 复习页「待复习队列 0 个」但生词本有数字             | 生词首次复习在 10 分钟后，没到点         | 不是 bug；见 7.6，用诊断脚本确认                               |
| 复习页「生词本 0」                        | 数据从没写进去                    | 学习流要走完**整轮**才会批量入库；跑诊断脚本看 `vocab 表条数`              |
| Cache Storage 里没有 shushu-data      | 第 5 步没真点进分片               | 联网状态下重新点一遍，看到内容出来再看                                |
| 缓存里出现几十 MB 的 precache            | 配置被改坏                      | 告诉我，我查 `globIgnores`                               |

---

## 验证通过后

用 Console 跑 `scripts/browser_diagnose.js`，把打印出来的整段复制发我 —— 那里面包含了上面所有需要确认的信息。  
如果想更直观，再补两张截图：Service Workers 状态、Cache Storage 两个桶的条目数。

之后我再按「每步等你确认」推进剩余不依赖云的收尾项（6.3 R2 CORS 脚本 / 6.6 Cloudflare Pages 备选 / 6.8 文档同步）。

> 真机（手机）验证暂不建议现在做：Chrome/Safari 要求 PWA 走 HTTPS，localhost 不行（手机访问电脑的局域网 IP 也拿不到安全上下文），  
> 需要 ngrok 之类的内网穿透或等云端部署后再测。等 P3 有云账号时一起做。
