// Canvas 绘制：节点 / 因果边 / 实体徽章（docs/04 §4 UI 呈现约定）。
//
// 硬约束（docs/02 §10）：本层只读 Layout + store 喂进来的纯视图模型
// （Scene），不得直接读取 CausalGraph。span 的 name / kind / status 与
// 实体的 label / 新鲜度都不在 Layout 契约里，由 store 组装成 Scene 传入，
// 渲染层保持零数据依赖、可整层替换。
//
// 徽章规则（04 §4）：节点是 span，数据实体以徽章渲染在因果边中点上；
// stale 的徽章变红并显示天数。producedBy === null 的实体（用户输入、
// 外部下发的策略）按 02 §4 不产生因果边——但它们是溯源链的根，徽章
// 挂在「消费者 span 左缘伸出的虚拟短边」中点上，保证 e-policy 这类
// 对照实体在图上可见、可点。
//
// T7 修订（压测数据 M4b：绘制路径每帧对每徽章做 O(E) 三元组查找，
// 10k 规模实测 247–505ms/帧，是 60fps 预算 16.7ms 的 ~30 倍）：
// 徽章几何改为**构造时一次解析**——EntityBadge 自带 rect（由 makeBadge
// 从构造源边/节点直接算出，O(1)），绘制 / 命中 / 裁剪 / 包围盒全部读
// 同一份 rect。构造源即几何源，「找不到所属边」在结构上不可能，
// T6 审查建议条（静默落到世界原点）随之消灭。drawScene 同时接入
// 视口裁剪（culling.ts）：每帧只画视口世界矩形内的元素。
import type {
  EntityId,
  FreshnessStatus,
  Layout,
  LayoutEdge,
  LayoutNode,
  SpanId,
  SpanKind,
  SpanStatus,
} from '../core/types'
import type { ContentBounds, Point } from './viewport'
import { cullScene, type WorldRect } from './culling'

// —— 徽章几何常量：构造（makeBadge）与命中测试必须共用同一份 ——
export const BADGE_FONT = '12px system-ui, sans-serif'
export const BADGE_HEIGHT = 22
export const BADGE_PAD_X = 10
/** 外部输入短边长度：从消费者左缘向左伸出，徽章中心在短边中点 */
export const INPUT_STUB = 160
/**
 * 外部输入徽章相对 span 中线的向下偏移：因果边徽章锚在边中点（span 中线
 * 高度），两者都宽于层间距（80px），同行必然水平重叠——外部输入徽章整体
 * 下移一行错开（如 s-decide 的 e-policy 与进入边上的 e-score 徽章）。
 */
export const INPUT_BADGE_DROP = 26
/** 同一 span 的多个外部输入徽章在垂直方向上的行距 */
export const INPUT_BADGE_LINE_HEIGHT = 26

/** —— 渲染层输入类型（store 组装，纯数据）—— */

/** span 的展示信息：Layout 契约只有几何，文本与配色语义由视图模型补充 */
export interface NodeVisual {
  spanId: SpanId
  name: string
  kind: SpanKind
  status: SpanStatus
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 因果边徽章的锚点中心：边中点（构造源即边本身，O(1)） */
export function edgeBadgeCenter(edge: LayoutEdge): Point {
  return { x: (edge.from.x + edge.to.x) / 2, y: (edge.from.y + edge.to.y) / 2 }
}

/** 外部输入徽章的锚点中心：消费者左缘短边中点下移 slot 行 */
export function inputBadgeCenter(node: LayoutNode, slot: number): Point {
  return {
    x: node.x - INPUT_STUB / 2,
    y: node.y + node.height / 2 + INPUT_BADGE_DROP + slot * INPUT_BADGE_LINE_HEIGHT,
  }
}

/** 近似字宽：无 canvas 也能算，徽章构造与命中测试共用同一结果 */
function approxTextWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0xff ? 12 : 6.5
  }
  return width
}

/** 徽章文本：stale 追加「· N 天」（04 §4：过期徽章变红并显示天数） */
function badgeText(badge: Pick<EntityBadge, 'label' | 'status' | 'ageDays'>): string {
  return badge.status === 'stale' ? `${badge.label} · ${badge.ageDays} 天` : badge.label
}

export interface EntityBadge {
  entityId: EntityId
  label: string
  status: FreshnessStatus
  /** 天数（向下取整）——stale 徽章的「91 天」由此而来 */
  ageDays: number
  dimmed: boolean
  /**
   * 徽章世界坐标矩形（平铺字段，构造时一次解析——T7「一次解析复用」）：
   * 绘制 / 命中 / 裁剪 / 包围盒共用同一份几何，「画在哪就点哪」的单一
   * 事实源。平铺而非嵌套 rect 对象：徽章是 10k 规模下的热路径对象，
   * 单对象分配省一半 GC 压力（压测 M4b：此前绘制路径逐帧 O(E) 查找
   * 247–505ms/帧，是 60fps 预算 16.7ms 的 ~30 倍）。
   */
  x: number
  y: number
  width: number
  height: number
  /** 外部输入徽章的短边归属（虚拟短边绘制用）；因果边徽章为 null */
  input: { spanId: SpanId; slot: number } | null
}

/** 徽章宽度：近似文本宽 + 两侧留白（构造时解析用，stale 含「· N 天」后缀） */
export function badgeWidth(label: string, status: FreshnessStatus, ageDays: number): number {
  const text = status === 'stale' ? `${label} · ${ageDays} 天` : label
  return approxTextWidth(text) + BADGE_PAD_X * 2
}

/** 构造完整徽章：字段 + 锚点中心 → 徽章（几何在此刻解析，单次分配） */
export function makeBadge(fields: Omit<EntityBadge, 'x' | 'y' | 'width' | 'height'>, center: Point): EntityBadge {
  const width = badgeWidth(fields.label, fields.status, fields.ageDays)
  return {
    ...fields,
    x: center.x - width / 2,
    y: center.y - BADGE_HEIGHT / 2,
    width,
    height: BADGE_HEIGHT,
  }
}

/** 一帧的完整绘制输入；version 由 store 在任何视图变化时自增 */
export interface Scene {
  version: number
  layout: Layout
  nodeVisuals: ReadonlyMap<SpanId, NodeVisual>
  badges: readonly EntityBadge[]
  /** null = 无高亮（全部 normal）；非 null = 集合内 highlighted、集合外 dimmed */
  highlightedSpanIds: ReadonlySet<SpanId> | null
}

/** 内容包围盒：节点矩形 ∪ 徽章矩形（外部输入徽章的 x 可能为负） */
export function contentBounds(scene: Scene): ContentBounds {
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  const include = (x: number, y: number, width: number, height: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + width)
    maxY = Math.max(maxY, y + height)
  }
  for (const node of scene.layout.nodes.values()) {
    include(node.x, node.y, node.width, node.height)
  }
  for (const badge of scene.badges) {
    include(badge.x, badge.y, badge.width, badge.height)
  }
  return { minX, minY, maxX, maxY }
}

// —— 配色（Canvas 无 Tailwind，色值写死在本层）——

const NODE_FILL = '#1e293b'
const NODE_TEXT = '#e2e8f0'
const NODE_SUBTEXT = '#94a3b8'
const HIGHLIGHT = '#fbbf24'

const KIND_COLORS: Record<SpanKind, string> = {
  agent: '#818cf8',
  llm: '#c084fc',
  tool: '#22d3ee',
  retrieval: '#34d399',
  decision: '#fb923c',
}

const EDGE_STYLES: Record<
  'normal' | 'highlighted' | 'dimmed',
  { color: string; width: number; alpha: number }
> = {
  normal: { color: '#475569', width: 1.5, alpha: 0.9 },
  highlighted: { color: HIGHLIGHT, width: 2.5, alpha: 1 },
  dimmed: { color: '#475569', width: 1, alpha: 0.12 },
}

const BADGE_COLORS: Record<FreshnessStatus, { bg: string; border: string; text: string }> = {
  stale: { bg: '#b91c1c', border: '#f87171', text: '#ffffff' },
  aging: { bg: '#78350f', border: '#f59e0b', text: '#fde68a' },
  fresh: { bg: '#334155', border: '#64748b', text: '#cbd5e1' },
}

// —— 基础绘制原语 ——

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** 截断文本到 maxWidth（带省略号）；只在绘制时用 ctx.measureText 精确测量 */
function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let cut = text.length
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) {
    cut -= 1
  }
  return `${text.slice(0, cut)}…`
}

type NodeVisualState = 'normal' | 'highlighted' | 'dimmed'

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: LayoutNode,
  visual: NodeVisual | undefined,
  state: NodeVisualState,
): void {
  ctx.save()
  if (state === 'dimmed') ctx.globalAlpha = 0.25
  const kindColor = visual !== undefined ? KIND_COLORS[visual.kind] : '#64748b'

  roundRectPath(ctx, node.x, node.y, node.width, node.height, 6)
  ctx.fillStyle = NODE_FILL
  ctx.fill()

  if (state === 'highlighted') {
    // 外圈光环：两层描边叠出被选中的视觉重量
    ctx.globalAlpha = 0.3
    ctx.lineWidth = 7
    ctx.strokeStyle = HIGHLIGHT
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 2.5
    ctx.strokeStyle = HIGHLIGHT
  } else {
    ctx.lineWidth = 1.5
    ctx.strokeStyle = kindColor
  }
  if (visual !== undefined && visual.status === 'running') ctx.setLineDash([5, 4])
  ctx.stroke()
  ctx.setLineDash([])

  if (visual !== undefined) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = NODE_TEXT
    ctx.font = 'bold 12px system-ui, sans-serif'
    ctx.fillText(
      truncateText(ctx, visual.name, node.width - 16),
      node.x + node.width / 2,
      node.y + node.height / 2 - 8,
    )
    ctx.fillStyle = NODE_SUBTEXT
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText(visual.kind, node.x + node.width / 2, node.y + node.height / 2 + 10)
  }
  ctx.restore()
}

function drawEdge(ctx: CanvasRenderingContext2D, edge: Layout['edges'][number]): void {
  const style = EDGE_STYLES[edge.state]
  ctx.save()
  ctx.globalAlpha = style.alpha
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.width
  ctx.beginPath()
  ctx.moveTo(edge.from.x, edge.from.y)
  ctx.lineTo(edge.to.x, edge.to.y)
  ctx.stroke()

  // 箭头指向 to 端（因果方向：数据的生产者 → 消费者）
  const angle = Math.atan2(edge.to.y - edge.from.y, edge.to.x - edge.from.x)
  const size = 7
  ctx.fillStyle = style.color
  ctx.beginPath()
  ctx.moveTo(edge.to.x, edge.to.y)
  ctx.lineTo(
    edge.to.x - size * Math.cos(angle - 0.42),
    edge.to.y - size * Math.sin(angle - 0.42),
  )
  ctx.lineTo(
    edge.to.x - size * Math.cos(angle + 0.42),
    edge.to.y - size * Math.sin(angle + 0.42),
  )
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/**
 * 外部输入的虚拟短边：从消费者左缘向左伸出，徽章盖在它的中点上。
 * 短边几何直接从徽章平铺几何推导（中心即短边中点，node.x = 中心
 * x + INPUT_STUB/2），无任何查找。
 */
function drawInputStub(ctx: CanvasRenderingContext2D, badge: EntityBadge): void {
  if (badge.input === null) return
  const nodeX = badge.x + badge.width / 2 + INPUT_STUB / 2
  const cy = badge.y + badge.height / 2
  ctx.save()
  ctx.globalAlpha = badge.dimmed ? 0.15 : 0.7
  ctx.strokeStyle = '#64748b'
  ctx.lineWidth = 1.5
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(nodeX - INPUT_STUB, cy)
  ctx.lineTo(nodeX, cy)
  ctx.stroke()
  ctx.restore()
}

function drawBadge(ctx: CanvasRenderingContext2D, badge: EntityBadge): void {
  const colors = BADGE_COLORS[badge.status]
  ctx.save()
  if (badge.dimmed) ctx.globalAlpha = 0.2
  roundRectPath(ctx, badge.x, badge.y, badge.width, badge.height, badge.height / 2)
  ctx.fillStyle = colors.bg
  ctx.fill()
  ctx.strokeStyle = colors.border
  ctx.lineWidth = badge.status === 'stale' ? 1.5 : 1
  ctx.stroke()
  ctx.fillStyle = colors.text
  ctx.font = BADGE_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(badgeText(badge), badge.x + badge.width / 2, badge.y + badge.height / 2 + 1)
  ctx.restore()
}

/**
 * 整帧绘制：视口裁剪（cullScene）→ 边 → 外部输入短边 → 节点 → 徽章
 * （徽章最上层）。徽章必须压在节点之上：徽章宽（含「· N 天」后缀）
 * 普遍超过层间距 80px，画在节点下面会被端点节点遮住大半，stale 红色
 * 与天数就看不见了。徽章是 04 §4 的视觉焦点，盖在节点边缘上是特性
 * 而非缺陷。
 */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, view: WorldRect): void {
  const { highlightedSpanIds } = scene
  const visible = cullScene(scene, view)
  for (const edge of visible.edges) {
    drawEdge(ctx, edge)
  }
  for (const badge of visible.badges) {
    drawInputStub(ctx, badge)
  }
  for (const node of visible.nodes) {
    const state: NodeVisualState =
      highlightedSpanIds === null
        ? 'normal'
        : highlightedSpanIds.has(node.spanId)
          ? 'highlighted'
          : 'dimmed'
    drawNode(ctx, node, scene.nodeVisuals.get(node.spanId), state)
  }
  for (const badge of visible.badges) {
    drawBadge(ctx, badge)
  }
}
