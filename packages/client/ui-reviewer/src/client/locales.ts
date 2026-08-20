/** Copy for the reviewer progress card. */
export const NS = 'reviewer'
/** Simplified Chinese reviewer-card messages. */
export const zh = {
  title: '审查',
  running: '审查中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  activity: '执行链路',
  empty: '等待 Codex 事件…',
  started: '开始',
  done: '完成',
} as const
/** English reviewer-card messages. */
export const en = {
  title: 'Review',
  running: 'Reviewing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  activity: 'Activity',
  empty: 'Waiting for Codex events…',
  started: 'started',
  done: 'done',
} as const
/** Message keys shared by every reviewer-card locale. */
export type ReviewerKey = keyof typeof zh
