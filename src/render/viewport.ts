// 视口：世界坐标（布局产物）↔ 屏幕坐标（画布像素）的双向变换（纯函数）。
//
// 变换式：screen = world * scale + offset（offset 为屏幕像素、未含 DPR——
// DPR 缩放由 renderer 作为基线变换处理，视口只在 CSS 像素层面工作）。
// 命中测试必须先把鼠标屏幕坐标经 screenToWorld 变回世界坐标再判定。

/** 布局与世界共用的二维点 */
export interface Point {
  x: number
  y: number
}

export interface Viewport {
  scale: number
  offsetX: number
  offsetY: number
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 2

/** 屏幕坐标 → 世界坐标 */
export function screenToWorld(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.offsetX) / vp.scale, y: (p.y - vp.offsetY) / vp.scale }
}

/** 世界坐标 → 屏幕坐标 */
export function worldToScreen(vp: Viewport, p: Point): Point {
  return { x: p.x * vp.scale + vp.offsetX, y: p.y * vp.scale + vp.offsetY }
}

/** 缩放夹紧到 [MIN_SCALE, MAX_SCALE] */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * 以屏幕点 anchor 为锚缩放 factor 倍：锚点下的世界坐标在缩放前后
 * 屏幕位置保持不动（否则缩放时鼠标下的内容会漂移）。
 */
export function zoomAt(vp: Viewport, anchor: Point, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  // 缩放无实际变化（factor=1 或已夹在边界）时直接返回原视口：
  // 走下面的除法/乘法往返会引入浮点误差，把 offset 漂移 1e-15 量级
  if (scale === vp.scale) return vp
  const world = screenToWorld(vp, anchor)
  return {
    scale,
    offsetX: anchor.x - world.x * scale,
    offsetY: anchor.y - world.y * scale,
  }
}

/** 平移：屏幕像素位移直接累加到 offset，scale 不变 */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { scale: vp.scale, offsetX: vp.offsetX + dx, offsetY: vp.offsetY + dy }
}

/** 内容的世界坐标范围（minX 可能 < 0：外部输入短边徽章在 0 层节点左侧） */
export interface ContentBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 适配视口：内容等比缩放到画布内（留边距）并居中。
 * 空内容退化为 scale=1 原点对齐，避免除零。
 */
export function fitViewport(
  bounds: ContentBounds,
  canvasWidth: number,
  canvasHeight: number,
): Viewport {
  // 空内容（无节点无徽章）：退化 scale=1、世界原点对齐画布中心，
  // 避免 0 宽高参与除法。首个事件到达前用这个视口，不会看到漂移。
  if (bounds.maxX <= bounds.minX && bounds.maxY <= bounds.minY) {
    return { scale: 1, offsetX: canvasWidth / 2, offsetY: canvasHeight / 2 }
  }
  const width = Math.max(bounds.maxX - bounds.minX, 1)
  const height = Math.max(bounds.maxY - bounds.minY, 1)
  const padding = 40
  const scale = clampScale(
    Math.min((canvasWidth - padding * 2) / width, (canvasHeight - padding * 2) / height),
  )
  return {
    scale,
    offsetX: (canvasWidth - width * scale) / 2 - bounds.minX * scale,
    offsetY: (canvasHeight - height * scale) / 2 - bounds.minY * scale,
  }
}
