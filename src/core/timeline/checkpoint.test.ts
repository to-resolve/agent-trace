// Checkpoint 与回溯测试（docs/02 §11.5/§11.9，T9 第二部分验收）：
// - 深拷贝零共享（幽灵 bug 的唯一来源）
// - 回溯一致性：任意 step 的回溯结果与从头回放逐字段相等（关键断言）
// - 混合策略三条路径各自正确：invert 回退 / 小步前进 / checkpoint 大步重建
// - 往返（回退→前进→再回退）反复 seek 的稳定性
// - 越界与 rollbackTo 方向守卫
import { describe, it, expect } from 'vitest'
import { applyEvent, createGraph } from '../graph/build'
import { layoutGraph } from '../graph/layout'
import {
  CHECKPOINT_INTERVAL,
  cloneGraph,
  cloneLayout,
  createReplaySession,
  makeCheckpoint,
  rollbackTo,
  seekTo,
  type ReplaySession,
} from './checkpoint'
import { mixedTopologyEvents } from '../source/synth'
import type { AgentEvent, CausalGraph, Span } from '../types'

const RUN = 'run-cp-test'

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

/** 图深快照（与 journal.test 同款：数组复制，span/entity 替换式写入引用安全） */
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

/** 从头回放到 n 的基准图（不经 session，独立构造） */
function replayFromScratch(events: readonly AgentEvent[], n: number): CausalGraph {
  const graph = createGraph(events[0].runId)
  for (let i = 0; i < n; i++) applyEvent(graph, events[i])
  return graph
}

describe('深拷贝：零结构共享（§11.8 条 5）', () => {
  it('cloneGraph：改克隆不改原图（含嵌套数组与 Map）', () => {
    const g2 = createGraph(RUN)
    applyEvent(g2, {
      type: 'entity.create',
      runId: RUN,
      entity: {
        id: 'e-1',
        kind: 'context',
        label: 'x',
        producedBy: null,
        payload: { nested: [1, 2] },
        time: { createdAt: 0, observedAt: 0 },
        source: 'test',
      },
    })
    applyEvent(g2, { type: 'span.start', runId: RUN, span: makeSpan('s-1', ['e-1']) })
    const cloned = cloneGraph(g2)
    // 克隆逐字段相等
    expect(snapshot(cloned)).toEqual(snapshot(g2))
    // 改克隆的一切结构：原图不动
    cloned.spans.get('s-1')?.inputEntityIds.push('e-extra')
    cloned.edges.push({ fromSpanId: 'x', toSpanId: 'y', viaEntityId: 'z' })
    cloned.outgoing.get('s-1')?.push({ fromSpanId: 'x', toSpanId: 'y', viaEntityId: 'z' })
    ;(cloned.entities.get('e-1')?.payload as { nested: number[] }).nested.push(99)
    expect(g2.spans.get('s-1')?.inputEntityIds).toEqual(['e-1'])
    expect(g2.edges).toHaveLength(0)
    expect(g2.outgoing.get('s-1')).toBeUndefined()
    expect(g2.entities.get('e-1')?.payload).toEqual({ nested: [1, 2] })
  })

  it('cloneLayout：节点对象与边数组不共享', () => {
    const layout = {
      nodes: new Map([
        ['s-1', { spanId: 's-1', layer: 0, x: 0, y: 0, width: 180, height: 60 }],
      ]),
      edges: [{ fromSpanId: 'a', toSpanId: 'b', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, viaEntityId: 'e', state: 'normal' as const }],
      bounds: { width: 100, height: 100 },
      version: 3,
    }
    const cloned = cloneLayout(layout)
    const node = cloned.nodes.get('s-1')
    if (node === undefined) throw new Error('克隆缺节点')
    node.x = 999
    cloned.edges[0].from.x = 999
    expect(layout.nodes.get('s-1')?.x).toBe(0)
    expect(layout.edges[0].from.x).toBe(0)
  })

  it('makeCheckpoint：检查点与活图零共享', () => {
    const graph = createGraph(RUN)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-1', []) })
    const layout = {
      nodes: new Map([
        ['s-1', { spanId: 's-1', layer: 0, x: 0, y: 0, width: 180, height: 60 }],
      ]),
      edges: [],
      bounds: { width: 180, height: 60 },
      version: 1,
    }
    const cp = makeCheckpoint(graph, layout, 1)
    applyEvent(graph, { type: 'span.start', runId: RUN, span: makeSpan('s-2', []) })
    const node = layout.nodes.get('s-1')
    if (node === undefined) throw new Error('缺节点')
    node.y = 999
    expect(cp.graph.spans.size).toBe(1)
    expect(cp.layout.nodes.get('s-1')?.y).toBe(0)
  })
})

describe('回溯一致性（§11.9 关键断言）', () => {
  // 600 节点混合流：跨过多个 checkpoint 间隔（600×~4.5 ≈ 2700 事件）
  const events = mixedTopologyEvents(600, 10, 3)

  it('任意 step 回退后的图，与从头回放该 step 逐字段相等（invert 路径）', () => {
    const session = createReplaySession(events)
    expect(session.applied).toBe(events.length)
    const targets = [1, CHECKPOINT_INTERVAL, 777, 1234, events.length - 1]
    for (const t of targets) {
      seekTo(session, t)
      expect(snapshot(session.graph)).toEqual(snapshot(replayFromScratch(events, t)))
      expect(session.applied).toBe(t)
    }
  })

  it('小步前进（从回退点逐步 applyEvent）：与从头回放逐字段相等', () => {
    const session = createReplaySession(events)
    seekTo(session, 800)
    // 小步前进 150 步（< CHECKPOINT_INTERVAL，走逐步路径）
    seekTo(session, 950)
    expect(snapshot(session.graph)).toEqual(snapshot(replayFromScratch(events, 950)))
    expect(session.journal.ops.length).toBe(950)
  })

  it('大步前进走 checkpoint 重建：与从头回放逐字段相等', () => {
    const session = createReplaySession(events)
    seekTo(session, 100) // 回退很深
    expect(session.applied).toBe(100)
    // 从 100 前进到 2000（远超 CHECKPOINT_INTERVAL → checkpoint 重建路径）
    seekTo(session, 2000)
    expect(snapshot(session.graph)).toEqual(snapshot(replayFromScratch(events, 2000)))
    expect(session.applied).toBe(2000)
    // journalBase = 重建用的检查点（2000 正是间隔倍数，base=2000）
    expect(session.journalBase).toBe(2000)
    // 重建后回退仍在有效区内（target ≥ journalBase）
    seekTo(session, 1900)
    expect(snapshot(session.graph)).toEqual(snapshot(replayFromScratch(events, 1900)))
  })

  it('回退越过 journalBase：经 checkpoint 重建仍然正确', () => {
    const session = createReplaySession(events)
    seekTo(session, 2000) // 大步前进 → checkpoint 重建，journalBase = 2000
    seekTo(session, 1990) // 有效区内 invert 回退
    seekTo(session, 50) // 越过 journalBase → 必须 checkpoint 重建
    expect(snapshot(session.graph)).toEqual(snapshot(replayFromScratch(events, 50)))
    expect(session.applied).toBe(50)
    // 无可用检查点（50 < 200）→ 从零重放分支
    expect(session.journalBase).toBe(0)
  })

  // T9 第二部分审查 B3 的守卫：大步前进到「非 checkpoint 边界」后小步
  // 回退——journalBase < applied 区间内的 invert 路径（原实现用全局索引
  // 访问相对索引的 ops，越界被 ?? [] 静默吞掉，图完全不回退）。
  // 前提断言不可省：若路径改变（journalBase === applied），测试会静默
  // 失去意义（这正是此前 14 个测试全绿却带 bug 的原因）。
  it('大步前进到非 checkpoint 边界后小步回退（journalBase < applied 区间的 invert 路径）', () => {
    const session = createReplaySession(events)
    seekTo(session, 100)
    seekTo(session, 1950) // 非 200 倍数 ⟹ journalBase=1800 < applied=1950
    expect(session.journalBase).toBeLessThan(session.applied) // 前提断言
    expect(session.journal.ops.length).toBe(session.applied - session.journalBase) // 相对索引不变量
    seekTo(session, 1900) // 落在 [journalBase, applied) 内 ⟹ invert 路径
    expect(snapshot(session.graph)).toEqual(snapshot(replayFromScratch(events, 1900)))
    expect(session.applied).toBe(1900)
    // ops 长度同步收缩（pop 了 50 组）
    expect(session.journal.ops.length).toBe(1900 - session.journalBase)
  })

  it('往返风暴：反复「回退→前进→回退」的每个落点都正确', () => {
    const session = createReplaySession(events)
    const hops = [1500, 300, 1600, 50, events.length, 900, 700, 120, 1800]
    for (const t of hops) {
      seekTo(session, t)
      expect(snapshot(session.graph)).toEqual(snapshot(replayFromScratch(events, t)))
    }
  })

  it('回退后布局重建：layoutGraph 全量语义（独立测试见文末 describe）', () => {
    // 结构性冒烟：回退后布局节点数与图 span 数一致（逐层比对在文末
    // 「回退后布局」describe 用动态 import 做全量对照）
    const session = createReplaySession(events)
    seekTo(session, 1000)
    expect(session.layout.nodes.size).toBe(session.graph.spans.size)
  })
})

describe('守卫', () => {
  const events = mixedTopologyEvents(30, 10, 3)
  it('seekTo 越界抛错', () => {
    const session = createReplaySession(events)
    expect(() => seekTo(session, -1)).toThrow(/越界/)
    expect(() => seekTo(session, events.length + 1)).toThrow(/越界/)
  })
  it('rollbackTo 拒绝前进方向', () => {
    const session = createReplaySession(events)
    seekTo(session, 10)
    expect(() => rollbackTo(session, 20)).toThrow(/只回退/)
    rollbackTo(session, 5)
    expect(session.applied).toBe(5)
  })
  it('seekTo 幂等（target === applied 零成本）', () => {
    const session: ReplaySession = createReplaySession(events)
    const before = snapshot(session.graph)
    seekTo(session, session.applied)
    expect(snapshot(session.graph)).toEqual(before)
  })
})

// 回退后布局（全量重建语义）：与独立全量布局的节点集合与层号对照
describe('回退后布局（全量重建语义）', () => {
  it('seek 回退后 layout 与独立全量布局的节点集合与层号一致', () => {
    const evts = mixedTopologyEvents(300, 10, 3)
    const session = createReplaySession(evts)
    seekTo(session, 800)
    const fresh = replayFromScratch(evts, 800)
    const freshLayout = layoutGraph(fresh)
    expect(session.layout.nodes.size).toBe(freshLayout.nodes.size)
    for (const [id, node] of freshLayout.nodes) {
      expect(session.layout.nodes.get(id)?.layer).toBe(node.layer)
    }
  })
})
