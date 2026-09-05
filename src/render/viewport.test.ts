// 视口单测：坐标变换来回可逆（T5 验收）、锚点缩放、夹紧、平移、适配。
import { describe, it, expect } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitViewport,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Point,
  type Viewport,
} from './viewport'

describe('坐标变换', () => {
  it('关键测试：worldToScreen ∘ screenToWorld 任意缩放平移组合下来回可逆', () => {
    const viewports: Viewport[] = [
      { scale: 1, offsetX: 0, offsetY: 0 },
      { scale: 0.37, offsetX: -123.4, offsetY: 88.2 },
      { scale: 1.8, offsetX: 420, offsetY: -17 },
      { scale: MIN_SCALE, offsetX: 9999, offsetY: -9999 },
    ]
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 180, y: 84 },
      { x: -96.5, y: 1234.7 },
      { x: 1e-7, y: -1e-7 },
    ]
    for (const vp of viewports) {
      for (const p of points) {
        const roundTrip = screenToWorld(vp, worldToScreen(vp, p))
        expect(roundTrip.x).toBeCloseTo(p.x, 10)
        expect(roundTrip.y).toBeCloseTo(p.y, 10)
        const back = worldToScreen(vp, screenToWorld(vp, p))
        expect(back.x).toBeCloseTo(p.x, 10)
        expect(back.y).toBeCloseTo(p.y, 10)
      }
    }
  })

  it('screenToWorld / worldToScreen 单点数值正确', () => {
    const vp: Viewport = { scale: 2, offsetX: 10, offsetY: -30 }
    expect(worldToScreen(vp, { x: 5, y: 5 })).toEqual({ x: 20, y: -20 })
    expect(screenToWorld(vp, { x: 20, y: -20 })).toEqual({ x: 5, y: 5 })
  })
})

describe('clampScale', () => {
  it('低于下限夹到 MIN_SCALE，高于上限夹到 MAX_SCALE，区间内原样返回', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(1)).toBe(1)
  })
})

describe('zoomAt', () => {
  it('关键测试：锚点下的世界坐标在缩放前后屏幕位置不变', () => {
    const vp: Viewport = { scale: 1, offsetX: 0, offsetY: 0 }
    const anchor: Point = { x: 100, y: 200 }
    const zoomed = zoomAt(vp, anchor, 1.25)
    // 锚点缩放前是屏幕 (100, 200)，对应世界 (100, 200)
    expect(worldToScreen(zoomed, { x: 100, y: 200 })).toEqual({ x: 100, y: 200 })
    expect(zoomed.scale).toBe(1.25)
    expect(zoomed.offsetX).toBe(100 - 100 * 1.25)
    expect(zoomed.offsetY).toBe(200 - 200 * 1.25)
  })

  it('带平移偏移的视口上锚点同样不动，且缩放被夹紧', () => {
    const vp: Viewport = { scale: 1.5, offsetX: -60, offsetY: 30 }
    const anchor: Point = { x: 400, y: 120 }
    const before = screenToWorld(vp, anchor)
    const zoomed = zoomAt(vp, anchor, 10) // 1.5 * 10 → 夹到 MAX_SCALE
    expect(zoomed.scale).toBe(MAX_SCALE)
    expect(worldToScreen(zoomed, before)).toEqual({ x: 400, y: 120 })
  })

  it('factor 为 1 时视口不变', () => {
    const vp: Viewport = { scale: 1.2, offsetX: 5, offsetY: -7 }
    expect(zoomAt(vp, { x: 33, y: 44 }, 1)).toEqual(vp)
  })
})

describe('panBy', () => {
  it('只改偏移，scale 不变', () => {
    const vp: Viewport = { scale: 1.4, offsetX: 10, offsetY: 10 }
    const panned = panBy(vp, -25, 40)
    expect(panned).toEqual({ scale: 1.4, offsetX: -15, offsetY: 50 })
  })
})

describe('fitViewport', () => {
  it('内容中心映射到画布中心，四角落在画布内（含 minX < 0 的外部输入徽章）', () => {
    // 内容：外部输入短边伸到 x=-160，节点区到 x=640，y 0..168
    const bounds = { minX: -160, minY: 0, maxX: 640, maxY: 168 }
    const vp = fitViewport(bounds, 800, 600)
    const center = worldToScreen(vp, { x: (-160 + 640) / 2, y: 84 })
    expect(center.x).toBeCloseTo(400, 6)
    expect(center.y).toBeCloseTo(300, 6)
    const corners = [
      { x: -160, y: 0 },
      { x: 640, y: 168 },
    ]
    for (const c of corners) {
      const s = worldToScreen(vp, c)
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(800)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(600)
    }
  })

  it('超大内容缩小到画布内且不越过 MIN_SCALE；空内容退化为 scale=1', () => {
    const vp = fitViewport({ minX: 0, minY: 0, maxX: 100000, maxY: 100000 }, 800, 600)
    expect(vp.scale).toBe(MIN_SCALE)
    const empty = fitViewport({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 800, 600)
    expect(empty.scale).toBe(1)
  })
})
