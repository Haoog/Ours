// services/format.ts —— 展示层格式化工具

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

export function formatSlate(ts: number): { md: string; dow: string } {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return { md: `${m}.${day}`, dow: DOW[d.getDay()] }
}
