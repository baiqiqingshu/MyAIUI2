import { useEffect, useState } from 'react'
import { Eye, EyeOff, Globe } from 'lucide-react'
import { Button, Field, IconButton, Input } from '../../components/ui'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import type { ProxySettingsDTO } from '../../domain/dto'
import { describeError } from './errors'

function validateProxy(value: string): string {
  if (!value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol === 'http:' && url.hostname &&
      (!url.pathname || url.pathname === '/') && !url.search && !url.hash) return ''
  } catch {
    // Keep credentials and the invalid URL out of error messages.
  }
  return '请输入有效的 HTTP 代理地址，例如 http://127.0.0.1:7890；留空可禁用代理。'
}

export function ProxyCard() {
  const showToast = useUiStore((s) => s.showToast)
  const [settings, setSettings] = useState<ProxySettingsDTO | null>(null)
  const [url, setURL] = useState('')
  const [urlVisible, setURLVisible] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setURLVisible(false)
    setLoadError('')
    appApi.GetProxySettings()
      .then((result) => {
        if (!alive) return
        setSettings(result)
        setURL(result.URL)
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(describeError(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [reload])

  async function save() {
    if (loading || saving || loadError) return
    setURLVisible(false)
    const validation = validateProxy(url)
    setError(validation)
    if (validation) return
    setSaving(true)
    try {
      const result = await appApi.SaveProxySettings({ URL: url.trim() })
      setSettings(result)
      setURL(result.URL)
      showToast(result.URL ? '代理已保存，新请求立即生效' : '代理已禁用', 'success')
    } catch (err) {
      setError(`保存失败：${describeError(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="provider-card proxy-card" aria-busy={loading || saving}>
      <header className="provider-card__head">
        <div className="relay-card__icon" aria-hidden="true"><Globe size={18} /></div>
        <div className="provider-card__title">
          <div className="provider-card__name">网络代理 <span className="provider-tag">可选</span></div>
          <div className="proxy-card__hint">统一代理 AIUI 的 HTTP / HTTPS 请求，内置中转开启或关闭时均生效。</div>
        </div>
      </header>
      <form className="proxy-card__form" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <div onBlur={() => setError(validateProxy(url))}>
          <Field label="代理地址" hint="支持 http://[用户名:密码@]主机:端口；留空并保存即可禁用。地址默认隐藏，可点击眼睛图标查看。">
            <div className="ui-field__row">
              <Input
                type={urlVisible ? 'text' : 'password'}
                value={url}
                onChange={(value) => { setURL(value); setError('') }}
                placeholder="http://127.0.0.1:7890"
                disabled={loading || saving || !!loadError}
              />
              <IconButton
                title={urlVisible ? '隐藏代理地址' : '显示代理地址（含账号密码）'}
                onClick={() => setURLVisible((value) => !value)}
                disabled={loading || saving || !!loadError}
              >
                {urlVisible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </IconButton>
            </div>
          </Field>
        </div>
        <p className="proxy-card__hint">覆盖模型验证、模型列表、对话、图片与联网搜索。支持自签名证书，证书校验已关闭（verify_ssl=false）。</p>
        {loadError ? <div className="relay-card__error" role="alert">配置获取失败：{loadError}</div> : null}
        {error ? <div className="relay-card__error" role="alert">{error}</div> : null}
        <div className="proxy-card__actions">
          <span className="proxy-card__hint" role="status">
            {loading ? '正在读取代理配置…' : saving ? '正在保存…' : settings ? (settings.URL ? '当前已启用代理' : '当前未配置代理') : ''}
          </span>
          {loadError ? (
            <Button size="sm" onClick={() => setReload((value) => value + 1)}>重新加载</Button>
          ) : (
            <Button type="submit" size="sm" variant="primary" loading={saving} disabled={loading || url.trim() === settings?.URL}>
              保存代理
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
