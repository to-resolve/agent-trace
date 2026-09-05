// 剧本加载、校验与时间偏移换算（docs/02 第 9 节 + docs/04 第 1 节）。
//
// 为什么剧本里存相对偏移而不是绝对时间戳：剧本要可重复运行、可移植，
// 每次运行时由 resolveEvent 以 runStartedAt 为基准换算成绝对时间。
import type { AgentEvent, DataEntity, RunId } from '../types'
import { isAgentEvent } from '../events'
import type { ScenarioMeta } from './types'

/**
 * 剧本文件中的实体形式：与 DataEntity 同构，但 time 换成相对 run 起点的偏移。
 * 负的 createdAtMs 表示数据产生早于本次运行（过期数据）。
 */
export interface ScenarioEntity extends Omit<DataEntity, 'time'> {
  timeOffset: {
    /** 数据自身产生时刻相对 run 开始的偏移，负数表示过期数据 */
    createdAtMs: number
    /** 被读取时刻相对 run 开始的偏移；省略时取事件实际发生时刻 */
    observedAtMs?: number
  }
}

/**
 * 剧本文件中的事件。五种事件与 AgentEvent 形状相同（时间字段的语义
 * 是「相对 run 起点的偏移」），唯 entity.create 的实体用 timeOffset；
 * run.snapshot 属回放语义，不允许出现在剧本里。
 */
export type ScenarioEvent =
  | Exclude<AgentEvent, { type: 'entity.create' } | { type: 'run.snapshot' }>
  | { type: 'entity.create'; runId: RunId; entity: ScenarioEntity }

/** 剧本（docs/02 第 9 节）：数据不是代码，新增剧本不需要改代码 */
export interface Scenario extends ScenarioMeta {
  /** 用于自动化验收：期望用户最终能定位到的根因 span */
  expectedRootCause: { spanId: string; reason: string }
  steps: ReadonlyArray<{
    /** 相对上一个事件的延迟，模拟真实耗时 */
    delayMs: number
    event: ScenarioEvent
  }>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number'
}

/**
 * 剧本事件的运行时守卫。校验策略：非 entity.create 事件形状与
 * AgentEvent 完全相同，直接复用 isAgentEvent；entity.create 把
 * timeOffset 替换成 dummy time 后再走 isAgentEvent，从而复用
 * T1 已有的全字段结构校验，避免维护两份校验逻辑。
 */
function isScenarioEvent(v: unknown): v is ScenarioEvent {
  if (!isRecord(v)) return false
  if (v.type !== 'entity.create') return isAgentEvent(v)
  if (!isRecord(v.entity)) return false
  const { timeOffset, ...rest } = v.entity
  if (!isRecord(timeOffset) || !isNumber(timeOffset.createdAtMs)) return false
  if (timeOffset.observedAtMs !== undefined && !isNumber(timeOffset.observedAtMs)) return false
  return isAgentEvent({ ...v, entity: { ...rest, time: { createdAt: 0, observedAt: 0 } } })
}

/**
 * 加载并校验剧本。非法剧本直接抛错，绝不静默吞掉——
 * 剧本是 T3 之后一切因果推导的输入，坏输入必须尽早暴露。
 */
export function loadScenario(raw: unknown): Scenario {
  if (!isRecord(raw)) {
    throw new Error('剧本必须是 JSON 对象')
  }
  const { id, name, description, expectedRootCause, steps } = raw
  if (!isString(id) || !isString(name) || !isString(description)) {
    throw new Error('剧本缺少 id / name / description 字符串字段')
  }
  if (
    !isRecord(expectedRootCause) ||
    !isString(expectedRootCause.spanId) ||
    !isString(expectedRootCause.reason)
  ) {
    throw new Error(`剧本 ${id} 的 expectedRootCause 必须含 spanId 与 reason 字符串`)
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`剧本 ${id} 的 steps 必须是非空数组`)
  }
  const checkedSteps = steps.map((step: unknown, index: number) => {
    if (!isRecord(step) || !isNumber(step.delayMs) || step.delayMs < 0) {
      throw new Error(`剧本 ${id} 第 ${index + 1} 步的 delayMs 必须是非负数字`)
    }
    if (!isScenarioEvent(step.event)) {
      throw new Error(`剧本 ${id} 第 ${index + 1} 步的 event 不是合法的剧本事件`)
    }
    return { delayMs: step.delayMs, event: step.event }
  })
  return {
    id,
    name,
    description,
    expectedRootCause: { spanId: expectedRootCause.spanId, reason: expectedRootCause.reason },
    steps: checkedSteps,
  }
}

/**
 * 把一个剧本事件换算成带绝对时间戳的标准事件。
 * - 剧本中所有 number 时间字段都是相对 run 起点的偏移，统一加 runStartedAt
 * - observedAt 省略时取 planTime（该事件的计划发生时刻 = runStartedAt + 累计 delay），
 *   而非 fire 时的墙上时钟：让结果只依赖剧本与基准，不受定时器抖动影响
 */
export function resolveEvent(
  event: ScenarioEvent,
  runStartedAt: number,
  planTime: number,
): AgentEvent {
  switch (event.type) {
    case 'run.start':
      return { ...event, startedAt: event.startedAt + runStartedAt }
    case 'run.end':
      return { ...event, endedAt: event.endedAt + runStartedAt }
    case 'span.start':
      return { ...event, span: { ...event.span, startedAt: event.span.startedAt + runStartedAt } }
    case 'span.end':
      return { ...event, endedAt: event.endedAt + runStartedAt }
    case 'entity.create': {
      const { timeOffset, ...rest } = event.entity
      const observedAt =
        timeOffset.observedAtMs !== undefined
          ? runStartedAt + timeOffset.observedAtMs
          : planTime
      return {
        ...event,
        entity: {
          ...rest,
          time: { createdAt: runStartedAt + timeOffset.createdAtMs, observedAt },
        },
      }
    }
  }
}
