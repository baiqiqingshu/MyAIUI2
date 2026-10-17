import { streamText } from 'ai'
import type { ModelMessage } from 'ai'
import { messageText } from '../../domain/message'
import type { MessagePart } from '../../domain/message'
import type { AssistantDTO, MessageDTO, ModelDTO, ProviderDTO } from '../../domain/dto'
import { languageModelFor } from './providerFactory'
import { abortError, sanitizeErrorMessage } from './capability'

export interface ChatRunInput {
  provider: ProviderDTO
  model: ModelDTO
  assistant: AssistantDTO
  history: MessageDTO[] // 不含本轮
  userText: string
  /** 为真时向模型请求写入联网搜索参数（模型 API 自带联网，是否生效由服务方决定） */
  webSearch: boolean
  signal: AbortSignal
  onParts: (parts: MessagePart[]) => void
}

const TOOL_CALL_ERROR_PART: MessagePart = {
  type: 'error',
  code: 'unsupported-tool-call',
  message: '当前模型返回了工具调用，本原型不支持执行工具',
}

type TextPart = Extract<MessagePart, { type: 'text' }>
type ReasoningPart = Extract<MessagePart, { type: 'reasoning' }>

function buildSystemPrompt(systemPrompt: string): string | undefined {
  const base = systemPrompt.trim()
  return base || undefined
}

// 历史只取 role=user/assistant 的纯文本（忽略图片、搜索片段），空文本消息直接跳过。
function buildMessages(history: MessageDTO[], userText: string): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const msg of history) {
    if (msg.Role !== 'user' && msg.Role !== 'assistant') continue
    const text = messageText(msg).trim()
    if (!text) continue
    messages.push(
      msg.Role === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: text },
    )
  }
  messages.push({ role: 'user', content: userText })
  return messages
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 执行一轮对话，返回最终 parts。每收到一个增量都会回调 onParts（节流由 Chat 层负责）。
 * 取消、失败都以 Error 抛出（取消时 name='AbortError'），调用方据此写 cancelled/error 状态。
 */
export async function runChat(input: ChatRunInput): Promise<MessagePart[]> {
  const { provider, model, assistant, history, userText, webSearch, signal } = input
  if (signal.aborted) throw abortError()

  const parts: MessagePart[] = []
  let textPart: TextPart | null = null
  let reasoningPart: ReasoningPart | null = null
  let toolCallReported = false
  const snapshot = (): MessagePart[] => parts.map((p) => ({ ...p }))

  try {
    const result = streamText({
      model: languageModelFor(provider, model, webSearch),
      system: buildSystemPrompt(assistant.SystemPrompt),
      messages: buildMessages(history, userText),
      temperature: assistant.TemperatureSet ? assistant.Temperature : undefined,
      abortSignal: signal,
      // 原型不做遥测，显式关闭。
      experimental_telemetry: { isEnabled: false },
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-delta': {
          if (!reasoningPart) {
            reasoningPart = { type: 'reasoning', text: '' }
            parts.push(reasoningPart)
          }
          reasoningPart.text += part.text
          input.onParts(snapshot())
          break
        }
        case 'text-delta': {
          if (!textPart) {
            textPart = { type: 'text', text: '' }
            parts.push(textPart)
          }
          textPart.text += part.text
          input.onParts(snapshot())
          break
        }
        case 'tool-call':
        case 'tool-result':
        case 'tool-error':
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
        case 'tool-output-denied': {
          if (!toolCallReported) {
            toolCallReported = true
            parts.push(TOOL_CALL_ERROR_PART)
            input.onParts(snapshot())
          }
          break
        }
        case 'abort': {
          throw abortError()
        }
        case 'error': {
          throw new Error(sanitizeErrorMessage(part.error))
        }
        default:
          break
      }
    }
  } catch (err) {
    if (signal.aborted || isAbort(err)) throw abortError()
    throw new Error(sanitizeErrorMessage(err))
  }

  if (signal.aborted) throw abortError()
  return snapshot()
}
