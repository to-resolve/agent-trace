// Checkpoint 与回溯（docs/02 §11.5，T9 第二部分）。
//
// 混合回溯策略（T9 第一部分审查 4.3 的授权偏离——纯 checkpoint 正向
// 重放达不到 §11.9 的 200ms 线：按 B 组实测 ~2.9ms/事件（applyEvent+
// updateLayout 满图），重放 200 步 ≈ 580ms）：
//
// - 回退（target < applied）：**invert 逐组回退**（第一部分实现的逆操作，
//   单组 O(逆操作数) 微秒级），journal.ops 同步 pop。任何距离都走此路
//   ——比 checkpoint 深拷贝 + 正向重放快且无需 clone。
// - 前进（target > applied）：小步（≤ CHECKPOINT_INTERVAL）逐步
//   applyEvent + updateLayout（与 traceStore.onEvent 同约定）；大步走
//   checkpoint 深拷贝 + 图/布局同步重放（checkpoint 是唯一能「跳到未来」
//   的路径——重放 ≤ CHECKPOINT_INTERVAL 步远快于从当前逐步走完全程）。
// - journal 有效起点（journalBase）：从 checkpoint 重建后，[0, base)
//   的逆操作随被替换的旧图丢弃——回退不得低于 journalBase；低于时先
//   用 ≤ target 的最近 checkpoint 重建（间隔 200 保证它存在）。
//
// 布局回退：updateLayout 不可逆（增量重心序是历史路径函数），回退后
// 全量 layoutGraph 重建（10k 实测 ~21ms，权威语义；与增量历史的层内
// 顺序差异是 T4 决策 1 的已知特性，非缺陷）。
import type { AgentEvent, CausalGraph, Layout, SpanId } from '../types'
import { applyEvent, createGraph } from '../graph/build'
import { layoutGraph, updateLayout } from '../graph/layout'
import { createJournal, invert, type Journal } from './journal'

/** 已应用前 eventIndex 个事件之后的图状态（§11.5：graph/layout 深拷贝） */
export interface Checkpoint {
  eventIndex: number
  graph: CausalGraph
  layout: Layout
}

/**
 * 检查点间隔。依据：① 契约默认值 200；② 从 checkpoint 重建的最坏重放
 * 步数 = 200（大步前进的成本上界，实测 ~0.3s 内，见提交材料）；③ 打点
 * 成本 = 每次 cloneGraph + cloneLayout（10k 流 50 个检查点共 ~1s，占
 * setup 比例 <2%）。不为凑回溯性能线调密度（审查 ⚠️ 明令禁止）。
 */
export const CHECKPOINT_INTERVAL = 200

/**
 * 深拷贝（§11.5：Map / 数组 / 节点对象逐层复制，禁止结构共享）。
 * structuredClone 递归复制全部普通对象 / 数组 / Map——语义上严格零共享，
 * 「改了 A 分支 B 分支也变」这类幽灵 bug 在结构上不可能。事件协议数据
 * 源自 JSON / SSE（无函数、无原型链定制），structuredClone 完全适用。
 */
export function cloneGraph(graph: CausalGraph): CausalGraph {
  return structuredClone(graph)
}

export function cloneLayout(layout: Layout): Layout {
  return structuredClone(layout)
}

export function makeCheckpoint(
  graph: CausalGraph,
  layout: Layout,
  eventIndex: number,
): Checkpoint {
  return { eventIndex, graph: cloneGraph(graph), layout: cloneLayout(layout) }
}

/**
 * traceStore.onEvent 同款 dirty 约定（layout.ts 文件头契约）——T9 第五
 * 部分统一导出：此前同一约定复制了 6 处（checkpoint/branch/traceStore/
 * bench×3），Phase 2 新增事件类型漏一处就是静默布局漂移。
 * 事件类型不含结构变更（run.start/end、span.end）时集合保持空。
 */
export function dirtyOf(event: AgentEvent, out: Set<SpanId>): void {
  if (event.type === 'span.start') {
    out.add(event.span.id)
  } else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
    out.add(event.entity.producedBy)
  }
}

/**
 * 回溯会话：一条事件流的执行状态（主线或分支共用——第三部分 Timeline
 * 在其上组合）。不变量：
 * - graph/layout 是「应用前 applied 个事件」的状态
 * - journal.ops.length === applied - journalBase；**ops[k] 对应
 *   events[journalBase + k]**（相对索引，T9 第二部分审查 B3：注释原写
 *   「ops[i] 对应 events[i]」是错的——它在 journalBase = 0 时与实现无法
 *   区分，正是索引错位 bug 的温床）
 * - journalBase ≤ applied；[journalBase, applied) 的逆操作有效，
 *   [0, journalBase) 随 checkpoint 重建丢弃
 * - checkpoints 按 eventIndex 升序，覆盖 [CHECKPOINT_INTERVAL, total]
 *   与终点；journalBase 处必有检查点（或 journalBase = 0）
 */
export interface ReplaySession {
  readonly events: readonly AgentEvent[]
  /** 图实例的 runId：默认取 events[0].runId；分支会话传派生 runId
   *  （`#fork-n` 后缀，§11.6）——事件流本身不重写（主线事件原样重放） */
  readonly runId: string
  graph: CausalGraph
  layout: Layout
  applied: number
  journal: Journal
  journalBase: number
  readonly checkpoints: readonly Checkpoint[]
}

/** 从头应用全部事件并按间隔打检查点（setup 成本 = 全量回放，一次性）。
 *  runId 缺省用 events[0].runId；分支会话传派生 runId（§11.6 硬约束：
 *  分支图是独立实例且 runId 派生自主线）。 */
export function createReplaySession(
  events: readonly AgentEvent[],
  runId?: string,
): ReplaySession {
  const graph = createGraph(runId ?? events[0].runId)
  const journal = createJournal()
  let layout: Layout = { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
  const checkpoints: Checkpoint[] = []
  const dirty = new Set<SpanId>()
  for (let i = 0; i < events.length; i++) {
    applyEvent(graph, events[i], journal)
    dirty.clear()
    dirtyOf(events[i], dirty)
    layout = updateLayout(layout, graph, dirty)
    if ((i + 1) % CHECKPOINT_INTERVAL === 0 || i === events.length - 1) {
      checkpoints.push(makeCheckpoint(graph, layout, i + 1))
    }
  }
  return {
    events,
    runId: graph.runId,
    graph,
    layout,
    applied: events.length,
    journal,
    journalBase: 0,
    checkpoints,
  }
}

/** ≤ eventIndex 的最近检查点；无（target < 首个检查点）则返回 null */
function latestCheckpointAtOrBefore(
  checkpoints: readonly Checkpoint[],
  eventIndex: number,
): Checkpoint | null {
  let found: Checkpoint | null = null
  for (const cp of checkpoints) {
    if (cp.eventIndex > eventIndex) break
    found = cp
  }
  return found
}

/**
 * 从 checkpoint 深拷贝出发，图/布局/journal 同步正向重放到 target。
 * 大步前进与「回退越过 journalBase」共用此路径。无可用检查点时从零重放。
 */
function rebuildFromCheckpoint(session: ReplaySession, target: number): void {
  const cp = latestCheckpointAtOrBefore(session.checkpoints, target)
  const graph = cp !== null ? cloneGraph(cp.graph) : createGraph(session.runId)
  // checkpoint 深拷贝自带打点时的图 runId（主线 checkpoint = 主线 runId，
  // B4-1 陷阱：分支会话复用主线 checkpoint 时会静默换回主线 runId）。
  // 以 session.runId 归一——主线会话 no-op，分支会话修正元数据（裁决 11
  // 条 2 边界：构造路径内的一次性 runId 设置）
  graph.runId = session.runId
  let layout: Layout =
    cp !== null
      ? cloneLayout(cp.layout)
      : { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
  const journal = createJournal()
  const base = cp !== null ? cp.eventIndex : 0
  const dirty = new Set<SpanId>()
  for (let i = base; i < target; i++) {
    applyEvent(graph, session.events[i], journal)
    dirty.clear()
    dirtyOf(session.events[i], dirty)
    layout = updateLayout(layout, graph, dirty)
  }
  session.graph = graph
  session.layout = layout
  session.journal = journal
  session.journalBase = base
  session.applied = target
}

/**
 * 跳转到 target（双向）。回退走 invert（任何距离）；前进小步逐步、
 * 大步（> CHECKPOINT_INTERVAL）走 checkpoint 重建（见文件头的混合策略）。
 * 幂等：target === applied 时零成本。
 */
export function seekTo(session: ReplaySession, target: number): void {
  if (target < 0 || target > session.events.length) {
    throw new Error(`seekTo 目标越界: ${target}（事件流长度 ${session.events.length}）`)
  }
  if (target === session.applied) return

  if (target < session.applied) {
    // 回退到 journal 有效区之下：先经 checkpoint 重建到 target（重建后
    // journalBase = 某检查点 ≤ target，后续回退总在有效区内）
    if (target < session.journalBase) {
      rebuildFromCheckpoint(session, target)
      return
    }
    // invert 逐组回退（第一部分实现）：图原地还原，ops 同步 pop。
    // i 是全局事件索引，ops 是相对索引（journalBase 起）——B3 修复：
    // 原写 ops[i] 在 journalBase > 0 时全部越界，被 ?? [] 静默吞掉，
    // 图完全不回退而 applied 照常更新（时间轴显示 1900、图还是 1950）。
    // 不变量保证 i - journalBase ∈ [0, ops.length)：此处直接索引，越界
    // 即崩溃（§4.1：编程错误不得静默降级）。
    for (let i = session.applied - 1; i >= target; i--) {
      invert(session.graph, session.journal.ops[i - session.journalBase])
      session.journal.ops.pop()
    }
    // 布局不可逆：全量重建（权威语义；10k 实测 ~21ms）
    session.layout = layoutGraph(session.graph)
    session.applied = target
    return
  }

  // 前进：大步走 checkpoint 重建（重放 ≤ CHECKPOINT_INTERVAL 步），
  // 小步从当前图逐步应用（journal 继续记录，保持可回退性）
  if (target - session.applied > CHECKPOINT_INTERVAL) {
    rebuildFromCheckpoint(session, target)
    return
  }
  const dirty = new Set<SpanId>()
  for (let i = session.applied; i < target; i++) {
    applyEvent(session.graph, session.events[i], session.journal)
    dirty.clear()
    dirtyOf(session.events[i], dirty)
    session.layout = updateLayout(session.layout, session.graph, dirty)
  }
  session.applied = target
}

/** 回溯（卡面 API：只回退；target > applied 属调用错误） */
export function rollbackTo(session: ReplaySession, target: number): void {
  if (target > session.applied) {
    throw new Error(`rollbackTo 只回退: target ${target} > applied ${session.applied}`)
  }
  seekTo(session, target)
}
