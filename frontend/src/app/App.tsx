import { useUiStore } from './uiStore'
import { AssistantRail } from '../features/assistants/AssistantList'
import { AssistantEditor } from '../features/assistants/AssistantEditor'
import { TopicPanel } from '../features/topics/TopicList'
import { ChatWorkspace } from '../features/chat/ChatWorkspace'
import { ProviderDrawer } from '../features/providers/ProviderDrawer'
import { SearchSettingsDialog } from '../features/search/SearchToggle'
import { ToastHost } from '../components/ui'

export function App() {
  const ready = useUiStore((s) => s.ready)
  const fatalError = useUiStore((s) => s.fatalError)

  if (!ready) {
    return (
      <div className="app-boot">
        <div className="app-boot__spinner" />
        <p>正在启动 MyAIUI2…</p>
      </div>
    )
  }

  if (fatalError) {
    return (
      <div className="app-boot">
        <h1>初始化失败</h1>
        <pre className="app-boot__error">{fatalError}</pre>
        <p className="app-boot__hint">
          请检查本机数据目录是否可写（%LOCALAPPDATA%\MyAIUI2\data），然后重新启动应用。
        </p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <AssistantRail />
      <TopicPanel />
      <main className="app-main">
        <ChatWorkspace />
      </main>
      <AssistantEditor />
      <ProviderDrawer />
      <SearchSettingsDialog />
      <ToastHost />
    </div>
  )
}
