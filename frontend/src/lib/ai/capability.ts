import type { ModelDTO } from '../../domain/dto'

// 模型能力判定：P0 只有 text / image 两种模态，未知一律按文本处理。
export function isImageModel(model: ModelDTO): boolean {
  return model.Modality === 'image'
}

// 取消异常统一用 AbortError 名称，便于上层区分“用户停止”和真实失败。
export function abortError(): Error {
  const err = new Error('请求已取消')
  err.name = 'AbortError'
  return err
}

// 错误脱敏：抹掉密钥形态、折叠空白、截断到 300 字，避免把上游回显内容整段抛给 UI。
export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-***')
    .replace(/(api[_-]?key|access[_-]?token|authorization)["'\s:=]+[A-Za-z0-9._-]{6,}/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 300) : '请求失败'
}
