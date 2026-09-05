// T3 query 验收测试：双向溯源、环检测不死循环、
// 新鲜度阈值语义（查询参数，不是图属性）、过期数据影响决策的聚合查询。
import { describe, it, expect } from 'vitest'
import { resolveEvent } from '../source/scenario'
import { loadScenarioById } from '../source/registry'
import { applyEvent, createGraph } from './build'
import {
  computeFreshness,
  findStaleEntities,
  findStaleInfluencedDecisions,
  traceDownstream,
  traceUpstream,
} from './query'
import type { CausalGraph, DataEntity, Span } from '../types'

const BASE = 1_700_000_000_000
const DAY_MS = 86_400_000
const RUN = 'run-test'

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

/** 构造含环的图：s-a 消费 e2（乱序到达），s-b 消费 e1，形成 s-a → s-b → s-a */
function buildCyclicGraph(): CausalGraph {
  const graph = createGraph(RUN)
  // s-a 引用尚不存在的 e2（挂起）
  applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e2']) })
  applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') })
  // s-b 消费 e1 → 边 s-a → s-b
  applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e1']) })
  // e2 到达且 producedBy = s-b → 补边 s-b → s-a，环成
  applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e2', 's-b') })
  expect(graph.edges).toEqual([
    { fromSpanId: 's-a', toSpanId: 's-b', viaEntityId: 'e1' },
    { fromSpanId: 's-b', toSpanId: 's-a', viaEntityId: 'e2' },
  ])
  return graph
}

describe('traceUpstream / traceDownstream（stale-context 剧本图）', () => {
  it('关键测试：对决策 span s-decide 反向溯源，结果必须包含 s-retrieve', () => {
    const graph = buildStaleContext()
    const result = traceUpstream(graph, 's-decide')
    expect(result.spanIds.has('s-retrieve')).toBe(true)
    expect(result.spanIds.has('s-score')).toBe(true)
    expect(result.spanIds.has('s-decide')).toBe(true)
    expect(result.spanIds.has('s-orchestrator')).toBe(false)
    // T3b 修补 1 后的语义（02 §6）：entityIds = 各 span 自身输入 ∪ 边经由实体。
    // e-policy 是 s-decide 的直接输入（producedBy === null 无边，但仍在集合中）；
    // e-query 是 s-retrieve 的直接输入，同理入集。
    expect(result.entityIds.has('e-score')).toBe(true)
    expect(result.entityIds.has('e-resume-v1')).toBe(true)
    expect(result.entityIds.has('e-policy')).toBe(true)
    expect(result.entityIds.has('e-query')).toBe(true)
    expect(result.edges).toHaveLength(2)
    expect(result.hasCycle).toBe(false)
  })

  it('正向传播：从 s-retrieve 出发影响全部下游', () => {
    const graph = buildStaleContext()
    const result = traceDownstream(graph, 's-retrieve')
    expect(result.spanIds.has('s-score')).toBe(true)
    expect(result.spanIds.has('s-decide')).toBe(true)
    expect(result.spanIds.has('s-retrieve')).toBe(true)
    expect(result.spanIds.has('s-orchestrator')).toBe(false)
    expect(result.entityIds.has('e-resume-v1')).toBe(true)
    expect(result.entityIds.has('e-score')).toBe(true)
  })

  it('中间节点 s-score 的上游 / 下游都各为一段', () => {
    const graph = buildStaleContext()
    expect([...traceUpstream(graph, 's-score').spanIds].sort()).toEqual([
      's-retrieve',
      's-score',
    ])
    expect([...traceDownstream(graph, 's-score').spanIds].sort()).toEqual(['s-decide', 's-score'])
  })

  it('叶子 / 根节点查询返回自身且不死循环', () => {
    const graph = buildStaleContext()
    const root = traceUpstream(graph, 's-orchestrator')
    expect([...root.spanIds]).toEqual(['s-orchestrator'])
    expect(root.entityIds.size).toBe(0)
    const leaf = traceDownstream(graph, 's-decide')
    expect([...leaf.spanIds]).toEqual(['s-decide'])
    // T3b 修补 1：叶子无下游边，但自身输入（e-score、e-policy）计入 entityIds
    expect(leaf.entityIds.size).toBe(2)
  })
})

describe('环检测', () => {
  it('关键测试：含环的图 traceUpstream 不死循环且 hasCycle === true', () => {
    const graph = buildCyclicGraph()
    const up = traceUpstream(graph, 's-a')
    expect(up.hasCycle).toBe(true)
    expect(up.spanIds.has('s-a')).toBe(true)
    expect(up.spanIds.has('s-b')).toBe(true)
    expect(up.entityIds.has('e1')).toBe(true)
    expect(up.entityIds.has('e2')).toBe(true)

    const down = traceDownstream(graph, 's-a')
    expect(down.hasCycle).toBe(true)

    // 菱形结构不是环：A→B→D、A→C→D，D 被两条路径到达
    const diamond = createGraph(RUN)
    applyEvent(diamond, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a') })
    applyEvent(diamond, { type: 'entity.create', runId: RUN, entity: makeEntity('e2', 's-b') })
    applyEvent(diamond, { type: 'entity.create', runId: RUN, entity: makeEntity('e3', 's-c') })
    applyEvent(diamond, { type: 'entity.create', runId: RUN, entity: makeEntity('e4', 's-d') })
    applyEvent(diamond, { type: 'span.start', runId: RUN, span: makeSpan('s-a', []) })
    applyEvent(diamond, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e1']) })
    applyEvent(diamond, { type: 'span.start', runId: RUN, span: makeSpan('s-c', ['e2']) })
    applyEvent(diamond, { type: 'span.start', runId: RUN, span: makeSpan('s-d', ['e3', 'e4']) })
    const diamondResult = traceDownstream(diamond, 's-a')
    expect(diamondResult.hasCycle).toBe(false)
    expect(diamondResult.spanIds.size).toBe(4)
  })
})

describe('新鲜度（阈值是查询参数，不是图的属性）', () => {
  it('关键测试：7 天阈值下返回 e-resume-v1（91 天），不返回 e-policy（2 天对照组）', () => {
    const graph = buildStaleContext()
    const stale = findStaleEntities(graph, 7 * DAY_MS)
    expect(stale.map((e) => e.id)).toEqual(['e-resume-v1'])
  })

  it('同一图不同阈值查询，Freshness.status 随之变化', () => {
    const graph = buildStaleContext()
    const policy = graph.entities.get('e-policy')
    if (policy === undefined) throw new Error('图中缺少 e-policy')
    // e-policy 的 age = 恰好 2 天
    expect(computeFreshness(policy, 1 * DAY_MS).status).toBe('stale')
    expect(computeFreshness(policy, 3 * DAY_MS).status).toBe('aging')
    expect(computeFreshness(policy, 5 * DAY_MS).status).toBe('fresh')
    // findStaleEntities 随阈值变化：92 天阈值下 e-resume-v1 不再过期
    expect(findStaleEntities(graph, 7 * DAY_MS).map((e) => e.id)).toEqual(['e-resume-v1'])
    expect(findStaleEntities(graph, 92 * DAY_MS)).toEqual([])
  })

  it('Freshness 回记录本次判定所用阈值与年龄', () => {
    const graph = buildStaleContext()
    const resume = graph.entities.get('e-resume-v1')
    if (resume === undefined) throw new Error('图中缺少 e-resume-v1')
    const f = computeFreshness(resume, 7 * DAY_MS)
    expect(f.thresholdMs).toBe(7 * DAY_MS)
    expect(f.ageMs).toBeGreaterThanOrEqual(91 * DAY_MS)
    expect(f.status).toBe('stale')
  })
})

describe('findStaleInfluencedDecisions', () => {
  it('s-decide 被 e-resume-v1 影响，且只被它影响（e-policy / e-score 均新鲜）', () => {
    const graph = buildStaleContext()
    const result = findStaleInfluencedDecisions(graph, 7 * DAY_MS)
    expect(result).toHaveLength(1)
    expect(result[0].span.id).toBe('s-decide')
    expect(result[0].viaEntities.map((e) => e.id)).toEqual(['e-resume-v1'])
  })

  it('阈值放宽到 92 天后，没有任何决策受过期数据影响', () => {
    const graph = buildStaleContext()
    expect(findStaleInfluencedDecisions(graph, 92 * DAY_MS)).toEqual([])
  })

  it('非 decision 类 span 不参与聚合', () => {
    // 把 s-decide 改名后重新构造成非决策图：只留 agent/llm span
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e1', 's-a', 30 * DAY_MS) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', [], 'agent') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e1'], 'llm') })
    expect(findStaleInfluencedDecisions(graph, 7 * DAY_MS)).toEqual([])
  })

  it('T3b 修补 1：决策直接消费 producedBy === null 的过期外部输入，必须被聚合返回', () => {
    // 场景：一份 91 天前的外部材料（无产出 span，无因果边）被决策 span 直接消费。
    // 修补前 entityIds 只收集边上的 via，这类实体整个漏掉 → 决策不被标记。
    const graph = createGraph(RUN)
    applyEvent(graph, {
      type: 'entity.create',
      runId: RUN,
      entity: makeEntity('e-external-doc', null, 91 * DAY_MS),
    })
    applyEvent(graph, {
      type: 'span.start',
      runId: RUN,
      span: makeSpan('s-judge', ['e-external-doc'], 'decision'),
    })
    const result = findStaleInfluencedDecisions(graph, 7 * DAY_MS)
    expect(result).toHaveLength(1)
    expect(result[0].span.id).toBe('s-judge')
    expect(result[0].viaEntities.map((e) => e.id)).toEqual(['e-external-doc'])
    // 对照：阈值放宽后不再判过期
    expect(findStaleInfluencedDecisions(graph, 92 * DAY_MS)).toEqual([])
  })
})
