import type { CSSProperties } from 'react'
import {
  BookOpen,
  Bot,
  Brain,
  Code,
  Coffee,
  Compass,
  Feather,
  Globe,
  Heart,
  Languages,
  Lightbulb,
  Music,
  Palette,
  PenLine,
  Rocket,
  Sparkles,
  Star,
  Terminal,
  Type,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/* 助手头像规格（存 assistants.emoji 字段，向后兼容纯 emoji 字符串）：
     'icon:<图标名>:<配色>' → 彩色圆角方块 + 白色 lucide 图标（应用图标风）
     其它字符串            → emoji 字形渲染在中性浅底方块上
     空值                  → AVATAR_FALLBACK_SPEC
   新增图标/配色只改下面两张表；key 会落库，改名即换头像，注意兼容。 */

export interface AssistantAvatarIcon {
  key: string
  label: string
  Icon: LucideIcon
}

export const ASSISTANT_AVATAR_ICONS: AssistantAvatarIcon[] = [
  { key: 'bot', label: '机器人', Icon: Bot },
  { key: 'sparkles', label: '灵感', Icon: Sparkles },
  { key: 'zap', label: '闪电', Icon: Zap },
  { key: 'code', label: '代码', Icon: Code },
  { key: 'terminal', label: '终端', Icon: Terminal },
  { key: 'languages', label: '语言', Icon: Languages },
  { key: 'type', label: '文字', Icon: Type },
  { key: 'brain', label: '大脑', Icon: Brain },
  { key: 'book', label: '书籍', Icon: BookOpen },
  { key: 'rocket', label: '火箭', Icon: Rocket },
  { key: 'globe', label: '地球', Icon: Globe },
  { key: 'lightbulb', label: '点子', Icon: Lightbulb },
  { key: 'feather', label: '羽毛', Icon: Feather },
  { key: 'pen', label: '钢笔', Icon: PenLine },
  { key: 'palette', label: '调色', Icon: Palette },
  { key: 'compass', label: '罗盘', Icon: Compass },
  { key: 'coffee', label: '咖啡', Icon: Coffee },
  { key: 'music', label: '音乐', Icon: Music },
  { key: 'star', label: '星星', Icon: Star },
  { key: 'heart', label: '爱心', Icon: Heart },
]

export interface AssistantAvatarColor {
  key: string
  label: string
  bg: string
}

export const ASSISTANT_AVATAR_COLORS: AssistantAvatarColor[] = [
  { key: 'indigo', label: '靛蓝', bg: 'oklch(0.55 0.2 268)' },
  { key: 'violet', label: '紫', bg: 'oklch(0.5 0.21 295)' },
  { key: 'sky', label: '天蓝', bg: 'oklch(0.6 0.16 235)' },
  { key: 'teal', label: '青', bg: 'oklch(0.62 0.13 185)' },
  { key: 'green', label: '绿', bg: 'oklch(0.62 0.16 150)' },
  { key: 'amber', label: '琥珀', bg: 'oklch(0.66 0.15 70)' },
  { key: 'rose', label: '玫红', bg: 'oklch(0.58 0.2 15)' },
  { key: 'slate', label: '石灰', bg: 'oklch(0.5 0.03 255)' },
]

export const AVATAR_SPEC_PREFIX = 'icon:'
export const AVATAR_FALLBACK_SPEC = 'icon:bot:indigo'

export function assistantAvatarSpec(iconKey: string, colorKey: string): string {
  return `${AVATAR_SPEC_PREFIX}${iconKey}:${colorKey}`
}

export type AssistantAvatarSpec =
  | { kind: 'icon'; icon: AssistantAvatarIcon; color: AssistantAvatarColor }
  | { kind: 'emoji'; emoji: string }

export function parseAssistantAvatar(value: string | undefined | null): AssistantAvatarSpec {
  const v = (value ?? '').trim()
  if (v.startsWith(AVATAR_SPEC_PREFIX)) {
    const parts = v.slice(AVATAR_SPEC_PREFIX.length).split(':')
    const icon = ASSISTANT_AVATAR_ICONS.find((item) => item.key === parts[0])
    const color = ASSISTANT_AVATAR_COLORS.find((item) => item.key === parts[1])
    if (icon && color) return { kind: 'icon', icon, color }
  }
  if (v) return { kind: 'emoji', emoji: v }
  return {
    kind: 'icon',
    icon: ASSISTANT_AVATAR_ICONS[0],
    color: ASSISTANT_AVATAR_COLORS[0],
  }
}

/* 渲染头像：size 为方块边长；icon 规格 = 彩底白图标，emoji = 中性浅底方块。 */
export function AssistantAvatar({ value, size = 30 }: { value: string; size?: number }) {
  const spec = parseAssistantAvatar(value)
  const base: CSSProperties = {
    width: size,
    height: size,
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Math.max(6, Math.round(size * 0.3)),
    lineHeight: 1,
    userSelect: 'none',
    overflow: 'hidden',
  }
  if (spec.kind === 'icon') {
    const { Icon } = spec.icon
    return (
      <span style={{ ...base, background: spec.color.bg, color: '#fff' }} aria-hidden="true">
        <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} />
      </span>
    )
  }
  return (
    <span
      style={{
        ...base,
        background: 'var(--bg-hover)',
        border: '1px solid var(--border-subtle)',
        fontSize: Math.round(size * 0.55),
      }}
      aria-hidden="true"
    >
      {spec.emoji}
    </span>
  )
}
