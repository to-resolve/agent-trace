// 视口裁剪（T7，docs/03 第二部分第 2 条）：输入世界矩形 + Scene，
// 输出可见集合（纯函数）。
//
// 压测依据：10k 节点全量绘制超 60fps 帧预算（16.7ms），裁剪后每帧
// 绘制量只与视口内元素数成正比、与总节点数无关。
// 判定用 AABB 相交（闭区间，与 hit-test 同语义）：
// - 节点：节点矩形
// - 徽章：badge.rect（构造时已解析——绘制/命中/裁剪/包围盒共用同一份几何）
// - 边：两端点包围盒（粗判，宁多画不漏画——被视口边框切到的长边会多画，
//   这是安全的保守上界）
import type { LayoutEdge, LayoutNode } from '../core/types'
import type { EntityBadge, Scene } from './draw-node'

/** 视口对应的世界坐标矩形（闭区间） */
export interface WorldRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface VisibleSet {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  badges: EntityBadge[]
}

function rectIntersectsView(
  rect: { x: number; y: number; width: number; height: number },
  view: WorldRect,
): boolean {
  return (
    rect.x <= view.maxX &&
    rect.x + rect.width >= view.minX &&
    rect.y <= view.maxY &&
    rect.y + rect.height >= view.minY
  )
}

/** 裁剪：返回与视口矩形相交的节点 / 边 / 徽章集合 */
export function cullScene(scene: Scene, view: WorldRect): VisibleSet {
  const nodes: LayoutNode[] = []
  for (const node of scene.layout.nodes.values()) {
    if (rectIntersectsView(node, view)) nodes.push(node)
  }

  const edges: LayoutEdge[] = []
  for (const edge of scene.layout.edges) {
    const minX = Math.min(edge.from.x, edge.to.x)
    const maxX = Math.max(edge.from.x, edge.to.x)
    const minY = Math.min(edge.from.y, edge.to.y)
    const maxY = Math.max(edge.from.y, edge.to.y)
    if (minX <= view.maxX && maxX >= view.minX && minY <= view.maxY && maxY >= view.minY) {
      edges.push(edge)
    }
  }

  const badges: EntityBadge[] = []
  for (const badge of scene.badges) {
    if (rectIntersectsView(badge, view)) badges.push(badge)
  }

  return { nodes, edges, badges }
}
