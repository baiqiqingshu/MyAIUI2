import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createWailsFetch } from '../../bridge/wailsFetch'
import type { ModelDTO, ProviderDTO } from '../../domain/dto'

// 所有模型请求都改写成 Go 受限 Transport（createWailsFetch）：前端不直连外网，
// 也不持有真实密钥，这里的 apiKey 只是占位，Go 侧会按 provider 注入 Authorization。
export function createProvider(provider: ProviderDTO): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: provider.Kind || 'openai-compatible',
    baseURL: provider.BaseURL,
    apiKey: '__managed_by_go__',
    fetch: createWailsFetch(provider.ID),
  })
}

export function languageModelFor(provider: ProviderDTO, model: ModelDTO): LanguageModel {
  return createProvider(provider).languageModel(model.RemoteID)
}
