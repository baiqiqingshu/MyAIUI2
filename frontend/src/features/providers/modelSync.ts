import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import type { ModelSyncResultDTO } from '../../domain/dto'
import { describeError } from './errors'

// 同步服务商模型：汇总新增/更新/失联数量并刷新模型列表。
// 返回同步结果（失败返回 null），调用方据此提示用户勾选本次新增的模型。
export async function syncModels(providerId: string): Promise<ModelSyncResultDTO | null> {
  const { showToast, refreshModels } = useUiStore.getState()
  try {
    const result = await appApi.SyncProviderModels(providerId)
    if (result.Error) {
      showToast(`同步失败：${result.Error}`, 'error')
      return null
    }
    showToast(
      result.Added > 0
        ? `同步完成：新增 ${result.Added} 个模型（默认未启用）/ 更新 ${result.Updated} / 失联 ${result.Missing}`
        : `同步完成：无新增模型 / 更新 ${result.Updated} / 失联 ${result.Missing}`,
      'success',
    )
    // 后端已保证 AddedIDs 为数组；这里再兜一层，避免 null 流到调用方。
    return { ...result, AddedIDs: result.AddedIDs ?? [] }
  } catch (error) {
    showToast(`同步失败：${describeError(error)}`, 'error')
    return null
  } finally {
    await refreshModels()
  }
}
