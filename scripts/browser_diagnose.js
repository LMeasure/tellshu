/**
 * 浏览器控制台一键诊断（本地验收用）
 * ==================================================================
 * 用法：在 Chrome 里打开述树的页面 → F12 → Console → 整段粘贴 → 回车。
 * 它会自己检查并打印结论，不需要你理解任何技术细节。
 *
 * 覆盖这次反馈的三个问题：
 *   1) 为什么装不上（安装条件 checklist）
 *   2) Service Worker 是否正常接管
 *   3) 断网后生词本 / 复习队列到底有没有数据
 */
;(async () => {
  const L = []
  const log = (s) => L.push(s)
  const hr = (t) => log(`\n${'─'.repeat(52)}\n${t}\n${'─'.repeat(52)}`)

  log(`页面地址 : ${location.href}`)
  log(`协议     : ${location.protocol}`)

  // ============ 问题 1：为什么装不上 ============
  hr('【问题 1】安装条件检查')
  const localhostOk = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  log(`${location.protocol === 'https:' || localhostOk ? '✅' : '❌'} 安全上下文（https 或 localhost）`)
  if (!(location.protocol === 'https:' || localhostOk)) {
    log('   → 当前地址不是 localhost / https，浏览器不会注册 SW，也无法安装。')
  }

  const linkEl = document.querySelector('link[rel="manifest"]')
  log(`${linkEl ? '✅' : '❌'} index.html 里有 manifest 链接${linkEl ? ` → ${linkEl.getAttribute('href')}` : ''}`)

  let mf = null
  try {
    const r = await fetch('/manifest.webmanifest', { cache: 'no-store' })
    log(`${r.ok ? '✅' : '❌'} /manifest.webmanifest HTTP ${r.status} ${r.headers.get('content-type') || ''}`)
    mf = await r.json()
  } catch (e) {
    log(`❌ manifest 拉取失败：${e && e.message}`)
  }

  if (mf) {
    log(`    name=${mf.name}  short_name=${mf.short_name}  display=${mf.display}  start_url=${mf.start_url}`)
    log(`    图标 ${Array.isArray(mf.icons) ? mf.icons.length : 0} 个`)
    const need = ['name', 'short_name', 'start_url', 'display', 'icons']
    const miss = need.filter((k) => !mf[k] || (k === 'icons' && !mf.icons.length))
    log(`${miss.length === 0 ? '✅' : '❌'} manifest 必填字段完整${miss.length ? `（缺：${miss.join(', ')}）` : ''}`)
    if (Array.isArray(mf.icons)) {
      for (const ic of mf.icons) {
        if (!ic.sizes || !/192|512/.test(ic.sizes)) log(`   ⚠ 图标尺寸不含 192/512：${ic.sizes}`)
        if (!ic.type) log(`   ⚠ 图标缺 type：${ic.src}`)
      }
    }
    log('\n当前已安装状态（true = 已经是 app 窗口，此时地址栏不会再显示安装图标）：')
    log(`   matchMedia('(display-mode: standalone)')        = ${matchMedia('(display-mode: standalone)').matches}`)
    log(`   matchMedia('(display-mode: minimal-ui)')         = ${matchMedia('(display-mode: minimal-ui)').matches}`)
    log(`   matchMedia('(display-mode: window-controls-overlay)') = ${matchMedia('(display-mode: window-controls-overlay)').matches}`)
  }

  // ============ 问题 2：Service Worker ============
  hr('【问题 2】Service Worker 状态')
  if (!('serviceWorker' in navigator)) {
    log('❌ 浏览器不支持 serviceWorker')
  } else {
    const regs = await navigator.serviceWorker.getRegistrations()
    log(`注册数量 : ${regs.length}`)
    regs.forEach((r) => {
      log(`   scope=${r.scope}`)
      log(`   active=${r.active ? r.active.state : 'null'}  waiting=${r.waiting ? r.waiting.state : 'null'}  installing=${r.installing ? r.installing.state : 'null'}`)
    })
    log(`controller : ${navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : 'null（说明本页不是由 SW 接管的，刷新一次再看）'}`)
    if (regs.length === 0) {
      log('   → 没有注册任何 SW。若地址是 5173，那是 dev 模式，故意不开 SW，属预期。')
    }
  }

  // ============ 问题 3：生词本 / 复习队列 ============
  hr('【问题 3】生词本与复习队列（本机 IndexedDB）')

  const openDb = (name) =>
    new Promise((res, rej) => {
      const rq = indexedDB.open(name)
      rq.onsuccess = () => res(rq.result)
      rq.onerror = () => rej(rq.error)
      rq.onblocked = () => log(`   ⚠ 打开 ${name} 被阻塞`)
    })

  const dbNames = (await indexedDB.databases()).map((d) => `${d.name}@v${d.version}`)
  log(`IndexedDB 数据库：${dbNames.length ? dbNames.join('、') : '（一个都没有 —— 说明本站从没成功写过数据）'}`)

  if (!dbNames.some((n) => n.startsWith('shushu-learn'))) {
    log('\n❌ 没有 shushu-learn 数据库。')
    log('   → 生词是在「学习流走完一轮」或单词卡点「加入生词本」时写入的。')
    log('     如果你只是浏览了词库、没走学习流，那就是 0 条，属预期。')
  } else {
    const db = await openDb('shushu-learn')
    log(`\nshushu-learn 版本 : ${db.version}`)
    log(`表               : ${Array.from(db.objectStoreNames).join(', ') || '（无表）'}`)

    const readAll = (storeName) =>
      new Promise((res, rej) => {
        if (!db.objectStoreNames.contains(storeName)) return res(null)
        const tx = db.transaction(storeName, 'readonly')
        const rq = tx.objectStore(storeName).getAll()
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => rej(rq.error)
      })

    const vocab = (await readAll('vocab')) || []
    const logs = (await readAll('reviewLog')) || []

    log(`\nvocab 表条数    : ${vocab.length}`)
    log(`reviewLog 条数  : ${logs.length}`)

    if (vocab.length === 0) {
      log('\n❌ 生词本里 0 条 —— 这就是「不能复习」的直接原因。')
      log('   → 请确认：学习流是否真的走完了「一轮结束」？')
      log('     生词是在一轮全部卡片走完后批量入库的（不是每张卡即时入库）。')
      log('     或者用单词卡上的「加入生词本」按钮单独加一个，再看这里是否变成 1。')
    } else {
      const now = Date.now()
      const byLayer = vocab.reduce((acc, v) => ((acc[v.layer] = (acc[v.layer] || 0) + 1), acc), {})
      log(`\n按层分布 : ${Object.entries(byLayer).map(([k, v]) => `${k}=${v}`).join('  ')}`)

      const dueList = vocab.filter((v) => v.next_review <= now && v.layer !== 'mastered')
      log(`已到复习点（next_review <= 现在，且未掌握）：${dueList.length} 条`)

      if (dueList.length === 0) {
        const fut = vocab
          .filter((v) => v.next_review > now)
          .sort((a, b) => a.next_review - b.next_review)
        log('   ⏳ 数据是有的，只是都还没到复习时间。最早的一个：')
        if (fut[0]) {
          const mins = Math.round((fut[0].next_review - now) / 60000)
          log(`      「${fut[0].word}」还需 ${mins < 1 ? '不到 1' : mins} 分钟（首复习排程是加入后 10 分钟）`)
        }
        log('   → 这就是「刚学完不能复习」的机制原因，不是坏了。')
        log('     想立刻验证复习流程，在 Console 里跑下面这行，把首复习时间提前：')
        log('     （复制下一行单独执行）')
        log("     (()=>{const r=indexedDB.open('shushu-learn');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('vocab','readwrite');const s=tx.objectStore('vocab');const g=s.getAll();g.onsuccess=()=>{g.result.forEach(v=>{v.next_review=Date.now()-1000;s.put(v)});console.log('已把',g.result.length,'个词的复习时间提前，回复习页看看')}}})()")
      } else {
        log(`   ✅ 有 ${dueList.length} 条可复习，示例：${dueList.slice(0, 5).map((v) => v.word).join('、')}`)
        const noBook = dueList.filter((v) => !v.book)
        if (noBook.length) {
          log(`   ⚠ 其中 ${noBook.length} 条缺 book 字段，闯关组题会取不到释义而丢弃：${noBook.slice(0, 5).map((v) => v.word).join('、')}`)
        }
      }
    }
    db.close()
  }

  hr('把以上全部内容复制发回即可')
  console.log(L.join('\n'))
  log.length = 0
})()
