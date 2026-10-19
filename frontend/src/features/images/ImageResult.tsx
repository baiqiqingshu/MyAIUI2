import './images.css'
import { useEffect, useState } from 'react'
import { appApi } from '../../bridge/appApi'
import { Button } from '../../components/ui'
import { imageDataUrl, isRemoteImageUrl } from '../../domain/message'
import type { ImageMessagePart } from '../../domain/message'

// 远程图片通过后端加载，避免 WebView 绕过应用的代理设置。
export function ImageResult({ part, messageId, streaming }: {
  part: ImageMessagePart
  messageId: string
  streaming: boolean
}) {
  const dataUrl = imageDataUrl(part)
  const remoteURL = isRemoteImageUrl(part.url) ? part.url : ''
  const [remote, setRemote] = useState({ url: '', source: '', error: '' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (dataUrl || !remoteURL || streaming) return
    let active = true
    setRemote({ url: remoteURL, source: '', error: '' })
    void appApi.LoadRemoteImage(messageId, remoteURL).then(
      (source) => { if (active) setRemote({ url: remoteURL, source, error: '' }) },
      (error: unknown) => {
        if (active) setRemote({ url: remoteURL, source: '', error: String(error) })
      },
    )
    return () => { active = false }
  }, [attempt, dataUrl, messageId, remoteURL, streaming])

  const source = dataUrl ?? (remote.url === remoteURL ? remote.source : '')

  if (!source) {
    const error = remote.url === remoteURL ? remote.error : ''
    return (
      <div className="image-result image-result--empty" role="status" title={error || undefined}>
        {error ? '图片加载失败' : remoteURL ? '图片加载中…' : '图片不可用'}
        {error && <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>重试</Button>}
      </div>
    )
  }

  return (
    <figure className="image-result">
      <img
        className="image-result__img"
        src={source}
        alt="图片结果"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </figure>
  )
}
