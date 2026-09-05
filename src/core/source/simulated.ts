// 剧本驱动的模拟运行时（docs/02 第 8 节的 TraceSource 实现，Phase 0/1 使用）。
// 调度模型：链式调度——任意时刻只挂一个 timer（发完第 i 个再排第 i+1 个），
// pause 只需清掉这一个 timer 并记录剩余毫秒，cancel 同理，不存在泄漏面。
import type { AgentEvent, DataEntity, RunId, Span } from '../types'
import type { EventHandlers, RunHandle, ScenarioMeta, TraceSource } from './types'
import { resolveEvent } from './scenario'
import type { Scenario } from './scenario'

/** 一次运行的生命周期状态；cancelled 与 done 都不再响应 resume */
type RunState = 'running' | 'paused' | 'done' | 'cancelled'

/** 运行归档：loadSnapshot 的数据来源（内存态，无持久化） */
interface RunArchive {
  spans: Span[]
  entities: DataEntity[]
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

/** 把吐出的事件归档成「一次完整运行」的快照（span.end 合并进对应 span） */
function archiveEvent(archive: RunArchive, event: AgentEvent): void {
  switch (event.type) {
    case 'span.start':
      // 拷贝入档：span.end 稍后更新的是归档副本，不污染已发给消费者的事件对象
      archive.spans.push({ ...event.span })
      break
    case 'span.end': {
      const span = archive.spans.find((s) => s.id === event.spanId)
      if (span !== undefined) {
        span.status = event.status
        span.endedAt = event.endedAt
        span.outputEntityIds = mergeUnique(span.outputEntityIds, event.outputEntityIds)
        if (event.error !== undefined) span.error = event.error
      }
      break
    }
    case 'entity.create':
      archive.entities.push({ ...event.entity })
      break
    default:
      // run.start / run.end 不改变归档内容
      break
  }
}

export class SimulatedSource implements TraceSource {
  readonly id = 'simulated'

  private readonly scenarios: Map<string, Scenario>
  private readonly archives: Map<RunId, RunArchive>

  constructor(scenarios: Scenario[]) {
    this.scenarios = new Map(scenarios.map((s) => [s.id, s]))
    this.archives = new Map()
  }

  async listScenarios(): Promise<ScenarioMeta[]> {
    return [...this.scenarios.values()].map(({ id, name, description }) => ({
      id,
      name,
      description,
    }))
  }

  start(scenarioId: string, handlers: EventHandlers): RunHandle {
    const scenario = this.scenarios.get(scenarioId)
    if (scenario === undefined) {
      throw new Error(`未知剧本: ${scenarioId}`)
    }

    // 单 run 剧本：首个事件即 run.start，其 runId 就是本次运行的 id
    const runId: RunId = scenario.steps[0].event.runId
    const runStartedAt = Date.now()

    // 预计算每个事件的计划发生时刻（runStartedAt + 累计 delay），
    // 供 entity.create 省略 observedAtMs 时使用
    const planTimes: number[] = []
    let cursor = runStartedAt
    for (const step of scenario.steps) {
      cursor += step.delayMs
      planTimes.push(cursor)
    }

    const archive: RunArchive = { spans: [], entities: [] }
    this.archives.set(runId, archive)

    let state: RunState = 'running'
    let nextIndex = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let plannedFireAt = 0
    // null 表示「暂停发生在事件间隙（fire 执行中，onEvent 回调内）」：
    // 下一事件尚未排期，resume 时按其完整 delayMs 重排
    let remainingMs: number | null = null

    const armTimer = (delayMs: number): void => {
      plannedFireAt = Date.now() + delayMs
      timer = setTimeout(fire, delayMs)
    }

    const fire = (): void => {
      timer = null
      if (state !== 'running') return
      const step = scenario.steps[nextIndex]
      const event = resolveEvent(step.event, runStartedAt, planTimes[nextIndex])
      nextIndex += 1
      archiveEvent(archive, event)
      handlers.onEvent(event)
      if (nextIndex >= scenario.steps.length) {
        // 自然结束。onEvent 内可能已把 state 置为 paused / cancelled，
        // 那是调用方的明确意图，不得被 done 覆盖（T2 审查必修项）。
        if (state !== 'running') return
        state = 'done'
        handlers.onDone()
        return
      }
      // onEvent 内同步调用过 pause/cancel 时不再排下一个事件
      if (state !== 'running') return
      armTimer(scenario.steps[nextIndex].delayMs)
    }

    armTimer(scenario.steps[0].delayMs)

    return {
      runId,
      pause(): void {
        // 只判 state，不把 timer === null 当提前返回条件：
        // onEvent 回调内调 pause 时 timer 已被 fire 置 null，但运行并未真正暂停
        if (state !== 'running') return
        state = 'paused'
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
          remainingMs = Math.max(0, plannedFireAt - Date.now())
        } else {
          remainingMs = null
        }
      },
      resume(): void {
        if (state !== 'paused') return
        state = 'running'
        // 暂停发生在最后一个事件的 onEvent 内：事件已全部发完，补上收尾
        if (nextIndex >= scenario.steps.length) {
          state = 'done'
          handlers.onDone()
          return
        }
        // 事件间隙暂停（timer 未挂）时按完整 delay 重排，不沿用旧 remaining
        armTimer(remainingMs ?? scenario.steps[nextIndex].delayMs)
      },
      cancel(): void {
        // 主动取消：先置状态再清 timer，之后不再吐任何事件，
        // 也不触发 onDone / onError（二者专属「自然结束」与「出错」）。
        // 在最后一个事件的 onEvent 内 cancel 时，靠 state 守住不被 done 覆盖
        if (state === 'done' || state === 'cancelled') return
        state = 'cancelled'
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      },
    }
  }

  async loadSnapshot(runId: RunId): Promise<{ spans: Span[]; entities: DataEntity[] }> {
    const archive = this.archives.get(runId)
    if (archive === undefined) {
      throw new Error(`没有可回放的运行记录: ${runId}`)
    }
    // 返回数组浅拷贝，避免调用方增删元素污染归档
    return { spans: [...archive.spans], entities: [...archive.entities] }
  }
}
