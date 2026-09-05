// 视口裁剪测试（T7 验收）：10k 节点、视口仅含约 50 个元素时，
// 单帧绘制调用数与视口内元素数成正比、与总节点数无关。
//
// stub ctx 记录绘制原语（fill/stroke/fillText）调用次数：测试内构造
// 桩对象是标准手段（同 T6 审查对 events.test.ts 构造脏数据的裁定，
// 不属「用强转绕过设计问题」）。桩实现 CanvasRenderingContext2D 被
// drawScene 实际触达的成员子集——nodeVisuals 留空使 measureText 路径
// 不触发，桩保持最小。
import { describe, it, expect } from 'vitest'
import { drawScene, edgeBadgeCenter, makeBadge, type Scene } from './draw-node'
import { cullScene, type WorldRect } from './culling'
import type { LayoutEdge, LayoutNode, SpanId } from '../core/types'

/** 列 × 行网格场景：节点在 (c×260, r×84)，水平边连接同行相邻列 */
function gridScene(cols: number, rows: number): Scene {
  const nodes = new Map<SpanId, LayoutNode>()
  const edges: LayoutEdge[] = []
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const id = `n-${c}-${r}`
      nodes.set(id, { spanId: id, layer: r, x: c * 260, y: r * 84, width: 180, height: 60 })
    }
  }
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < rows; r++) {
      const from = nodes.get(`n-${c}-${r}`)
      const to = nodes.get(`n-${c + 1}-${r}`)
      if (from === undefined || to === undefined) continue
      const edge: LayoutEdge = {
        fromSpanId: from.spanId,
        toSpanId: to.spanId,
        from: { x: from.x + from.width, y: from.y + from.height / 2 },
        to: { x: to.x, y: to.y + to.height / 2 },
        viaEntityId: `e-${c}-${r}`,
        state: 'normal',
      }
      edges.push(edge)
    }
  }
  const badges = edges.map((edge) =>
    makeBadge(
      {
        entityId: edge.viaEntityId,
        label: `实体 ${edge.viaEntityId}`,
        status: 'fresh',
        ageDays: 0,
        dimmed: false,
        input: null,
      },
      edgeBadgeCenter(edge),
    ),
  )
  return {
    version: 1,
    layout: { nodes, edges, bounds: { width: cols * 260, height: rows * 84 }, version: 1 },
    nodeVisuals: new Map(),
    badges,
    highlightedSpanIds: null,
  }
}

/** 记录绘制原语调用次数的 stub ctx（counts 是活引用，绘制后读取） */
function makeCountingCtx(): {
  counts: { fills: number; strokes: number; fillTexts: number }
  ctx: CanvasRenderingContext2D
} {
  const counts = { fills: 0, strokes: 0, fillTexts: 0 }
  const stub = {
    save(): void {},
    restore(): void {},
    beginPath(): void {},
    moveTo(_x: number, _y: number): void {},
    lineTo(_x: number, _y: number): void {},
    arcTo(_x1: number, _y1: number, _x2: number, _y2: number, _r: number): void {},
    closePath(): void {},
    setLineDash(_segments: number[]): void {},
    fill(): void {
      counts.fills += 1
    },
    stroke(): void {
      counts.strokes += 1
    },
    fillText(_text: string, _x: number, _y: number): void {
      counts.fillTexts += 1
    },
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    font: '12px sans-serif',
    textAlign: 'center' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
  }
  // 桩只实现被触达的成员子集；CanvasRenderingContext2D 可赋给该子集类型，
  // 因此这一转换是类型安全的结构性收窄（非绕过设计）
  return { counts, ctx: stub as CanvasRenderingContext2D }
}

describe('cullScene 纯函数', () => {
  it('视口外的节点 / 边 / 徽章被排除，视口内与边界相接的保留', () => {
    const scene = gridScene(4, 2)
    const view: WorldRect = { minX: 0, minY: 0, maxX: 800, maxY: 167 }
    const visible = cullScene(scene, view)
    // 4 列 × 2 行全部可见（第 3 列 780–960 与视口 0–800 相接）
    expect(visible.nodes).toHaveLength(8)
    // 每行 3 条边（c=0,1,2 的边终点 ≤ 800；c=3 的边起点 960 > 800 被排除）
    expect(visible.edges).toHaveLength(6)
    expect(visible.badges).toHaveLength(6)
  })

  it('完全在视口外的元素零命中：平移视口后同一元素被排除', () => {
    const scene = gridScene(4, 2)
    const all = cullScene(scene, { minX: -100, minY: -100, maxX: 5000, maxY: 5000 })
    expect(all.nodes).toHaveLength(8)
    // 视口移到右侧远处：左侧两列节点全部落在视口外
    const right = cullScene(scene, { minX: 520, minY: 0, maxX: 5000, maxY: 5000 })
    expect(right.nodes.map((n) => n.spanId)).toEqual([
      'n-2-0',
      'n-2-1',
      'n-3-0',
      'n-3-1',
    ])
    // 视口上方远处：全部排除
    const far = cullScene(scene, { minX: 0, minY: 1000, maxX: 5000, maxY: 2000 })
    expect(far.nodes).toHaveLength(0)
    expect(far.edges).toHaveLength(0)
    expect(far.badges).toHaveLength(0)
  })
})

describe('drawScene 视口裁剪（stub ctx 计数断言）', () => {
  /** 覆盖左上角 4 列 × 2 行的视口（第 2 行 y=168 起在视口外） */
  const view: WorldRect = { minX: 0, minY: 0, maxX: 800, maxY: 167 }

  it('关键测试：10k 节点与 200 节点在相同视口下绘制调用数完全一致（与总节点数无关）', () => {
    const big = gridScene(100, 100) // 10k 节点 / 9900 边
    const small = gridScene(100, 2) // 200 节点 / 198 边
    expect(big.layout.nodes.size).toBe(10_000)
    expect(small.layout.nodes.size).toBe(200)

    const a = makeCountingCtx()
    const b = makeCountingCtx()
    drawScene(a.ctx, big, view)
    drawScene(b.ctx, small, view)

    // 同一可见区域 → 完全相同的绘制调用：证明调用数只由视口内元素决定
    expect(a.counts.fills).toBe(b.counts.fills)
    expect(a.counts.strokes).toBe(b.counts.strokes)
    expect(a.counts.fillTexts).toBe(b.counts.fillTexts)
    // 且是小量：可见 8 节点 + 6 边 + 6 徽章的量级，而非 10k 量级
    expect(a.counts.fills).toBeLessThan(50)
    expect(a.counts.strokes).toBeLessThan(50)
    expect(a.counts.fillTexts).toBeLessThan(20)
  })

  it('绘制调用数与视口内元素数成正比：全图视口的调用数远大于小视口', () => {
    const scene = gridScene(100, 2) // 200 节点 / 198 边
    const small = makeCountingCtx()
    drawScene(small.ctx, scene, view)
    const full = makeCountingCtx()
    drawScene(full.ctx, scene, { minX: 0, minY: 0, maxX: 26_000, maxY: 5000 })

    // 200 节点全画：fills = 200 节点 + 198 徽章 + 198 边箭头 ≈ 600
    expect(full.counts.fills).toBeGreaterThan(500)
    expect(full.counts.fills / small.counts.fills).toBeGreaterThan(10)
    expect(full.counts.fillTexts).toBe(198) // 每徽章一次文本
  })
})
