import type { CSSProperties } from 'react'

/* 服务商图标：名称哈希映射到稳定色块 + 首字（中文取首个汉字）。
   色值取自 Cherry Studio 基础色板（packages/ui/src/styles/tokens/colors/primitive.css）的 600 档。 */

type Swatch = { readonly background: string; readonly color: string }

const WHITE = 'oklch(1 0 0)'
const INK = 'oklch(0.205 0 0)'

const SWATCHES: readonly Swatch[] = [
  { background: 'oklch(0.54 0.215 263)', color: WHITE }, // blue-600
  { background: 'oklch(0.51 0.228 277)', color: WHITE }, // indigo-600
  { background: 'oklch(0.54 0.245 293)', color: WHITE }, // violet-600
  { background: 'oklch(0.56 0.251 302)', color: WHITE }, // purple-600
  { background: 'oklch(0.59 0.256 323)', color: WHITE }, // fuchsia-600
  { background: 'oklch(0.59 0.217 360)', color: WHITE }, // pink-600
  { background: 'oklch(0.59 0.222 18)', color: WHITE }, // rose-600
  { background: 'oklch(0.58 0.214 27)', color: WHITE }, // red-600
  { background: 'oklch(0.65 0.192 42)', color: INK }, // orange-600
  { background: 'oklch(0.67 0.159 58)', color: INK }, // amber-600
  { background: 'oklch(0.65 0.177 132)', color: INK }, // lime-600
  { background: 'oklch(0.62 0.169 149)', color: WHITE }, // green-600
  { background: 'oklch(0.59 0.127 163)', color: WHITE }, // emerald-600
  { background: 'oklch(0.61 0.105 185)', color: WHITE }, // teal-600
  { background: 'oklch(0.6 0.11 222)', color: WHITE }, // cyan-600
  { background: 'oklch(0.59 0.137 241)', color: WHITE }, // sky-600
]

/* FNV-1a：同名永远得到同一颜色 */
function hashName(name: string): number {
  let hash = 2166136261
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function initialOf(name: string): string {
  const chars = Array.from(name.trim())
  if (chars.length === 0) return '?'
  return chars[0].toUpperCase()
}

export function ProviderIcon({ name, size }: { name: string; size?: number }) {
  const px = size ?? 28
  const swatch = SWATCHES[hashName(name) % SWATCHES.length]
  const style: CSSProperties = {
    width: px,
    height: px,
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-full)',
    background: swatch.background,
    color: swatch.color,
    fontSize: Math.round(px * 0.44),
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
  }

  return (
    <span className="provider-icon" style={style} aria-hidden="true">
      {initialOf(name)}
    </span>
  )
}
