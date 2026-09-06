// 反事实推演（T9 第五部分 5-2 演示闭环与端到端证明共用同一函数——
// 「所见即所测」，UI 按钮与 timeline-e2e.test.ts 走同一推导）。
//
// stale-context 剧本的「新鲜简历重跑」：在简历实体创建前分叉后，向
// branch.events 注入「修改过的历史 + 新执行」（§11.6 对分支事件表的
// 定义）：
// 1. 新鲜版简历：同 id entity.create 替换写入（createdAt 挪到 observedAt，
//    payload 标注 v3）——改的是「检索命中了最新版本」这一输入
// 2. 分叉点之后的主线事件续演：结构事件（span.start/end、run.end）
//    原样保留（因果骨架不变），评分与决策两个输出实体按「新鲜简历下」
//    的推定值改写
//
// 推定值（评分 85 / 邀请面试）是**反事实假设的 fixture**：真实重跑需要
// Agent 重新执行（B7+ 接真实后端后由事件源发新事件），本函数是「人工
// 假设」的载体——这正是 §11.1 分叉语义在模拟数据源下的形态：回到
// 过去、改掉输入、推演执行会如何分叉。
//
// 纯函数、零副作用；只依赖 core 类型（分层规则 store/ → core/）。
import type { AgentEvent, DataEntity } from '../core/types'

/** 剧本关键实体 id（stale-context 专用推演；其他剧本返回 null 由 UI 隐藏入口） */
const RESUME_ID = 'e-resume-v1'
const SCORE_ID = 'e-score'
const DECISION_ID = 'e-decision'

/** 推定输出：新鲜简历（v3）下的评分与决策（反事实假设，见文件头） */
function positedScoreEntity(original: DataEntity): DataEntity {
  return {
    ...original,
    label: '综合评分 85',
    time: { ...original.time, createdAt: original.time.observedAt }, // 新鲜输入的产物同样新鲜
    payload: {
      score: 85,
      breakdown: { 经验: 45, 技能匹配: 40 },
      comment: '基于 v3 简历：三年经验，技能覆盖充分',
    },
  }
}

function positedDecisionEntity(original: DataEntity): DataEntity {
  return {
    ...original,
    label: '决策 · 邀请面试',
    time: { ...original.time, createdAt: original.time.observedAt },
    payload: {
      result: 'interview',
      reason: '综合评分 85 高于阈值 70',
    },
  }
}

/**
 * 生成 stale-context 的反事实事件序列（forkIndex = 分叉点，主线在
 * mainEvents[forkIndex] 处是 e-resume-v1 的 entity.create）。
 * 返回序列 = [新鲜版简历, 分叉点之后的主线事件续演（输出改写）]。
 * 分叉点不是该形态（其他剧本/其他位置）时返回 null——调用方决定入口
 * 是否展示，本函数不做静默降级。
 */
export function staleResumeRerunEvents(
  mainEvents: readonly AgentEvent[],
  forkIndex: number,
): AgentEvent[] | null {
  const forkEvent = mainEvents[forkIndex]
  if (forkEvent === undefined || forkEvent.type !== 'entity.create') return null
  if (forkEvent.entity.id !== RESUME_ID) return null

  // 1. 新鲜版简历（替换式写入：同 id entity.create 覆盖，B2 测过的语义）
  const originalResume = forkEvent.entity
  const freshResume: DataEntity = {
    ...originalResume,
    label: '候选人 A 简历 · v3（反事实）',
    time: { ...originalResume.time, createdAt: originalResume.time.observedAt }, // 年龄归零
    payload: {
      ...(originalResume.payload as Record<string, unknown>),
      version: 'v3',
      yearsOfExperience: 3,
      skills: ['JavaScript', 'TypeScript', 'React'],
      note: '反事实推演：检索命中了最新版本',
    },
  }
  const events: AgentEvent[] = [
    { type: 'entity.create', runId: forkEvent.runId, entity: freshResume },
  ]

  // 2. 续演分叉点之后的主线事件：结构原样、输出按推定值改写。
  //    注入事件的 runId 保持主线形态（组合流前缀一致；图实例的 runId
  //    才是分支标识——branch.test.ts 同款约定）
  for (let i = forkIndex + 1; i < mainEvents.length; i++) {
    const event = mainEvents[i]
    if (event.type === 'entity.create') {
      const { entity } = event
      if (entity.id === RESUME_ID) continue // 已被新鲜版替换，跳过原始简历
      if (entity.id === SCORE_ID) {
        events.push({ type: 'entity.create', runId: event.runId, entity: positedScoreEntity(entity) })
        continue
      }
      if (entity.id === DECISION_ID) {
        events.push({
          type: 'entity.create',
          runId: event.runId,
          entity: positedDecisionEntity(entity),
        })
        continue
      }
    }
    events.push(event)
  }
  return events
}
