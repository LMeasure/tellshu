import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initStorage } from './domain/learning'
import './index.css'

/**
 * 先打开本地存储再渲染：
 * IndexedDB 首次打开会执行版本升级（v1→v5），让它发生在首屏之前，
 * 避免页面刚挂载时读到空数据闪一下「生词本为空」。
 * 失败不阻断启动（initStorage 内部已兜底打印告警）。
 */
initStorage().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  )
})
