import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initStorage } from './domain/learning'
import { reconcileTranscriptReadings } from './domain/transcript/store'
import { drainPendingEvents } from './domain/spellingErrorEvents'
import './index.css'

/**
 * 先打开本地存储再渲染：
 * IndexedDB 首次打开会执行版本升级（v1→v10），让它发生在首屏之前，
 * 避免页面刚挂载时读到空数据闪一下「生词本为空」。
 * 失败不阻断启动（initStorage 内部已兜底打印告警）。
 *
 * 存储就绪后跑一次「历史转写 → 阅读器资料」幂等补齐（reconcile），
 * **渲染等它完成**：修复前完成的转写若还没进阅读器，启动即自动补登记
 * （幂等键 t_<jobId>，已存在则跳过，绝不覆盖进度/书架）；等它完成
 * 再渲染，首屏的「我的素材」列表就不会漏掉刚补齐的资料。
 * 补齐本身失败仅告警（内部已兜底），不阻断启动。
 */
initStorage()
  .then(async () => {
    // U16 恢复链：启动期把「T-A 事件已落盘、T-B 凭证未落盘」的中断补结算。
    // 只结算本标签能取到锁的会话；被其它活跃标签持锁的保持 pending，不抢不丢。
    try {
      const drained = await drainPendingEvents()
      if (drained.scanned > 0) {
        console.info('[spelling] 启动错词事件恢复', {
          scanned: drained.scanned,
          settled: drained.settled,
          settledSkipped: drained.settledSkipped,
          sessionsSkipped: drained.sessionsSkipped,
          failures: drained.failures.length,
          retries: drained.retries,
          pendingRemaining: drained.pendingRemaining,
          converged: drained.converged,
        })
      }
      if (!drained.converged) {
        // 未收敛只告警，不阻断启动：页面级 U16 闸门会保持输入禁用直到收敛
        console.warn('[spelling] 启动 drain 未收敛，待结算事件保留，输入保持禁用', {
          failures: drained.failures.length,
          pendingRemaining: drained.pendingRemaining,
        })
      }
    } catch (err) {
      // 恢复失败不阻断启动：事件行仍在，下次启动重试（不假报恢复成功）
      console.warn('[spelling] 启动错词事件恢复未完成，事件保留待下次重试', err)
    }
  })
  .then(() => reconcileTranscriptReadings())
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </React.StrictMode>,
    )
  })
