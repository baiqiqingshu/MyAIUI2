import { appApi } from '../bridge/appApi'
import { useUiStore } from './uiStore'

const PASTE_REJECTED_TOAST = '本应用仅支持粘贴纯文本'

let guardsInstalled = false

function applyTheme(theme: string): void {
  const root = document.documentElement
  // system 时交给系统偏好（global.css 的 prefers-color-scheme 分支）。
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme
  else delete root.dataset.theme
}

// 全窗口拦截拖放与文件/图片粘贴：本原型没有任何文件接收能力。
// 只在这里安装一次，其它模块不要重复绑定 drop/dragover。
function installInputGuards(): void {
  if (guardsInstalled) return
  guardsInstalled = true

  const blockDrop = (event: DragEvent): void => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
  }
  window.addEventListener('dragover', blockDrop)
  window.addEventListener('drop', blockDrop)

  window.addEventListener(
    'paste',
    (event: ClipboardEvent) => {
      const data = event.clipboardData
      if (!data) return
      const hasImageItem = Array.from(data.items).some(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      )
      if (data.files.length === 0 && !hasImageItem) return // 纯文本放行
      event.preventDefault()
      useUiStore.getState().showToast(PASTE_REJECTED_TOAST, 'error')
    },
    true,
  )
}

export async function bootstrap(): Promise<void> {
  installInputGuards()
  try {
    const data = await appApi.Bootstrap()
    useUiStore.getState().applyBootstrap(data)
    applyTheme(data.Settings.Theme)
  } catch (err) {
    useUiStore.getState().setFatalError(err instanceof Error && err.message ? err.message : '初始化失败')
  }
}
