import { createOpenAI } from '@ai-sdk/openai'
import type { OpenAIProvider } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createWailsFetch } from '../../bridge/wailsFetch'
import type { ModelDTO, ProviderDTO } from '../../domain/dto'

// 两种 SDK provider 的模型工厂签名不同，对外暴露联合类型，取模型时按 Kind 收窄。
export type Provider = OpenAICompatibleProvider | OpenAIProvider

// 所有模型请求都改写成 Go 受限 Transport（createWailsFetch）：前端不直连外网，
// 也不持有真实密钥，这里的 apiKey 只是占位，Go 侧会按 provider 注入 Authorization。
export function createProvider(provider: ProviderDTO): Provider {
  // 'openai' 与 'openai-responses' 共用官方 SDK，只是取模型的方法不同。
  if (provider.Kind === 'openai' || provider.Kind === 'openai-responses') {
    return createOpenAI({
      name: provider.Kind,
      baseURL: provider.BaseURL,
      apiKey: '__managed_by_go__',
      fetch: createWailsFetch(provider.ID),
    })
  }
  return createOpenAICompatible({
    name: provider.Kind || 'openai-compatible',
    baseURL: provider.BaseURL,
    apiKey: '__managed_by_go__',
    fetch: createWailsFetch(provider.ID),
  })
}

export function languageModelFor(provider: ProviderDTO, model: ModelDTO): LanguageModel {
  const sdk = createProvider(provider)
  if (provider.Kind === 'openai-responses') return (sdk as OpenAIProvider).responses(model.RemoteID)
  if (provider.Kind === 'openai') return (sdk as OpenAIProvider).chat(model.RemoteID)
  return (sdk as OpenAICompatibleProvider).languageModel(model.RemoteID)
}
