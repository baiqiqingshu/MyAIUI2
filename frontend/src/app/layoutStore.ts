import { create } from 'zustand'

/* 布局偏好：话题面板宽度 / 对话内容铺满。纯 UI 偏好，持久化到 localStorage，
   不走后端（AppSettings 无对应字段，也不该为它扩 DTO）。读取失败一律回退默认。 */

const STORAGE_KEY = 'myaiui:layout'

export const TOPIC_PANEL_MIN_WIDTH = 200
export const TOPIC_PANEL_MAX_WIDTH = 480
/** 与 tokens.css 的 --panel-width 保持一致，避免首屏宽度跳变。 */
export const TOPIC_PANEL_DEFAULT_WIDTH = 256

interface LayoutState {
  /** 话题面板（第二栏）宽度，px */
  topicPanelWidth: number
  /** 对话内容是否取消 max-width 铺满主区 */
  chatFullWidth: boolean
  setTopicPanelWidth: (width: number) => void
  setChatFullWidth: (full: boolean) => void
}

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return TOPIC_PANEL_DEFAULT_WIDTH
  return Math.min(Math.max(Math.round(width), TOPIC_PANEL_MIN_WIDTH), TOPIC_PANEL_MAX_WIDTH)
}

interface PersistedLayout {
  topicPanelWidth?: unknown
  chatFullWidth?: unknown
}

function loadLayout(): Pick<LayoutState, 'topicPanelWidth' | 'chatFullWidth'> {
  const fallback = { topicPanelWidth: TOPIC_PANEL_DEFAULT_WIDTH, chatFullWidth: false }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as PersistedLayout
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      topicPanelWidth: clampPanelWidth(Number(parsed.topicPanelWidth)),
      chatFullWidth: parsed.chatFullWidth === true,
    }
  } catch {
    return fallback
  }
}

export const useLayoutStore = create<LayoutState>()((set, get) => {
  function persist() {
    try {
      const { topicPanelWidth, chatFullWidth } = get()
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ topicPanelWidth, chatFullWidth }))
    } catch {
      /* 存储不可用（隐私模式等）时静默，偏好不持久不影响使用 */
    }
  }

  return {
    ...loadLayout(),
    setTopicPanelWidth(width) {
      set({ topicPanelWidth: clampPanelWidth(width) })
      persist()
    },
    setChatFullWidth(full) {
      set({ chatFullWidth: full })
      persist()
    },
  }
})
