import { generateImage } from 'ai'
import { createWailsFetch } from '../../bridge/wailsFetch'
import { createWebFetch } from '../../bridge/web'
import type { MessagePart } from '../../domain/message'
import type { ModelDTO, ProviderDTO } from '../../domain/dto'
import { createProvider } from './providerFactory'
import { abortError, sanitizeErrorMessage } from './capability'

export async function runImageGeneration(input: {
  provider: ProviderDTO
  model: ModelDTO
  prompt: string
  signal: AbortSignal
}): Promise<MessagePart> {
  const { provider, model, prompt, signal } = input
  if (signal.aborted) throw abortError()

  try {
    // AI SDK 6 的 openai-compatible 已提供 imageModel，优先走 SDK。
    const result = await generateImage({
      model: createProvider(provider).imageModel(model.RemoteID),
      prompt,
      n: 1,
      size: '1024x1024',
      abortSignal: signal,
    })
    return imagePartFromBase64(
      result.image.base64,
      normalizeMime(result.image.mediaType),
      result.image.uint8Array.byteLength,
    )
  } catch (err) {
    if (signal.aborted) throw abortError()
    // 本地校验（格式/体积）不通过时重试没有意义，直接抛出。
    if (err instanceof UnsupportedImageError) throw err
    // 部分兼容服务只返回 url（SDK 要求 b64_json），回退到直连 POST 再试一次。
  }

  if (signal.aborted) throw abortError()
  return await generateViaHttp(provider, model, prompt, signal)
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// 本地校验不通过（格式/体积）时使用：重试不可能成功。
class UnsupportedImageError extends Error {}

function normalizeMime(mime: string): string {
  const value = (mime ?? '').trim().toLowerCase().split(';')[0].trim()
  return value === 'image/jpg' ? 'image/jpeg' : value
}

function imagePartFromBase64(base64: string, mime: string, byteLength: number): MessagePart {
  if (!ALLOWED_MIME.has(mime)) throw new UnsupportedImageError(`不支持的图片格式：${mime || '未知'}`)
  if (byteLength > MAX_IMAGE_BYTES) throw new UnsupportedImageError('生成的图片超过 10MB 上限')
  return { type: 'image', source: 'generated', mimeType: mime, data: base64 }
}

function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return ''
}

// 只解出 base64 头部若干字节做魔数识别，避免为了校验把整张图解码一份。
function sniffMimeFromBase64(base64: string): string {
  const head = base64.slice(0, 24)
  let binary = ''
  try {
    binary = atob(head + '='.repeat((4 - (head.length % 4)) % 4))
  } catch {
    return ''
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return detectImageMime(bytes)
}

function base64ByteLength(base64: string): number {
  return Math.floor((base64.replace(/=+$/, '').length * 3) / 4)
}

function mimeFromUrl(url: string): string {
  const path = url.split('?')[0].toLowerCase()
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.webp')) return 'image/webp'
  return ''
}

// SDK 之外的兜底路径：直接 POST {BaseURL}/images/generations，兼容 b64_json 与 url 两种返回。
async function generateViaHttp(
  provider: ProviderDTO,
  model: ModelDTO,
  prompt: string,
  signal: AbortSignal,
): Promise<MessagePart> {
  const baseURL = provider.BaseURL.replace(/\/+$/, '')
  // 与 providerFactory 同一套运行时判断：桌面端走 Go 传输桥，浏览器走 /api/proxy。
  const transport = window.go?.api?.AppAPI
    ? createWailsFetch(provider.ID)
    : createWebFetch(provider)
  const response = await transport(`${baseURL}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: model.RemoteID,
      prompt,
      n: 1,
      response_format: 'b64_json',
      size: '1024x1024',
    }),
    signal,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`图片接口返回 ${response.status}${text ? `：${sanitizeErrorMessage(text)}` : ''}`)
  }

  let payload: { data?: Array<{ b64_json?: string; url?: string }> }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    throw new Error('图片接口返回的内容不是合法 JSON')
  }

  const item = payload?.data?.[0]
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    const mime = sniffMimeFromBase64(item.b64_json)
    if (!mime) throw new UnsupportedImageError('无法识别返回图片的格式（仅支持 png/jpeg/webp）')
    return imagePartFromBase64(item.b64_json, mime, base64ByteLength(item.b64_json))
  }
  if (typeof item?.url === 'string' && item.url) {
    if (!item.url.startsWith('https://')) throw new UnsupportedImageError('图片接口返回了非 https 的远程地址')
    return { type: 'image', source: 'remote', mimeType: mimeFromUrl(item.url), url: item.url }
  }
  throw new Error('图片接口未返回可用图片')
}
