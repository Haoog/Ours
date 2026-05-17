// services/cloud-api.ts — 调用云函数 ours

export interface CloudResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export async function callOurs<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await wx.cloud.callFunction({
    name: 'ours',
    data: { action, payload },
  })
  const result = res.result as CloudResult<T>
  if (!result || !result.ok) {
    throw new Error(result?.error || '云函数调用失败')
  }
  return result.data as T
}
