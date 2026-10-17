// 话题列表的时间显示工具：UpdatedAt/CreatedAt 都是毫秒 epoch。

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / MM-dd / yyyy-MM-dd。 */
export function formatRelative(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < MINUTE_MS) return '刚刚'
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`

  const date = new Date(ms)
  const now = new Date()
  if (sameDay(date, now)) return `${Math.floor(diff / HOUR_MS)} 小时前`

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) return '昨天'

  const md = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}-${md}`
}

/** 完整时间：YYYY-MM-DD HH:mm（用于行 title 悬浮提示）。 */
export function formatDateTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
