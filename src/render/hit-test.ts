// AABB 命中测试（纯函数）。判定一律在世界坐标系进行——调用方必须先把
// 鼠标屏幕坐标经 viewport.screenToWorld 变回世界坐标（docs/03 T5 要求）。
// 徽章矩形即构造时解析的 badge.rect（T7 一次解析复用）：绘制、命中、
// 裁剪共用同一份几何，保证「画在哪就点哪」。
import type { EntityId, LayoutNode, SpanId } from '../core/types'
import type { EntityBadge } from './draw-node'
import type { Point } from './viewport'

/** 节点命中：返回覆盖该世界坐标的 spanId，无命中返回 null */
export function hitTestNode(nodes: Iterable<LayoutNode>, p: Point): SpanId | null {
  for (const node of nodes) {
    if (
      p.x >= node.x &&
      p.x <= node.x + node.width &&
      p.y >= node.y &&
      p.y <= node.y + node.height
    ) {
      return node.spanId
    }
  }
  return null
}

/** 徽章命中：返回覆盖该世界坐标的 entityId，无命中返回 null */
export function hitTestBadge(badges: readonly EntityBadge[], p: Point): EntityId | null {
  for (const badge of badges) {
    if (
      p.x >= badge.x &&
      p.x <= badge.x + badge.width &&
      p.y >= badge.y &&
      p.y <= badge.y + badge.height
    ) {
      return badge.entityId
    }
  }
  return null
}
