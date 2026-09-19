import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { bootstrap } from './app/bootstrap'
import './styles/tokens.css'
import './styles/global.css'
import './styles/scrollbar.css'
import './styles/markdown.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('缺少 #root 挂载点')

void bootstrap()

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
