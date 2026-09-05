// T7 压测基建测试：生成器确定性、三种拓扑的结构断言、事件协议合法性，
// 以及「10k 深链上 traceUpstream 与 layoutGraph 完成且不爆栈」的回归守卫
// （docs/03 T7 第二部分第 1 条——递归爆栈验证的持续化证据）。
import { describe, it, expect } from 'vitest'
import { deepChainEvents, fanoutEvents, mixedTopologyEvents } from './synth'
import { isAgentEvent } from '../events'
import { applyEvent, createGraph } from '../graph/build'
import { layoutGraph } from '../graph/layout'
import { traceUpstream } from '../graph/query'
import type { AgentEvent, CausalGraph } from '../types'

/** 逐事件应用（bench 与本测试共用的建图方式：确定性、无 timer） */
function buildGraph(events: readonly AgentEvent[]): CausalGraph {
  const graph = createGraph(events[0].runId)
  for (const event of events) applyEvent(graph, event)
  return graph
}

describe('生成器确定性', () => {
  it('同参数两次生成深链流逐元素全等', () => {
    expect(deepChainEvents(50)).toEqual(deepChainEvents(50))
  })

  it('同参数两次生成混合流逐元素全等', () => {
    expect(mixedTopologyEvents(30, 5, 2)).toEqual(mixedTopologyEvents(30, 5, 2))
  })
})

describe('拓扑结构', () => {
  it('深链：N 个 span、N-1 条边、链尾溯源到链头', () => {
    const events = deepChainEvents(10)
    expect(events).toHaveLength(3 * 10 + 3)
    expect(events.every(isAgentEvent)).toBe(true)
    const graph = buildGraph(events)
    expect(graph.spans.size).toBe(10)
    expect(graph.edges.length).toBe(9)
    const result = traceUpstream(graph, 's-9')
    expect(result.spanIds.size).toBe(10) // 整条链
    expect(result.entityIds.has('e-root')).toBe(true) // 外部根实体在收集口径内
  })

  it('宽扇出：M 个消费边全部来自 s-prod，经由同一实体', () => {
    const events = fanoutEvents(5)
    expect(events.every(isAgentEvent)).toBe(true)
    const graph = buildGraph(events)
    expect(graph.spans.size).toBe(6)
    expect(graph.edges.length).toBe(5)
    for (const edge of graph.edges) {
      expect(edge.fromSpanId).toBe('s-prod')
      expect(edge.viaEntityId).toBe('e-out')
    }
  })

  it('混合：span / 边数与公式一致，分叉叶挂在正确的链节点上', () => {
    const chainSpans = 20
    const fanLayers = Math.floor(chainSpans / 5) - 1 // i=5,10,15 → 3 层（i>0 才挂）
    const events = mixedTopologyEvents(chainSpans, 5, 2)
    expect(events.every(isAgentEvent)).toBe(true)
    const graph = buildGraph(events)
    expect(graph.spans.size).toBe(chainSpans + fanLayers * 2)
    expect(graph.edges.length).toBe(chainSpans - 1 + fanLayers * 2)
    // 第 5 层链节点的两条出边都经由 e-5
    const out5 = graph.outgoing.get('s-5') ?? []
    expect(out5).toHaveLength(3) // 链后继 + 2 个分叉
    expect(out5.every((e) => e.viaEntityId === 'e-5')).toBe(true)
  })

  it('事件流满足协议顺序：entity.create 先于引用它的 span.start', () => {
    const events = mixedTopologyEvents(12, 4, 2)
    const created = new Set<string>()
    for (const event of events) {
      if (event.type === 'entity.create') created.add(event.entity.id)
      else if (event.type === 'span.start') {
        for (const id of event.span.inputEntityIds) {
          expect(created.has(id)).toBe(true)
        }
      }
    }
  })
})

describe('10k 深链递归深度（T7 爆栈检查的持续化守卫）', () => {
  it('traceUpstream 与 layoutGraph 在 10k 深链上完成且不爆栈', () => {
    const graph = buildGraph(deepChainEvents(10_000))
    expect(graph.spans.size).toBe(10_000)
    const result = traceUpstream(graph, 's-9999')
    expect(result.spanIds.size).toBe(10_000)
    const layout = layoutGraph(graph)
    expect(layout.nodes.size).toBe(10_000)
    expect(layout.nodes.get('s-9999')?.layer).toBe(9_999)
  })
})
