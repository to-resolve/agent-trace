// 因果图双向溯源与新鲜度查询（docs/02 第 6 节）。
//
// 性能约定：溯源查询走 outgoing / incoming 索引，复杂度 O(邻接边)
// 而非 O(全图)；这是 02 第 5 节两张索引表存在的意义。
// 阈值语义（T3 硬约束 3）：新鲜度阈值是查询参数，不是图的属性；
// Freshness.thresholdMs 仅回记录本次判定所用阈值，供 UI 展示。
import type {
  CausalEdge,
  CausalGraph,
  DataEntity,
  EntityId,
  Freshness,
  Span,
  SpanId,
} from '../types'
import { AGING_RATIO } from '../types'

export interface TraversalResult {
  spanIds: Set<SpanId>
  entityIds: Set<EntityId>
  edges: CausalEdge[]
  /** 是否遇到环（用于 UI 提示） */
  hasCycle: boolean
}

type Direction = 'up' | 'down'

/**
 * DFS 双向遍历。环安全的关键是两个集合分工：
 * - onPath：当前 DFS 路径上的节点，再次到达即回边 → 判定环
 * - visited：已完成的节点，再次到达只是菱形汇合（如 A→B→D、A→C→D），不是环
 *
 * entityIds 的收集口径（02 §6，T3 审查必修项 B1）：
 * 被访问 span 自身的 inputEntityIds ∪ 边上的 viaEntityId。
 * 自身输入这一项不能省——producedBy === null 的实体（用户输入、
 * 外部下发的规则）按 02 §4 不产生因果边，只靠边收集会把
 * 「决策直接消费了一份过期外部材料」整个漏掉。
 *
 * 实现为显式栈迭代（T7 压测裁决：10k 深链上递归版爆栈——RangeError
 * Maximum call stack size exceeded，7700 深的混合拓扑链尾即爆）。
 * 栈帧保存「当前处理到第几条邻接边」，语义与递归版逐点一致：
 * 前序访问、edges 按进入顺序收集、onPath 命中设 hasCycle 但当条边照常入集。
 */
function traverse(
  graph: CausalGraph,
  startId: SpanId,
  direction: Direction,
): TraversalResult {
  const spanIds = new Set<SpanId>()
  const entityIds = new Set<EntityId>()
  const edges: CausalEdge[] = []
  const visited = new Set<SpanId>()
  const onPath = new Set<SpanId>()
  let hasCycle = false

  /**
   * 进入一个节点（对应递归版 visit 的头部）：
   * 环命中 → 置 hasCycle；已访问 → 菱形汇合直接弹回；否则标记并收集
   * 自身输入实体。返回「是否需要为其建立栈帧」。
   */
  const enter = (id: SpanId): boolean => {
    if (onPath.has(id)) {
      hasCycle = true
      return false
    }
    if (visited.has(id)) return false
    visited.add(id)
    onPath.add(id)
    spanIds.add(id)
    const span = graph.spans.get(id)
    if (span !== undefined) {
      for (const entityId of span.inputEntityIds) entityIds.add(entityId)
    }
    return true
  }

  interface Frame {
    id: SpanId
    edgeIndex: number
  }
  const stack: Frame[] = []
  if (enter(startId)) {
    stack.push({ id: startId, edgeIndex: 0 })
  }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) break
    const adjacency =
      direction === 'up' ? graph.incoming.get(frame.id) : graph.outgoing.get(frame.id)
    if (adjacency === undefined || frame.edgeIndex >= adjacency.length) {
      // 该节点的邻接边全部处理完（对应递归版函数返回前的 onPath.delete）
      onPath.delete(frame.id)
      stack.pop()
      continue
    }
    const edge = adjacency[frame.edgeIndex]
    frame.edgeIndex += 1
    edges.push(edge)
    entityIds.add(edge.viaEntityId)
    const next = direction === 'up' ? edge.fromSpanId : edge.toSpanId
    if (enter(next)) {
      stack.push({ id: next, edgeIndex: 0 })
    }
  }
  return { spanIds, entityIds, edges, hasCycle }
}

/** 反向溯源：这个 span 的决策，被哪些上游影响（递归到根） */
export function traceUpstream(graph: CausalGraph, spanId: SpanId): TraversalResult {
  return traverse(graph, spanId, 'up')
}

/** 正向传播：这个 span 影响了哪些下游 */
export function traceDownstream(graph: CausalGraph, spanId: SpanId): TraversalResult {
  return traverse(graph, spanId, 'down')
}

/**
 * 由实体的双时间推导新鲜度。判定式见 02 §3（唯一权威定义）：
 * - ageMs ≥ thresholdMs                       → stale（过期）
 * - thresholdMs * AGING_RATIO ≤ ageMs < 阈值   → aging（临近过期预警）
 * - ageMs < thresholdMs * AGING_RATIO          → fresh
 */
export function computeFreshness(entity: DataEntity, thresholdMs: number): Freshness {
  const ageMs = entity.time.observedAt - entity.time.createdAt
  const status =
    ageMs >= thresholdMs ? 'stale' : ageMs >= thresholdMs * AGING_RATIO ? 'aging' : 'fresh'
  return { ageMs, status, thresholdMs }
}

/** 找出所有新鲜度不达标的实体 —— 「过期上下文」剧本的判定基础 */
export function findStaleEntities(
  graph: CausalGraph,
  thresholdMs: number,
): DataEntity[] {
  const stale: DataEntity[] = []
  for (const entity of graph.entities.values()) {
    if (computeFreshness(entity, thresholdMs).status === 'stale') {
      stale.push(entity)
    }
  }
  return stale
}

/** 跨 span 聚合：哪些决策受到了超过阈值的过期数据影响（Phase 1 核心卖点） */
export function findStaleInfluencedDecisions(
  graph: CausalGraph,
  thresholdMs: number,
): Array<{ span: Span; viaEntities: DataEntity[] }> {
  const result: Array<{ span: Span; viaEntities: DataEntity[] }> = []
  for (const span of graph.spans.values()) {
    if (span.kind !== 'decision') continue
    const upstream = traceUpstream(graph, span.id)
    const viaEntities: DataEntity[] = []
    for (const entityId of upstream.entityIds) {
      const entity = graph.entities.get(entityId)
      if (entity !== undefined && computeFreshness(entity, thresholdMs).status === 'stale') {
        viaEntities.push(entity)
      }
    }
    if (viaEntities.length > 0) {
      result.push({ span, viaEntities })
    }
  }
  return result
}
