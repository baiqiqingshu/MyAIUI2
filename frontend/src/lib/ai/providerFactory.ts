import { createOpenAI } from '@ai-sdk/openai'
import type { OpenAIProvider } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createWailsFetch } from '../../bridge/wailsFetch'
import { createWebFetch } from '../../bridge/web'
import { withWebSearchFetch } from './webSearchFetch'
import type { ModelDTO, ProviderDTO } from '../../domain/dto'

// 两种 SDK provider 的模型工厂签名不同，对外暴露联合类型，取模型时按 Kind 收窄。
export type Provider = OpenAICompatibleProvider | OpenAIProvider

// 模型请求的底层 fetch 按运行时二选一：桌面端走 Go 受限 Transport（createWailsFetch），
// 浏览器端走 bridge/web 的直连 fetch（createWebFetch，密钥从 localStorage 注入）。
// 两种模式下 apiKey 都只是占位：真实密钥由底层 fetch 注入 Authorization。
// webSearch 为真时再叠一层“注入联网参数”的 fetch（见 webSearchFetch.ts）。
export function createProvider(provider: ProviderDTO, webSearch = false): Provider {
  const baseFetch = window.go?.api?.AppAPI ? createWailsFetch(provider.ID) : createWebFetch(provider)
  const transport = webSearch ? withWebSearchFetch(baseFetch, provider.Kind) : baseFetch
  // 'openai' 与 'openai-responses' 共用官方 SDK，只是取模型的方法不同。
  if (provider.Kind === 'openai' || provider.Kind === 'openai-responses') {
    return createOpenAI({
      name: provider.Kind,
      baseURL: provider.BaseURL,
      apiKey: '__managed_by_go__',
      fetch: transport,
    })
  }
  return createOpenAICompatible({
    name: provider.Kind || 'openai-compatible',
    baseURL: provider.BaseURL,
    apiKey: '__managed_by_go__',
    fetch: transport,
  })
}

export function languageModelFor(
  provider: ProviderDTO,
  model: ModelDTO,
  webSearch = false,
): LanguageModel {
  const sdk = createProvider(provider, webSearch)
  if (provider.Kind === 'openai-responses') return (sdk as OpenAIProvider).responses(model.RemoteID)
  if (provider.Kind === 'openai') return (sdk as OpenAIProvider).chat(model.RemoteID)
  return (sdk as OpenAICompatibleProvider).languageModel(model.RemoteID)
}
