// Branch 分叉测试（docs/02 §11.6，T9 第四部分验收）：
// - fork 纯数据操作：不修改 mainEvents 与既有 branches；id 派生
// - fork 隔离性：分支 session 的图与主线零共享（改分支不动主线）
// - 分支图 runId 派生自主线、经 createGraph 工厂
// - 溯源/新鲜度查询在分支图上照常工作（不为分支写第二套查询逻辑）
// - 组合流会话：主线 checkpoint 复用正确 + 分支自有事件增量应用
//   + 分支上的 seekTo 时间旅行照常
// - 反事实雏形：分支注入「修改过的实体」后，图状态与主线分叉
import { describe, it, expect } from 'vitest'
import { applyEvent, createGraph } from '../graph/build'
import { traceUpstream, computeFreshness } from '../graph/query'
import { createReplaySession, seekTo } from './checkpoint'
import { createBranchSession, createTimeline, forkBranch } from './branch'
import { mixedTopologyEvents } from '../source/synth'
import type { CausalGraph, DataEntity } from '../types'

/** synth 混合流的 runId（mixedTopologyEvents 固定值） */
const MAIN_RUN = 'run-synth-mixed'

function makeEntity(id: string, producedBy: string | null, ageDays = 0): DataEntity {
  const DAY = 86_400_000
  return {
    id,
    kind: 'context',
    label: id,
    producedBy,
    payload: { v: 1 },
    time: { createdAt: 1_000_000 - ageDays * DAY, observedAt: 1_000_000 },
    source: 'test',
  }
}

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

/** 「图与基准一致（忽略 runId）」的比较：分支图的 runId 是派生 id，
 *  基准图用主线 runId 建图——结构逐字段相等、runId 各自正确即可 */
function expectGraphEqualsMainPrefix(branchGraph: CausalGraph, fresh: CausalGraph): void {
  const a = snapshot(branchGraph) as { runId: string }
  const b = snapshot(fresh) as { runId: string }
  expect({ ...a, runId: b.runId }).toEqual(b)
  expect(a.runId).not.toBe(b.runId) // 分支图 runId 是派生的
}

describe('forkBranch：纯数据操作（§11.6）', () => {
  // 600 节点混合流（2157 事件，跨多个 checkpoint 间隔——与第二部分测试同规模）
  const events = mixedTopologyEvents(600, 10, 3)

  it('登记分支但不修改 mainEvents 与既有 branches', () => {
    const timeline = createTimeline([...events])
    const mainBefore = [...timeline.mainEvents]
    const b1 = forkBranch(timeline, 500, '把简历换成 v2')
    expect(timeline.mainEvents).toEqual(mainBefore) // 主时间线不动
    expect(timeline.branches).toHaveLength(1)
    expect(timeline.branches[0]).toBe(b1)
    // 再 fork：既有分支不动、新分支登记
    const b2 = forkBranch(timeline, 700, '另一改动')
    expect(timeline.branches).toHaveLength(2)
    expect(timeline.branches[0]).toBe(b1)
    expect(timeline.branches[1]).toBe(b2)
  })

  it('分支字段：id 派生自主线 runId、baseEventIndex、空事件表、note', () => {
    const timeline = createTimeline([...events])
    const b = forkBranch(timeline, 500, '把简历换成 v2')
    expect(b.id).toBe(`${MAIN_RUN}#fork-1`)
    expect(b.baseEventIndex).toBe(500)
    expect(b.events).toEqual([])
    expect(b.note).toBe('把简历换成 v2')
    // 第二条分支的序号递增
    expect(forkBranch(timeline, 600, 'x').id).toBe(`${MAIN_RUN}#fork-2`)
  })

  it('fork 位置越界抛错', () => {
    const timeline = createTimeline([...events])
    expect(() => forkBranch(timeline, -1, 'x')).toThrow(/越界/)
    expect(() => forkBranch(timeline, events.length + 1, 'x')).toThrow(/越界/)
    // 边界合法：0 与末尾
    expect(() => forkBranch(timeline, 0, 'x')).not.toThrow()
    expect(() => forkBranch(timeline, events.length, 'x')).not.toThrow()
  })
})

describe('createBranchSession：组合流会话', () => {
  const events = mixedTopologyEvents(600, 10, 3)
  const timeline = createTimeline([...events])
  const mainSession = createReplaySession(events)

  it('分支会话的图 = 主线前缀的独立重放（与从头回放逐字段相等）', () => {
    const b = forkBranch(timeline, 800, '测试分叉')
    const branchSession = createBranchSession(timeline, b, mainSession)
    expect(branchSession.graph.runId).toBe(`${MAIN_RUN}#fork-1`) // runId 派生
    // 基准：独立图重放前 800 个事件（分支自有事件为空）
    const fresh = createGraph(MAIN_RUN)
    for (let i = 0; i < 800; i++) applyEvent(fresh, events[i])
    expectGraphEqualsMainPrefix(branchSession.graph, fresh)
    // 组合流长度 = 前缀 + 分支事件（0）
    expect(branchSession.events).toHaveLength(800)
    expect(branchSession.applied).toBe(800)
    // 不变量：ops.length === applied - journalBase（复用 checkpoint 时
    // journalBase = checkpoint 起点——B3 的教训写进断言）
    expect(branchSession.journal.ops.length).toBe(
      branchSession.applied - branchSession.journalBase,
    )
  })

  it('fork 隔离性：修改分支图，主线逐字段不变（§11.9 关键验收）', () => {
    const b = forkBranch(timeline, 800, '隔离测试')
    const branchSession = createBranchSession(timeline, b, mainSession)
    const mainBefore = snapshot(mainSession.graph)

    // 在分支上做激进修改：删 span、加边、改邻接表
    branchSession.graph.spans.delete('s-1')
    branchSession.graph.edges.push({ fromSpanId: 'x', toSpanId: 'y', viaEntityId: 'z' })
    branchSession.graph.outgoing.get('s-0')?.push({ fromSpanId: 'x', toSpanId: 'y', viaEntityId: 'z' })

    // 主线不受影响（独立图实例 + checkpoint 深拷贝零共享）
    expect(snapshot(mainSession.graph)).toEqual(mainBefore)

    // 后续新建的分支也不被污染：b2 从主线 checkpoint 独立重放，
    // 其图与「未动过的 b 分支初始图」一致（s-1 在、无 x→y 边）
    const b2 = forkBranch(timeline, 800, '再来一条')
    const session2 = createBranchSession(timeline, b2, mainSession)
    expect(session2.graph.spans.has('s-1')).toBe(true)
    expect(session2.graph.edges.some((e) => e.fromSpanId === 'x')).toBe(false)
    expect(snapshot(mainSession.graph)).toEqual(mainBefore)
  })

  it('分支注入修改事件后：图状态与主线分叉（反事实的雏形）', () => {
    const b = forkBranch(timeline, 4, '修改 e-1 为新鲜版本')
    // 注入：重复 entity.create 覆盖 e-1（替换式写入——分支上 e-1 变新）。
    // 事件的 runId 保持主线形态（组合流前缀一致；applyEvent 不校验非
    // snapshot 事件的 runId，图实例的 runId 才是分支标识）
    b.events.push({
      type: 'entity.create',
      runId: MAIN_RUN,
      entity: makeEntity('e-1', 's-0', 0),
    })
    const branchSession = createBranchSession(timeline, b, mainSession)
    // 分支上 e-1 的 createdAt 是新鲜的（ageDays=0）
    const entity = branchSession.graph.entities.get('e-1')
    expect(entity).toBeDefined()
    if (entity !== undefined) {
      const fresh = computeFreshness(entity, 7 * 86_400_000)
      expect(fresh.status).toBe('fresh')
    }
    // 主线 session 的 e-1 未被分支注入污染（独立图实例）：仍是 synth 原值
    const mainEntity = mainSession.graph.entities.get('e-1')
    expect(mainEntity).toBeDefined()
    if (mainEntity !== undefined && entity !== undefined) {
      expect(mainEntity.time).not.toEqual(entity.time) // 主线旧 / 分支新
    }
  })

  it('溯源查询在分支图上照常工作（不写第二套查询逻辑）', () => {
    const b = forkBranch(timeline, 800, '溯源测试')
    const branchSession = createBranchSession(timeline, b, mainSession)
    const result = traceUpstream(branchSession.graph, 's-50')
    expect(result.spanIds.size).toBeGreaterThan(1) // 深链上游照常
    expect(result.hasCycle).toBe(false)
  })

  it('分支会话上的 seekTo 时间旅行照常（含跨 checkpoint 回退）', () => {
    const b = forkBranch(timeline, 800, '时间旅行测试')
    const branchSession = createBranchSession(timeline, b, mainSession)
    // 组合流 800 事件，seekTo 到处跑：回退 / 越过 base / 前进回终点
    seekTo(branchSession, 300)
    const fresh300 = createGraph(MAIN_RUN)
    for (let i = 0; i < 300; i++) applyEvent(fresh300, events[i])
    expectGraphEqualsMainPrefix(branchSession.graph, fresh300)
    seekTo(branchSession, 800)
    expect(branchSession.applied).toBe(800)
    // 前提断言复述（B3 教训）：seek 后不变量保持
    expect(branchSession.journal.ops.length).toBe(
      branchSession.applied - branchSession.journalBase,
    )
  })

  // B4-2（第四部分审查探针转正）：分支事件区间的 invert 回退——B3 的
  // 原触发形态在分支会话上的覆盖。前提断言不可省：空分支时
  // journalBase === applied，区间不存在，测试会静默失去意义。
  it('分支注入事件后回退到 [journalBase, applied) 区间内部（invert 路径）', () => {
    const b = forkBranch(timeline, 800, '注入 60 事件')
    for (let k = 0; k < 60; k++) {
      b.events.push({
        type: 'entity.create',
        runId: MAIN_RUN,
        entity: makeEntity(`e-inject-${k}`, null),
      })
    }
    const branchSession = createBranchSession(timeline, b, mainSession)
    // 组合流 860：journalBase=800（复用 checkpoint），applied=860，opsLen=60
    expect(branchSession.applied).toBe(860)
    expect(branchSession.journalBase).toBeLessThan(branchSession.applied) // 前提断言
    expect(branchSession.journal.ops.length).toBe(
      branchSession.applied - branchSession.journalBase,
    ) // 不变量断言

    // 回退到 820：落在区间内部 ⟹ invert 路径
    seekTo(branchSession, 820)
    // 基准：主线前 800 事件 + 前 20 个注入事件的独立重放
    const fresh820 = createGraph(MAIN_RUN)
    for (let i = 0; i < 800; i++) applyEvent(fresh820, events[i])
    for (let k = 0; k < 20; k++) {
      applyEvent(fresh820, {
        type: 'entity.create',
        runId: MAIN_RUN,
        entity: makeEntity(`e-inject-${k}`, null),
      })
    }
    expectGraphEqualsMainPrefix(branchSession.graph, fresh820)
    expect(branchSession.applied).toBe(820)
    expect(branchSession.journal.ops.length).toBe(20) // pop 了 40 组

    // 越过 journalBase 深回退：走 checkpoint 重建（B4-1 验收——不再从零）
    seekTo(branchSession, 100)
    const fresh100 = createGraph(MAIN_RUN)
    for (let i = 0; i < 100; i++) applyEvent(fresh100, events[i])
    expectGraphEqualsMainPrefix(branchSession.graph, fresh100)

    // 前进回终点：大步 → checkpoint 重建
    seekTo(branchSession, 860)
    expect(branchSession.applied).toBe(860)
    expect(branchSession.journalBase).toBeLessThanOrEqual(branchSession.applied)
    expect(branchSession.journal.ops.length).toBe(
      branchSession.applied - branchSession.journalBase,
    )
  })

  // B4-1 验收：分支会话的 checkpoints 覆盖主线区间（共享引用），
  // journalBase 之下的深回退走 checkpoint 重建（重放 ≤200 步）而非从零。
  it('B4-1：分支会话深回退走主线 checkpoint 重建（覆盖不变量成立）', () => {
    const b = forkBranch(timeline, 800, '深回退')
    const branchSession = createBranchSession(timeline, b, mainSession)
    // 主线 ≤800 的 checkpoints 已并入（600 节点流 = 2157 事件 ⟹ 800/600/400/200 都有）
    const idx = branchSession.checkpoints.map((c) => c.eventIndex)
    expect(idx).toContain(200)
    expect(idx).toContain(800)
    // journalBase=800 之下、首个 own checkpoint 之上的深回退：
    // 应走「主线 checkpoint（400）重建 + 重放」而不再从零
    seekTo(branchSession, 450)
    const fresh450 = createGraph(MAIN_RUN)
    for (let i = 0; i < 450; i++) applyEvent(fresh450, events[i])
    expectGraphEqualsMainPrefix(branchSession.graph, fresh450)
    // 重建后的图 runId 仍是分支派生 id（B4-1 陷阱：主线 checkpoint 带
    // 主线 runId，rebuildFromCheckpoint 须归一）——用该会话自己的 runId 断言
    expect(branchSession.graph.runId).toBe(b.id)
    expect(branchSession.journalBase).toBe(400) // 复用了 400 的检查点
  })
})
