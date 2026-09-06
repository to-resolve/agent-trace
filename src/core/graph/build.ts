// 事件流 → provenance 因果图的增量构建（docs/02 第 4、5 节）。
//
// 三条硬约束（T3 任务卡）：
// 1. applyEvent 是唯一写入口：edges / outgoing / incoming 三处冗余存储
//    只在私有函数 addEdge 内原子更新，其他任何函数不得触碰。
// 2. 事件顺序运行时容错：span.start 引用了尚不存在的实体时跳过，
//    该实体到达时经 consumersIndex 反查消费方补建因果边。
// 3. 每个事件只处理自己涉及的一个 span / entity（O(Δ)），禁止全量重建。
//
// 时间旅行（T9，§11.4）：applyEvent 接受可选 journal 参数——在每个写入点
// 之前记录逆操作（InverseOp）。journal 为 undefined 时零开销，既有调用点
// 行为完全不变。写入全部是替换/追加语义（§11.8 条 6，由冻结守卫测试
// 保护）——prev 存对象引用即可，零拷贝。run.snapshot 不记逆操作（裁决 9：
// 它是回溯下界，同一图实例生命周期内不会越过它回滚）。
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
import type { InverseOp, Journal } from '../timeline/journal'
import { consumersOf, invalidateConsumersIndex } from './consumers-index'

export function createGraph(runId: RunId): CausalGraph {
  const graph: CausalGraph = {
    runId,
    spans: new Map(),
    entities: new Map(),
    edges: [],
    outgoing: new Map(),
    incoming: new Map(),
  }
  // 索引不需要预置：consumersOf 未命中时惰性重建（build 不再持有 WeakMap，
  // 抽取见 consumers-index.ts——T9 审查 B1）
  return graph
}

/**
 * 当前事件的逆操作收集器：journal 存在时指向 ops 的最后一组（本次
 * applyEvent 开头 push 的空数组），写入点直接 push；不存在时为 null——
 * 每个写入点的记录调用都是「null 则什么都不做」的零开销形态。
 */
type Recorder = ((op: InverseOp) => void) | null

/** edges + outgoing + incoming 三处存储的唯一原子写入口（幂等） */
function addEdge(
  graph: CausalGraph,
  from: SpanId,
  to: SpanId,
  via: EntityId,
  record: Recorder,
): void {
  const existing = graph.outgoing.get(from)
  if (existing !== undefined && existing.some((e) => e.toSpanId === to && e.viaEntityId === via)) {
    return
  }
  const edge: CausalEdge = { fromSpanId: from, toSpanId: to, viaEntityId: via }
  if (record !== null) {
    // 逆操作：三处都是尾部追加 → 各自截断回当前长度
    record({ kind: 'edges.truncate', length: graph.edges.length })
    const out = graph.outgoing.get(from)
    if (out !== undefined) record({ kind: 'adj.truncate', table: 'outgoing', spanId: from, length: out.length })
    else record({ kind: 'adj.truncate', table: 'outgoing', spanId: from, length: 0 })
    const inc = graph.incoming.get(to)
    if (inc !== undefined) record({ kind: 'adj.truncate', table: 'incoming', spanId: to, length: inc.length })
    else record({ kind: 'adj.truncate', table: 'incoming', spanId: to, length: 0 })
  }
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

/**
 * 灌入一个 span（span.start 与 run.snapshot 共用）：
 * 入图后对每个 inputEntity 做因果边推导（02 第 4 节规则）。
 * 拷贝入图（替换式写入是 §11.8 条 6 硬约束，由冻结守卫测试保护）：
 * span.end 之后只替换图内副本，不污染已发给消费者的事件对象。
 */
function ingestSpan(graph: CausalGraph, span: Span, record: Recorder): void {
  if (record !== null) {
    const prev = graph.spans.get(span.id)
    record({ kind: 'span.set', spanId: span.id, prev: prev === undefined ? null : prev })
  }
  // 先登记消费、后入图：consumersOf 的惰性重建扫描 graph.spans，若当前
  // span 已入图会把它计入重建结果，随后的显式 push 变成双重登记
  // （B1 往返测试实测抓出）。顺序调换后重建不含当前 span，push 是
  // 唯一登记路径。边推导不依赖 span 是否已入图（只查 entities 与邻接表）。
  const spanCopy: Span = {
    ...span,
    inputEntityIds: [...span.inputEntityIds],
    outputEntityIds: [...span.outputEntityIds],
  }
  for (const entityId of span.inputEntityIds) {
    consumersOf(graph, entityId).push(span.id)
    const entity = graph.entities.get(entityId)
    if (entity === undefined) continue // 乱序：实体未到，待 entity.create 补边
    if (entity.producedBy === null) continue // 外部输入不产边（溯源链的根）
    if (entity.producedBy === span.id) continue // 自环跳过
    addEdge(graph, entity.producedBy, span.id, entityId, record)
  }
  graph.spans.set(span.id, spanCopy)
}

/** 灌入一个实体；若此前有 span 已引用它而它尚未到达，此处补建因果边 */
function ingestEntity(graph: CausalGraph, entity: DataEntity, record: Recorder): void {
  if (record !== null) {
    const prev = graph.entities.get(entity.id)
    record({ kind: 'entity.set', entityId: entity.id, prev: prev === undefined ? null : prev })
  }
  graph.entities.set(entity.id, { ...entity })
  if (entity.producedBy === null) return
  for (const consumerId of consumersOf(graph, entity.id)) {
    if (consumerId === entity.producedBy) continue // 自环跳过
    addEdge(graph, entity.producedBy, consumerId, entity.id, record)
  }
}

/**
 * 增量应用一个事件。只处理当前事件涉及的 span / entity，禁止全量重建；
 * 返回同一 graph 引用（调用方不需要重新绑定）。
 *
 * journal（§11.4，可选第三参数）：传入时为本次事件在 journal.ops 追加
 * 一组逆操作；undefined 时零开销（record 恒为 null，写入点零额外成本）。
 * 禁止为了记日志而改变任何既有写入语义。
 */
export function applyEvent(
  graph: CausalGraph,
  event: AgentEvent,
  journal?: Journal,
): CausalGraph {
  // 局部非空绑定（TS 闭包内不保持参数收窄）：journal 存在时为本次事件
  // 开一组逆操作；record 为 null 时写入点零额外成本
  const activeJournal = journal
  const record: Recorder =
    activeJournal !== undefined
      ? (op: InverseOp): void => {
          const group = activeJournal.ops[activeJournal.ops.length - 1]
          group.push(op)
        }
      : null
  if (activeJournal !== undefined) activeJournal.ops.push([])

  switch (event.type) {
    case 'run.start':
    case 'run.end':
      // 运行级事件不改变图结构（journal 里留空组，index 对齐事件流）
      return graph
    case 'span.start':
      ingestSpan(graph, event.span, record)
      return graph
    case 'span.end': {
      const span = graph.spans.get(event.spanId)
      if (span === undefined) return graph // 乱序容错：end 早于 start，静默跳过
      if (record !== null) {
        // 逆操作：把替换前的旧对象放回（替换式写入 ⟹ prev 引用安全）
        record({ kind: 'span.set', spanId: event.spanId, prev: span })
      }
      // 替换写入（裁决 8，§11.8 条 6）：不得 mutate 既有 span 对象——
      // 时间旅行的逆操作 prev 存对象引用，mutate 会让 prev 与图内同体，
      // 回滚静默错误。该不变量由 build.test.ts 的冻结守卫测试保护。
      graph.spans.set(event.spanId, {
        ...span,
        status: event.status,
        endedAt: event.endedAt,
        outputEntityIds: [...new Set([...span.outputEntityIds, ...event.outputEntityIds])],
        ...(event.error !== undefined ? { error: event.error } : {}),
      })
      return graph
    }
    case 'entity.create':
      ingestEntity(graph, event.entity, record)
      return graph
    case 'run.snapshot': {
      // 快照语义是全量重置（回放场景）。清空后按「先实体后 span」重放，
      // 与增量路径共用同一套 ingest / 边推导规则，保证规则单份维护。
      //
      // 不记逆操作（裁决 9，§11.8 条 7）：snapshot 是回溯下界，回溯永不
      // 越过它，逆操作无意义。本轮调用前 push 的空组保留（index 对齐）。
      //
      // runId 冲突显式拒绝（§11.8 条 8）：一个 CausalGraph 只对应一个
      // run，snapshot 携带不同 runId 属事件源错误，抛错而非静默覆盖
      // （与 §9「非法剧本直接抛错」同源原则）。抛错前撤销本次 push 的
      // 空组——否则 journal.ops 与事件流 index 错位（错位是静默的，
      // 会回滚到错误位置；T9 审查第一部分建议 1）。
      if (graph.runId !== event.runId) {
        if (record !== null) activeJournal?.ops.pop()
        throw new Error(
          `run.snapshot 的 runId (${event.runId}) 与图实例既有值 (${graph.runId}) 冲突——一个图只对应一个 run`,
        )
      }
      graph.spans.clear()
      graph.entities.clear()
      graph.edges.length = 0
      graph.outgoing.clear()
      graph.incoming.clear()
      // 图已全量重置，旧索引内容全部作废：整体失效（比逐条清理语义
      // 更直接——「失效 + 惰性重建」是缓存的正确语义，见 B1 修复）
      invalidateConsumersIndex(graph)
      for (const entity of event.entities) ingestEntity(graph, entity, record)
      for (const span of event.spans) ingestSpan(graph, span, record)
      return graph
    }
  }
}
