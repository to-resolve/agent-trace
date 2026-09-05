// isAgentEvent 直测（T6 修补 2，T3b 审查裁决 4）。
// 事件协议层是脏数据的第一道防线：剧本 JSON、回放文件、未来的 SSE 报文
// 都从这里收窄为类型安全的 AgentEvent——协议边界的每个分支都值得直测。
// 写法：合法基准件 + 单字段突变表，一次只破坏一个约束，失败可定位到字段。
import { describe, it, expect } from 'vitest'
import { isAgentEvent } from './events'
import type { AgentEvent, DataEntity, Span } from './types'

// —— 合法基准件（字段齐全的最小形态）——

function baseSpan(): Span {
  return {
    id: 's-1',
    runId: 'r-1',
    parentId: null,
    agentId: 'agent-retriever',
    kind: 'retrieval',
    name: '检索简历',
    status: 'ok',
    startedAt: 1_000,
    endedAt: 2_000,
    inputEntityIds: ['e-in'],
    outputEntityIds: ['e-out'],
    attributes: { topK: 3 },
  }
}

function baseEntity(): DataEntity {
  return {
    id: 'e-1',
    kind: 'context',
    label: '候选人简历',
    producedBy: null,
    payload: { version: 'v1' },
    time: { createdAt: 900, observedAt: 1_000 },
    source: 'candidate-db',
  }
}

function baseEvents(): Record<string, AgentEvent> {
  const span = baseSpan()
  const entity = baseEntity()
  return {
    'run.start': { type: 'run.start', runId: 'r-1', startedAt: 1_000 },
    'run.end': { type: 'run.end', runId: 'r-1', endedAt: 9_000, status: 'ok' },
    'span.start': { type: 'span.start', runId: 'r-1', span },
    'span.end': {
      type: 'span.end',
      runId: 'r-1',
      spanId: 's-1',
      endedAt: 2_000,
      status: 'ok',
      outputEntityIds: ['e-out'],
    },
    'entity.create': { type: 'entity.create', runId: 'r-1', entity },
    'run.snapshot': { type: 'run.snapshot', runId: 'r-1', spans: [span], entities: [entity] },
  }
}

/** 在类型安全的事件上做单字段突变：路径取值 + 覆盖非法值 */
function mutated(event: AgentEvent, path: string, value: unknown): unknown {
  const clone = structuredClone(event) as Record<string, unknown>
  const keys = path.split('.')
  let cursor: Record<string, unknown> = clone
  for (const key of keys.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[keys[keys.length - 1]] = value
  return clone
}

describe('isAgentEvent · 合法形态', () => {
  it.each(Object.keys(baseEvents()))('%s 基准件通过', (type) => {
    expect(isAgentEvent(baseEvents()[type])).toBe(true)
  })

  it('可选字段的合法取值都通过', () => {
    // run.start.scenarioName、span.error、entity.trustScore、span.parentId 字符串形态、
    // span.endedAt 数值形态 —— 全部是被协议接受的
    expect(
      isAgentEvent({ ...baseEvents()['run.start'], scenarioName: 'stale-context' }),
    ).toBe(true)
    const span = { ...baseSpan(), parentId: 's-parent', endedAt: 2_001, error: 'boom' }
    expect(isAgentEvent({ type: 'span.start', runId: 'r-1', span })).toBe(true)
    const entity = { ...baseEntity(), producedBy: 's-1', trustScore: 0.8 }
    expect(isAgentEvent({ type: 'entity.create', runId: 'r-1', entity })).toBe(true)
    expect(
      isAgentEvent({ ...baseEvents()['span.end'], error: '超时' }),
    ).toBe(true)
  })

  it('空数组与空对象的边界形态通过（span.input/outputEntityIds、attributes、snapshot 集合）', () => {
    const span = { ...baseSpan(), inputEntityIds: [], outputEntityIds: [], attributes: {} }
    expect(isAgentEvent({ type: 'span.start', runId: 'r-1', span })).toBe(true)
    expect(
      isAgentEvent({ type: 'run.snapshot', runId: 'r-1', spans: [], entities: [] }),
    ).toBe(true)
  })
})

describe('isAgentEvent · 非事件形态', () => {
  it.each([
    ['null', null],
    ['数组', [baseEvents()['run.start']]],
    ['字符串', 'run.start'],
    ['数字', 42],
    ['无 type 字段', { runId: 'r-1' }],
    ['type 非字符串', { type: 7 }],
  ])('%s 拒绝', (_label, input) => {
    expect(isAgentEvent(input)).toBe(false)
  })

  it('未知 type 走 default 分支拒绝', () => {
    expect(isAgentEvent({ type: 'span.update', runId: 'r-1' })).toBe(false)
    expect(isAgentEvent({ type: 'agent.message', runId: 'r-1' })).toBe(false)
  })
})

describe('isAgentEvent · 顶层字段突变', () => {
  // 每条只破坏一个字段，事件的类型分发本身必须先成立
  const cases: Array<[string, string, unknown]> = [
    ['run.start', 'runId', 7],
    ['run.start', 'startedAt', '1000'],
    ['run.start', 'scenarioName', 42],
    ['run.end', 'runId', true],
    ['run.end', 'endedAt', null],
    ['run.end', 'status', 'pending'],
    ['span.start', 'runId', 7],
    ['span.end', 'spanId', 7],
    ['span.end', 'endedAt', '2000'],
    ['span.end', 'status', 'finished'],
    ['span.end', 'outputEntityIds', 'not-array'],
    ['span.end', 'outputEntityIds', [1, 2]],
    ['span.end', 'error', 42],
    ['entity.create', 'runId', 7],
    ['run.snapshot', 'runId', 7],
  ]
  it.each(cases)('%s.%s = %j 拒绝', (type, path, value) => {
    expect(isAgentEvent(mutated(baseEvents()[type], path, value))).toBe(false)
  })
})

describe('isAgentEvent · 嵌套 span 字段突变', () => {
  const spanCases: Array<[string, unknown]> = [
    ['id', 7],
    ['runId', 7],
    ['parentId', 123], // 既非 null 也非 string
    ['agentId', 7],
    ['kind', 'unknown-kind'], // 不在 SPAN_KINDS
    ['kind', 7],
    ['name', 7],
    ['status', 'crashed'], // 不在 SPAN_STATUSES
    ['startedAt', '1000'],
    ['endedAt', '2000'], // 既非 null 也非 number
    ['inputEntityIds', 'not-array'],
    ['inputEntityIds', [1]],
    ['outputEntityIds', [1]],
    ['attributes', null],
    ['error', 42], // 既非 undefined 也非 string
  ]
  it.each(spanCases)('span.%s = %j 拒绝', (path, value) => {
    const event = mutated(baseEvents()['span.start'], `span.${path}`, value)
    expect(isAgentEvent(event)).toBe(false)
  })

  it('span 整体非对象（数组 / null）拒绝', () => {
    expect(isAgentEvent(mutated(baseEvents()['span.start'], 'span', [baseSpan()]))).toBe(false)
    expect(isAgentEvent(mutated(baseEvents()['span.start'], 'span', null))).toBe(false)
  })
})

describe('isAgentEvent · 嵌套 entity 字段突变', () => {
  const entityCases: Array<[string, unknown]> = [
    ['id', 7],
    ['kind', 'artifact'], // 不在 ENTITY_KINDS
    ['label', 7],
    ['producedBy', 0], // 既非 null 也非 string
    ['time', 'not-record'],
    ['source', 7],
    ['trustScore', 'high'], // 既非 undefined 也非 number
  ]
  it.each(entityCases)('entity.%s = %j 拒绝', (path, value) => {
    const event = mutated(baseEvents()['entity.create'], `entity.${path}`, value)
    expect(isAgentEvent(event)).toBe(false)
  })

  it('entity.time 子字段非法拒绝', () => {
    expect(isAgentEvent(mutated(baseEvents()['entity.create'], 'entity.time.createdAt', '900'))).toBe(false)
    expect(isAgentEvent(mutated(baseEvents()['entity.create'], 'entity.time.observedAt', null))).toBe(false)
  })

  it('entity 缺 payload 字段拒绝（值任意但字段必须存在）', () => {
    const event = baseEvents()['entity.create'] as Record<string, unknown>
    const entity = { ...(event.entity as object) }
    delete (entity as Record<string, unknown>).payload
    expect(isAgentEvent({ ...event, entity })).toBe(false)
  })

  it('entity 整体非对象拒绝', () => {
    expect(isAgentEvent(mutated(baseEvents()['entity.create'], 'entity', null))).toBe(false)
  })
})

describe('isAgentEvent · run.snapshot 嵌套校验（T3b 遗留未覆盖分支）', () => {
  it('spans 不是数组拒绝', () => {
    expect(isAgentEvent(mutated(baseEvents()['run.snapshot'], 'spans', 'not-array'))).toBe(false)
  })

  it('spans 内含非法 span 拒绝', () => {
    expect(
      isAgentEvent(mutated(baseEvents()['run.snapshot'], 'spans.0.kind', 'no-such-kind')),
    ).toBe(false)
  })

  it('entities 不是数组拒绝', () => {
    expect(isAgentEvent(mutated(baseEvents()['run.snapshot'], 'entities', 42))).toBe(false)
  })

  it('entities 内含非法 entity 拒绝', () => {
    expect(
      isAgentEvent(mutated(baseEvents()['run.snapshot'], 'entities.0.kind', 'no-such-kind')),
    ).toBe(false)
  })

  it('合法快照整体通过（spans / entities 各含一个合法元素）', () => {
    expect(isAgentEvent(baseEvents()['run.snapshot'])).toBe(true)
  })
})
