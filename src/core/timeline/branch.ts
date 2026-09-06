// Branch 分叉（docs/02 §11.6，T9 第四部分）。
//
// fork 的语义（§11.1 设计原点）：回到某个 step，改掉当时的输入，让执行
// 从这里分叉出新分支——「哪份数据导致了这个决策」的实验级证据。
//
// 职责划分：
// - forkBranch 是**纯数据操作**：在 Timeline 上登记一条 Branch（id 派生
//   自主线 runId、分叉点、空事件表、说明），不建图、不动主时间线
//   （mainEvents 与既有 branches 均不修改——「登记新分支」是 branches
//   表的预期用途，不属「修改主时间线」）
// - createBranchSession 按需为分支建图：组合流 = 主线前缀 + 分支自有
//   事件，**复用主线 checkpoint**（分叉点之前的事件流与主线逐字一致，
//   重放结果是同一图——直接深拷贝，省 O(baseEventIndex) 全量回放），
//   分叉点之后用分支事件增量应用。**不写第二套边推导规则**：全部走
//   applyEvent（§11.8 条 4），溯源/新鲜度查询照常工作（§11.7）
import type { AgentEvent } from '../types'
import { applyEvent, createGraph } from '../graph/build'
import { updateLayout } from '../graph/layout'
import { createJournal, type Journal } from './journal'
import {
  CHECKPOINT_INTERVAL,
  cloneGraph,
  cloneLayout,
  dirtyOf,
  makeCheckpoint,
  type Checkpoint,
  type ReplaySession,
} from './checkpoint'

/** 从主时间线分出的执行分支（§11.6 契约） */
export interface Branch {
  id: string
  /** 从主时间线的第几个事件后分叉（baseEventIndex 个事件已应用） */
  baseEventIndex: number
  /** 该分支在分叉点之后的事件序列（含「修改过的历史」与「新执行」）；
   *  fork 时为空——由调用方（store/UI）随后注入修改事件 */
  events: AgentEvent[]
  /** 分叉时的人工改动说明（UI 展示用，如「把简历换成 v2」） */
  note: string
}

/** 时间线：主线 + 分支登记表（§11.6 契约） */
export interface Timeline {
  mainEvents: AgentEvent[]
  branches: Branch[]
  activeBranchId: string | null // null = 主线
}

export function createTimeline(mainEvents: AgentEvent[]): Timeline {
  return { mainEvents, branches: [], activeBranchId: null }
}

/**
 * 在 atEventIndex 处开一条新分支（登记，纯数据操作）。
 * 分支 id 派生自主线（`${mainRunId}#fork-${n}`，§11.6 硬约束：分支图
 * 的 runId 永远经 createGraph 工厂诞生，§5 构造约束不被绕过）。
 * 不修改 mainEvents 与既有 branches。
 */
export function forkBranch(timeline: Timeline, atEventIndex: number, note: string): Branch {
  if (atEventIndex < 0 || atEventIndex > timeline.mainEvents.length) {
    throw new Error(
      `fork 位置越界: ${atEventIndex}（主线事件流长度 ${timeline.mainEvents.length}）`,
    )
  }
  const mainRunId = timeline.mainEvents[0].runId
  const branch: Branch = {
    id: `${mainRunId}#fork-${timeline.branches.length + 1}`,
    baseEventIndex: atEventIndex,
    events: [],
    note,
  }
  timeline.branches.push(branch)
  return branch
}

/**
 * 为分支建执行会话：组合流 = 主线前缀（复用主线 checkpoint 深拷贝）+
 * 分支自有事件（增量应用）。图的 runId 用分支派生 id（createGraph 工厂）。
 *
 * 主线 checkpoint 复用的正确性：checkpoint 是「应用前 k 个事件后的图」
 * 的深拷贝，k ≤ baseEventIndex ⟹ 它对分支前缀同样成立（同一前缀、同一
 * applyEvent 规则 ⟹ 同一图）。深拷贝保证零结构共享（§11.8 条 5）。
 *
 * 分支自身的 checkpoint 按组合流的全局 index 从头打点（间隔语义与
 * createReplaySession 一致；前缀部分的打点成本 = 深拷贝 × baseEventIndex/
 * INTERVAL，远低于全量重放）。
 */
export function createBranchSession(
  timeline: Timeline,
  branch: Branch,
  mainSession: ReplaySession,
): ReplaySession {
  const events: AgentEvent[] = [
    ...timeline.mainEvents.slice(0, branch.baseEventIndex),
    ...branch.events,
  ]
  // 复用主线 ≤ baseEventIndex 的最近 checkpoint（无则从零）
  let cp: Checkpoint | null = null
  for (const candidate of mainSession.checkpoints) {
    if (candidate.eventIndex > branch.baseEventIndex) break
    cp = candidate
  }
  const graph = cp !== null ? cloneGraph(cp.graph) : createGraph(branch.id)
  // checkpoint 深拷贝自带主线 runId——分支图换成派生 id（§11.6：分支的
  // runId 派生自主线）。runId 是图元数据而非因果结构，此处的一次赋值
  // 不构成「绕过 applyEvent 改图」（§5 指结构写入；构造路径仍是
  // 深拷贝 + 工厂，见 createBranchSession 文档注释）
  graph.runId = branch.id
  let layout =
    cp !== null
      ? cloneLayout(cp.layout)
      : { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
  const journal: Journal = createJournal()
  const base = cp !== null ? cp.eventIndex : 0
  // B4-1（裁决 11 条 4）：并入主线 ≤ baseEventIndex 的 checkpoints（共享
  // 引用安全——Checkpoint 只读、使用时 clone）。分支会话的 checkpoint
  // 覆盖不变量由此与主线一致：深回退走 checkpoint 重建（重放 ≤200 步），
  // 不再「journalBase 之下从零重放」的性能悬崖（10k 流上秒级冻结）。
  // own 打点只补 base 之后的（主线 checkpoint 的 eventIndex 是全局索引，
  // 与组合流前缀一致——前缀逐字相同，直接可用）
  const checkpoints: Checkpoint[] = []
  for (const candidate of mainSession.checkpoints) {
    if (candidate.eventIndex <= branch.baseEventIndex) checkpoints.push(candidate)
  }
  const dirty = new Set<string>()
  for (let i = base; i < events.length; i++) {
    const event = events[i]
    applyEvent(graph, event, journal)
    dirty.clear()
    dirtyOf(event, dirty)
    layout = updateLayout(layout, graph, dirty)
    // 从 base 之后接续打点（i+1 是组合流全局 index，与并入的主线
    // checkpoint 索引空间一致）。终点打点可能与已并入的主线 checkpoint
    // 重 eventIndex（分支事件为空且终点恰为间隔倍数时）——防重
    if ((i + 1) % CHECKPOINT_INTERVAL === 0 || i === events.length - 1) {
      if (checkpoints[checkpoints.length - 1]?.eventIndex !== i + 1) {
        checkpoints.push(makeCheckpoint(graph, layout, i + 1))
      }
    }
  }
  return {
    events,
    runId: branch.id,
    graph,
    layout,
    applied: events.length,
    journal,
    // journalBase = 复用的 checkpoint 起点：journal 只记录了从 base 开始的
    // 逆操作（[0, base) 随 checkpoint 深拷贝被跳过），不变量
    // ops.length === applied - journalBase 由此成立（B3 的教训：注释、
    // 实现与不变量三者必须一致）
    journalBase: base,
    checkpoints,
  }
}
