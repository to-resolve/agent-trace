// 合成事件流生成器（T7 压测基建，docs/03 T7 第一部分）。
//
// 三种拓扑对应三类压力面：
// - deepChainEvents     深链：N 个串行 span——递归深度压力（traverse /
//                       computeLayering 的栈深是 10k 爆栈检查的对象）
// - fanoutEvents        宽扇出：1 个产出被 M 个消费——单节点出边数压力
//                       （层内排序与边重建的最坏形态）
// - mixedTopologyEvents 混合：深链为主 + 每 fanoutEvery 层挂 fanoutWidth 个
//                       分叉叶——p95 验收基准，最接近真实 Agent 执行流形态
//
// 确定性：所有 id 与时间戳均由参数推导，同参数必产同流——两次压测可比。
// 纯函数、零依赖、不经 timer（bench 直接 applyEvent，不走 SimulatedSource）。
import type { AgentEvent, DataEntity, Span } from '../types'

/** 所有合成时间戳的公共基准（固定的过去时刻，与真实时钟无关） */
const BASE = 1_700_000_000_000

function synthSpan(id: string, runId: string, inputEntityIds: string[], startedAt: number): Span {
  return {
    id,
    runId,
    parentId: null,
    agentId: `agent-${id}`,
    kind: 'agent',
    name: `span ${id}`,
    status: 'running',
    startedAt,
    endedAt: null,
    inputEntityIds,
    outputEntityIds: [],
    attributes: {},
  }
}

function synthEntity(
  id: string,
  producedBy: string | null,
  createdAt: number,
  observedAt: number,
): DataEntity {
  return {
    id,
    kind: 'llm_output',
    label: `实体 ${id}`,
    producedBy,
    payload: { synth: true },
    time: { createdAt, observedAt },
    source: 'synth',
  }
}

/**
 * 深链：s-0 → s-1 → … → s-(N-1)。每个 span 消费上一个的产出并产出
 * 自己的实体；s-0 消费一个外部输入（producedBy === null，溯源链的根）。
 * 边数 = N-1，事件数 = 3N + 3。
 */
export function deepChainEvents(totalSpans: number, runId = 'run-synth-deep'): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'run.start', runId, startedAt: BASE }]
  events.push({
    type: 'entity.create',
    runId,
    entity: synthEntity('e-root', null, BASE - 1_000, BASE),
  })
  for (let i = 0; i < totalSpans; i++) {
    const startedAt = BASE + i * 100
    const input = i === 0 ? ['e-root'] : [`e-${i - 1}`]
    events.push({ type: 'span.start', runId, span: synthSpan(`s-${i}`, runId, input, startedAt) })
    events.push({
      type: 'entity.create',
      runId,
      entity: synthEntity(`e-${i}`, `s-${i}`, startedAt + 10, startedAt + 20),
    })
    events.push({
      type: 'span.end',
      runId,
      spanId: `s-${i}`,
      endedAt: startedAt + 50,
      status: 'ok',
      outputEntityIds: [`e-${i}`],
    })
  }
  events.push({ type: 'run.end', runId, endedAt: BASE + totalSpans * 100, status: 'ok' })
  return events
}

/**
 * 宽扇出：s-prod 的单个产出 e-out 被 M 个 span 消费（全部挂在第 1 层）。
 * 边数 = M，事件数 = 2M + 5。
 */
export function fanoutEvents(consumers: number, runId = 'run-synth-fanout'): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'run.start', runId, startedAt: BASE }]
  events.push({
    type: 'entity.create',
    runId,
    entity: synthEntity('e-root', null, BASE - 1_000, BASE),
  })
  events.push({
    type: 'span.start',
    runId,
    span: synthSpan('s-prod', runId, ['e-root'], BASE),
  })
  events.push({
    type: 'entity.create',
    runId,
    entity: synthEntity('e-out', 's-prod', BASE + 10, BASE + 20),
  })
  events.push({
    type: 'span.end',
    runId,
    spanId: 's-prod',
    endedAt: BASE + 50,
    status: 'ok',
    outputEntityIds: ['e-out'],
  })
  for (let j = 0; j < consumers; j++) {
    const startedAt = BASE + 100 + j * 10
    events.push({
      type: 'span.start',
      runId,
      span: synthSpan(`s-fan-${j}`, runId, ['e-out'], startedAt),
    })
    events.push({
      type: 'span.end',
      runId,
      spanId: `s-fan-${j}`,
      endedAt: startedAt + 5,
      status: 'ok',
      outputEntityIds: [],
    })
  }
  events.push({
    type: 'run.end',
    runId,
    endedAt: BASE + 100 + consumers * 10,
    status: 'ok',
  })
  return events
}

/**
 * 混合拓扑：chainSpans 长深链，链上第 fanoutEvery 的倍数层额外挂
 * fanoutWidth 个分叉叶（消费该链节点的产出，无自己的输出）。
 * 总 span 数 = chainSpans + floor(chainSpans / fanoutEvery) × fanoutWidth；
 * 边数 = chainSpans - 1 + 分叉数。
 */
export function mixedTopologyEvents(
  chainSpans: number,
  fanoutEvery: number,
  fanoutWidth: number,
  runId = 'run-synth-mixed',
): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'run.start', runId, startedAt: BASE }]
  events.push({
    type: 'entity.create',
    runId,
    entity: synthEntity('e-root', null, BASE - 1_000, BASE),
  })
  for (let i = 0; i < chainSpans; i++) {
    const startedAt = BASE + i * 100
    const input = i === 0 ? ['e-root'] : [`e-${i - 1}`]
    events.push({ type: 'span.start', runId, span: synthSpan(`s-${i}`, runId, input, startedAt) })
    events.push({
      type: 'entity.create',
      runId,
      entity: synthEntity(`e-${i}`, `s-${i}`, startedAt + 10, startedAt + 20),
    })
    events.push({
      type: 'span.end',
      runId,
      spanId: `s-${i}`,
      endedAt: startedAt + 50,
      status: 'ok',
      outputEntityIds: [`e-${i}`],
    })
    if (i > 0 && i % fanoutEvery === 0) {
      for (let j = 0; j < fanoutWidth; j++) {
        const fanStart = startedAt + 60 + j * 5
        events.push({
          type: 'span.start',
          runId,
          span: synthSpan(`s-fan-${i}-${j}`, runId, [`e-${i}`], fanStart),
        })
        events.push({
          type: 'span.end',
          runId,
          spanId: `s-fan-${i}-${j}`,
          endedAt: fanStart + 5,
          status: 'ok',
          outputEntityIds: [],
        })
      }
    }
  }
  events.push({ type: 'run.end', runId, endedAt: BASE + chainSpans * 100, status: 'ok' })
  return events
}
