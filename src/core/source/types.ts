// 数据源抽象（docs/02 第 8、9 节）。
// 三个实现的演进顺序：SimulatedSource（T2）→ ReplaySource（Phase 1）
// → DecisionCourtSource（Phase 2，接真实 SSE 流）。
import type { AgentEvent } from '../types'
import type { DataEntity, RunId, Span } from '../types'

export interface EventHandlers {
  onEvent(e: AgentEvent): void
  onError(err: Error): void
  onDone(): void
}

export interface RunHandle {
  runId: RunId
  pause(): void
  resume(): void
  cancel(): void
}

export interface ScenarioMeta {
  id: string
  name: string
  description: string
}

export interface TraceSource {
  readonly id: string
  listScenarios(): Promise<ScenarioMeta[]>
  /** 按剧本启动一次模拟运行，按 delayMs 定时吐出事件 */
  start(scenarioId: string, handlers: EventHandlers): RunHandle
  /** 加载一次完整运行（离线回放） */
  loadSnapshot(runId: RunId): Promise<{ spans: Span[]; entities: DataEntity[] }>
}
