// 事件协议层（自研 AG-UI 子集，见 docs/02 第 7 节；不安装 @ag-ui/*）。
// 本模块的职责：把「来源不可信的运行时数据」（剧本 JSON、回放文件、SSE 报文）
// 收窄为类型安全的 AgentEvent。事件语义处理（顺序校验、图构建）属后续任务卡。
import type { AgentEvent, DataEntity, Span } from './types'

export type { AgentEvent }

// —— 事件顺序约束（docs/02 第 7 节，T2 事件源须按此假设实现）——
// 1. entity.create 必须早于任何引用它的 span.start
// 2. span.start 必须早于同 spanId 的 span.end
// 3. run.snapshot 只能出现在流的最开始（回放场景）或断线重连后的第一条

const SPAN_KINDS: ReadonlySet<string> = new Set([
  'agent',
  'llm',
  'tool',
  'retrieval',
  'decision',
])
const SPAN_STATUSES: ReadonlySet<string> = new Set(['running', 'ok', 'error'])
const RUN_END_STATUSES: ReadonlySet<string> = new Set(['ok', 'error'])
const ENTITY_KINDS: ReadonlySet<string> = new Set([
  'user_input',
  'context',
  'tool_result',
  'llm_output',
  'decision',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number'
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item: unknown): boolean => isString(item))
}

function isSpan(v: unknown): v is Span {
  if (!isRecord(v)) return false
  return (
    isString(v.id) &&
    isString(v.runId) &&
    (v.parentId === null || isString(v.parentId)) &&
    isString(v.agentId) &&
    isString(v.kind) &&
    SPAN_KINDS.has(v.kind) &&
    isString(v.name) &&
    isString(v.status) &&
    SPAN_STATUSES.has(v.status) &&
    isNumber(v.startedAt) &&
    (v.endedAt === null || isNumber(v.endedAt)) &&
    isStringArray(v.inputEntityIds) &&
    isStringArray(v.outputEntityIds) &&
    isRecord(v.attributes) &&
    (v.error === undefined || isString(v.error))
  )
}

function isDataEntity(v: unknown): v is DataEntity {
  if (!isRecord(v)) return false
  return (
    isString(v.id) &&
    isString(v.kind) &&
    ENTITY_KINDS.has(v.kind) &&
    isString(v.label) &&
    (v.producedBy === null || isString(v.producedBy)) &&
    // payload 类型是 unknown，值本身任意，但字段必须存在
    'payload' in v &&
    isRecord(v.time) &&
    isNumber(v.time.createdAt) &&
    isNumber(v.time.observedAt) &&
    isString(v.source) &&
    (v.trustScore === undefined || isNumber(v.trustScore))
  )
}

/**
 * AgentEvent 运行时类型守卫：校验未知数据是否为本项目事件协议的合法事件。
 * 校验深度：事件顶层字段逐项校验；嵌套的 span / entity 做全字段结构校验
 * （payload / attributes 值本身为 unknown，不深入）。
 */
export function isAgentEvent(e: unknown): e is AgentEvent {
  if (!isRecord(e) || !isString(e.type)) return false
  switch (e.type) {
    case 'run.start':
      return (
        isString(e.runId) &&
        isNumber(e.startedAt) &&
        (e.scenarioName === undefined || isString(e.scenarioName))
      )
    case 'run.end':
      return (
        isString(e.runId) &&
        isNumber(e.endedAt) &&
        isString(e.status) &&
        RUN_END_STATUSES.has(e.status)
      )
    case 'span.start':
      return isString(e.runId) && isSpan(e.span)
    case 'span.end':
      return (
        isString(e.runId) &&
        isString(e.spanId) &&
        isNumber(e.endedAt) &&
        isString(e.status) &&
        SPAN_STATUSES.has(e.status) &&
        isStringArray(e.outputEntityIds) &&
        (e.error === undefined || isString(e.error))
      )
    case 'entity.create':
      return isString(e.runId) && isDataEntity(e.entity)
    case 'run.snapshot':
      return (
        isString(e.runId) &&
        Array.isArray(e.spans) &&
        e.spans.every((item: unknown): boolean => isSpan(item)) &&
        Array.isArray(e.entities) &&
        e.entities.every((item: unknown): boolean => isDataEntity(item))
      )
    default:
      return false
  }
}
