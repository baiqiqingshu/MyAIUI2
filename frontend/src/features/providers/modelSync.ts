import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import { describeError } from './errors'

// 同步服务商模型：汇总新增/更新/失联数量并刷新模型列表。
export async function syncModels(providerId: string): Promise<void> {
  const { showToast, refreshModels } = useUiStore.getState()
  try {
    const result = await appApi.SyncProviderModels(providerId)
    if (result.Error) {
      showToast(`同步失败：${result.Error}`, 'error')
      return
    }
    showToast(
      `同步完成：新增 ${result.Added} / 更新 ${result.Updated} / 失联 ${result.Missing}`,
      'success',
    )
  } catch (error) {
    showToast(`同步失败：${describeError(error)}`, 'error')
  } finally {
    await refreshModels()
  }
}
