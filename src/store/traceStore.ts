// traceStore：Zustand 唯一状态源（docs/03 T5；T9 第五部分增 timeline）。
//
// 职责边界：
// - 订阅事件源 → applyEvent 增量建图 → updateLayout 增量布局（dirty 约定
//   统一走 timeline/checkpoint 的 dirtyOf——T9 前同一约定复制 6 处）
// - 把 CausalGraph + Layout 组装成 render 层可用的 Scene 视图模型
//   （组装纯函数在 ./scene.ts）
// - 选中 span → traceUpstream 高亮上游链、其余 dimmed；点空白取消
// - T9 时间旅行：run 结束后可建 ReplaySession（回溯任意 step / fork 分支 /
//   分支切换）。会话持有自己的 graph/layout——timeline 模式下 store 的
//   graph/scene 直接指向会话状态；回到 live 模式（新 startRun）即丢弃
//
// 副作用集中在本文件与 source/（01 §5 代码风格约定）。
import { create } from 'zustand'
import { loadAllScenarios } from '../core/source/registry'
import { SimulatedSource } from '../core/source/simulated'
import type { RunHandle, ScenarioMeta } from '../core/source/types'
import { applyEvent, createGraph } from '../core/graph/build'
import { layoutGraph, updateLayout } from '../core/graph/layout'
import { buildScene, emptyScene } from './scene'
import { staleResumeRerunEvents } from './counterfactual'
import { dirtyOf } from '../core/timeline/checkpoint'
import {
  createBranchSession,
  createTimeline,
  forkBranch,
  type Branch,
  type Timeline,
} from '../core/timeline/branch'
import {
  createReplaySession,
  seekTo,
  type ReplaySession,
} from '../core/timeline/checkpoint'
import type {
  AgentEvent,
  CausalGraph,
  DataEntity,
  EntityId,
  RunId,
  SpanId,
} from '../core/types'
import type { Scene } from '../render/draw-node'
import type { Viewport } from '../render/viewport'

/** 新鲜度阈值常量自 scene.ts 移出后在此 re-export，UI 层既有导入不破 */
export { FRESHNESS_THRESHOLD_MS } from './scene'

type RunState = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'error'

// —— 模块级单例：事件源与运行句柄不进 React 状态（不可序列化且无渲染需求） ——

let source: SimulatedSource | null = null
/** 剧本 id → runId（单 run 剧本：首个事件的 runId 即本次运行的 id） */
const scenarioRunIds = new Map<string, RunId>()
/** init 只发起一次装配（StrictMode 下 effect 会重入，防重复加载） */
let initStarted = false
let runHandle: RunHandle | null = null
/** 本轮 run 的原始事件流（时间旅行的输入）：onEvent 时同步收集。
 *  注意存的是 SimulatedSource resolve 过的 AgentEvent（绝对时间戳），
 *  不是剧本偏移事件——回放一致性由此与 live 图完全同源。 */
let mainEvents: AgentEvent[] = []

// —— Store ——

interface TraceStoreState {
  scenarios: ScenarioMeta[]
  scenarioId: string | null
  runState: RunState
  runError: string | null
  graph: CausalGraph | null
  scene: Scene
  selectedSpanId: SpanId | null
  selectedEntityId: EntityId | null
  viewport: Viewport
  // —— T9 时间旅行状态 ——
  /** 当前时间轴位置（已应用事件数）；live 模式（null）= 跟随事件流 */
  timelinePosition: number | null
  /** 主线事件总数（时间轴 max；live 中跟随增长） */
  timelineTotal: number
  /** 分支登记表（含 note 供 UI 展示） */
  branches: Branch[]
  /** 当前激活分支：null = 主线 */
  activeBranchId: string | null
  init(): void
  startRun(scenarioId: string): void
  pauseRun(): void
  resumeRun(): void
  cancelRun(): void
  selectSpan(spanId: SpanId | null): void
  selectEntity(entityId: EntityId | null): void
  clearSelection(): void
  setViewport(viewport: Viewport): void
  // —— T9 timeline actions ——
  /** run 结束后建立回溯会话（时间旅行入口；进行中调用是 no-op） */
  enterTimeline(): void
  /** 拖时间轴：回退/前进到 target（会话内混合策略） */
  seek(target: number): void
  /** 在当前位置 fork 分支；注入修改事件后由 UI 再调用 refreshBranch */
  fork(note: string): Branch | null
  /** 向当前激活分支批量注入事件并重建该分支会话。branch.events 变更后
   *  既有会话失效（组合流快照过时）——**重建时机收敛在此一处**：每次
   *  注入整批重建一次（组合流 = 主线前缀 + 分支事件，checkpoint 复用
   *  下重建成本 ≈ 增量段重放，无需逐事件重建） */
  injectBranchEvents(events: AgentEvent[]): void
  /** 切换主线/分支视图（分支无会话则按需建） */
  switchBranch(branchId: string | null): void
  /** 查询实体在**主线终态**上的版本（分支对比用：store 只暴露当前视图
   *  的 graph，主线会话在模块级——经此方法读取，不复制进 React 状态） */
  entityOnMain(entityId: EntityId): DataEntity | null
  /** stale-context 反事实推演（验收演示闭环）：向当前激活分支注入
   *  「新鲜简历 + 推定的下游重跑」（推导在 ./counterfactual.ts，与
   *  timeline-e2e 测试同一函数）。分叉点不在简历创建前、非该剧本、
   *  或该分支已注入过事件时 no-op 并返回 false（UI 据此提示，不静默
   *  降级）。已注入守卫（T10-0）：重复注入此前碰巧幂等——替换语义
   *  让第二份序列覆盖第一份、图状态不变，但那是侥幸而非契约 */
  injectStaleResumeRerun(): boolean
}

/** 模块级时间旅行会话（不进 React 状态：含 journal/checkpoints 大对象，
 *  store 只暴露派生视图）。null = live 模式。 */
let session: ReplaySession | null = null
/** 主线**终态**图（enterTimeline 时从 live 路径捕获——live 图与全量回放
 *  逐字段一致，T9 e2e 断言过）。时间旅行期间 session 会被 seek 回退，
 *  分支对比需要的是终态基准，故单独持有；startRun 归零。 */
let mainFinalGraph: CausalGraph | null = null
let timeline: Timeline | null = null
/** 分支 id → 该分支的会话（按需建、injectBranchEvents 后重建） */
const branchSessions = new Map<string, ReplaySession>()

export const useTraceStore = create<TraceStoreState>()((set, get) => ({
  scenarios: [],
  scenarioId: null,
  runState: 'idle',
  runError: null,
  graph: null,
  scene: emptyScene(),
  selectedSpanId: null,
  selectedEntityId: null,
  viewport: { scale: 1, offsetX: 0, offsetY: 0 },
  timelinePosition: null,
  timelineTotal: 0,
  branches: [],
  activeBranchId: null,

  init: () => {
    if (initStarted) return
    initStarted = true
    void loadAllScenarios()
      .then((list) => {
        source = new SimulatedSource(list)
        for (const scenario of list) {
          scenarioRunIds.set(scenario.id, scenario.steps[0].event.runId)
        }
        set({
          scenarios: list.map(({ id, name, description }) => ({ id, name, description })),
        })
      })
      .catch((err: unknown) => {
        set({ runError: err instanceof Error ? err.message : String(err) })
      })
  },

  startRun: (scenarioId) => {
    const runId = scenarioRunIds.get(scenarioId)
    if (runId === undefined) return
    const activeSource = source
    if (activeSource === null) return
    runHandle?.cancel()
    // 新 run：丢弃全部时间旅行状态（会话/分支/事件流归零）
    session = null
    mainFinalGraph = null
    timeline = null
    branchSessions.clear()
    mainEvents = []
    const graph = createGraph(runId)
    runHandle = activeSource.start(scenarioId, {
      onEvent: (event: AgentEvent) => {
        const state = get()
        if (state.graph !== graph) return // 已被新一次 startRun 取代，丢弃迟到事件
        mainEvents.push(event)
        const dirty = new Set<SpanId>()
        dirtyOf(event, dirty)
        applyEvent(graph, event)
        const baseLayout = updateLayout(state.scene.layout, graph, dirty)
        const scene = buildScene(graph, baseLayout, state.selectedSpanId, state.scene.version + 1)
        set({ scene, timelineTotal: mainEvents.length })
      },
      onDone: () => {
        if (get().graph !== graph) return
        set({ runState: 'done' })
      },
      onError: (err: Error) => {
        if (get().graph !== graph) return
        set({ runState: 'error', runError: err.message })
      },
    })
    set({
      scenarioId,
      graph,
      runState: 'running',
      runError: null,
      selectedSpanId: null,
      selectedEntityId: null,
      scene: buildScene(graph, layoutGraph(graph), null, 1),
      viewport: { scale: 1, offsetX: 0, offsetY: 0 },
      timelinePosition: null,
      timelineTotal: 0,
      branches: [],
      activeBranchId: null,
    })
  },

  pauseRun: () => {
    if (get().runState !== 'running') return
    runHandle?.pause()
    set({ runState: 'paused' })
  },

  resumeRun: () => {
    if (get().runState !== 'paused') return
    set({ runState: 'running' })
    runHandle?.resume()
  },

  cancelRun: () => {
    const state = get()
    if (state.runState !== 'running' && state.runState !== 'paused') return
    runHandle?.cancel()
    runHandle = null
    set({ runState: 'cancelled' })
  },

  selectSpan: (spanId) => {
    const state = get()
    const graph = state.graph
    if (graph === null) return
    const selected = spanId !== null && graph.spans.has(spanId) ? spanId : null
    set({
      selectedSpanId: selected,
      selectedEntityId: null,
      scene: buildScene(graph, state.scene.layout, selected, state.scene.version + 1),
    })
  },

  selectEntity: (entityId) => {
    const state = get()
    if (entityId === null) {
      if (state.selectedEntityId === null) return
      set({ selectedEntityId: null, scene: { ...state.scene, version: state.scene.version + 1 } })
      return
    }
    if (state.graph?.entities.has(entityId) !== true) return
    set({ selectedEntityId: entityId, scene: { ...state.scene, version: state.scene.version + 1 } })
  },

  clearSelection: () => {
    const state = get()
    if (state.selectedSpanId === null && state.selectedEntityId === null) return
    const graph = state.graph
    const scene =
      graph !== null
        ? buildScene(graph, state.scene.layout, null, state.scene.version + 1)
        : { ...state.scene, version: state.scene.version + 1 }
    set({ selectedSpanId: null, selectedEntityId: null, scene })
  },

  setViewport: (viewport) => {
    set({ viewport })
  },

  // —— T9 timeline actions ——

  enterTimeline: () => {
    const state = get()
    // 只在 run 结束后可进入（进行中的流 position 语义未定）
    if (state.runState !== 'done' && state.runState !== 'cancelled') return
    if (mainEvents.length === 0) return
    if (session !== null) return // 已在时间旅行模式
    timeline = createTimeline([...mainEvents])
    session = createReplaySession(timeline.mainEvents)
    mainFinalGraph = state.graph // 捕获主线终态（分支对比基准，见声明处注释）
    set({
      timelinePosition: session.applied,
      timelineTotal: session.events.length,
      branches: [],
      activeBranchId: null,
    })
  },

  seek: (target) => {
    const state = get()
    // 激活分支时 seek 分支会话，否则 seek 主会话
    const active =
      state.activeBranchId !== null ? branchSessions.get(state.activeBranchId) : session
    if (active === undefined || active === null) return
    seekTo(active, target)
    const scene = buildScene(active.graph, active.layout, null, state.scene.version + 1)
    set({
      graph: active.graph,
      scene,
      selectedSpanId: null,
      selectedEntityId: null,
      timelinePosition: active.applied,
      timelineTotal: active.events.length,
    })
  },

  fork: (note) => {
    const state = get()
    if (timeline === null || session === null) return null
    // fork 只发生在主时间线当前位置。分支视图下 no-op（T10-0 守卫）：
    // 此前靠注释维持「先切回主线」的约定，用户在分支视图点分叉会静默
    // fork 主线位置——所见与所得不一致。UI 侧按钮同步禁用，此处是契约
    // 层兜底（防未来其他调用路径绕过 UI）
    if (state.activeBranchId !== null) return null
    const at = session.applied
    const branch = forkBranch(timeline, at, note)
    set({ branches: [...timeline.branches] })
    return branch
  },

  injectBranchEvents: (events) => {
    const state = get()
    if (timeline === null || state.activeBranchId === null) return
    const branch = timeline.branches.find((b) => b.id === state.activeBranchId)
    if (branch === undefined || session === null) return
    branch.events.push(...events)
    // branch.events 变更 ⟹ 既有分支会话的组合流快照失效——重建
    const rebuilt = createBranchSession(timeline, branch, session)
    branchSessions.set(branch.id, rebuilt)
    const scene = buildScene(rebuilt.graph, rebuilt.layout, null, state.scene.version + 1)
    set({
      graph: rebuilt.graph,
      scene,
      selectedSpanId: null,
      selectedEntityId: null,
      timelinePosition: rebuilt.applied,
      timelineTotal: rebuilt.events.length,
    })
  },

  entityOnMain: (entityId) => {
    if (mainFinalGraph === null) return null
    return mainFinalGraph.entities.get(entityId) ?? null
  },

  injectStaleResumeRerun: () => {
    const state = get()
    if (timeline === null || state.activeBranchId === null) return false
    const branch = timeline.branches.find((b) => b.id === state.activeBranchId)
    if (branch === undefined) return false
    if (branch.events.length > 0) return false // 已注入守卫（见接口注释）
    const events = staleResumeRerunEvents(timeline.mainEvents, branch.baseEventIndex)
    if (events === null) return false
    get().injectBranchEvents(events)
    return true
  },

  switchBranch: (branchId) => {
    const state = get()
    if (timeline === null || session === null) return
    if (branchId === null) {
      // 回主线：显示主会话当前位置
      const scene = buildScene(session.graph, session.layout, null, state.scene.version + 1)
      set({
        graph: session.graph,
        scene,
        selectedSpanId: null,
        selectedEntityId: null,
        activeBranchId: null,
        timelinePosition: session.applied,
        timelineTotal: session.events.length,
      })
      return
    }
    const branch = timeline.branches.find((b) => b.id === branchId)
    if (branch === undefined) return
    // 按需建会话（裁决 11 条 1：切换到哪条才建哪条的图）；inject 后已重建则复用
    let branchSession = branchSessions.get(branchId)
    if (branchSession === undefined) {
      branchSession = createBranchSession(timeline, branch, session)
      branchSessions.set(branchId, branchSession)
    }
    const scene = buildScene(
      branchSession.graph,
      branchSession.layout,
      null,
      state.scene.version + 1,
    )
    set({
      graph: branchSession.graph,
      scene,
      selectedSpanId: null,
      selectedEntityId: null,
      activeBranchId: branchId,
      timelinePosition: branchSession.applied,
      timelineTotal: branchSession.events.length,
    })
  },
}))
