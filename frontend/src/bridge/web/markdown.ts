// 话题导出 Markdown 的纯渲染层，逐条对齐 internal/api/topic_export.go：
// 只渲染活动分支（兄弟变体不进导出），正文保留原 Markdown，结构化片段做包装。
import type { StoredAssistant, StoredMessage, StoredTopic } from './db'

const EXPORT_NAME_MAX_RUNES = 60
const EXPORT_NAME_FALLBACK = '对话'
const DEFAULT_TOPIC_TITLE = '新话题'
const DEFAULT_ASSISTANT_NAME = '默认助手'
const MAX_PARTS_BYTES = 256 * 1024

const encoder = new TextEncoder()

/** parts_json 片段的只读投影；未知类型忽略。 */
interface ExportPart {
  type?: string
  text?: string
  title?: string
  url?: string
  source?: string
  mimeType?: string
  code?: string
  message?: string
}

/** 渲染活动分支为 Markdown 文本并生成建议文件名。 */
export function exportMarkdown(
  topic: StoredTopic,
  path: StoredMessage[],
  assistant: StoredAssistant | null,
  now: Date = new Date(),
): { fileName: string; markdown: string } {
  const title = topic.Title.trim() || DEFAULT_TOPIC_TITLE
  let body = `# ${title}\n\n`
  body += `${exportAssistantLine(assistant)}\n`
  body += `- 导出时间：${formatTime(now)}\n`
  body += `- 消息数：${path.length}（当前分支）\n`
  for (const message of path) {
    body += '\n---\n\n'
    body += `### ${exportRoleLabel(message.Role)}\n\n`
    const segments: string[] = []
    const parts = renderExportMessageParts(message.PartsJSON)
    if (parts) segments.push(parts)
    const note = exportStatusNote(message.Status)
    if (note) segments.push(note)
    body += `${segments.join('\n\n')}\n`
  }
  return { fileName: exportFileName(topic.Title, now), markdown: `${body.replace(/\n+$/, '')}\n` }
}

/** 助手信息行；助手缺失时退回默认写法（对齐 exportAssistantLine）。 */
function exportAssistantLine(assistant: StoredAssistant | null): string {
  const name = assistant?.Name.trim() ?? ''
  const emoji = assistant?.Emoji.trim() ?? ''
  if (!assistant || !assistant.ID || !name) return `- 助手：${DEFAULT_ASSISTANT_NAME}`
  return emoji ? `- 助手：${emoji} ${name}` : `- 助手：${name}`
}

/** 按顺序拼装消息片段；脏数据按空内容处理，不打断整篇导出。 */
function renderExportMessageParts(partsJSON: string): string {
  const raw = partsJSON.trim()
  if (!raw || encoder.encode(raw).length > MAX_PARTS_BYTES) return ''
  let parts: ExportPart[]
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return ''
    parts = parsed as ExportPart[]
  } catch {
    return ''
  }
  const blocks: string[] = []
  let searchIndex = -1
  for (const part of parts) {
    switch (part?.type) {
      case 'text': {
        const text = normalizeExportText(part.text ?? '')
        if (text) blocks.push(text)
        break
      }
      case 'reasoning': {
        const text = normalizeExportText(part.text ?? '')
        if (text) blocks.push(`<details>\n<summary>思考过程</summary>\n\n${text}\n\n</details>`)
        break
      }
      case 'search-result': {
        // 同一条消息里的多个引用合并成一个列表。
        const line = `- [${part.title ?? ''}](${part.url ?? ''})`
        if (searchIndex < 0) {
          searchIndex = blocks.length
          blocks.push(line)
        } else {
          blocks[searchIndex] += `\n${line}`
        }
        break
      }
      case 'image':
        blocks.push(renderExportImagePart(part))
        break
      case 'error':
        blocks.push(`> ⚠️ 生成失败：${part.message ?? ''}（${part.code ?? ''}）`)
        break
    }
  }
  return blocks.join('\n\n').trim()
}

/** 远程 https 图片可直接内联；生成图只留提示行（不写 base64/非 https 协议）。 */
function renderExportImagePart(part: ExportPart): string {
  const url = (part.url ?? '').trim()
  if (part.source === 'remote' && url.startsWith('https://')) return `![图片](${url})`
  return `> [图片输出：${part.mimeType ?? ''}]（Markdown 导出不包含图片数据）`
}

/** 未完成的回复补一行说明。 */
function exportStatusNote(status: string): string {
  switch (status) {
    case 'cancelled':
      return '> 该回复已停止生成'
    case 'interrupted':
      return '> 该回复因应用重启被中断'
    case 'streaming':
    case 'pending':
      return '> 该回复未完成'
    default:
      return ''
  }
}

function exportRoleLabel(role: string): string {
  switch (role) {
    case 'assistant':
      return '助手'
    case 'user':
      return '用户'
    default:
      return '消息'
  }
}

/** 统一换行并去首尾空白，保留正文自身的 Markdown 结构。 */
function normalizeExportText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

/** 建议文件名：清洗后的标题 + 时间戳 + .md，不含任何路径成分。 */
export function exportFileName(title: string, now: Date): string {
  const name = sanitizeExportName(title) || EXPORT_NAME_FALLBACK
  return `${name}-${formatStamp(now)}.md`
}

/**
 * 把用户可控文本压成安全的文件名片段：剥离路径分隔符、控制字符与 `..`，
 * 折叠空白，去掉首尾点/空格并截断长度（对齐 sanitizeExportName）。
 */
export function sanitizeExportName(raw: string): string {
  let built = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    // 空白类控制字符交给后续折叠，其余控制字符直接丢弃。
    if (code === 0x7f || (code < 0x20 && !/\s/.test(ch))) continue
    if ('\\/:*?"<>|'.includes(ch)) continue
    built += ch
  }
  let cleaned = built
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ')
  // 先去掉所有 `..`，再裁首尾点号/空格：不会拼出 `.`、`..` 或点结尾的非法名。
  cleaned = cleaned.replace(/\.\./g, '')
  cleaned = cleaned.replace(/^[. ]+|[. ]+$/g, '')
  if (Array.from(cleaned).length > EXPORT_NAME_MAX_RUNES) {
    cleaned = Array.from(cleaned)
      .slice(0, EXPORT_NAME_MAX_RUNES)
      .join('')
  }
  return cleaned.replace(/^[. ]+|[. ]+$/g, '')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Go 布局 2006-01-02 15:04（本地时间）。 */
function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Go 布局 20060102-150405（本地时间）。 */
function formatStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}
