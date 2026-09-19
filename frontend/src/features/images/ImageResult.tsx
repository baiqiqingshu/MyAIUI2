import './images.css'
import { imageDataUrl, isRemoteImageUrl } from '../../domain/message'
import type { ImageMessagePart } from '../../domain/message'

// 只读展示图片结果：数据 URL 或 https 远程地址。
export function ImageResult({ part }: { part: ImageMessagePart }) {
  const dataUrl = imageDataUrl(part)
  const source = dataUrl ?? (isRemoteImageUrl(part.url) ? part.url : '')

  if (!source) {
    return <div className="image-result image-result--empty">图片不可用</div>
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
