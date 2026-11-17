import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Server } from 'lucide-react'
import { Toggle } from '../../components/ui'
import { useUiStore } from '../../app/uiStore'
import { getWebProxyEnabled, probeWebProxy, setWebProxyEnabled } from '../../bridge/web'
import { describeError } from './errors'

// 「部署端中转」卡片：仅浏览器模式渲染（ProvidersPage 按 window.go 判定）。
// 开关决定外联请求走同源 /api/proxy 还是浏览器直连；状态行展示端点探测结果。
export function WebProxyCard() {
  const showToast = useUiStore((s) => s.showToast)
  const [enabled, setEnabled] = useState(() => getWebProxyEnabled())
  const [probe, setProbe] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void probeWebProxy().then((ok) => {
      if (alive) setProbe(ok)
    })
    return () => {
      alive = false
    }
  }, [])

  function handleToggle(value: boolean) {
    try {
      setWebProxyEnabled(value)
      setEnabled(value)
      showToast(value ? '部署端中转已开启' : '部署端中转已关闭，改为浏览器直连', 'success')
    } catch (err) {
      showToast(`切换失败：${describeError(err)}`, 'error')
    }
  }

  return (
    <section className="provider-card relay-card">
      <header className="provider-card__head">
        <div className="relay-card__icon" aria-hidden="true">
          <Server size={18} />
        </div>
        <div className="provider-card__title">
          <div className="provider-card__name">部署端中转</div>
          <div className="provider-card__url">
            外联请求经同源 /api/proxy 中转，绕过浏览器跨域限制；关闭则直连 provider
          </div>
        </div>
        <Toggle checked={enabled} onChange={handleToggle} label="启用" />
      </header>
      <div className="provider-card__meta relay-card__meta">
        {probe === null ? <span>正在探测中转端点…</span> : null}
        {probe !== null ? (
          <span className={clsx('relay-status', probe ? 'is-running' : 'is-off')}>
            <span className="relay-status__dot" aria-hidden />
            {probe ? '中转端点可用' : '中转端点不可用，请求将浏览器直连'}
          </span>
        ) : null}
        {probe === false ? <span>仅部署到含代理函数的站点（如 Vercel）时可用</span> : null}
      </div>
    </section>
  )
}
