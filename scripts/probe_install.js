/**
 * 安装可行性探针
 * ==================================================================
 * 用法：DevTools Console 粘贴 → 回车 → **然后手动刷新一次页面**（F5 / Ctrl+R）
 * 刷新后立刻再粘贴运行一次本脚本，看它输出什么。
 *
 * 为什么必须刷新：Chrome 的 beforeinstallprompt 是「页面加载过程中」触发的一次性事件，
 * 脚本运行时才挂监听，来不及捕获当前这次；挂上之后再刷新才能抓到。
 *
 * 判定规则：
 *   ● 拿到 beforeinstallprompt  → Chrome 认为可安装 → 地址栏一定有入口，或脚本直接弹安装框
 *   ● 拿不到                    → Chrome 当前不愿意提供安装（已安装过 / 被忽略过 / 省略名单）
 *
 * 注意：Chrome 在 Windows 上安装 Web App **默认不创建桌面快捷方式**，
 * 只进「开始菜单」和 chrome://apps。桌面图标要单独勾。
 */
;(function installProbe() {
  // 用 sessionStorage 跨刷新传递状态
  const KEY = '__shushu_install_probe__'
  const prev = sessionStorage.getItem(KEY)

  if (!prev) {
    sessionStorage.setItem(KEY, 'armed')
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault()
      window.__deferredInstallPrompt = e
      sessionStorage.setItem(KEY, 'PROMPT_RECEIVED')
      console.log('%c✅ 捕获到 beforeinstallprompt —— Chrome 判定本站可安装', 'color:#2fae6a;font-weight:bold')
    })
    window.addEventListener('appinstalled', () => {
      sessionStorage.setItem(KEY, 'INSTALLED')
      console.log('%c✅ appinstalled 事件触发 —— 安装成功！', 'color:#2fae6a;font-weight:bold')
    })
    console.log('%c监听已挂载。现在请【刷新页面】，然后再粘贴运行一次本脚本。', 'color:#c98200;font-weight:bold')
    return
  }

  // 第二次运行（刷新之后）：读结果
  const out = []
  out.push('────────── 安装可行性结果 ──────────')
  out.push(`当前地址        : ${location.href}`)
  out.push(`display-mode    : standalone=${matchMedia('(display-mode: standalone)').matches}`)

  switch (prev) {
    case 'PROMPT_RECEIVED':
      out.push('结论            : ✅ Chrome 已提供安装能力')
      out.push('')
      out.push('这么做即可完成安装（任选其一）：')
      out.push('   A) 看地址栏最右侧，应出现「显示器 + 下箭头」图标，点它')
      out.push('   B) 在 Console 里执行下面这行，直接弹出安装框：')
      out.push('      window.__deferredInstallPrompt && window.__deferredInstallPrompt.prompt()')
      out.push('   C) 右上角 ⋮ → 「投放、保存和共享」→「安装页面为应用」')
      break
    case 'INSTALLED':
      out.push('结论            : ✅ 已经安装过了')
      out.push('')
      out.push('桌面/任务栏没有图标的话：')
      out.push('   打开 chrome://apps ，右键「述树」→「创建快捷方式」→ 勾选【桌面】')
      out.push('   或在开始菜单里直接搜「述树」')
      break
    default:
      out.push('结论            : ⚠️ 刷新后仍未捕获 beforeinstallprompt')
      out.push('')
      out.push('按顺序排查：')
      out.push('   1) 打开 chrome://apps 搜「述树」—— 若有图标说明其实已装过')
      out.push('   2) 确认当前是 http://localhost:<端口>/ 根路径、且端口全程没换过')
      out.push('   3) 换成无痕窗口重来一次（旧配置/忽略记录会屏蔽安装提示）')
      out.push('   4) 换 Edge (edge://apps) 试 —— 与 Chrome 相互独立的安装状态')
  }

  out.push('')
  out.push('──────── 补充：先刷新��之前请清掉本次状态 ────────')
  out.push('重测请执行：sessionStorage.removeItem("__shushu_install_probe__")')

  console.log(out.join('\n'))
})()
