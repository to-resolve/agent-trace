// T7/T8 压测（vitest bench）—— 方法学按 T7 审查裁决 6 修正。
//
// 指标与口径（两项分开，不再混报）：
// - A. 回放口径：完整 10k 事件流逐事件计时（applyEvent + updateLayout +
//      buildScene）。**样本混合「小图阶段」（图从 0 生长）与「满图阶段」
//      两个总体，p50 被小图系统性稀释、无意义；只报 p95/p99**。
//      逐事件 4 次 performance.now() 的计时开销已含在数字内（每事件
//      ~0.24ms 量级下占比可观，声明为已知偏差，不扣除）。
// - B. 满图单事件口径：10k 满图稳态下「追加一个新 span」的单事件成本，
//      **批量计时**（每批 100 事件只打 2 次时间戳，计时开销 / 100）。
//      代表「事件流尾部继续生长」的稳态交互成本。
// - C. 轻量可迭代指标（M1 全量布局 / M3 链尾溯源 / 深链爆栈 / 宽扇出）
//      交 vitest bench 自身统计（多迭代），其结果即多轮数据。
//
// 方法学（裁决 6）：①环境指纹表头；②每口径跑 4 轮、丢弃第 1 轮（25%
// 预热，满足「前 10%」）③后 3 轮各指标取**轮间中位数**为结论；④口径
// 显式声明；⑤B 组批量计时；⑥绝对毫秒数仅是环境参考值——**验收看同环境
// 相对 T7 优化前基线（M2 回放口径 p95 = 4.05ms @ Node 24.18.1）的改善率**。
// 生成器确定性：同参数必产同流，两次压测可比。
import { bench, describe } from 'vitest'
import os from 'node:os'
import { applyEvent, createGraph } from '../core/graph/build'
import { layoutGraph, updateLayout } from '../core/graph/layout'
import { traceUpstream } from '../core/graph/query'
import { buildScene } from '../store/scene'
import { createJournal } from '../core/timeline/journal'
import { createReplaySession, seekTo } from '../core/timeline/checkpoint'
import { deepChainEvents, fanoutEvents, mixedTopologyEvents } from '../core/source/synth'
import type { AgentEvent, CausalGraph, Layout, SpanId } from '../core/types'

// —— 压测参数 ——
const MIXED = { chainSpans: 7_700, fanoutEvery: 10, fanoutWidth: 3 } // 10007 spans / 10006 edges / 27717 events
const DEEP_N = 10_000 // 10000 spans / 9999 edges
const FANOUT_M = 5_000 // 5001 spans / 5000 edges
const MIXED_TAIL: SpanId = `s-${MIXED.chainSpans - 1}`
const ROUNDS = 4 // 1 轮预热（丢弃）+ 3 轮记录，中位数取后 3 轮
const B_BATCH = 100 // B 组批量计时：每批事件数

// —— 统计工具（nearest-rank 百分位 + 轮间中位数）——

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return Number.NaN
  const sorted = [...arr].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

function fmt95(arr: number[]): string {
  return `p95=${pct(arr, 95).toFixed(3)}ms  p99=${pct(arr, 99).toFixed(3)}ms  (n=${arr.length})`
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** 轮间中位数：对每轮各自算好百分位后取中位（裁决 6 条 3） */
function fmtRounds(rounds: number[][]): string {
  const p95s = rounds.map((r) => pct(r, 95))
  const p99s = rounds.map((r) => pct(r, 99))
  return `轮间中位数 p95=${median(p95s).toFixed(3)}ms  p99=${median(p99s).toFixed(3)}ms  （${rounds.length} 轮中位）`
}

function buildGraph(events: readonly AgentEvent[]): CausalGraph {
  const graph = createGraph(events[0].runId)
  for (const event of events) applyEvent(graph, event)
  return graph
}

// —— 环境指纹表头（裁决 6 条 1）——

const cpus = os.cpus()
console.log('=== 环境指纹（T7 审查裁决 6）===')
console.log(
  `Node ${process.version} | V8 ${process.versions.v8} | ${os.platform()} ${os.arch()}`,
)
console.log(
  `CPU: ${cpus[0]?.model ?? 'unknown'} × ${cpus.length} 逻辑核 | 内存 ${(os.totalmem() / 2 ** 30).toFixed(1)}GB`,
)
console.log(
  `负载: loadavg=[${os.loadavg().map((v) => v.toFixed(2)).join(', ')}]` +
    '（Windows 下 loadavg 恒 0，本次为专机专跑）',
)
console.log(`压测参数: 混合拓扑 ${JSON.stringify(MIXED)} | 深链 ${DEEP_N} | 宽扇出 ${FANOUT_M} | ${ROUNDS} 轮（首轮预热丢弃）`)
console.log('')

// 模块级一次性构建（synth 确定性 + applyEvent 迭代，深链安全）
const mixedEvents = mixedTopologyEvents(MIXED.chainSpans, MIXED.fanoutEvery, MIXED.fanoutWidth)
const mixedGraph = buildGraph(mixedEvents)
const fanoutGraph = buildGraph(fanoutEvents(FANOUT_M))
const deepGraph = buildGraph(deepChainEvents(DEEP_N))

console.log(
  `规模: ${mixedGraph.spans.size} spans / ${mixedGraph.edges.length} edges / ${mixedEvents.length} events（混合拓扑）`,
)

/** 与 traceStore.onEvent 同约定的单轮回放，返回逐事件样本。
 *  计时口径与 T7 基线一致（改善率可比的前提）：每事件 4 次 now()——
 *  M2 = updateLayout 单独段（t2-t1），M4 = applyEvent+updateLayout+
 *  buildScene 全链路（t3-t0）。计时开销已含在数字内（声明为已知偏差）。 */
function replayRound(): { updateLayout: number[]; buildScene: number[]; totalMs: number } {
  const graph = createGraph(mixedEvents[0].runId)
  let layout: Layout = { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
  const sUpdateLayout: number[] = []
  const sBuildScene: number[] = []
  const tTotal0 = performance.now()
  for (const event of mixedEvents) {
    const dirty = new Set<SpanId>()
    if (event.type === 'span.start') {
      dirty.add(event.span.id)
    } else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
      dirty.add(event.entity.producedBy)
    }
    const t0 = performance.now()
    applyEvent(graph, event)
    const t1 = performance.now()
    layout = updateLayout(layout, graph, dirty)
    const t2 = performance.now()
    buildScene(graph, layout, null, 1)
    const t3 = performance.now()
    sUpdateLayout.push(t2 - t1)
    sBuildScene.push(t3 - t0)
  }
  const totalMs = performance.now() - tTotal0
  return { updateLayout: sUpdateLayout, buildScene: sBuildScene, totalMs }
}

// —— A 组：回放口径（4 轮，首轮预热丢弃）——

{
  const roundsUpdate: number[][] = []
  const roundsScene: number[][] = []
  const totals: number[] = []
  for (let r = 0; r < ROUNDS; r++) {
    const round = replayRound()
    totals.push(round.totalMs)
    if (r === 0) {
      console.log(`A组 轮${r + 1}（预热，丢弃）: total=${round.totalMs.toFixed(0)}ms`)
      continue
    }
    roundsUpdate.push(round.updateLayout)
    roundsScene.push(round.buildScene)
    console.log(
      `A组 轮${r + 1}: M2 ${fmt95(round.updateLayout)} | M4 ${fmt95(round.buildScene)} | M5 total=${round.totalMs.toFixed(0)}ms`,
    )
  }
  console.log(`A组 结论（轮间中位数）: M2 ${fmtRounds(roundsUpdate)}`)
  console.log(`          M4 ${fmtRounds(roundsScene)}`)
  console.log(`          M5 中位数 ${median(totals.slice(1)).toFixed(0)}ms（完整回放：applyEvent+updateLayout+buildScene / 27717 事件）`)
  console.log(`（口径声明：A 组样本混合小图/满图两阶段，p50 被小图稀释不报；仅 p95/p99 有效）`)

  // —— A 组附：journal 开启（时间旅行模式，T9 §11.9 验收「退化 ≤ 20%」）——
  // 同口径回放一轮，applyEvent 带第三参数。直接对比上面 A 组的轮间中位数。
  const journal = createJournal()
  const graph = createGraph(mixedEvents[0].runId)
  let layout: Layout = { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
  const jUpdate: number[] = []
  const jScene: number[] = []
  const jTotal0 = performance.now()
  for (const event of mixedEvents) {
    const dirty = new Set<SpanId>()
    if (event.type === 'span.start') {
      dirty.add(event.span.id)
    } else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
      dirty.add(event.entity.producedBy)
    }
    const t0 = performance.now()
    applyEvent(graph, event, journal)
    const t1 = performance.now()
    layout = updateLayout(layout, graph, dirty)
    const t2 = performance.now()
    buildScene(graph, layout, null, 1)
    const t3 = performance.now()
    jUpdate.push(t2 - t1)
    jScene.push(t3 - t0)
  }
  const jTotal = performance.now() - jTotal0
  const baseM2 = median(roundsUpdate.map((r) => pct(r, 95)))
  const baseM4 = median(roundsScene.map((r) => pct(r, 95)))
  const jM2 = pct(jUpdate, 95)
  const jM4 = pct(jScene, 95)
  const delta = (a: number, b: number): string => `${(((a - b) / b) * 100).toFixed(1)}%`
  console.log(`A组附（journal 开启）: M2 p95=${jM2.toFixed(3)}ms（vs 关闭 ${baseM2.toFixed(3)}ms，${delta(jM2, baseM2)}）`)
  console.log(`                        M4 p95=${jM4.toFixed(3)}ms（vs 关闭 ${baseM4.toFixed(3)}ms，${delta(jM4, baseM4)}）`)
  console.log(`                        M5 total=${jTotal.toFixed(0)}ms | journal 记录 ${journal.ops.length} 组`)
  console.log('')
}

// —— B 组：满图单事件口径（批量计时 + 4 轮中位数）——
//
// 口径（T8 审查裁决 7）：**仅 applyEvent + updateLayout，不含 buildScene**
// （A 组 M4 才是完整链路）；样本取自图 16k 稳态（与 A 组 10k 不同规模）。
// B 组为**趋势参考，不作验收基准**——验收以 A 组相对基线为准；其价值
// 在于揭示 updateLayout 每事件 O(N+E) 成分随规模的增长趋势。
//
// 场景：10k 满图稳态下「追加一个新 span」（dirty = {新 span}，下游闭包
// 为空——事件流尾部继续生长的稳态）。每批 B_BATCH 个事件只在批前后打
// 两次时间戳，单事件成本 = 批耗时 / B_BATCH——计时开销被摊薄 100 倍。
// 已知偏差：每轮追加 20 批 × 100 = 2000 个 span，四轮共 8000
// （10007 → 18007），规模上涨使后几轮数字略偏保守（偏高），方向安全、
// 不虚报性能。

{
  const graph = createGraph(mixedEvents[0].runId)
  let layout: Layout = { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 }
  for (const event of mixedEvents) {
    const dirty = new Set<SpanId>()
    if (event.type === 'span.start') {
      dirty.add(event.span.id)
    } else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
      dirty.add(event.entity.producedBy)
    }
    applyEvent(graph, event)
    layout = updateLayout(layout, graph, dirty)
  }
  const tailEntity = `e-${MIXED.chainSpans - 1}`

  const rounds: number[][] = []
  for (let r = 0; r < ROUNDS; r++) {
    // 每轮追加 20 批 × 100 事件（图持续生长，声明为保守偏差）
    const perEvent: number[] = []
    for (let b = 0; b < 20; b++) {
      const t0 = performance.now()
      for (let i = 0; i < B_BATCH; i++) {
        const id = `s-bench-r${r}-${b}-${i}`
        applyEvent(graph, {
          type: 'span.start',
          runId: mixedEvents[0].runId,
          span: {
            id,
            runId: mixedEvents[0].runId,
            parentId: null,
            agentId: 'agent-bench',
            kind: 'agent',
            name: id,
            status: 'running',
            startedAt: 1_700_000_000_000,
            endedAt: null,
            inputEntityIds: [tailEntity],
            outputEntityIds: [],
            attributes: {},
          },
        })
        layout = updateLayout(layout, graph, new Set<SpanId>([id]))
      }
      perEvent.push((performance.now() - t0) / B_BATCH)
    }
    if (r === 0) {
      console.log(
        `B组 轮1（预热，丢弃）: 满图单事件 p50=${pct(perEvent, 50).toFixed(4)}ms（图 ${graph.spans.size} spans）`,
      )
      continue
    }
    rounds.push(perEvent)
    console.log(
      `B组 轮${r + 1}: p50=${pct(perEvent, 50).toFixed(4)}ms  p95=${pct(perEvent, 95).toFixed(4)}ms  （批量计时批大小 ${B_BATCH}；图 ${graph.spans.size} spans）`,
    )
  }
  const p50s = rounds.map((r) => pct(r, 50))
  const p95s = rounds.map((r) => pct(r, 95))
  console.log(
    `B组 结论（轮间中位数）: 满图单事件 p50=${median(p50s).toFixed(4)}ms  p95=${median(p95s).toFixed(4)}ms`,
  )
  console.log(
    `（口径：仅 applyEvent + updateLayout，不含 buildScene；图 16k 稳态；趋势参考，不作验收基准——T8 裁决 7）`,
  )
  console.log('')
}

// —— T9 第二部分：10k 回溯性能（§11.9：step 5000 < 200ms，多轮中位数）——
//
// 口径：10k 混合流（27717 事件）从终态回退到事件 5000（invert 22717 组
// + 消费方索引失效重建 + 布局全量重建）。每轮先经 checkpoint 快路径回到
// 终态，再计时回退；首轮预热丢弃，后 5 轮取中位数（裁决 6 形态）。

{
  const tSetup0 = performance.now()
  const session = createReplaySession(mixedEvents)
  console.log(
    `T9 回溯 setup（10k 全量回放 + 检查点打点）: ${(performance.now() - tSetup0).toFixed(0)}ms（一次性成本）`,
  )
  const SEEK_TARGET = 5_000
  const SEEK_ROUNDS = 6
  const samples: number[] = []
  for (let r = 0; r < SEEK_ROUNDS; r++) {
    seekTo(session, mixedEvents.length) // 回终态（终点检查点重建，快路径）
    const t0 = performance.now()
    seekTo(session, SEEK_TARGET) // 计时目标：回退 22717 组
    samples.push(performance.now() - t0)
    if (r === 0) {
      console.log(`T9 回溯 轮1（预热，丢弃）: ${samples[0]?.toFixed(1)}ms`)
      samples.length = 0
      continue
    }
    console.log(`T9 回溯 轮${r + 1}: ${samples[samples.length - 1]?.toFixed(1)}ms`)
  }
  console.log(
    `T9 结论（轮间中位数）: 10k 流回溯到 step ${SEEK_TARGET} = ${median(samples).toFixed(1)}ms（验收线 < 200ms；含 invert + 索引重建 + 布局全量重建）`,
  )
  console.log('')
}

// —— M3：链尾溯源（C 组，vitest 多迭代统计）+ 轻量指标 ——
{
  // M3 也按多轮中位数采样（50 次/轮 × 4 轮），与 A/B 组方法学一致
  const rounds: number[][] = []
  for (let r = 0; r < ROUNDS; r++) {
    const samples: number[] = []
    for (let i = 0; i < 50; i++) {
      const t = performance.now()
      traceUpstream(mixedGraph, MIXED_TAIL)
      samples.push(performance.now() - t)
    }
    if (r === 0) continue // 预热丢弃
    rounds.push(samples)
  }
  const p95s = rounds.map((r) => pct(r, 95))
  const p99s = rounds.map((r) => pct(r, 99))
  console.log(
    `M3 结论（4 轮中位）: traceUpstream 链尾 p95=${median(p95s).toFixed(3)}ms  p99=${median(p99s).toFixed(3)}ms（含逐次计时开销）`,
  )
  console.log('')
}

// —— 轻量可迭代指标：交给 vitest bench 自身统计（天然多迭代）——

describe('10k 混合拓扑（10007 spans / 10006 edges / 27717 events）', () => {
  bench('M1 · layoutGraph 全量', () => {
    layoutGraph(mixedGraph)
  })
})

describe('10k 深链（递归爆栈检查）', () => {
  bench('traceUpstream 链尾（爆栈则本 case 记 0 samples，失败即数据）', () => {
    traceUpstream(deepGraph, `s-${DEEP_N - 1}`)
  })

  bench('layoutGraph 全量（爆栈则本 case 记 0 samples，失败即数据）', () => {
    layoutGraph(deepGraph)
  })
})

describe('5k 宽扇出（层内排序与边重建最坏形态）', () => {
  bench('layoutGraph 全量', () => {
    layoutGraph(fanoutGraph)
  })
})
