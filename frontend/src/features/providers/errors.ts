// Wails 绑定抛出的错误统一转成可展示的中文文本。
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const text = String(error ?? '')
  return text || '未知错误'
}
