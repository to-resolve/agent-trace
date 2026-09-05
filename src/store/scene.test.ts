// scene 组装测试（T8-B2，T7 审查阻塞项 2）：
// 「选中 → 取消 → 边视觉态归零」——T7 修复的「选中→点空白→边永久高亮」
// bug 此前只活在临时探针里（探针还因脏数据从未跑通），零正式守卫。
// 数据用 synth 生成器（干净 AgentEvent，非未转换的 ScenarioEvent）。
import { describe, it, expect } from 'vitest'
import { mixedTopologyEvents } from '../core/source/synth'
import { applyEvent, createGraph } from '../core/graph/build'
import { layoutGraph, updateLayout } from '../core/graph/layout'
import { buildScene } from './scene'
import type { AgentEvent, CausalGraph, Layout, SpanId } from '../core/types'

/** 与 traceStore.onEvent 完全一致的增量回放约定（干净数据：synth 事件流） */
function replay(events: readonly AgentEvent[]): { graph: CausalGraph; layout: Layout } {
  const graph = createGraph(events[0].runId)
  let layout = layoutGraph(graph)
  for (const event of events) {
    const dirty = new Set<SpanId>()
    if (event.type === 'span.start') {
      dirty.add(event.span.id)
    } else if (event.type === 'entity.create' && event.entity.producedBy !== null) {
      dirty.add(event.entity.producedBy)
    }
    applyEvent(graph, event)
    layout = updateLayout(layout, graph, dirty)
  }
  return { graph, layout }
}

describe('applyEdgeStates 视觉态生命周期（T7 修复的回归守卫）', () => {
  it('关键测试：选中 → 取消 → 边全部归零，无任何 highlighted/dimmed 残留', () => {
    // 50 节点混合拓扑：链 + 扇出分叉，选中链尾后存在高亮/置灰两种边
    const events = mixedTopologyEvents(40, 10, 3)
    const { graph, layout } = replay(events)
    expect(layout.edges.length).toBeGreaterThan(10)

    // 选中链尾（clearSelection 走 buildScene(..., null, ...) 的同一路径）
    const tail: SpanId = 's-39'
    const selected = buildScene(graph, layout, tail, 2)
    const highlighted = selected.layout.edges.filter((e) => e.state === 'highlighted')
    const dimmed = selected.layout.edges.filter((e) => e.state === 'dimmed')
    expect(highlighted.length).toBeGreaterThan(0)
    expect(dimmed.length).toBeGreaterThan(0)

    // 取消选中：传入的是携带视觉态的 selected.layout（不是干净的 baseLayout）
    const cleared = buildScene(graph, selected.layout, null, 3)
    expect(cleared.layout.edges.every((e) => e.state === 'normal')).toBe(true)
  })

  it('未选中任何节点时，携带视觉态的输入 layout 也会被归零（buildScene 幂等性）', () => {
    const events = mixedTopologyEvents(10, 5, 2)
    const { graph, layout } = replay(events)
    // 人为把边污染成视觉态再传入——null 路径必须显式复位而非原样返回
    const tainted = {
      ...layout,
      edges: layout.edges.map((e) => ({ ...e, state: 'dimmed' as const })),
    }
    const scene = buildScene(graph, tainted, null, 1)
    expect(scene.layout.edges.every((e) => e.state === 'normal')).toBe(true)
  })

  it('选中状态与取消状态之间，徽章几何与节点几何逐字段不变（视觉态是唯一差异）', () => {
    const events = mixedTopologyEvents(10, 5, 2)
    const { graph, layout } = replay(events)
    const a = buildScene(graph, layout, 's-9', 1)
    const b = buildScene(graph, layout, null, 2)
    // 节点引用同一批 LayoutNode；徽章几何一致（选中只改 dimmed 标记）
    expect(a.layout.nodes).toEqual(b.layout.nodes)
    expect(a.badges.length).toBe(b.badges.length)
    for (let i = 0; i < a.badges.length; i++) {
      expect(a.badges[i].x).toBe(b.badges[i].x)
      expect(a.badges[i].y).toBe(b.badges[i].y)
      expect(a.badges[i].width).toBe(b.badges[i].width)
    }
  })
})
