import { useMemo } from 'react'
import clsx from 'clsx'
import { Bot, GitBranch, RefreshCw, User } from 'lucide-react'
import { Button, Modal } from '../../components/ui'
import { useUiStore } from '../../app/uiStore'
import { useChatStore } from '../chat/chatStore'
import type { TreeNodeDTO } from '../../domain/dto'
import './branches.css'

export interface BranchPanelProps {
  open: boolean
  onClose: () => void
}

/* 分支管理：把话题内的消息树拍平成可点击的行（父先于子），点击即精确回退/前进。 */

const EMPTY_NODES: TreeNodeDTO[] = []

export function BranchPanel({ open, onClose }: BranchPanelProps) {
  const tree = useChatStore((s) => s.tree)
  const generating = useChatStore((s) => s.generating)
  const switchActiveNode = useChatStore((s) => s.switchActiveNode)
  const refresh = useChatStore((s) => s.refresh)
  const activeTopicId = useUiStore((s) => s.activeTopicId)

  const nodes = tree?.Nodes ?? EMPTY_NODES

  // 深度由 ParentID 链在本地计算：后端只保证「父先于子」的顺序
  const depths = useMemo(() => {
    const parentOf = new Map(nodes.map((node) => [node.ID, node.ParentID]))
    const result = new Map<string, number>()
    for (const node of nodes) {
      let depth = 0
      let cursor = parentOf.get(node.ID) ?? ''
      while (cursor && depth < nodes.length) {
        depth += 1
        cursor = parentOf.get(cursor) ?? ''
      }
      result.set(node.ID, depth)
    }
    return result
  }, [nodes])

  const pick = (node: TreeNodeDTO) => {
    if (generating) {
      useUiStore.getState().showToast('正在生成回复，请稍后再切换分支', 'info')
      return
    }
    void switchActiveNode(node.ID)
  }

  return (
    <Modal
      open={open}
      title="分支管理"
      width={640}
      onClose={onClose}
      footer={
        <div className="branch-panel__foot">
          <span className="branch-panel__hint">点击任意节点即可把当前分支切换到该位置</span>
          <Button
            size="sm"
            disabled={!activeTopicId}
            title="重新加载消息树"
            onClick={() => {
              void refresh()
            }}
          >
            <RefreshCw size={13} />
            <span>刷新</span>
          </Button>
        </div>
      }
    >
      {nodes.length === 0 ? (
        <div className="branch-panel__empty">暂无可切换的消息</div>
      ) : (
        <div className="branch-panel">
          {nodes.map((node) => {
            const empty = node.Preview.trim() === ''
            return (
              <button
                key={node.ID}
                type="button"
                aria-disabled={generating}
                className={clsx('branch-row', node.OnActivePath && 'is-on-path', node.IsActive && 'is-active')}
                style={{ paddingLeft: 10 + (depths.get(node.ID) ?? 0) * 18 }}
                title="切换到此节点"
                onClick={() => pick(node)}
              >
                <span className="branch-row__role">
                  {node.Role === 'user' ? <User size={13} /> : <Bot size={13} />}
                </span>
                <span className={clsx('branch-row__preview', empty && 'branch-row__preview--empty')}>
                  {empty ? '（空消息）' : node.Preview}
                </span>
                {node.SiblingCount > 1 ? (
                  <span className="branch-badge" title="同一位置的版本">
                    {node.SiblingIndex}/{node.SiblingCount}
                  </span>
                ) : null}
                {node.ChildCount > 1 ? (
                  <span className="branch-badge" title={`该节点有 ${node.ChildCount} 个后续分支`}>
                    <GitBranch size={11} />
                    {node.ChildCount}
                  </span>
                ) : null}
                {node.IsActive ? <span className="branch-badge branch-badge--current">当前</span> : null}
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
