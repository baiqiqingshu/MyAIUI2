import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import clsx from 'clsx'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Star,
  Trash2,
} from 'lucide-react'
import { appApi } from '../../bridge/appApi'
import type { TopicDTO, TopicFolderDTO } from '../../domain/dto'
import {
  TOPIC_PANEL_DEFAULT_WIDTH,
  TOPIC_PANEL_MAX_WIDTH,
  TOPIC_PANEL_MIN_WIDTH,
  useLayoutStore,
} from '../../app/layoutStore'
import { useUiStore } from '../../app/uiStore'
import { useChatStore } from '../chat/chatStore'
import { ConfirmDialog, EmptyState, IconButton } from '../../components/ui'
import { ExportMarkdownDialog } from './ExportMarkdownDialog'
import { TopicDeleteConfirm, TopicRow } from './TopicActions'
import './topics.css'

/* 第二栏话题面板：收藏区 + 目录树 + 未分组话题。
   拖拽用原生 HTML5 DnD：话题行可排序/移入目录/收藏，目录行可改父级。 */

const ZONE_NORMAL = ''
const ZONE_FAV = 'fav'

/* 拖拽负载：自定义 MIME 用于 dragover 期间判定类型（此时读不到数据），
   text/plain 携带 JSON 负载作兜底解析与调试。 */
const TOPIC_MIME = 'application/x-myaiui-topic'
const FOLDER_MIME = 'application/x-myaiui-folder'

type DragKind = 'topic' | 'folder'

interface DragPayload {
  kind: DragKind
  id: string
}

function writeDrag(event: DragEvent, payload: DragPayload) {
  event.dataTransfer.setData(payload.kind === 'topic' ? TOPIC_MIME : FOLDER_MIME, payload.id)
  event.dataTransfer.setData('text/plain', JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'move'
}

function readDrag(event: DragEvent): DragPayload | null {
  const topicId = event.dataTransfer.getData(TOPIC_MIME)
  if (topicId) return { kind: 'topic', id: topicId }
  const folderId = event.dataTransfer.getData(FOLDER_MIME)
  if (folderId) return { kind: 'folder', id: folderId }
  try {
    const parsed = JSON.parse(event.dataTransfer.getData('text/plain')) as DragPayload
    if ((parsed.kind === 'topic' || parsed.kind === 'folder') && parsed.id) return parsed
  } catch {
    /* 非本应用拖拽负载 */
  }
  return null
}

function mimeOf(kind: DragKind): string {
  return kind === 'topic' ? TOPIC_MIME : FOLDER_MIME
}

/** dragover 阶段读不到负载数据，只能用 types 判定拖拽来源类型。 */
function accepts(event: DragEvent, ...kinds: DragKind[]): boolean {
  const types = Array.from(event.dataTransfer.types)
  return kinds.some((kind) => types.includes(mimeOf(kind)))
}

function errText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

function topicSorter(a: TopicDTO, b: TopicDTO): number {
  return a.SortOrder - b.SortOrder || b.UpdatedAt - a.UpdatedAt
}

function folderSorter(a: TopicFolderDTO, b: TopicFolderDTO): number {
  return a.SortOrder - b.SortOrder || a.CreatedAt - b.CreatedAt
}

/** 目录树缩进：每层 14px。 */
function indentOf(depth: number): number {
  return 8 + depth * 14
}

export function TopicPanel() {
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const activeTopicId = useUiStore((s) => s.activeTopicId)
  const topics = useUiStore((s) => s.topics)
  const folders = useUiStore((s) => s.folders)
  const selectTopic = useUiStore((s) => s.selectTopic)
  const refreshTopics = useUiStore((s) => s.refreshTopics)
  const refreshFolders = useUiStore((s) => s.refreshFolders)
  const showToast = useUiStore((s) => s.showToast)
  // chatStore 契约：正在生成回复的话题 ID 列表（话题行打「生成中」标记）。
  const runningTopicIds = useChatStore((s) => s.runningTopicIds)
  // 布局偏好：面板宽度受控（右缘拖宽把手实时改写），持久化在 layoutStore。
  const topicPanelWidth = useLayoutStore((s) => s.topicPanelWidth)
  const setTopicPanelWidth = useLayoutStore((s) => s.setTopicPanelWidth)

  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TopicDTO | null>(null)
  const [pendingExport, setPendingExport] = useState<TopicDTO | null>(null)
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<TopicFolderDTO | null>(null)
  const [deletingFolder, setDeletingFolder] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [dropHint, setDropHint] = useState('')
  const [renamingId, setRenamingId] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [creatingFolder, setCreatingFolder] = useState<{ zone: string; parentId: string } | null>(
    null,
  )
  const [folderDraft, setFolderDraft] = useState('')
  const [folderSaving, setFolderSaving] = useState(false)
  const [resizing, setResizing] = useState(false)
  const resizeDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const selectLockedRef = useRef(false)

  const folderById = useMemo(() => new Map(folders.map((f) => [f.ID, f])), [folders])
  const favFolders = useMemo(() => folders.filter((f) => f.Zone === ZONE_FAV), [folders])
  const normalFolders = useMemo(() => folders.filter((f) => f.Zone !== ZONE_FAV), [folders])
  const favFolderIds = useMemo(() => new Set(favFolders.map((f) => f.ID)), [favFolders])
  const normalFolderIds = useMemo(() => new Set(normalFolders.map((f) => f.ID)), [normalFolders])

  // 收藏话题只进收藏区：fav 目录内按目录分组，其余（根级或目录缺失）平铺在收藏区根部。
  const favRootTopics = useMemo(
    () => topics.filter((t) => t.Favorite && !favFolderIds.has(t.FolderID)).sort(topicSorter),
    [topics, favFolderIds],
  )
  const rootTopics = useMemo(
    () => topics.filter((t) => !t.Favorite && !normalFolderIds.has(t.FolderID)).sort(topicSorter),
    [topics, normalFolderIds],
  )
  const runningSet = useMemo(() => new Set(runningTopicIds), [runningTopicIds])

  function topicsInFolder(folder: TopicFolderDTO): TopicDTO[] {
    const favorite = folder.Zone === ZONE_FAV
    return topics
      .filter((t) => t.FolderID === folder.ID && t.Favorite === favorite)
      .sort(topicSorter)
  }

  function childFoldersOf(zone: string, parentId: string): TopicFolderDTO[] {
    const zoneFolders = zone === ZONE_FAV ? favFolders : normalFolders
    return zoneFolders.filter((f) => (f.ParentID ?? '') === parentId).sort(folderSorter)
  }

  /** 分区根目录：ParentID 为空，或父目录已不存在（孤儿提升到根级显示）。 */
  function rootFoldersOf(zone: string): TopicFolderDTO[] {
    const zoneFolders = zone === ZONE_FAV ? favFolders : normalFolders
    return zoneFolders.filter((f) => !f.ParentID || !folderById.has(f.ParentID)).sort(folderSorter)
  }

  /** folderId 是否位于 ancestorId 的子树内（沿 ParentID 链上溯，成环时截断）。 */
  function isInside(folderId: string, ancestorId: string): boolean {
    let cursor = folderById.get(folderId)?.ParentID ?? ''
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (cursor === ancestorId) return true
      seen.add(cursor)
      cursor = folderById.get(cursor)?.ParentID ?? ''
    }
    return false
  }

  async function handleCreate() {
    if (!activeAssistantId) {
      showToast('请先选择一个助手', 'error')
      return
    }
    setCreating(true)
    try {
      const created = await appApi.CreateTopic({ AssistantID: activeAssistantId, Title: '' })
      await refreshTopics()
      selectTopic(created.ID)
    } catch (err) {
      showToast(`新建话题失败：${errText(err)}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  // -------------------------------------------------------------- 面板拖宽

  const lockTextSelection = (locked: boolean) => {
    if (locked) {
      document.body.style.userSelect = 'none'
      selectLockedRef.current = true
      return
    }
    if (!selectLockedRef.current) return
    document.body.style.userSelect = ''
    selectLockedRef.current = false
  }

  /* 拖动中指针会划过话题行与主区，锁住文本选择；组件在拖动中卸载也要恢复。 */
  useEffect(() => () => lockTextSelection(false), [])

  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: topicPanelWidth,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
    lockTextSelection(true)
  }

  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setTopicPanelWidth(drag.startWidth + (event.clientX - drag.startX))
  }

  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current) return
    resizeDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizing(false)
    lockTextSelection(false)
  }

  /* 键盘微调：左箭头收窄、右箭头放宽，步长与输入框拖高一致。 */
  const onResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setTopicPanelWidth(topicPanelWidth + (event.key === 'ArrowRight' ? 24 : -24))
  }

  // -------------------------------------------------------------- 移动/拖拽

  async function moveTopic(topicId: string, folderId: string, favorite: boolean, sortOrder: number) {
    try {
      await appApi.MoveTopic({
        TopicID: topicId,
        FolderID: folderId,
        Favorite: favorite,
        SortOrder: sortOrder,
      })
      await refreshTopics()
    } catch (err) {
      showToast(`移动话题失败：${errText(err)}`, 'error')
    }
  }

  async function moveFolder(folderId: string, parentId: string, zone: string, sortOrder: number) {
    try {
      await appApi.MoveTopicFolder({
        FolderID: folderId,
        ParentID: parentId,
        Zone: zone,
        SortOrder: sortOrder,
      })
      await Promise.all([refreshFolders(), refreshTopics()])
    } catch (err) {
      showToast(`移动目录失败：${errText(err)}`, 'error')
    }
  }

  /** 话题行星标：收藏进收藏区根部末尾；取消收藏回普通区根部末尾。 */
  function handleToggleFavorite(topic: TopicDTO) {
    const favorite = !topic.Favorite
    const sortOrder = favorite ? favRootTopics.length : rootTopics.length
    void moveTopic(topic.ID, '', favorite, sortOrder)
  }

  /** 标记当前悬停放置目标；kinds 限定接受的拖拽类型（不符则不 preventDefault，交给外层）。 */
  function handleDragOver(event: DragEvent<HTMLElement>, hint: string, ...kinds: DragKind[]) {
    if (!accepts(event, ...kinds)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    if (dropHint !== hint) setDropHint(hint)
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    // 移入子元素也触发 dragleave：仍在同一目标内时不取消高亮。
    const related = event.relatedTarget
    if (related instanceof Node && event.currentTarget.contains(related)) return
    setDropHint('')
  }

  /** 拖到话题行：上半区插到该行前，下半区插到该行后（容器取目标行所在容器）。 */
  function handleDropOnTopic(
    event: DragEvent<HTMLDivElement>,
    target: TopicDTO,
    container: TopicDTO[],
  ) {
    const drag = readDrag(event)
    if (!drag || drag.kind !== 'topic') return // 目录拖拽放行给外层容器
    event.preventDefault()
    event.stopPropagation()
    setDropHint('')
    if (drag.id === target.ID) return
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    // 目标下标基于「移除拖拽项之后」的列表计算
    const siblings = container.filter((t) => t.ID !== drag.id)
    let at = siblings.findIndex((t) => t.ID === target.ID)
    if (at < 0) at = siblings.length
    void moveTopic(drag.id, target.FolderID ?? '', target.Favorite, after ? at + 1 : at)
  }

  /** 拖到目录行：话题 → 移入该目录末尾；目录 → 成为该目录的子目录。 */
  function handleDropOnFolder(event: DragEvent<HTMLElement>, folder: TopicFolderDTO) {
    const drag = readDrag(event)
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    setDropHint('')
    if (drag.kind === 'topic') {
      void moveTopic(drag.id, folder.ID, folder.Zone === ZONE_FAV, topicsInFolder(folder).length)
      return
    }
    if (drag.id === folder.ID) return
    if (isInside(folder.ID, drag.id)) {
      showToast('不能移动到它自己的子目录里', 'info')
      return
    }
    void moveFolder(drag.id, folder.ID, folder.Zone, childFoldersOf(folder.Zone, folder.ID).length)
  }

  /** 拖到分区空白/标题：话题 → 该分区根级末尾；目录 → 该分区根级末尾。 */
  function handleDropOnZone(event: DragEvent<HTMLElement>, zone: string) {
    const drag = readDrag(event)
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    setDropHint('')
    if (drag.kind === 'topic') {
      const count = zone === ZONE_FAV ? favRootTopics.length : rootTopics.length
      void moveTopic(drag.id, '', zone === ZONE_FAV, count)
      return
    }
    const folder = folderById.get(drag.id)
    // 已在该分区根级时不发请求
    if (!folder || (!folder.ParentID && (folder.Zone === ZONE_FAV) === (zone === ZONE_FAV))) return
    void moveFolder(drag.id, '', zone, rootFoldersOf(zone).length)
  }

  // -------------------------------------------------------------- 目录增删改

  function toggleCollapsed(folderId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  function startCreateFolder(zone: string, parentId: string) {
    setRenamingId('')
    setFolderDraft('')
    setCreatingFolder({ zone, parentId })
    // 新建子目录时确保父级处于展开状态
    if (parentId && collapsed.has(parentId)) toggleCollapsed(parentId)
  }

  async function submitCreateFolder() {
    const target = creatingFolder
    if (!target) return
    const name = folderDraft.trim()
    if (!name) {
      setCreatingFolder(null)
      return
    }
    setFolderSaving(true)
    try {
      await appApi.SaveTopicFolder({
        ID: '',
        AssistantID: activeAssistantId,
        ParentID: target.parentId,
        Name: name,
        Zone: target.zone,
        SortOrder: childFoldersOf(target.zone, target.parentId).length,
      })
      setCreatingFolder(null)
      setFolderDraft('')
      await refreshFolders()
    } catch (err) {
      showToast(`新建目录失败：${errText(err)}`, 'error')
    } finally {
      setFolderSaving(false)
    }
  }

  function startRenameFolder(folder: TopicFolderDTO) {
    setCreatingFolder(null)
    setRenameDraft(folder.Name)
    setRenamingId(folder.ID)
  }

  async function submitRenameFolder(folder: TopicFolderDTO) {
    const name = renameDraft.trim()
    if (!name || name === folder.Name) {
      setRenamingId('')
      return
    }
    try {
      await appApi.SaveTopicFolder({
        ID: folder.ID,
        AssistantID: folder.AssistantID,
        ParentID: folder.ParentID,
        Name: name,
        Zone: folder.Zone,
        SortOrder: folder.SortOrder,
      })
      setRenamingId('')
      await Promise.all([refreshFolders(), refreshTopics()])
    } catch (err) {
      showToast(`重命名目录失败：${errText(err)}`, 'error')
    }
  }

  async function handleDeleteFolder() {
    const folder = pendingDeleteFolder
    if (!folder) return
    setDeletingFolder(true)
    try {
      await appApi.DeleteTopicFolder(folder.ID)
      await Promise.all([refreshFolders(), refreshTopics()])
      setPendingDeleteFolder(null)
      showToast('目录已删除', 'success')
    } catch (err) {
      showToast(`删除目录失败：${errText(err)}`, 'error')
    } finally {
      setDeletingFolder(false)
    }
  }

  // ------------------------------------------------------------------ 渲染

  function renderFolderCreator(zone: string, parentId: string, depth: number) {
    if (!creatingFolder || creatingFolder.zone !== zone || creatingFolder.parentId !== parentId) {
      return null
    }
    return (
      <div className="topic-folder topic-folder--new" style={{ paddingLeft: indentOf(depth) }}>
        <span className="topic-folder__chevron" aria-hidden />
        <Folder size={14} className="topic-folder__icon" />
        <input
          className="ui-input topic-item__input"
          value={folderDraft}
          placeholder="目录名称"
          autoFocus
          disabled={folderSaving}
          onChange={(event) => setFolderDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitCreateFolder()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setCreatingFolder(null)
            }
          }}
          onBlur={() => {
            if (!folderSaving) setCreatingFolder(null)
          }}
        />
      </div>
    )
  }

  function renderTopicRow(topic: TopicDTO, container: TopicDTO[], depth: number) {
    const hint =
      dropHint === `topic-before:${topic.ID}`
        ? 'before'
        : dropHint === `topic-after:${topic.ID}`
          ? 'after'
          : null
    return (
      <TopicRow
        key={topic.ID}
        topic={topic}
        active={topic.ID === activeTopicId}
        running={runningSet.has(topic.ID)}
        indent={indentOf(depth)}
        dropPos={hint}
        onSelect={selectTopic}
        onRequestDelete={setPendingDelete}
        onRequestExport={setPendingExport}
        onToggleFavorite={handleToggleFavorite}
        onDragStart={(event) => writeDrag(event, { kind: 'topic', id: topic.ID })}
        onDragEnd={() => setDropHint('')}
        onDragOver={(event) => {
          if (!accepts(event, 'topic')) return
          const rect = event.currentTarget.getBoundingClientRect()
          const after = event.clientY > rect.top + rect.height / 2
          handleDragOver(event, `topic-${after ? 'after' : 'before'}:${topic.ID}`, 'topic')
        }}
        onDragLeave={handleDragLeave}
        onDrop={(event) => handleDropOnTopic(event, topic, container)}
      />
    )
  }

  function renderFolder(
    folder: TopicFolderDTO,
    depth: number,
    zone: string,
    ancestry: ReadonlySet<string>,
  ) {
    if (ancestry.has(folder.ID)) return null // 防御：ParentID 数据成环时截断
    const nextAncestry = new Set(ancestry)
    nextAncestry.add(folder.ID)
    const isCollapsed = collapsed.has(folder.ID)
    const children = childFoldersOf(zone, folder.ID)
    const folderTopics = topicsInFolder(folder)
    const renaming = renamingId === folder.ID

    return (
      <div key={folder.ID} className="topic-folder-block">
        <div
          className={clsx('topic-folder', dropHint === `folder:${folder.ID}` && 'is-drop')}
          style={{ paddingLeft: indentOf(depth) }}
          draggable={!renaming}
          onDragStart={(event) => writeDrag(event, { kind: 'folder', id: folder.ID })}
          onDragEnd={() => setDropHint('')}
          onDragOver={(event) => handleDragOver(event, `folder:${folder.ID}`, 'topic', 'folder')}
          onDragLeave={handleDragLeave}
          onDrop={(event) => handleDropOnFolder(event, folder)}
        >
          <button
            type="button"
            className="topic-folder__chevron"
            title={isCollapsed ? '展开' : '折叠'}
            aria-label={isCollapsed ? `展开目录 ${folder.Name}` : `折叠目录 ${folder.Name}`}
            onClick={() => toggleCollapsed(folder.ID)}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <Folder size={14} className="topic-folder__icon" />
          {renaming ? (
            <input
              className="ui-input topic-item__input"
              value={renameDraft}
              autoFocus
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submitRenameFolder(folder)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setRenamingId('')
                }
              }}
              onBlur={() => setRenamingId('')}
            />
          ) : (
            <button
              type="button"
              className="topic-folder__name"
              title={folder.Name}
              onClick={() => toggleCollapsed(folder.ID)}
            >
              {folder.Name}
            </button>
          )}
          <span className="topic-folder__actions">
            <IconButton title="新建子目录" onClick={() => startCreateFolder(zone, folder.ID)}>
              <FolderPlus size={13} />
            </IconButton>
            <IconButton title="重命名目录" onClick={() => startRenameFolder(folder)}>
              <Pencil size={13} />
            </IconButton>
            <IconButton title="删除目录" onClick={() => setPendingDeleteFolder(folder)}>
              <Trash2 size={13} />
            </IconButton>
          </span>
        </div>
        {isCollapsed ? null : (
          <>
            {renderFolderCreator(zone, folder.ID, depth + 1)}
            {children.map((sub) => renderFolder(sub, depth + 1, zone, nextAncestry))}
            {folderTopics.map((topic) => renderTopicRow(topic, folderTopics, depth + 1))}
            {children.length === 0 &&
            folderTopics.length === 0 &&
            creatingFolder?.parentId !== folder.ID ? (
              <div className="topic-folder__empty" style={{ paddingLeft: indentOf(depth + 1) }}>
                空目录
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  return (
    <aside className="topic-panel" aria-label="话题" style={{ width: topicPanelWidth }}>
      <header className="topic-panel__head">
        <span className="topic-panel__title">话题</span>
        <span className="topic-panel__head-actions">
          <IconButton
            title="新建话题"
            onClick={handleCreate}
            disabled={creating || !activeAssistantId}
          >
            <Plus size={16} />
          </IconButton>
          <IconButton
            title="新建目录"
            onClick={() => startCreateFolder(ZONE_NORMAL, '')}
            disabled={!activeAssistantId}
          >
            <FolderPlus size={15} />
          </IconButton>
        </span>
      </header>

      <div className="topic-panel__list scroll-area">
        {/* 收藏区：fav 目录树 + 根级收藏话题；拖到标题/空白 = 收藏到根级 */}
        <section
          className={clsx('topic-zone', dropHint === 'zone:fav' && 'is-drop')}
          onDragOver={(event) => handleDragOver(event, 'zone:fav', 'topic', 'folder')}
          onDragLeave={handleDragLeave}
          onDrop={(event) => handleDropOnZone(event, ZONE_FAV)}
        >
          <div className="topic-zone__head">
            <Star size={12} className="topic-zone__icon topic-zone__icon--fav" />
            <span className="topic-zone__title">收藏</span>
            <IconButton
              title="新建收藏目录"
              className="topic-zone__action"
              onClick={() => startCreateFolder(ZONE_FAV, '')}
              disabled={!activeAssistantId}
            >
              <FolderPlus size={13} />
            </IconButton>
          </div>
          {renderFolderCreator(ZONE_FAV, '', 0)}
          {rootFoldersOf(ZONE_FAV).map((folder) => renderFolder(folder, 0, ZONE_FAV, new Set()))}
          {favRootTopics.map((topic) => renderTopicRow(topic, favRootTopics, 0))}
          {favFolders.length === 0 && favRootTopics.length === 0 ? (
            <div className="topic-zone__empty">拖拽话题到这里收藏</div>
          ) : null}
        </section>

        {/* 普通区：目录树在前，未分组话题平铺在目录下面；空白处可接受拖出目录的话题 */}
        <section
          className={clsx('topic-zone topic-zone--grow', dropHint === 'zone:normal' && 'is-drop')}
          onDragOver={(event) => handleDragOver(event, 'zone:normal', 'topic', 'folder')}
          onDragLeave={handleDragLeave}
          onDrop={(event) => handleDropOnZone(event, ZONE_NORMAL)}
        >
          {renderFolderCreator(ZONE_NORMAL, '', 0)}
          {rootFoldersOf(ZONE_NORMAL).map((folder) => renderFolder(folder, 0, ZONE_NORMAL, new Set()))}
          {rootTopics.map((topic) => renderTopicRow(topic, rootTopics, 0))}
          {normalFolders.length === 0 && rootTopics.length === 0 ? (
            <EmptyState title="暂无话题" description="点击右上角「+」新建一个话题" />
          ) : null}
        </section>
      </div>

      {/* 右缘拖宽把手：命中区 8px，hover/拖动中露 accent 指示条 */}
      <div
        className={clsx('topic-panel__resize', resizing && 'topic-panel__resize--active')}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整话题面板宽度"
        aria-valuenow={topicPanelWidth}
        aria-valuemin={TOPIC_PANEL_MIN_WIDTH}
        aria-valuemax={TOPIC_PANEL_MAX_WIDTH}
        tabIndex={0}
        title="拖动调整面板宽度，双击复位"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onLostPointerCapture={onResizeEnd}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => setTopicPanelWidth(TOPIC_PANEL_DEFAULT_WIDTH)}
      />

      <TopicDeleteConfirm topic={pendingDelete} onClose={() => setPendingDelete(null)} />
      <ExportMarkdownDialog topic={pendingExport} onClose={() => setPendingExport(null)} />
      <ConfirmDialog
        open={pendingDeleteFolder !== null}
        title="删除目录"
        description={
          pendingDeleteFolder
            ? `确定删除目录「${pendingDeleteFolder.Name}」？其中的话题与子目录会提升到上一级，不会被删除。`
            : ''
        }
        confirmText={deletingFolder ? '删除中…' : '删除'}
        onConfirm={handleDeleteFolder}
        onCancel={() => setPendingDeleteFolder(null)}
      />
    </aside>
  )
}
