// T2 验收测试：剧本校验、跑完 stale-context 的新鲜度断言（91 天）、
// cancel / pause / resume 行为、loadSnapshot 归档。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadScenario } from './scenario'
import { loadScenarioById } from './registry'
import type { AgentEvent } from '../types'
import { SimulatedSource } from './simulated'
import type { EventHandlers } from './types'

const DAY_MS = 86_400_000

/** 剧本经注册表加载（T6 修补 3）：测试不直接 import 剧本 JSON */
const staleContext = await loadScenarioById('stale-context')

/** 收集一次运行吐出的全部事件；advance 足够大的时间让流自然结束 */
function runAll(scenarioId: string): {
  events: AgentEvent[]
  onDoneCount: number
  source: SimulatedSource
} {
  const source = new SimulatedSource([staleContext])
  const events: AgentEvent[] = []
  let onDoneCount = 0
  const handlers: EventHandlers = {
    onEvent: (e) => events.push(e),
    onError: (err) => {
      throw err
    },
    onDone: () => {
      onDoneCount += 1
    },
  }
  source.start(scenarioId, handlers)
  vi.advanceTimersByTime(10_000)
  return { events, onDoneCount, source }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('loadScenario 剧本校验', () => {
  it('stale-context.json 是合法剧本，能被加载', () => {
    const scenario = staleContext
    expect(scenario.id).toBe('stale-context')
    expect(scenario.name).toBe('过期上下文导致错误拒绝')
    expect(scenario.steps.length).toBe(15)
    expect(scenario.expectedRootCause.spanId).toBe('s-retrieve')
  })

  it('非法剧本直接抛错，不静默吞掉', () => {
    expect(() => loadScenario({ garbage: true })).toThrow()
    expect(() => loadScenario({ id: 'x', name: 'x', description: 'x', steps: [] })).toThrow()
    expect(() =>
      loadScenario({
        id: 'x',
        name: 'x',
        description: 'x',
        expectedRootCause: { spanId: 's', reason: 'r' },
        steps: [{ delayMs: -1, event: { type: 'run.end', runId: 'r', endedAt: 0, status: 'ok' } }],
      }),
    ).toThrow()
    expect(() =>
      loadScenario({
        id: 'x',
        name: 'x',
        description: 'x',
        expectedRootCause: { spanId: 's', reason: 'r' },
        steps: [{ delayMs: 0, event: { type: 'run.end', runId: 'r', endedAt: 0, status: 'oops' } }],
      }),
    ).toThrow()
  })
})

describe('跑完 stale-context 剧本', () => {
  it('吐出全部 15 个事件，最后一个为 run.end，onDone 恰好一次', () => {
    const { events, onDoneCount } = runAll('stale-context')
    expect(events.length).toBe(15)
    expect(events[events.length - 1]).toMatchObject({ type: 'run.end', status: 'ok' })
    expect(onDoneCount).toBe(1)
  })

  it('e-resume-v1 的 observedAt - createdAt 约等于 91 天', () => {
    const { events } = runAll('stale-context')
    const created = events.filter((e) => e.type === 'entity.create')
    const resume = created.find(
      (e) => e.type === 'entity.create' && e.entity.id === 'e-resume-v1',
    )
    if (resume === undefined || resume.type !== 'entity.create') {
      throw new Error('未收到 e-resume-v1 的 entity.create 事件')
    }
    const age = resume.entity.time.observedAt - resume.entity.time.createdAt
    // 计划发生时刻在 run 后 800ms，允许 ±2s 容差
    expect(age).toBeGreaterThanOrEqual(91 * DAY_MS)
    expect(age).toBeLessThan(91 * DAY_MS + 2_000)
  })

  it('对照组 e-policy 仅过期约 2 天', () => {
    const { events } = runAll('stale-context')
    const created = events.filter((e) => e.type === 'entity.create')
    const policy = created.find((e) => e.type === 'entity.create' && e.entity.id === 'e-policy')
    if (policy === undefined || policy.type !== 'entity.create') {
      throw new Error('未收到 e-policy 的 entity.create 事件')
    }
    const age = policy.entity.time.observedAt - policy.entity.time.createdAt
    expect(age).toBeGreaterThanOrEqual(2 * DAY_MS)
    expect(age).toBeLessThan(2 * DAY_MS + 2_000)
  })

  it('loadSnapshot 返回本次运行的 spans 与 entities（span.end 已合并）', async () => {
    const { source } = runAll('stale-context')
    const snapshot = await source.loadSnapshot('run-stale-demo')
    expect(snapshot.spans.length).toBe(4)
    expect(snapshot.entities.length).toBe(5)
    const decide = snapshot.spans.find((s) => s.id === 's-decide')
    expect(decide?.status).toBe('ok')
    expect(decide?.endedAt).not.toBeNull()
    expect(decide?.outputEntityIds).toContain('e-decision')
  })
})

describe('RunHandle 控制语义', () => {
  it('cancel() 后不再有新事件吐出', () => {
    const source = new SimulatedSource([staleContext])
    const events: AgentEvent[] = []
    const handlers: EventHandlers = {
      onEvent: (e) => events.push(e),
      onError: (err) => {
        throw err
      },
      onDone: () => {},
    }
    const handle = source.start('stale-context', handlers)
    vi.advanceTimersByTime(1_000)
    handle.cancel()
    const countAtCancel = events.length
    vi.advanceTimersByTime(60_000)
    expect(events.length).toBe(countAtCancel)
    expect(countAtCancel).toBeGreaterThan(0)
    expect(countAtCancel).toBeLessThan(15)
  })

  it('pause() 后事件暂停，resume() 后从暂停处继续跑完', () => {
    const source = new SimulatedSource([staleContext])
    const events: AgentEvent[] = []
    let onDoneCount = 0
    const handlers: EventHandlers = {
      onEvent: (e) => events.push(e),
      onError: (err) => {
        throw err
      },
      onDone: () => {
        onDoneCount += 1
      },
    }
    const handle = source.start('stale-context', handlers)

    vi.advanceTimersByTime(1_000)
    handle.pause()
    const countAtPause = events.length
    expect(countAtPause).toBe(7) // 计划时刻 ≤1000ms 的事件共 7 个（第 7 个在 900ms）

    vi.advanceTimersByTime(60_000)
    expect(events.length).toBe(countAtPause) // 暂停期间无新事件

    handle.resume()
    vi.advanceTimersByTime(10_000)
    expect(events.length).toBe(15) // 从暂停处继续直至跑完
    expect(onDoneCount).toBe(1)
  })

  it('T3b 修补 3：onEvent 回调内调用 pause()，暂停生效且 resume 后继续跑完', () => {
    const source = new SimulatedSource([staleContext])
    const events: AgentEvent[] = []
    let handle: ReturnType<SimulatedSource['start']> | null = null
    const handlers: EventHandlers = {
      onEvent: (e) => {
        events.push(e)
        // 第 3 个事件的回调内同步暂停：此时 fire() 尚未排下一个 timer，
        // 修补前 pause 会因 timer === null 被静默忽略
        if (events.length === 3) handle?.pause()
      },
      onError: (err) => {
        throw err
      },
      onDone: () => {},
    }
    handle = source.start('stale-context', handlers)

    vi.advanceTimersByTime(10_000)
    expect(events.length).toBe(3) // 暂停后不再有新事件吐出

    handle.resume()
    vi.advanceTimersByTime(10_000)
    expect(events.length).toBe(15) // 从暂停处继续跑完全部事件
  })

  it('T3b 修补 3：最后一个事件的 onEvent 内 cancel()，不被 done 覆盖、不触发 onDone', () => {
    const source = new SimulatedSource([staleContext])
    let onDoneCount = 0
    let handle: ReturnType<SimulatedSource['start']> | null = null
    const handlers: EventHandlers = {
      onEvent: (e) => {
        // run.end 是最后一个事件：此刻 cancel，fire() 的自然结束分支
        // 不得用 done 覆盖 cancelled、不得误报 onDone
        if (e.type === 'run.end') handle?.cancel()
      },
      onError: (err) => {
        throw err
      },
      onDone: () => {
        onDoneCount += 1
      },
    }
    handle = source.start('stale-context', handlers)
    vi.advanceTimersByTime(10_000)
    expect(onDoneCount).toBe(0)
  })

  it('listScenarios 返回剧本元信息', async () => {
    const source = new SimulatedSource([staleContext])
    const metas = await source.listScenarios()
    expect(metas).toEqual([
      {
        id: 'stale-context',
        name: '过期上下文导致错误拒绝',
        description: expect.any(String),
      },
    ])
  })

  it('未知剧本与未知运行记录均抛错', async () => {
    const source = new SimulatedSource([staleContext])
    const handlers: EventHandlers = {
      onEvent: () => {},
      onError: () => {},
      onDone: () => {},
    }
    expect(() => source.start('no-such-scenario', handlers)).toThrow()
    await expect(source.loadSnapshot('no-such-run')).rejects.toThrow()
  })
})
