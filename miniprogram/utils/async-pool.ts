export async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let next = 0
  const runner = async () => {
    while (true) {
      const i = next++
      if (i >= items.length) break
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runner()))
  return results
}

export async function weightedAsyncPool<T, R>(
  items: T[],
  maxWeight: number,
  getWeight: (item: T) => number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return []
  const results: R[] = new Array(items.length)
  let next = 0
  let activeWeight = 0
  return new Promise((resolve, reject) => {
    let settled = 0
    let failed = false
    const pump = () => {
      if (failed) return
      while (next < items.length) {
        const i = next
        const w = Math.max(1, getWeight(items[i]))
        if (activeWeight + w > maxWeight) break
        next += 1
        activeWeight += w
        const idx = i
        Promise.resolve(worker(items[idx], idx))
          .then(r => { results[idx] = r })
          .catch(err => { failed = true; reject(err) })
          .finally(() => {
            activeWeight -= w
            settled += 1
            if (failed) return
            if (settled >= items.length) { resolve(results); return }
            pump()
          })
      }
    }
    pump()
  })
}