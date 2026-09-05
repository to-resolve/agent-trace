// 命中测试单测：节点内/外、边界、缩放平移后的真实点击链路、徽章命中。
// T7 适配：徽章几何改为构造时解析（makeBadge + 锚点中心），命中直接读
// 平铺字段——本文件同时验证构造正确性（几何与构造源边/节点的对齐）。
import { describe, it, expect } from 'vitest'
import { hitTestBadge, hitTestNode } from './hit-test'
import {
  INPUT_BADGE_DROP,
  INPUT_BADGE_LINE_HEIGHT,
  INPUT_STUB,
  edgeBadgeCenter,
  inputBadgeCenter,
  makeBadge,
  type EntityBadge,
} from './draw-node'
import { screenToWorld, type Viewport } from './viewport'
import type { LayoutEdge, LayoutNode } from '../core/types'

function makeNode(id: string, x: number, y: number, w = 180, h = 60): LayoutNode {
  return { spanId: id, layer: 0, x, y, width: w, height: h }
}

function edgeBetween(fromId: string, toId: string, entityId: string): LayoutEdge {
  // 边从 from 节点右缘到 to 节点左缘（buildEdges 的几何规则）
  const from = makeNode(fromId, fromId === 's-a' ? 0 : 260, 0)
  const to = makeNode(toId, toId === 's-b' ? 260 : 520, 0)
  return {
    fromSpanId: fromId,
    toSpanId: toId,
    from: { x: from.x + from.width, y: from.y + from.height / 2 },
    to: { x: to.x, y: to.y + to.height / 2 },
    viaEntityId: entityId,
    state: 'normal',
  }
}

function edgeBadge(entityId: string, edge: LayoutEdge): EntityBadge {
  return makeBadge(
    {
      entityId,
      label: '实体',
      status: 'fresh',
      ageDays: 0,
      dimmed: false,
      input: null,
    },
    edgeBadgeCenter(edge),
  )
}

function inputBadge(entityId: string, spanId: string, slot = 0): EntityBadge {
  return makeBadge(
    {
      entityId,
      label: '实体',
      status: 'fresh',
      ageDays: 0,
      dimmed: false,
      input: { spanId, slot },
    },
    inputBadgeCenter(makeNode(spanId, 0, 0), slot),
  )
}

describe('hitTestNode', () => {
  const nodes = [
    makeNode('s-a', 0, 0),
    makeNode('s-b', 260, 0),
    makeNode('s-c', 0, 84),
  ]

  it('关键测试：节点内命中（含几何中心与四角），节点外不命中', () => {
    const a = nodes[0]
    expect(hitTestNode(nodes, { x: a.x + 90, y: a.y + 30 })).toBe('s-a')
    // 四个角（闭区间边界）
    expect(hitTestNode(nodes, { x: a.x, y: a.y })).toBe('s-a')
    expect(hitTestNode(nodes, { x: a.x + 180, y: a.y })).toBe('s-a')
    expect(hitTestNode(nodes, { x: a.x, y: a.y + 60 })).toBe('s-a')
    expect(hitTestNode(nodes, { x: a.x + 180, y: a.y + 60 })).toBe('s-a')
    // 一像素之外即未命中
    expect(hitTestNode(nodes, { x: a.x - 1, y: a.y + 30 })).toBeNull()
    expect(hitTestNode(nodes, { x: a.x + 181, y: a.y + 30 })).toBeNull()
    expect(hitTestNode(nodes, { x: a.x + 90, y: a.y - 1 })).toBeNull()
    expect(hitTestNode(nodes, { x: a.x + 90, y: a.y + 61 })).toBeNull()
  })

  it('多个节点各自命中正确的 spanId', () => {
    expect(hitTestNode(nodes, { x: 300, y: 20 })).toBe('s-b')
    expect(hitTestNode(nodes, { x: 50, y: 100 })).toBe('s-c')
  })

  it('关键测试：缩放平移后，屏幕坐标经 screenToWorld 变回世界坐标后命中不变', () => {
    // s-b 的世界中心是 (350, 30)；构造视口把它映到屏幕 (500, 200)
    const vp: Viewport = { scale: 1.6, offsetX: -60, offsetY: 152 }
    const screen = { x: 350 * 1.6 - 60, y: 30 * 1.6 + 152 }
    expect(screen).toEqual({ x: 500, y: 200 })
    const world = screenToWorld(vp, screen)
    expect(hitTestNode(nodes, world)).toBe('s-b')
    // 屏幕偏移 160px = 世界偏移 100px，超过半节点宽 90 → 不再命中
    const miss = screenToWorld(vp, { x: screen.x + 160, y: screen.y })
    expect(hitTestNode(nodes, miss)).toBeNull()
  })
})

describe('makeBadge 构造几何（T7 一次解析）', () => {
  it('因果边徽章几何居中于边中点，宽随文本（stale 追加「· N 天」变宽）', () => {
    const edge = edgeBetween('s-a', 's-b', 'e-x')
    const center = edgeBadgeCenter(edge)
    const fresh = edgeBadge('e-x', edge)
    expect(fresh.x + fresh.width / 2).toBeCloseTo(center.x, 6)
    expect(fresh.y + fresh.height / 2).toBeCloseTo(center.y, 6)
    // stale 追加「· 91 天」→ 文本更长 → 更宽
    const stale = makeBadge(
      {
        entityId: 'e-x',
        label: '候选人简历',
        status: 'stale',
        ageDays: 91,
        dimmed: false,
        input: null,
      },
      center,
    )
    expect(stale.width).toBeGreaterThan(fresh.width)
    // 两者同中心：stale 的外扩部分（右侧半宽差）在 stale 内、fresh 外
    const farRight = { x: center.x + fresh.width / 2 + 5, y: center.y }
    expect(hitTestBadge([stale], farRight)).toBe('e-x')
    expect(hitTestBadge([fresh], farRight)).toBeNull()
  })

  it('外部输入徽章几何居于短边中点：中线 + DROP + slot × 行距', () => {
    const badge0 = inputBadge('e-in-0', 's-a', 0)
    const badge1 = inputBadge('e-in-1', 's-a', 1)
    // span (0,0,180,60) 的中线 y=30；slot 0 中心 y = 30 + DROP；slot 1 再下一行
    expect(badge0.y + badge0.height / 2).toBe(30 + INPUT_BADGE_DROP)
    expect(badge1.y + badge1.height / 2).toBe(30 + INPUT_BADGE_DROP + INPUT_BADGE_LINE_HEIGHT)
    expect(badge0.x + badge0.width / 2).toBe(-INPUT_STUB / 2)
  })
})

describe('hitTestBadge', () => {
  it('因果边徽章：在边中点命中，偏离中点不命中', () => {
    const edge = edgeBetween('s-a', 's-b', 'e-1')
    const badges = [edgeBadge('e-1', edge)]
    const center = edgeBadgeCenter(edge)
    expect(hitTestBadge(badges, center)).toBe('e-1')
    expect(hitTestBadge(badges, { x: center.x, y: center.y - 20 })).toBeNull()
    expect(hitTestBadge(badges, { x: center.x + 100, y: center.y })).toBeNull()
  })

  it('外部输入徽章：下移一行锚在短边中点，垂直 slot 堆叠各自命中', () => {
    const badges = [inputBadge('e-in-0', 's-a', 0), inputBadge('e-in-1', 's-a', 1)]
    const y0 = 30 + INPUT_BADGE_DROP
    const y1 = y0 + INPUT_BADGE_LINE_HEIGHT
    expect(hitTestBadge(badges, { x: -INPUT_STUB / 2, y: y0 })).toBe('e-in-0')
    expect(hitTestBadge(badges, { x: -INPUT_STUB / 2, y: y1 })).toBe('e-in-1')
    // 因果边徽章所在的 span 中线一行不再命中输入徽章（两行已错开）
    expect(hitTestBadge(badges, { x: -INPUT_STUB / 2, y: 30 })).toBeNull()
    expect(hitTestBadge(badges, { x: -INPUT_STUB / 2, y: y0 - 30 })).toBeNull()
  })

  it('命中与徽章数组顺序无关（rect 构造时解析，不依赖任何数组对齐）', () => {
    const edgeA = edgeBetween('s-a', 's-b', 'e-a')
    const edgeB = edgeBetween('s-b', 's-c', 'e-b')
    // s-c 的 x 取 520（edgeBetween 内 toId==='s-c' 分支）
    const centerA = edgeBadgeCenter(edgeA)
    const centerB = edgeBadgeCenter(edgeB)
    const bA = edgeBadge('e-a', edgeA)
    const bB = edgeBadge('e-b', edgeB)
    // 两个顺序都各自命中自己的位置
    expect(hitTestBadge([bA, bB], centerA)).toBe('e-a')
    expect(hitTestBadge([bA, bB], centerB)).toBe('e-b')
    expect(hitTestBadge([bB, bA], centerA)).toBe('e-a')
    expect(hitTestBadge([bB, bA], centerB)).toBe('e-b')
    // 互不误命中
    expect(hitTestBadge([bA], centerB)).toBeNull()
    expect(hitTestBadge([bB], centerA)).toBeNull()
  })
})
