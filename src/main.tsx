import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// 显式判空而不是非空断言，让挂载点缺失在启动时立刻暴露
const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('index.html 中缺少 #root 挂载点')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
