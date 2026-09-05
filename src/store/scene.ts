// Scene 组装（纯函数）：CausalGraph + Layout → render 层视图模型。
//
// 从 traceStore 抽出的原因（T7 指标 4）：buildScene 全链路耗时是压测
// 指标（applyEvent + updateLayout + 徽章锚点解析），挂在 zustand store
// 文件里无法被 bench 直接引用。本模块零框架依赖、零副作用，与 store
// 的职责边界不变——store 只管订阅与状态，这里只做数据组装。
import { computeFreshness, traceUpstream } from '../core/graph/query'
import type { TraversalResult } from '../core/graph/query'
import type { CausalGraph, EntityId, Layout, LayoutEdge, SpanId } from '../core/types'
import {
  BADGE_HEIGHT,
  INPUT_BADGE_DROP,
  INPUT_BADGE_LINE_HEIGHT,
  INPUT_STUB,
  badgeWidth,
  type EntityBadge,
  type NodeVisual,
  type Scene,
} from '../render/draw-node'

const DAY_MS = 86_400_000
/**
 * 新鲜度判定阈值（查询参数语义，docs/02 §3）：7 天，与 UI 文案
 * 「91 天 / 阈值 7 天」一致。阈值是查询参数不是数据属性，B4+ 再做可配置。
 */
export const FRESHNESS_THRESHOLD_MS = 7 * DAY_MS

/**
 * 溯源路径边集合 → LayoutEdge 视觉态（02 §10，T4 审查裁决 5）。
 * 边按（fromSpanId, toSpanId, viaEntityId）三元组标识定位成员，
 * 与 graph.edges 的遍历顺序、过滤条件**零耦合**——改任何一方的
 * 过滤谓词都不会让高亮落错边。
 *
 * upstream === null 时**显式重置**全部边为 normal：baseLayout 来自
 * state.scene.layout，可能携带上一次选中留下的 highlighted/dimmed
 * （clearSelection 走这条路）。此前 null 直接原样返回，选中→点空白后
 * 边会永久保持高亮（T7 修复的潜在 bug——节点靠 highlightedSpanIds
 * 自行复位，边没有这层兜底）。全 normal 的快路径零分配原样返回。
 */
function applyEdgeStates(layout: Layout, upstream: TraversalResult | null): Layout {
  if (upstream === null) {
    if (layout.edges.every((e) => e.state === 'normal')) return layout
    return { ...layout, edges: layout.edges.map((e) => ({ ...e, state: 'normal' })) }
  }
  const onPath = new Set(
    upstream.edges.map((e) => edgeKey(e.fromSpanId, e.toSpanId, e.viaEntityId)),
  )
  const edges: LayoutEdge[] = layout.edges.map((edge) => ({
    ...edge,
    state: onPath.has(edgeKey(edge.fromSpanId, edge.toSpanId, edge.viaEntityId))
      ? 'highlighted'
      : 'dimmed',
  }))
  return { ...layout, edges }
}

function edgeKey(from: SpanId, to: SpanId, via: EntityId): string {
  return `${from}\0${to}\0${via}`
}

function buildNodeVisuals(graph: CausalGraph): ReadonlyMap<SpanId, NodeVisual> {
  const visuals = new Map<SpanId, NodeVisual>()
  for (const span of graph.spans.values()) {
    visuals.set(span.id, {
      spanId: span.id,
      name: span.name,
      kind: span.kind,
      status: span.status,
    })
  }
  return visuals
}

/**
 * 徽章视图模型（docs/04 §4）：
 * - 因果边徽章：锚在边中点——几何由构造源边直接解析（T7「一次解析复用」：
 *   压测 M4b 显示绘制路径逐帧逐徽章 O(E) 查找在 10k 规模下 247–505ms/帧，
 *   是 60fps 预算 16.7ms 的 ~30 倍）
 * - 外部输入徽章：producedBy === null 的实体按 02 §4 不产生因果边，
 *   但它们是溯源链的根（e-policy 是对照组）——锚在消费者 span 左缘的
 *   虚拟短边上，slot 按同 span 的外部输入序堆叠
 * 新鲜度用 core 的 computeFreshness 统一判定，ageDays 供「91 天」显示。
 * 徽章对象直接字面量构造（单次分配）：它是每事件 O(E) 的热路径对象，
 * 中间层（字段对象 → 复制）会双倍分配（压测实测 p50 +0.7ms）。
 */
export function buildBadges(
  layout: Layout,
  graph: CausalGraph,
  upstream: TraversalResult | null,
): EntityBadge[] {
  const badges: EntityBadge[] = []
  const dimmed = (entityId: EntityId): boolean =>
    upstream !== null && !upstream.entityIds.has(entityId)

  for (const edge of layout.edges) {
    const entity = graph.entities.get(edge.viaEntityId)
    if (entity === undefined) continue
    const freshness = computeFreshness(entity, FRESHNESS_THRESHOLD_MS)
    const ageDays = Math.floor(freshness.ageMs / DAY_MS)
    const width = badgeWidth(entity.label, freshness.status, ageDays)
    badges.push({
      entityId: entity.id,
      label: entity.label,
      status: freshness.status,
      ageDays,
      dimmed: dimmed(entity.id),
      input: null,
      x: (edge.from.x + edge.to.x) / 2 - width / 2,
      y: (edge.from.y + edge.to.y) / 2 - BADGE_HEIGHT / 2,
      width,
      height: BADGE_HEIGHT,
    })
  }

  for (const span of graph.spans.values()) {
    const node = layout.nodes.get(span.id)
    if (node === undefined) continue
    let slot = 0
    for (const entityId of span.inputEntityIds) {
      const entity = graph.entities.get(entityId)
      if (entity === undefined || entity.producedBy !== null) continue
      const freshness = computeFreshness(entity, FRESHNESS_THRESHOLD_MS)
      const ageDays = Math.floor(freshness.ageMs / DAY_MS)
      const width = badgeWidth(entity.label, freshness.status, ageDays)
      badges.push({
        entityId: entity.id,
        label: entity.label,
        status: freshness.status,
        ageDays,
        dimmed: dimmed(entity.id),
        input: { spanId: span.id, slot },
        x: node.x - INPUT_STUB / 2 - width / 2,
        y:
          node.y +
          node.height / 2 +
          INPUT_BADGE_DROP +
          slot * INPUT_BADGE_LINE_HEIGHT -
          BADGE_HEIGHT / 2,
        width,
        height: BADGE_HEIGHT,
      })
      slot += 1
    }
  }
  return badges
}

export function buildScene(
  graph: CausalGraph,
  baseLayout: Layout,
  selectedSpanId: SpanId | null,
  version: number,
): Scene {
  const upstream = selectedSpanId !== null ? traceUpstream(graph, selectedSpanId) : null
  const layout = applyEdgeStates(baseLayout, upstream)
  return {
    version,
    layout,
    nodeVisuals: buildNodeVisuals(graph),
    badges: buildBadges(layout, graph, upstream),
    highlightedSpanIds: upstream !== null ? upstream.spanIds : null,
  }
}

export function emptyScene(): Scene {
  return {
    version: 0,
    layout: { nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, version: 0 },
    nodeVisuals: new Map(),
    badges: [],
    highlightedSpanIds: null,
  }
}
