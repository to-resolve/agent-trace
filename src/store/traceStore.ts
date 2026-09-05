// traceStore：Zustand 唯一状态源（docs/03 T5）。
//
// 职责边界：
// - 订阅事件源 → applyEvent 增量建图 → updateLayout 增量布局（dirty 约定
//   见 layout.ts 文件头：span.start 标自身、entity.create 标 producedBy）
// - 把 CausalGraph + Layout 组装成 render 层可用的 Scene 视图模型
//   （组装纯函数在 ./scene.ts，T7 抽出供 bench 直接引用）
// - 选中 span → traceUpstream 高亮上游链、其余 dimmed；点空白取消
//
// 副作用集中在本文件与 source/（01 §5 代码风格约定）。
import { create } from 'zustand'
import { loadAllScenarios } from '../core/source/registry'
import { SimulatedSource } from '../core/source/simulated'
import type { RunHandle, ScenarioMeta } from '../core/source/types'
import { applyEvent, createGraph } from '../core/graph/build'
import { layoutGraph, updateLayout } from '../core/graph/layout'
import { buildScene, emptyScene } from './scene'
import type {
  AgentEvent,
  CausalGraph,
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
//
// 事件源由剧本注册表在 init() 首次调用时异步装配（glob 懒加载），
// 装配完成前 source 为 null——此时剧本列表尚为空，UI 上不存在可点的
// 播放按钮，startRun 的双守卫只是类型收窄的防御。

let source: SimulatedSource | null = null
/** 剧本 id → runId（单 run 剧本：首个事件的 runId 即本次运行的 id） */
const scenarioRunIds = new Map<string, RunId>()
/** init 只发起一次装配（StrictMode 下 effect 会重入，防重复加载） */
let initStarted = false
let runHandle: RunHandle | null = null

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
  init(): void
  startRun(scenarioId: string): void
  pauseRun(): void
  resumeRun(): void
  cancelRun(): void
  selectSpan(spanId: SpanId | null): void
  selectEntity(entityId: EntityId | null): void
  clearSelection(): void
  setViewport(viewport: Viewport): void
}

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

  init: () => {
    if (initStarted) return
    initStarted = true
    void loadAllScenarios()
      .then((list) => {
        source = new SimulatedSource(list)
        for (const scenario of list) {
          scenarioRunIds.set(scenario.id, scenario.steps[0].event.runId)
        }
        // 先装配 source 再 set 剧本列表：列表一旦渲染，播放就绪
        set({
          scenarios: list.map(({ id, name, description }) => ({ id, name, description })),
        })
      })
      .catch((err: unknown) => {
        // 剧本装配失败（非法 JSON / 结构校验不过）上屏暴露，不静默吞
        set({ runError: err instanceof Error ? err.message : String(err) })
      })
  },

  startRun: (scenarioId) => {
    const runId = scenarioRunIds.get(scenarioId)
    if (runId === undefined) return
    const activeSource = source
    if (activeSource === null) return
    runHandle?.cancel()
    const graph = createGraph(runId)
    runHandle = activeSource.start(scenarioId, {
      onEvent: (event: AgentEvent) => {
        const state = get()
        if (state.graph !== graph) return // 已被新一次 startRun 取代，丢弃迟到事件
        const dirty = new Set<SpanId>()
        if (event.type === 'span.start') {
          dirty.add(event.span.id)
        } else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
          dirty.add(event.entity.producedBy)
        }
        applyEvent(graph, event)
        const baseLayout = updateLayout(state.scene.layout, graph, dirty)
        const scene = buildScene(graph, baseLayout, state.selectedSpanId, state.scene.version + 1)
        set({ scene })
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
    // 徽章点击保留 span 高亮链：只切换检查器内容，图上的溯源高亮不动
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
}))
