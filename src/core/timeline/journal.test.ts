// Journal 测试（docs/02 §11.3/§11.4，T9 第一部分验收）：
// - 零开销路径：不传 journal 时行为与既有完全一致
// - 核心验收：applyEvent + invert 一轮后，图状态与操作前逐字段相等
// - LIFO 逆序：一组逆操作必须整组逆序应用（后产生的先还原）
// - 随机化回滚压力测试：事件流逐个应用并逐步回滚，任意时刻图状态
//   与「从头回放到该时刻」逐字段相等
// - adj.truncate 到 0 删除键（§11.3 硬约束）
import { describe, it, expect } from 'vitest'
import { applyEvent, createGraph } from '../graph/build'
import { peekConsumers } from '../graph/consumers-index'
import { createJournal, invert, type InverseOp } from './journal'
import { mixedTopologyEvents } from '../source/synth'
import type { AgentEvent, CausalGraph, Span, DataEntity } from '../types'

const RUN = 'run-journal-test'

function makeSpan(id: string, inputEntityIds: string[]): Span {
  return {
    id,
    runId: RUN,
    parentId: null,
    agentId: `agent-${id}`,
    kind: 'llm',
    name: id,
    status: 'running',
    startedAt: 0,
    endedAt: null,
    inputEntityIds,
    outputEntityIds: [],
    attributes: {},
  }
}

function makeEntity(id: string, producedBy: string | null): DataEntity {
  return {
    id,
    kind: 'context',
    label: id,
    producedBy,
    payload: { v: 1 },
    time: { createdAt: 0, observedAt: 0 },
    source: 'test',
  }
}

/** 图的深快照（toEqual 深比较用）。必须复制数组——edges / 邻接表内层数组
 *  会被后续 applyEvent 原地 push，捕获引用会让「先拍的快照」被后续推进污染
 *  （首次实现就栽在这：基准图持续生长，回滚图的快照对着被污染的终态比）。
 *  span / entity 对象是替换式写入（§11.8 条 6），引用安全，无需复制。 */
function snapshot(graph: CausalGraph): unknown {
  return {
    runId: graph.runId,
    spans: [...graph.spans.entries()],
    entities: [...graph.entities.entries()],
    edges: [...graph.edges],
    outgoing: [...graph.outgoing.entries()].map(([k, v]) => [k, [...v]] as [string, unknown[]]),
    incoming: [...graph.incoming.entries()].map(([k, v]) => [k, [...v]] as [string, unknown[]]),
  }
}

describe('零开销路径', () => {
  it('不传 journal 时 ops 为空、图行为与既有完全一致', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-1', []) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-1', 's-1') })
    expect(graph.spans.size).toBe(1)
    expect(graph.entities.size).toBe(1)
  })

  it('传 journal 后事件按序入组（ops[i] 对应第 i 个事件）', () => {
    const graph = createGraph(RUN)
    const journal = createJournal()
    const events: AgentEvent[] = [
      { type: 'run.start', runId: RUN, startedAt: 0 },
      { type: 'entity.create', runId: RUN, entity: makeEntity('e-root', null) },
      { type: 'span.start', runId: RUN, span: makeSpan('s-1', ['e-root']) },
      { type: 'run.end', runId: RUN, endedAt: 9, status: 'ok' },
    ]
    for (const event of events) applyEvent(graph, event, journal)
    expect(journal.ops).toHaveLength(4)
    expect(journal.ops[0]).toEqual([]) // run.start 无写入
    expect(journal.ops[3]).toEqual([]) // run.end 无写入
    expect(journal.ops[2].length).toBeGreaterThan(0) // span.start 有写入
  })
})

describe('核心验收：applyEvent + invert 逐字段还原', () => {
  it('单事件（span.start 建新键）：invert 后图回到空', () => {
    const graph = createGraph(RUN)
    const before = snapshot(graph)
    const journal = createJournal()
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-1', []) }, journal)
    expect(graph.spans.size).toBe(1)
    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before)
  })

  it('单事件（span.end 替换既有键）：invert 放回旧对象', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-1', []) })
    const before = snapshot(graph)
    const journal = createJournal()
    applyEvent(graph, {
      type: 'span.end',
      runId: RUN,
      spanId: 's-1',
      endedAt: 5,
      status: 'ok',
      outputEntityIds: [],
    }, journal)
    expect(graph.spans.get('s-1')?.status).toBe('ok')
    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before)
    expect(graph.spans.get('s-1')?.status).toBe('running')
  })

  it('边产生（addEdge 三处追加）：invert 后三处全部截断回原状', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-1', null) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-prod', null) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-prod', []) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-out', 's-prod') })
    const before2 = snapshot(graph)
    const journal = createJournal()
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-consumer', ['e-out']) }, journal)
    expect(graph.edges).toHaveLength(1) // s-prod → s-consumer 经 e-out
    expect(graph.outgoing.get('s-prod')).toHaveLength(1)
    expect(graph.incoming.get('s-consumer')).toHaveLength(1)
    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before2)
  })

  it('乱序补边（entity 后到）：invert 精确还原补建前的状态', () => {
    const graph = createGraph(RUN)
    // span 先引用尚不存在的实体（无边）；实体到达时补边
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e-late']) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', []) })
    const before = snapshot(graph)
    const journal = createJournal()
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-late', 's-b') }, journal)
    // 补边发生：s-b → s-a
    expect(graph.edges).toHaveLength(1)
    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before)
    expect(graph.edges).toHaveLength(0)
  })

  it('run.snapshot 不记逆操作（裁决 9：空组，但 index 对齐）', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-old', []) })
    const journal = createJournal()
    applyEvent(graph, {
      type: 'run.snapshot',
      runId: RUN,
      spans: [makeSpan('s-new', [])],
      entities: [],
    }, journal)
    // snapshot 自身是全量重置，重放的内容照样记逆（ingest 路径共用），
    // 但「清空旧内容」这一步不记——见下一断言：ops 组里没有能还原
    // s-old 消失的逆操作（s-old 的 prev 不在任何组里）
    const allOps: InverseOp[] = journal.ops.flat()
    const oldRestore = allOps.find(
      (op) => op.kind === 'span.set' && op.spanId === 's-old' && op.prev !== null,
    )
    expect(oldRestore).toBeUndefined()
    expect(graph.spans.has('s-old')).toBe(false)
  })
})

describe('LIFO 与分组', () => {
  it('一组内多个逆操作整组逆序应用（后产生的先还原）', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-p', []) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-x', 's-p') })
    const before = snapshot(graph)
    // 一个事件同时产生：entity.set（新键）+ addEdge（span 消费 e-x 时的
    // 实体后到补边——e-x 已存在，span.start 产出的实体被既有 span 消费）
    const journal = createJournal()
    applyEvent(graph, {
      type: 'span.start',
      runId: RUN,
      span: makeSpan('s-c', ['e-x']),
    }, journal)
    expect(graph.edges).toHaveLength(1)
    expect(graph.spans.size).toBe(2)
    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before)
  })

  it('连续多事件整体逆序回滚到任意中间点', () => {
    const events: AgentEvent[] = [
      { type: 'entity.create', runId: RUN, entity: makeEntity('e-0', null) },
      { type: 'span.start', runId: RUN, span: makeSpan('s-0', ['e-0']) },
      { type: 'entity.create', runId: RUN, entity: makeEntity('e-1', 's-0') },
      { type: 'span.start', runId: RUN, span: makeSpan('s-1', ['e-1']) },
      { type: 'entity.create', runId: RUN, entity: makeEntity('e-2', 's-1') },
      { type: 'span.start', runId: RUN, span: makeSpan('s-2', ['e-2']) },
    ]
    // 基准：graphBefore[i] = 应用第 i 个事件之前的状态（即应用前 i 个事件后）
    const graphBefore: unknown[] = []
    const staged = createGraph(RUN)
    graphBefore.push(snapshot(staged)) // 应用第 0 个事件前 = 空图
    for (const event of events) {
      applyEvent(staged, event)
      graphBefore.push(snapshot(staged))
    }
    // 全部应用到目标图
    const graph = createGraph(RUN)
    const journal = createJournal()
    for (const event of events) applyEvent(graph, event, journal)
    expect(snapshot(graph)).toEqual(graphBefore[events.length])
    // 逐步回滚：每逆第 i 组，图回到「应用第 i 个事件前」= graphBefore[i]
    for (let i = events.length - 1; i >= 0; i--) {
      invert(graph, journal.ops[i] ?? [])
      expect(snapshot(graph)).toEqual(graphBefore[i])
    }
  })
})

describe('adj.truncate 硬约束（§11.3）', () => {
  it('length 为 0 时删除键而非留空数组', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-1', null) })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-p', []) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-out', 's-p') })
    const journal = createJournal()
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-c', ['e-out']) }, journal)
    // s-c 的 incoming 在边产生时从无到有（length 0 → 1）
    expect(graph.incoming.has('s-c')).toBe(true)
    invert(graph, journal.ops[0] ?? [])
    // 截断回 0 ⟹ 键必须消失（不留空数组）
    expect(graph.incoming.has('s-c')).toBe(false)
  })

  it('多出边 / 多入边节点：非零长度 adj.truncate 记录，invert 精确还原', () => {
    // 覆盖 addEdge 记录分支的「out / inc 已有内容」路径：s-a 已有出边、
    // s-c 已有入边时再追加边，截断长度非零
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', []) })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-a1', 's-a') })
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-a2', 's-a') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-b', ['e-a1']) })
    const before = snapshot(graph)
    const journal = createJournal()
    // s-c 消费两份实体：两条边都从 s-a 出（第二条时 out 已非空），
    // 第二条进入 s-c 时 inc 已非空
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-c', ['e-a1', 'e-a2']) }, journal)
    // 边：s-a→s-b(e-a1) + s-a→s-c(e-a1) + s-a→s-c(e-a2)
    expect(graph.edges).toHaveLength(3)
    expect(graph.outgoing.get('s-a')).toHaveLength(3)
    expect(graph.incoming.get('s-c')).toHaveLength(2)

    // 重复入图触发 addEdge 幂等去重（既有同 to+via 边直接返回）：
    // 不回滚、直接再放一次 s-c 的 span.start，边数不变，逆操作只含 span.set
    const journal2 = createJournal()
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-c', ['e-a1', 'e-a2']) }, journal2)
    expect(graph.edges).toHaveLength(3)
    expect(journal2.ops[0]?.every((op) => op.kind === 'span.set')).toBe(true)

    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before)
  })
})

describe('T9 第二部分必修 B1：回滚+重放往返后索引不膨胀', () => {
  // 复现审查给出的机理：apply(span A 消费 E1) → index['E1']=['A']；
  // invert 后 spans.delete('A') 但索引残留 'A'；重放同事件 → 若索引
  // 未失效则 push 成 ['A','A']。invert 已改为整体失效（惰性重建），
  // 本测试是它的守卫。
  it('单次往返：invert 后索引失效，重放不累积重复项', () => {
    const graph = createGraph(RUN)
    // E1 有生产者 s-src，s-src 先入图
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-1', 's-src') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-src', []) })
    const before = snapshot(graph)

    const journal = createJournal()
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e-1']) }, journal)
    // s-src 是 e-1 的生产者而非消费者（无输入实体），索引只含 s-a
    expect(peekConsumers(graph, 'e-1')).toEqual(['s-a'])

    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before) // 图正确回滚（s-a 消失）

    // 重放同一事件：索引经失效→重建（从 spans：s-a 已不在图内）→push
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-a', ['e-1']) }, journal)
    expect(peekConsumers(graph, 'e-1')).toEqual(['s-a']) // 无重复（膨胀形态是 ['s-a','s-a']）
    expect(graph.edges).toHaveLength(1)
  })

  it('多次往返（拖时间轴的核心交互）：往返 50 次索引长度恒定', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-1', 's-src') })
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-src', []) })
    const replayEvent: AgentEvent = {
      type: 'span.start',
      runId: RUN,
      span: makeSpan('s-a', ['e-1']),
    }
    // 50 轮「应用 → 回滚」：每轮索引若不失效就多积一个 's-a'
    for (let round = 0; round < 50; round++) {
      const journal = createJournal()
      applyEvent(graph, replayEvent, journal)
      invert(graph, journal.ops[0] ?? [])
      expect(graph.spans.has('s-a')).toBe(false) // 每轮都回到干净状态
    }
    // 最终重放一次并检查索引：无重复（膨胀形态会是 50+ 个 's-a'）
    const journal = createJournal()
    applyEvent(graph, replayEvent, journal)
    expect(peekConsumers(graph, 'e-1')).toEqual(['s-a'])
    const consumers = peekConsumers(graph, 'e-1') ?? []
    expect(consumers.filter((id) => id === 's-a')).toHaveLength(1)
  })
})

describe('T9 第二部分必修 B2：entity.set prev !== null 分支（重复 entity.create）', () => {
  it('重复 entity.create 覆盖既有实体后回滚，回到第一版的值', () => {
    const graph = createGraph(RUN)
    const first = { ...makeEntity('e-re', null), label: '第一版' }
    const second = { ...makeEntity('e-re', null), label: '第二版' }
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: first })
    const before = snapshot(graph)

    const journal = createJournal()
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: second }, journal)
    expect(graph.entities.get('e-re')?.label).toBe('第二版')
    // 逆操作应记录第一版（prev !== null，替换既有实体分支）
    const op = journal.ops[0]?.[0]
    expect(op?.kind).toBe('entity.set')
    if (op?.kind === 'entity.set') {
      expect(op.prev?.label).toBe('第一版')
    }
    invert(graph, journal.ops[0] ?? [])
    expect(snapshot(graph)).toEqual(before)
    expect(graph.entities.get('e-re')?.label).toBe('第一版')
  })
})

describe('runId 冲突 + journal：空组撤销不残留（第一部分审查建议 1）', () => {
  it('冲突抛错前撤销本次 push 的空组，journal.ops 与事件流 index 保持对齐', () => {
    const graph = createGraph(RUN)
    const journal = createJournal()
    // 先应用两个正常事件（ops 有两组）
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-1', null) }, journal)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-1', []) }, journal)
    expect(journal.ops).toHaveLength(2)
    // 第三个事件 runId 冲突：抛错 + 空组不残留
    expect(() =>
      applyEvent(graph, {
        type: 'run.snapshot',
        runId: 'run-another',
        spans: [],
        entities: [],
      }, journal),
    ).toThrow(/冲突/)
    expect(journal.ops).toHaveLength(2) // 关键：冲突事件未留下错位的空组
    // 后续事件继续记录在正确位置（index 2）
    applyEvent(graph, { type: 'entity.create', runId: RUN, entity: makeEntity('e-2', null) }, journal)
    expect(journal.ops).toHaveLength(3)
  })
})

describe('混合拓扑随机化压力回滚（10k 规模前哨）', () => {
  it('随机回滚点：回滚后与从头回放到该点逐字段相等', () => {
    // 用 500 节点混合流（10k 全量留给 checkpoint 部分），验证「回滚到
    // 任意事件边界」的正确性——这是 §11.9 验收口径的微观形态
    const events = mixedTopologyEvents(400, 10, 3)
    const graph = createGraph(events[0].runId)
    const journal = createJournal()
    for (const event of events) applyEvent(graph, event, journal)

    // 基准：从头回放到各检查点
    const checkAt = (n: number): unknown => {
      const g = createGraph(events[0].runId)
      for (let i = 0; i < n; i++) applyEvent(g, events[i])
      return snapshot(g)
    }
    const checks = [1, Math.floor(events.length / 3), Math.floor(events.length / 2), events.length - 1]
    const baselines = checks.map(checkAt)

    // 回滚：从尾到各检查点
    for (let c = checks.length - 1; c >= 0; c--) {
      for (let i = events.length - 1; i >= checks[c]; i--) {
        invert(graph, journal.ops[i] ?? [])
      }
      expect(snapshot(graph)).toEqual(baselines[c])
    }
  })
})
