// 事件流 → provenance 因果图的增量构建（docs/02 第 4、5 节）。
//
// 三条硬约束（T3 任务卡）：
// 1. applyEvent 是唯一写入口：edges / outgoing / incoming 三处冗余存储
//    只在私有函数 addEdge 内原子更新，其他任何函数不得触碰。
// 2. 事件顺序运行时容错：span.start 引用了尚不存在的实体时跳过，
//    该实体到达时经 consumersIndex 反查消费方补建因果边。
// 3. 每个事件只处理自己涉及的一个 span / entity（O(Δ)），禁止全量重建。
import type {
  AgentEvent,
  CausalEdge,
  CausalGraph,
  DataEntity,
  EntityId,
  RunId,
  Span,
  SpanId,
} from '../types'

/**
 * 乱序容错的旁路索引：实体 id → 已把它记入 inputEntityIds 的 span 列表。
 * 不放进 CausalGraph（那是 02 的固定契约），用 WeakMap 挂在图实例上，
 * 图被丢弃时索引随之可回收。
 *
 * 索引只是纯缓存：内容完全可从 graph.spans 推导（T3 审查必修项 B2）。
 * 未命中时扫描 spans 重建——绝不能返回空列表，否则 createGraph 之外
 * 构造的图（Phase 1 ReplaySource 反序列化）会静默丢失补边。
 */
const consumersIndex = new WeakMap<CausalGraph, Map<EntityId, SpanId[]>>()

export function createGraph(runId: RunId): CausalGraph {
  const graph: CausalGraph = {
    runId,
    spans: new Map(),
    entities: new Map(),
    edges: [],
    outgoing: new Map(),
    incoming: new Map(),
  }
  consumersIndex.set(graph, new Map())
  return graph
}

/** edges + outgoing + incoming 三处存储的唯一原子写入口（幂等） */
function addEdge(
  graph: CausalGraph,
  from: SpanId,
  to: SpanId,
  via: EntityId,
): void {
  const existing = graph.outgoing.get(from)
  if (existing !== undefined && existing.some((e) => e.toSpanId === to && e.viaEntityId === via)) {
    return
  }
  const edge: CausalEdge = { fromSpanId: from, toSpanId: to, viaEntityId: via }
  graph.edges.push(edge)
  let out = graph.outgoing.get(from)
  if (out === undefined) {
    out = []
    graph.outgoing.set(from, out)
  }
  out.push(edge)
  let inc = graph.incoming.get(to)
  if (inc === undefined) {
    inc = []
    graph.incoming.set(to, inc)
  }
  inc.push(edge)
}

function consumersOf(graph: CausalGraph, entityId: EntityId): SpanId[] {
  let index = consumersIndex.get(graph)
  if (index === undefined) {
    // 缓存未命中（图不是 createGraph 构造的，如反序列化结果）：
    // 扫描 spans 重建完整索引后再查。重建让索引退化为纯缓存，
    // 无论图从哪来，补边行为都正确。
    index = new Map()
    for (const span of graph.spans.values()) {
      for (const inputId of span.inputEntityIds) {
        let list = index.get(inputId)
        if (list === undefined) {
          list = []
          index.set(inputId, list)
        }
        list.push(span.id)
      }
    }
    consumersIndex.set(graph, index)
  }
  let list = index.get(entityId)
  if (list === undefined) {
    list = []
    index.set(entityId, list)
  }
  return list
}

/**
 * 灌入一个 span（span.start 与 run.snapshot 共用）：
 * 入图后对每个 inputEntity 做因果边推导（02 第 4 节规则）。
 */
function ingestSpan(graph: CausalGraph, span: Span): void {
  // 拷贝入图：span.end 之后只会更新图内副本，不污染已发给消费者的事件对象
  graph.spans.set(span.id, {
    ...span,
    inputEntityIds: [...span.inputEntityIds],
    outputEntityIds: [...span.outputEntityIds],
  })
  for (const entityId of span.inputEntityIds) {
    consumersOf(graph, entityId).push(span.id)
    const entity = graph.entities.get(entityId)
    if (entity === undefined) continue // 乱序：实体未到，待 entity.create 补边
    if (entity.producedBy === null) continue // 外部输入不产边（溯源链的根）
    if (entity.producedBy === span.id) continue // 自环跳过
    addEdge(graph, entity.producedBy, span.id, entityId)
  }
}

/** 灌入一个实体；若此前有 span 已引用它而它尚未到达，此处补建因果边 */
function ingestEntity(graph: CausalGraph, entity: DataEntity): void {
  graph.entities.set(entity.id, { ...entity })
  if (entity.producedBy === null) return
  for (const consumerId of consumersOf(graph, entity.id)) {
    if (consumerId === entity.producedBy) continue // 自环跳过
    addEdge(graph, entity.producedBy, consumerId, entity.id)
  }
}

/**
 * 增量应用一个事件。只处理当前事件涉及的 span / entity，禁止全量重建；
 * 返回同一 graph 引用（调用方不需要重新绑定）。
 */
export function applyEvent(graph: CausalGraph, event: AgentEvent): CausalGraph {
  switch (event.type) {
    case 'run.start':
    case 'run.end':
      // 运行级事件不改变图结构
      return graph
    case 'span.start':
      ingestSpan(graph, event.span)
      return graph
    case 'span.end': {
      const span = graph.spans.get(event.spanId)
      if (span === undefined) return graph // 乱序容错：end 早于 start，静默跳过
      span.status = event.status
      span.endedAt = event.endedAt
      span.outputEntityIds = [...new Set([...span.outputEntityIds, ...event.outputEntityIds])]
      if (event.error !== undefined) span.error = event.error
      return graph
    }
    case 'entity.create':
      ingestEntity(graph, event.entity)
      return graph
    case 'run.snapshot': {
      // 快照语义是全量重置（回放场景）。清空后按「先实体后 span」重放，
      // 与增量路径共用同一套 ingest / 边推导规则，保证规则单份维护。
      graph.runId = event.runId
      graph.spans.clear()
      graph.entities.clear()
      graph.edges.length = 0
      graph.outgoing.clear()
      graph.incoming.clear()
      consumersIndex.get(graph)?.clear()
      for (const entity of event.entities) ingestEntity(graph, entity)
      for (const span of event.spans) ingestSpan(graph, span)
      return graph
    }
  }
}
