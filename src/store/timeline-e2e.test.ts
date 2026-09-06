// T9 端到端证明（第五部分验收硬要求，docs/03 T9）：
// stale-context 剧本跑完 → 进入时间旅行 → 回溯到简历实体创建前 →
// fork 分支注入「新鲜版简历 + 推定的下游重跑」→ **决策 span 输出变化**。
//
// 用真实 SimulatedSource（resolve 过的绝对时间事件，与 UI 完全同源），
// 注入序列走 store/counterfactual.ts 的 staleResumeRerunEvents——与
// BranchPanel 按钮（store.injectStaleResumeRerun）同一函数，所见即所测。
// 这是「时间旅行不只是撤销按钮」的存在性证据。
import { describe, it, expect, vi } from 'vitest'
import { loadScenarioById } from '../core/source/registry'
import { SimulatedSource } from '../core/source/simulated'
import type { EventHandlers } from '../core/source/types'
import type { AgentEvent } from '../core/types'
import { createGraph, applyEvent } from '../core/graph/build'
import { createTimeline, createBranchSession, forkBranch } from '../core/timeline/branch'
import { createReplaySession, seekTo } from '../core/timeline/checkpoint'
import { computeFreshness, traceUpstream } from '../core/graph/query'
import { staleResumeRerunEvents } from './counterfactual'
import { useTraceStore } from './traceStore'

const THRESHOLD = 7 * 86_400_000

describe('T9 端到端：简历换成新鲜版本 → 决策变化（存在性证明）', () => {
  it('完整反事实链路：回溯 → fork → 注入新鲜简历并重跑 → 决策输出改变', async () => {
    // 1. 跑完 stale-context（与 UI 同源：SimulatedSource + resolve 事件）
    const scenario = await loadScenarioById('stale-context')
    const events: AgentEvent[] = []
    const handlers: EventHandlers = {
      onEvent: (e) => events.push(e),
      onError: (err) => {
        throw err
      },
      onDone: () => {},
    }
    vi.useFakeTimers()
    try {
      const src = new SimulatedSource([scenario])
      src.start('stale-context', handlers)
      vi.advanceTimersByTime(10_000)
    } finally {
      vi.useRealTimers()
    }
    expect(events.length).toBeGreaterThan(10)
    // 主线基准：全量回放（UI live 路径的语义）
    const mainGraph = createGraph(events[0].runId)
    for (const event of events) applyEvent(mainGraph, event)
    // 主线断言：e-resume-v1 是 91 天过期，决策拒绝、评分 60（剧本预期）
    const staleResume = mainGraph.entities.get('e-resume-v1')
    expect(staleResume).toBeDefined()
    if (staleResume !== undefined) {
      expect(computeFreshness(staleResume, THRESHOLD).status).toBe('stale')
    }
    const mainDecisionBefore = mainGraph.entities.get('e-decision')
    expect(mainDecisionBefore?.payload).toMatchObject({ result: 'reject' })
    const mainScoreBefore = mainGraph.entities.get('e-score')
    expect(mainScoreBefore?.payload).toMatchObject({ score: 60 })

    // 2. 进入时间旅行（store.enterTimeline 同款逻辑）
    const timeline = createTimeline([...events])
    const session = createReplaySession(timeline.mainEvents)

    // 3. 回溯到「简历实体创建前」：动态定位 e-resume-v1 的 entity.create
    //    （剧本里它之前还有 run.start / span.start / e-query / e-policy，index 以实际为准）
    const resumeCreateIndex = events.findIndex(
      (e) => e.type === 'entity.create' && e.entity.id === 'e-resume-v1',
    )
    expect(resumeCreateIndex).toBeGreaterThan(0) // 前提：找到了
    seekTo(session, resumeCreateIndex) // 回到创建前
    expect(session.graph.entities.has('e-resume-v1')).toBe(false)

    // 4. fork 分支（store.fork 同款：在当前位置分叉）+ 注入反事实序列
    //    （store.injectStaleResumeRerun 同款：与 UI 按钮同一推导函数）
    const branch = forkBranch(timeline, resumeCreateIndex, '把简历换成 v3（新鲜）')
    const rerun = staleResumeRerunEvents(events, resumeCreateIndex)
    expect(rerun).not.toBeNull() // 前提：分叉点形态正确（简历创建前）
    branch.events.push(...(rerun ?? []))

    // 5. 建分支会话（store.switchBranch / injectBranchEvents 同款）
    const branchSession = createBranchSession(timeline, branch, session)

    // 【存在性证明】分支上决策 span 的输出与主线不同：
    // a) 决策输出：主线 拒绝 → 分支 邀请面试（评分 60 → 85）
    const branchDecision = branchSession.graph.entities.get('e-decision')
    expect(branchDecision).toBeDefined()
    if (branchDecision !== undefined && mainDecisionBefore !== undefined) {
      expect(branchDecision.payload).toMatchObject({ result: 'interview' })
      expect(mainDecisionBefore.payload).toMatchObject({ result: 'reject' })
      expect(branchDecision.label).not.toBe(mainDecisionBefore.label) // 输出变化
    }
    const branchScore = branchSession.graph.entities.get('e-score')
    expect(branchScore).toBeDefined()
    if (branchScore !== undefined) {
      expect(branchScore.payload).toMatchObject({ score: 85 })
    }

    // b) 根因数据被换新：e-resume-v1 在分支上是 fresh（91 天 → 0 天）
    const branchResume = branchSession.graph.entities.get('e-resume-v1')
    expect(branchResume).toBeDefined()
    if (branchResume !== undefined) {
      const freshness = computeFreshness(branchResume, THRESHOLD)
      expect(freshness.status).toBe('fresh') // ← 反事实生效
      expect(freshness.ageMs).toBe(0)
    }

    // c) 因果骨架在分支上完整：决策 span 溯源仍达检索 span（同一查询逻辑）
    const upstream = traceUpstream(branchSession.graph, 's-decide')
    expect(upstream.spanIds.has('s-retrieve')).toBe(true)

    // d) 主线不受影响（隔离性）。主会话此前被回退到创建前；前进回终点后
    //    全部关键实体仍是原始版本（分支注入未污染主线——独立图实例 +
    //    checkpoint 深拷贝零结构共享）
    seekTo(session, events.length)
    const mainResumeAfter = session.graph.entities.get('e-resume-v1')
    const originalResumeEvent = events[resumeCreateIndex]
    if (originalResumeEvent.type !== 'entity.create') throw new Error('测试前提失败')
    expect(mainResumeAfter).toBeDefined()
    if (mainResumeAfter !== undefined) {
      expect(computeFreshness(mainResumeAfter, THRESHOLD).status).toBe('stale')
      expect(mainResumeAfter.time.createdAt).toBe(originalResumeEvent.entity.time.createdAt)
      expect(mainResumeAfter.label).not.toContain('v3')
    }
    const mainDecisionAfter = session.graph.entities.get('e-decision')
    expect(mainDecisionAfter?.payload).toMatchObject({ result: 'reject' })
  })

  it('staleResumeRerunEvents 对非目标分叉点返回 null（不静默降级）', async () => {
    const scenario = await loadScenarioById('stale-context')
    const events: AgentEvent[] = []
    const handlers: EventHandlers = {
      onEvent: (e) => events.push(e),
      onError: (err) => {
        throw err
      },
      onDone: () => {},
    }
    vi.useFakeTimers()
    try {
      const src = new SimulatedSource([scenario])
      src.start('stale-context', handlers)
      vi.advanceTimersByTime(10_000)
    } finally {
      vi.useRealTimers()
    }
    // 分叉点不在简历创建事件上（step 0 是 run.start）→ null
    expect(staleResumeRerunEvents(events, 0)).toBeNull()
    // 越界 → null
    expect(staleResumeRerunEvents(events, events.length)).toBeNull()
  })
})

describe('T10-0 守卫：store 行为（UI 约定的契约层兜底）', () => {
  // 走 store 全链路（与 UI 按钮同一 action）：跑完剧本 → 时间旅行 →
  // 分叉 → 切分支 → 注入。守卫在此路径上验证，非单独 mock。
  it('分支视图下 fork 返回 null；已注入分支再点推演返回 false（各不产生副作用）', async () => {
    useTraceStore.getState().init()
    await vi.waitFor(() => {
      expect(useTraceStore.getState().scenarios.length).toBeGreaterThan(0)
    }, 5_000)
    // fake timers 先于 startRun 启用：事件源的 setTimeout 要注册进 fake 队列
    vi.useFakeTimers()
    try {
      useTraceStore.getState().startRun('stale-context')
      vi.advanceTimersByTime(10_000)
    } finally {
      vi.useRealTimers()
    }
    const store = useTraceStore.getState()
    expect(store.runState).toBe('done')
    expect(store.timelineTotal).toBe(15)

    // 时间旅行 → 回到简历创建前（step 5）
    store.enterTimeline()
    store.seek(5)

    // 主线视图：fork 正常登记
    const branch = store.fork('守卫测试')
    expect(branch).not.toBeNull()
    expect(useTraceStore.getState().branches).toHaveLength(1)

    // 切到分支视图
    useTraceStore.getState().switchBranch(branch!.id)
    expect(useTraceStore.getState().activeBranchId).toBe(branch!.id)

    // 【守卫 1】分支视图下 fork → null 且不登记新分支（按钮同款禁用，
    // 此处验证契约层兜底——防绕过 UI 的调用路径）
    expect(useTraceStore.getState().fork('不该出现的分支')).toBeNull()
    expect(useTraceStore.getState().branches).toHaveLength(1)

    // 首次注入：true
    expect(useTraceStore.getState().injectStaleResumeRerun()).toBe(true)
    // 【守卫 2】重复注入：false（此前碰巧幂等——替换语义覆盖，图状态
    // 恰好不变；现在把「一份推演」变成契约）
    expect(useTraceStore.getState().injectStaleResumeRerun()).toBe(false)
    // branch.events 只有一份推演序列（10 个事件），未叠加第二份
    expect(branch!.events).toHaveLength(10)
    // 分支视图正常显示推演结果（决策 = 邀请面试）
    const decision = useTraceStore.getState().graph?.entities.get('e-decision')
    expect(decision?.payload).toMatchObject({ result: 'interview' })
  })
})
