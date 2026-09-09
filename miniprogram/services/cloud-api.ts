// services/cloud-api.ts — 调用云函数 ours（含超时、重试与统一错误）

export interface CloudResult<T> {
  ok: boolean
  data?: T
  error?: string
}

/** 单次请求超时（毫秒）。云函数冷启动可能偏慢，留足余量 */
const TIMEOUT_MS = 20000
/** 网络类错误的最大重试次数（业务错误不重试） */
const MAX_RETRY = 1

interface OursError extends Error {
  /** 业务错误（云函数 ok=false）不应重试 */
  business?: boolean
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('网络较慢，请稍后重试')), ms)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function invoke<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const res = (await Promise.race([
    wx.cloud.callFunction({ name: 'ours', data: { action, payload } }),
    timeout(TIMEOUT_MS),
  ])) as { result?: CloudResult<T> }
  const result = res?.result
  if (!result) throw new Error('云函数无响应，请重试')
  if (!result.ok) {
    const err: OursError = new Error(result.error || '云函数调用失败')
    err.business = true
    throw err
  }
  return result.data as T
}

export async function callOurs<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      return await invoke<T>(action, payload)
    } catch (err) {
      lastErr = err
      // 业务错误（如「今天已签到」）直接抛出，不重试
      if ((err as OursError)?.business) throw err
      if (attempt < MAX_RETRY) {
        await delay(400 * (attempt + 1))
        continue
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('网络异常，请重试')
}
