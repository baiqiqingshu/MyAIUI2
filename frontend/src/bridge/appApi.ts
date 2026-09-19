import type {
  AppSettingsDTO,
  AssistantDTO,
  BootstrapDTO,
  ConnectionResultDTO,
  CreateTopicDTO,
  FinishTurnDTO,
  MessageDTO,
  ModelDTO,
  ModelSyncResultDTO,
  ProviderDTO,
  ProviderRequestDTO,
  RequestHandleDTO,
  SaveAppSettingsDTO,
  SaveAssistantDTO,
  SaveMessageSnapshotDTO,
  SaveModelDTO,
  SaveProviderDTO,
  SaveSearchSettingsDTO,
  SearchRequestDTO,
  SearchResponseDTO,
  SearchSettingsDTO,
  StartAssistantMessageDTO,
  StartTurnDTO,
  TopicDTO,
  TurnDTO,
} from '../domain/dto'

// 前端唯一允许触达后端的位置：全部通过 Wails 进程内绑定。
// 这里手写薄包装（等价于 wails 生成的 bindings），好处是生成产物出现之前前端即可独立类型检查。
// 不要在本文件之外直接访问 window.go / window.runtime 的绑定方法。

function bindingFor(method: string) {
  const api = window.go?.api?.AppAPI
  const fn = api?.[method]
  if (typeof fn !== 'function') {
    throw new Error(`Wails 绑定不可用：${method}。请通过 wails dev 或已构建的桌面应用运行。`)
  }
  return fn.bind(api)
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const raw = await bindingFor(method)(...args)
  return raw as T
}

export const appApi = {
  Bootstrap: () => call<BootstrapDTO>('Bootstrap'),

  ListProviders: () => call<ProviderDTO[]>('ListProviders'),
  SaveProvider: (input: SaveProviderDTO) => call<ProviderDTO>('SaveProvider', input),
  DeleteProvider: (id: string) => call<void>('DeleteProvider', id),
  TestProvider: (id: string) => call<ConnectionResultDTO>('TestProvider', id),
  SyncProviderModels: (id: string) => call<ModelSyncResultDTO>('SyncProviderModels', id),

  ListModels: (providerId: string) => call<ModelDTO[]>('ListModels', providerId),
  SaveManualModel: (input: SaveModelDTO) => call<ModelDTO>('SaveManualModel', input),
  SetModelEnabled: (id: string, enabled: boolean) => call<void>('SetModelEnabled', id, enabled),
  DeleteModel: (id: string) => call<void>('DeleteModel', id),

  ListAssistants: () => call<AssistantDTO[]>('ListAssistants'),
  SaveAssistant: (input: SaveAssistantDTO) => call<AssistantDTO>('SaveAssistant', input),
  DeleteAssistant: (id: string) => call<void>('DeleteAssistant', id),

  ListTopics: (assistantId: string) => call<TopicDTO[]>('ListTopics', assistantId),
  CreateTopic: (input: CreateTopicDTO) => call<TopicDTO>('CreateTopic', input),
  RenameTopic: (id: string, title: string) => call<void>('RenameTopic', id, title),
  DeleteTopic: (id: string) => call<void>('DeleteTopic', id),

  ListMessages: (topicId: string, beforeOrder: number, limit: number) =>
    call<MessageDTO[]>('ListMessages', topicId, beforeOrder, limit),
  StartTurn: (input: StartTurnDTO) => call<TurnDTO>('StartTurn', input),
  StartAssistantMessage: (input: StartAssistantMessageDTO) =>
    call<MessageDTO>('StartAssistantMessage', input),
  SaveTurnSnapshot: (input: SaveMessageSnapshotDTO) => call<void>('SaveTurnSnapshot', input),
  FinishTurn: (input: FinishTurnDTO) => call<void>('FinishTurn', input),
  DeleteMessage: (id: string) => call<void>('DeleteMessage', id),

  SaveAppSettings: (input: SaveAppSettingsDTO) => call<AppSettingsDTO>('SaveAppSettings', input),
  GetSearchSettings: () => call<SearchSettingsDTO>('GetSearchSettings'),
  SaveSearchSettings: (input: SaveSearchSettingsDTO) =>
    call<SearchSettingsDTO>('SaveSearchSettings', input),
  Search: (input: SearchRequestDTO) => call<SearchResponseDTO>('Search', input),

  StartProviderRequest: (input: ProviderRequestDTO) =>
    call<RequestHandleDTO>('StartProviderRequest', input),
  CancelProviderRequest: (requestId: string) => call<void>('CancelProviderRequest', requestId),

  OpenExternalURL: (url: string) => call<void>('OpenExternalURL', url),
}

export type AppApi = typeof appApi
