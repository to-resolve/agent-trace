// T4 布局验收测试：最长路径分层、增量坐标稳定性（本卡立身之本）、
// 环打破不死循环、version 语义、全量与增量两条路径的层级收敛。
import { describe, it, expect } from 'vitest'
import { resolveEvent } from '../source/scenario'
import { loadScenarioById } from '../source/registry'
import { mixedTopologyEvents } from '../source/synth'
import { applyEvent, createGraph } from './build'
import {
  LAYER_GAP,
  NODE_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutGraph,
  updateLayout,
} from './layout'
import type { AgentEvent, CausalGraph, DataEntity, Layout, Span, SpanId } from '../types'

const BASE = 1_700_000_000_000
const RUN = 'run-layout-test'
const X_STRIDE = NODE_WIDTH + LAYER_GAP
const Y_STRIDE = NODE_HEIGHT + NODE_GAP

/** 剧本经注册表加载（T6 修补 3）：测试不直接 import 剧本 JSON */
const staleContext = await loadScenarioById('stale-context')

function buildStaleContext(): CausalGraph {
  const graph = createGraph('run-stale-demo')
  let t = BASE
  for (const step of staleContext.steps) {
    t += step.delayMs
    applyEvent(graph, resolveEvent(step.event, BASE, t))
  }
  return graph
}

function makeSpan(id: string, inputEntityIds: string[], kind: Span['kind'] = 'llm'): Span {
  return {
    id,
    runId: RUN,
    parentId: null,
    agentId: `agent-${id}`,
    kind,
    name: id,
    status: 'ok',
    startedAt: 0,
    endedAt: 1,
    inputEntityIds,
    outputEntityIds: [],
    attributes: {},
  }
}

function makeEntity(id: string, producedBy: string | null, ageMs = 0): DataEntity {
  return {
    id,
    kind: 'context',
    label: id,
    producedBy,
    payload: null,
    time: { createdAt: BASE - ageMs, observedAt: BASE },
    source: 'test',
  }
}

function emptyLayout(): Layout {
  return { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
}

/**
 * 按事件流逐个 applyEvent 并按调用方约定做增量布局（模拟 T5 store 用法）：
 * span.start 标该 span 为 dirty；entity.create 标 producedBy 为 dirty。
 */
function buildIncrementally(): { graph: CausalGraph; layout: Layout; dirtyCount: number } {
  const graph = createGraph('run-stale-demo')
  let layout = emptyLayout()
  let dirtyCount = 0
  let t = BASE
  for (const step of staleContext.steps) {
    t += step.delayMs
    const event = resolveEvent(step.event, BASE, t)
    applyEvent(graph, event)
    const dirty = new Set<SpanId>()
    if (event.type === 'span.start') dirty.add(event.span.id)
    else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
      dirty.add(event.entity.producedBy)
    }
    if (dirty.size > 0) dirtyCount += 1
    layout = updateLayout(layout, graph, dirty)
  }
  return { graph, layout, dirtyCount }
}

describe('layoutGraph 全量布局', () => {
  it('关键测试：stale-context 层级 s-retrieve=0 / s-score=1 / s-decide=2', () => {
    const layout = layoutGraph(buildStaleContext())
    expect(layout.nodes.get('s-retrieve')?.layer).toBe(0)
    expect(layout.nodes.get('s-score')?.layer).toBe(1)
    expect(layout.nodes.get('s-decide')?.layer).toBe(2)
    // s-orchestrator 无因果边（无输入、无产出的消费），同为 0 层
    expect(layout.nodes.get('s-orchestrator')?.layer).toBe(0)
    // 自左向右：x = layer * (NODE_WIDTH + LAYER_GAP)
    expect(layout.nodes.get('s-retrieve')?.x).toBe(0)
    expect(layout.nodes.get('s-score')?.x).toBe(X_STRIDE)
    expect(layout.nodes.get('s-decide')?.x).toBe(2 * X_STRIDE)
  })

  it('节点尺寸用导出常量，同层相邻节点 y 间距 = NODE_HEIGHT + NODE_GAP', () => {
    const layout = layoutGraph(buildStaleContext())
    for (const node of layout.nodes.values()) {
      expect(node.width).toBe(NODE_WIDTH)
      expect(node.height).toBe(NODE_HEIGHT)
      expect(node.x).toBe(node.layer * X_STRIDE)
    }
    // 0 层内 s-orchestrator 在前、s-retrieve 在后（入图顺序），间距一个行距
    const orch = layout.nodes.get('s-orchestrator')
    const retrieve = layout.nodes.get('s-retrieve')
    if (orch === undefined || retrieve === undefined) throw new Error('缺少节点')
    expect(orch.y).toBe(0)
    expect(retrieve.y - orch.y).toBe(Y_STRIDE)
  })

  it('边几何：起点=源右缘中点，终点=目标左缘中点，state 为 normal', () => {
    const layout = layoutGraph(buildStaleContext())
    expect(layout.edges).toHaveLength(2)
    const retrieve = layout.nodes.get('s-retrieve')
    const score = layout.nodes.get('s-score')
    if (retrieve === undefined || score === undefined) throw new Error('缺少节点')
    const edge = layout.edges.find((e) => e.viaEntityId === 'e-resume-v1')
    if (edge === undefined) throw new Error('缺少 e-resume-v1 对应的边')
    expect(edge.from).toEqual({ x: retrieve.x + NODE_WIDTH, y: retrieve.y + NODE_HEIGHT / 2 })
    expect(edge.to).toEqual({ x: score.x, y: score.y + NODE_HEIGHT / 2 })
    expect(edge.state).toBe('normal')
  })

  it('bounds 恰好覆盖全部节点范围', () => {
    const layout = layoutGraph(buildStaleContext())
    let width = 0
    let height = 0
    for (const node of layout.nodes.values()) {
      width = Math.max(width, node.x + node.width)
      height = Math.max(height, node.y + node.height)
    }
    expect(layout.bounds).toEqual({ width, height })
  })

  it('空图：无节点无边界，version 从 1 起', () => {
    const layout = layoutGraph(createGraph(RUN))
    expect(layout.nodes.size).toBe(0)
    expect(layout.edges).toHaveLength(0)
    expect(layout.bounds).toEqual({ width: 0, height: 0 })
    expect(layout.version).toBe(1)
  })

  it('重心法：层内顺序跟随上游位置（初始顺序错误时被纠正）', () => {
    // 两条独立链 s-a→s-b、s-c→s-d；入图顺序让 d 先于 b（初始顺序错）。
    // 重心下扫后 b（上游 a 在上层序 0）应排在 d（上游 c 序 1）之前。
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-a', 's-a') })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-c', 's-c') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', []) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-c', []) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-d', ['e-c']) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e-a']) })
    const layout = layoutGraph(graph)
    const b = layout.nodes.get('s-b')
    const d = layout.nodes.get('s-d')
    if (b === undefined || d === undefined) throw new Error('缺少节点')
    expect(b.layer).toBe(1)
    expect(d.layer).toBe(1)
    expect(b.y).toBeLessThan(d.y)
  })
})

describe('updateLayout 增量', () => {
  it('关键测试：追加新 span 后，未受影响节点的 (x, y) 逐个保持不变', () => {
    const graph = buildStaleContext()
    const before = layoutGraph(graph)
    // 追加 s-notify：消费 e-decision（s-decide 的产出）→ 第 3 层
    applyEvent(graph, {
      type: 'span.start',
      runId: 'run-stale-demo',
      span: makeSpan('s-notify', ['e-decision'], 'tool'),
    })
    const after = updateLayout(before, graph, new Set<SpanId>(['s-notify']))
    for (const id of ['s-orchestrator', 's-retrieve', 's-score', 's-decide']) {
      const oldNode = before.nodes.get(id)
      const newNode = after.nodes.get(id)
      if (oldNode === undefined || newNode === undefined) throw new Error(`缺少节点 ${id}`)
      expect(newNode.x).toBe(oldNode.x)
      expect(newNode.y).toBe(oldNode.y)
      expect(newNode.layer).toBe(oldNode.layer)
    }
    const notify = after.nodes.get('s-notify')
    if (notify === undefined) throw new Error('缺少 s-notify')
    expect(notify.layer).toBe(3)
    expect(notify.x).toBe(3 * X_STRIDE)
    // 新增的因果边也出现在布局里
    expect(after.edges).toHaveLength(3)
  })

  it('同层追加：新节点排在同层固定节点下方，同层所有 y 互不重叠', () => {
    const graph = buildStaleContext()
    const before = layoutGraph(graph)
    // s-retrieve-2 不消费任何实体 → 0 层；该层已有 s-orchestrator / s-retrieve
    applyEvent(graph, {
      type: 'span.start',
      runId: 'run-stale-demo',
      span: makeSpan('s-retrieve-2', [], 'retrieval'),
    })
    const after = updateLayout(before, graph, new Set<SpanId>(['s-retrieve-2']))
    const added = after.nodes.get('s-retrieve-2')
    const retrieve = after.nodes.get('s-retrieve')
    if (added === undefined || retrieve === undefined) throw new Error('缺少节点')
    expect(added.layer).toBe(0)
    expect(added.y).toBeGreaterThan(retrieve.y)
    const ys = [...after.nodes.values()].filter((n) => n.layer === 0).map((n) => n.y)
    expect(new Set(ys).size).toBe(ys.length)
  })

  it('version：无变更返回原对象（不自增），有变更时 +1', () => {
    const graph = buildStaleContext()
    const layout = layoutGraph(graph)
    const unchanged = updateLayout(layout, graph, new Set<SpanId>())
    expect(unchanged).toBe(layout)
    applyEvent(graph, {
      type: 'span.start',
      runId: 'run-stale-demo',
      span: makeSpan('s-notify', ['e-decision'], 'tool'),
    })
    const changed = updateLayout(layout, graph, new Set<SpanId>(['s-notify']))
    expect(changed.version).toBe(layout.version + 1)
  })

  it('未标 dirty 的新 span 被自动并入受影响集合（防御漏标）', () => {
    const graph = buildStaleContext()
    const before = layoutGraph(graph)
    applyEvent(graph, {
      type: 'span.start',
      runId: 'run-stale-demo',
      span: makeSpan('s-notify', ['e-decision'], 'tool'),
    })
    const after = updateLayout(before, graph, new Set<SpanId>())
    expect(after.nodes.get('s-notify')?.layer).toBe(3)
    expect(after.version).toBe(before.version + 1)
  })

  it('从空布局随事件流逐步生长：节点齐、边齐、version 随每次 dirty 调用 +1', () => {
    const { layout, dirtyCount } = buildIncrementally()
    expect(layout.nodes.size).toBe(4)
    expect(layout.edges).toHaveLength(2)
    expect(layout.version).toBe(dirtyCount)
  })

  it('关键测试：layoutGraph 与连续 updateLayout 的最终层级一致（两条路径收敛）', () => {
    const { graph, layout } = buildIncrementally()
    const full = layoutGraph(graph)
    expect(layout.nodes.size).toBe(full.nodes.size)
    for (const [id, node] of full.nodes) {
      const incremental = layout.nodes.get(id)
      if (incremental === undefined) throw new Error(`增量布局缺少节点 ${id}`)
      expect(incremental.layer).toBe(node.layer)
    }
  })
})

describe('环与悬空边', () => {
  it('关键测试：含环的图分层不死循环，环上节点被分配到有限层', () => {
    // s-a 先引用尚不存在的 e2；e1 由 s-a 产出被 s-b 消费；e2 的 producedBy
    // 是 s-b → 边 s-a→s-b 与 s-b→s-a 构成环
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e2']) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e1']) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e2', 's-b') })
    // 若环未被打破，这一步会栈溢出或超时
    const layout = layoutGraph(graph)
    const a = layout.nodes.get('s-a')
    const b = layout.nodes.get('s-b')
    if (a === undefined || b === undefined) throw new Error('缺少节点')
    expect(Number.isFinite(a.layer)).toBe(true)
    expect(Number.isFinite(b.layer)).toBe(true)
    expect(a.layer).toBeGreaterThanOrEqual(0)
    expect(b.layer).toBeGreaterThanOrEqual(0)
    // 两节点环只留一条约束边，层号为 0 与 1（有限且确定）
    expect(Math.max(a.layer, b.layer)).toBe(1)
    // 回边只是不参与层级约束，仍会渲染
    expect(layout.edges).toHaveLength(2)
  })

  it('悬空边（producedBy 指向从未 start 的 span）不参与约束也不渲染', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-ghost', 's-ghost') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-x', ['e-ghost']) })
    const layout = layoutGraph(graph)
    const x = layout.nodes.get('s-x')
    if (x === undefined) throw new Error('缺少节点')
    expect(x.layer).toBe(0)
    expect(layout.edges).toHaveLength(0)
    // 增量路径同样成立：悬空边不参与层级约束（增量重心的守卫分支）
    const incremental = updateLayout(emptyLayout(), graph, new Set<SpanId>(['s-x']))
    expect(incremental.nodes.get('s-x')?.layer).toBe(0)
    expect(incremental.edges).toHaveLength(0)
  })

  it('增量路径下的环：updateLayout 分层不死循环且层级有限', () => {
    // 与全量用例同一个环（s-a → s-b → s-a），但按事件流增量生长。
    // 补边（第 4 步 e2 到达）会把整条环收进受影响集合，环内分层仍有限。
    const graph = createGraph(RUN)
    const events: AgentEvent[] = [
      { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e2']) },
      { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') },
      { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e1']) },
      { type: 'entity.create', runId: RUN, entity: makeEntity('e2', 's-b') },
    ]
    let layout = emptyLayout()
    for (const event of events) {
      applyEvent(graph, event)
      const dirty = new Set<SpanId>()
      if (event.type === 'span.start') dirty.add(event.span.id)
      else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
        dirty.add(event.entity.producedBy)
      }
      layout = updateLayout(layout, graph, dirty)
    }
    const a = layout.nodes.get('s-a')
    const b = layout.nodes.get('s-b')
    if (a === undefined || b === undefined) throw new Error('缺少节点')
    expect(Number.isFinite(a.layer)).toBe(true)
    expect(Number.isFinite(b.layer)).toBe(true)
    expect(Math.max(a.layer, b.layer)).toBe(1)
    expect(layout.edges).toHaveLength(2)
  })

  it('防御路径：prev 中已不在图里的节点被剔除且 version 自增', () => {
    // run.snapshot 清场后误用增量（正确用法是 layoutGraph 全量重建）：
    // 图已空，prev 的全部节点视为已消失，结果应为空布局且版本前进
    const graph = buildStaleContext()
    const before = layoutGraph(graph)
    const after = updateLayout(before, createGraph('run-stale-demo'), new Set<SpanId>())
    expect(after.nodes.size).toBe(0)
    expect(after.edges).toHaveLength(0)
    expect(after.version).toBe(before.version + 1)
  })
})

describe('T8-B2 · 边级增量正确性（T7 审查阻塞项，干净 synth 数据）', () => {
  /** synth 混合拓扑的增量回放（与 traceStore.onEvent 同约定） */
  function replayMixed(chainSpans: number, fanoutEvery: number, fanoutWidth: number) {
    const events = mixedTopologyEvents(chainSpans, fanoutEvery, fanoutWidth)
    const graph = createGraph(events[0].runId)
    let layout: Layout = { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
    for (const event of events) {
      const dirty = new Set<SpanId>()
      if (event.type === 'span.start') {
        dirty.add(event.span.id)
      } else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
        dirty.add(event.entity.producedBy)
      }
      applyEvent(graph, event)
      layout = updateLayout(layout, graph, dirty)
    }
    return { graph, layout }
  }

  it('关键测试：未受影响的边对象原样复用（引用相等），受影响的边重建后几何正确', () => {
    // 满图后做一个只污染链尾局部的 dirty：链尾 s-(N-1) 沿出边无下游（它是
    // 链终点），扇出分叉叶也不是它的下游 → affected = {s-(N-1)}，其余
    // 9.9k+ 边全部不受影响
    const N = 200
    const { graph, layout } = replayMixed(N, 10, 3)
    expect(layout.edges.length).toBeGreaterThan(100)

    const before = [...layout.edges]
    const tail: SpanId = `s-${N - 1}`
    // 链尾的入边（s-(N-2) → s-(N-1)）是受影响边，其余应引用复用
    const affectedEdgeKey = (from: string, to: string, via: string) => `${from}|${to}|${via}`
    const tailIncomingKey = affectedEdgeKey(`s-${N - 2}`, tail, `e-${N - 2}`)

    const after = updateLayout(layout, graph, new Set<SpanId>([tail]))

    // 复用断言：除链尾入边外，每个 LayoutEdge 对象与更新前引用相等（toBe）
    const afterByKey = new Map(after.edges.map((e) => [affectedEdgeKey(e.fromSpanId, e.toSpanId, e.viaEntityId), e]))
    let reused = 0
    for (const edge of before) {
      const key = affectedEdgeKey(edge.fromSpanId, edge.toSpanId, edge.viaEntityId)
      if (key === tailIncomingKey) continue
      expect(afterByKey.get(key)).toBe(edge) // 引用相等：对象原样复用，零重建
      reused += 1
    }
    expect(reused).toBe(before.length - 1)

    // 重建断言：链尾入边几何随新坐标正确重算（from = 源节点右缘中点）
    const rebuilt = afterByKey.get(tailIncomingKey)
    expect(rebuilt).toBeDefined()
    expect(rebuilt).not.toBe(before.find((e) => affectedEdgeKey(e.fromSpanId, e.toSpanId, e.viaEntityId) === tailIncomingKey))
    const fromNode = after.nodes.get(`s-${N - 2}`)
    const toNode = after.nodes.get(tail)
    expect(fromNode).toBeDefined()
    expect(toNode).toBeDefined()
    if (rebuilt !== undefined && fromNode !== undefined && toNode !== undefined) {
      expect(rebuilt.from.x).toBe(fromNode.x + fromNode.width)
      expect(rebuilt.from.y).toBe(fromNode.y + fromNode.height / 2)
      expect(rebuilt.to.x).toBe(toNode.x)
      expect(rebuilt.to.y).toBe(toNode.y + toNode.height / 2)
    }
  })

  it('关键测试：10k 规模回放后 layout.edges 与 graph.edges 按 (from, to, via) 三元组双向无差', () => {
    // 10007 spans / 10006 edges（synth 生成器确定性：同参数必产同流）
    const { graph, layout } = replayMixed(7_700, 10, 3)
    expect(graph.spans.size).toBe(10_007)
    expect(graph.edges.length).toBe(10_006)

    const key = (from: string, to: string, via: string) => `${from}|${to}|${via}`
    const graphKeys = new Set(graph.edges.map((e) => key(e.fromSpanId, e.toSpanId, e.viaEntityId)))
    const layoutKeys = new Set(layout.edges.map((e) => key(e.fromSpanId, e.toSpanId, e.viaEntityId)))
    expect(layoutKeys.size).toBe(layout.edges.length) // 无重复（三元组唯一性）
    expect(graphKeys.size).toBe(graph.edges.length)

    const missingInLayout = [...graphKeys].filter((k) => !layoutKeys.has(k))
    const extraInLayout = [...layoutKeys].filter((k) => !graphKeys.has(k))
    expect(missingInLayout).toEqual([])
    expect(extraInLayout).toEqual([])
    expect(layout.edges.length).toBe(graph.edges.length)

    // 复用与重建的并集完备性在计数维度复核：每条 layout 边的几何端点
    // 都指向真实节点（不存在悬空引用）
    for (const edge of layout.edges) {
      expect(layout.nodes.has(edge.fromSpanId)).toBe(true)
      expect(layout.nodes.has(edge.toSpanId)).toBe(true)
    }
  })
})
