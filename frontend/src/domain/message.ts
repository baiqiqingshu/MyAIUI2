import { z } from 'zod'
import type { MessageDTO, TreeNodeDTO } from './dto'

// P0 只允许这五种消息片段（方案 §8.3）。file/attachment/tool/mcp/knowledge/artifact/agent
// 片段不在本项目范围内，不要在 UI 里“顺手恢复”。
// 片段来自 SQLite（外部持久化数据），因此在边界处用 zod 解析一次，之后按类型读取。
const textPart = z.object({ type: z.literal('text'), text: z.string() })
const reasoningPart = z.object({ type: z.literal('reasoning'), text: z.string() })
const searchResultPart = z.object({
  type: z.literal('search-result'),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
})
const imagePart = z.object({
  type: z.literal('image'),
  source: z.union([z.literal('generated'), z.literal('remote')]),
  mimeType: z.string(),
  data: z.string().optional(),
  url: z.string().optional(),
})
const errorPart = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
})

export const messagePartSchema = z.discriminatedUnion('type', [
  textPart,
  reasoningPart,
  searchResultPart,
  imagePart,
  errorPart,
])

export type MessagePart = z.infer<typeof messagePartSchema>
export type ImageMessagePart = Extract<MessagePart, { type: 'image' }>

export function parseParts(json: string): MessagePart[] {
  if (!json) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const parsed = z.array(messagePartSchema).safeParse(raw)
  return parsed.success ? parsed.data : []
}

export function partsToText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

export function messageText(msg: MessageDTO): string {
  return partsToText(parseParts(msg.PartsJSON))
}

export function lastUserText(messages: MessageDTO[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].Role === 'user') return messageText(messages[i])
  }
  return ''
}

export function imageDataUrl(part: ImageMessagePart): string | null {
  if (part.source === 'generated' && part.data && part.mimeType.startsWith('image/')) {
    return `data:${part.mimeType};base64,${part.data}`
  }
  return null
}

export function isRemoteImageUrl(url: string | undefined): url is string {
  return !!url && url.startsWith('https://')
}

/**
 * 收集消息子树：rootId 连同按 ParentID 向下的全部后代（用于级联删除/勾选）。
 * 消息树缺失或不含该节点时退化为只返回 rootId 本身。
 */
export function collectSubtreeIds(
  nodes: TreeNodeDTO[] | null | undefined,
  rootId: string,
): string[] {
  const children = new Map<string, string[]>()
  for (const node of nodes ?? []) {
    const list = children.get(node.ParentID)
    if (list) list.push(node.ID)
    else children.set(node.ParentID, [node.ID])
  }
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    const kids = children.get(id)
    if (kids) queue.push(...kids)
  }
  return out
}

export function newRequestId(): string {
  return crypto.randomUUID()
}
