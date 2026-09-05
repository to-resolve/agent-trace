// T3 build 验收测试：因果边推导规则（02 第 4 节）、乱序补边、
// 三处存储一致性、span.end 合并、run.snapshot 重置、增量性（引用稳定）。
import { describe, it, expect, vi } from 'vitest'
import { resolveEvent } from '../source/scenario'
import { loadScenarioById } from '../source/registry'
import { SimulatedSource } from '../source/simulated'
import type { EventHandlers } from '../source/types'
import { applyEvent, createGraph } from './build'
import type { AgentEvent, CausalGraph, DataEntity, Span } from '../types'

const BASE = 1_700_000_000_000
const RUN = 'run-test'

/** 剧本经注册表加载（T6 修补 3）：测试不直接 import 剧本 JSON */
const staleContext = await loadScenarioById('stale-context')

/** 不经过 timer，直接逐 step 换算并应用（确定性，无 fake clock） */
function buildStaleContext(): CausalGraph {
  const graph = createGraph('run-stale-demo')
  let t = BASE
  for (const step of staleContext.steps) {
    t += step.delayMs
    applyEvent(graph, resolveEvent(step.event, BASE, t))
  }
  return graph
}

// —— 测试事件工厂 ——

function makeSpan(id: string, inputEntityIds: string[], kind: Span['kind'] = 'llm'): Span {
  return {
    id,
    runId: RUN,
    parentId: null,
    agentId: `agent-${id}`,
    kind,
    name: id,
    status: 'running',
    startedAt: 0,
    endedAt: null,
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

describe('stale-context 剧本全量构建', () => {
  it('spans / entities 数量正确，因果边恰好两条且三处存储一致', () => {
    const graph = buildStaleContext()
    expect(graph.spans.size).toBe(4)
    expect(graph.entities.size).toBe(5)
    // 04 第 3 节约定的因果链：s-retrieve --(e-resume-v1)--> s-score --(e-score)--> s-decide
    expect(graph.edges).toEqual([
      { fromSpanId: 's-retrieve', toSpanId: 's-score', viaEntityId: 'e-resume-v1' },
      { fromSpanId: 's-score', toSpanId: 's-decide', viaEntityId: 'e-score' },
    ])
    // 三处冗余存储一致性：边总数 = 索引条目总数
    const outCount = [...graph.outgoing.values()].reduce((n, list) => n + list.length, 0)
    const inCount = [...graph.incoming.values()].reduce((n, list) => n + list.length, 0)
    expect(outCount).toBe(graph.edges.length)
    expect(inCount).toBe(graph.edges.length)
    expect(graph.outgoing.get('s-retrieve')).toHaveLength(1)
    expect(graph.incoming.get('s-decide')).toHaveLength(1)
  })

  it('producedBy === null 的实体（e-query / e-policy）不产生任何因果边', () => {
    const graph = buildStaleContext()
    const viaIds = graph.edges.map((e) => e.viaEntityId)
    expect(viaIds).not.toContain('e-query')
    expect(viaIds).not.toContain('e-policy')
  })

  it('span.end 已合并进图内 span（status / endedAt / outputEntityIds）', () => {
    const graph = buildStaleContext()
    const retrieve = graph.spans.get('s-retrieve')
    expect(retrieve?.status).toBe('ok')
    expect(retrieve?.endedAt).toBe(BASE + 900)
    expect(retrieve?.outputEntityIds).toEqual(['e-resume-v1'])
  })

  it('端到端：SimulatedSource 吐出的事件流逐个 applyEvent 后图结构一致', () => {
    vi.useFakeTimers()
    try {
      const source = new SimulatedSource([staleContext])
      const events: AgentEvent[] = []
      const handlers: EventHandlers = {
        onEvent: (e) => events.push(e),
        onError: (err) => {
          throw err
        },
        onDone: () => {},
      }
      source.start('stale-context', handlers)
      vi.advanceTimersByTime(10_000)

      const graph = createGraph('run-stale-demo')
      for (const event of events) applyEvent(graph, event)
      expect(graph.spans.size).toBe(4)
      expect(graph.entities.size).toBe(5)
      expect(graph.edges).toEqual([
        { fromSpanId: 's-retrieve', toSpanId: 's-score', viaEntityId: 'e-resume-v1' },
        { fromSpanId: 's-score', toSpanId: 's-decide', viaEntityId: 'e-score' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('因果边推导规则（02 第 4 节）', () => {
  it('常规顺序：span.start 引用已存在实体 → 立即建边', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e1']) })
    expect(graph.edges).toEqual([
      { fromSpanId: 's-a', toSpanId: 's-b', viaEntityId: 'e1' },
    ])
  })

  it('乱序容错：引用不存在的实体不抛错，实体到达时补建因果边', () => {
    const graph = createGraph(RUN)
    // 实体未到：跳过，不抛错
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-x', ['e-late']) })
    expect(graph.edges).toHaveLength(0)
    // 实体到达：补建边
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-late', 's-y') })
    expect(graph.edges).toEqual([
      { fromSpanId: 's-y', toSpanId: 's-x', viaEntityId: 'e-late' },
    ])
    expect(graph.outgoing.get('s-y')).toHaveLength(1)
    expect(graph.incoming.get('s-x')).toHaveLength(1)
  })

  it('自环跳过：producedBy === 消费 span 自身时不建边（两种到达顺序均成立）', () => {
    // 顺序一：先实体后 span（span.start 路径的自环检查）
    const g1 = createGraph(RUN)
    applyEvent(g1, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') })
    applyEvent(g1, { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e1']) })
    expect(g1.edges).toHaveLength(0)
    // 顺序二：先 span 后实体（entity.create 补边路径的自环检查）
    const g2 = createGraph(RUN)
    applyEvent(g2, { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e1']) })
    applyEvent(g2, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') })
    expect(g2.edges).toHaveLength(0)
  })

  it('同一实体被两个 span 消费时建两条边（多消费者）', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e1']) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-c', ['e1']) })
    expect(graph.edges).toHaveLength(2)
    expect(graph.outgoing.get('s-a')).toHaveLength(2)
  })

  it('乱序 span.end（span 不存在）不抛错', () => {
    const graph = createGraph(RUN)
    expect(() =>
      applyEvent(graph, {
        type: 'span.end',
        runId: RUN,
        spanId: 's-ghost',
        endedAt: 1,
        status: 'ok',
        outputEntityIds: [],
      }),
    ).not.toThrow()
  })

  it('T3b 修补 2：非 createGraph 构造的图（反序列化场景）缓存未命中时重建索引、补边正确', () => {
    // 模拟 Phase 1 ReplaySource 的反序列化：图容器不是 createGraph 出品，
    // 但 spans 里已有内容（含对 e-late 的引用），WeakMap 索引为空。
    // 修补前：consumersOf 降级返回空列表 → 静默不补边；修补后：扫描 spans 重建。
    const existingSpan = makeSpan('s-x', ['e-late'])
    const foreign: CausalGraph = {
      runId: RUN,
      spans: new Map([[existingSpan.id, existingSpan]]),
      entities: new Map(),
      edges: [],
      outgoing: new Map(),
      incoming: new Map(),
    }
    applyEvent(foreign, { type: 'entity.create', runId: RUN, entity: makeEntity('e-late', 's-y') })
    expect(foreign.edges).toEqual([
      { fromSpanId: 's-y', toSpanId: 's-x', viaEntityId: 'e-late' },
    ])
    expect(foreign.outgoing.get('s-y')).toHaveLength(1)
    expect(foreign.incoming.get('s-x')).toHaveLength(1)
  })
})

describe('增量性（O(Δ)，禁止全量重建）', () => {
  it('applyEvent 返回同一 graph 引用，内部容器引用稳定', () => {
    const graph = createGraph(RUN)
    const spansMap = graph.spans
    const edgesArray = graph.edges
    const outgoingMap = graph.outgoing
    const event: AgentEvent = {
      type: 'span.start',
      runId: RUN,
      span: makeSpan('s-a', []),
    }
    const returned = applyEvent(graph, event)
    expect(returned).toBe(graph)
    expect(graph.spans).toBe(spansMap)
    expect(graph.edges).toBe(edgesArray)
    expect(graph.outgoing).toBe(outgoingMap)
    expect(graph.spans.size).toBe(1)
  })
})

describe('run.snapshot', () => {
  it('清空旧内容并按快照重放，边按统一规则推导', () => {
    const graph = createGraph(RUN)
    // 先放一些旧内容
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-old', []) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-old', null) })
    expect(graph.spans.size).toBe(1)

    const snapSpanA: Span = { ...makeSpan('s-a', []), status: 'ok', endedAt: 10 }
    const snapSpanB = makeSpan('s-b', ['e-snap'])
    const snapEntity = makeEntity('e-snap', 's-a')
    applyEvent(graph, {
      type: 'run.snapshot',
      runId: 'run-snap',
      spans: [snapSpanA, snapSpanB],
      entities: [snapEntity],
    })

    expect(graph.runId).toBe('run-snap')
    expect(graph.spans.size).toBe(2)
    expect(graph.entities.size).toBe(1)
    expect(graph.entities.has('e-old')).toBe(false)
    expect(graph.edges).toEqual([
      { fromSpanId: 's-a', toSpanId: 's-b', viaEntityId: 'e-snap' },
    ])
    // 快照里的 endedAt 语义是「已结束」，重放后不再丢失
    expect(graph.spans.get('s-a')?.endedAt).toBe(10)
  })
})
