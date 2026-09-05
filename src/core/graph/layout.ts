// 增量分层布局（docs/02 第 10 节 Layout 契约 + T4 任务卡）。
//
// 布局方向自左向右：layer 决定 x（第 layer 列），层内序号决定 y（行）。
// 分层用最长路径法：layer(span) = max(layer(上游)) + 1，无上游者为 0。
// 环必须能打破：DFS 中「回到 onPath 上节点」的边是回边（判定语义与
// query.ts 的 hasCycle 一致），回边不参与层级约束，否则分层无限循环。
//
// 两个入口：
// - layoutGraph   首次构建 / run.snapshot 后的全量重建。层内排序用重心法
//                 （barycenter），固定 4 轮「下-上」交替扫描，不做全局优化。
// - updateLayout  增量：只重算 dirty 节点及其下游闭包，未受影响节点的
//                 (x, y) 逐字段保持不变（直接复用原 LayoutNode 对象）。
//
// 增量调用的 dirty 标记约定（供 T5 store 参考实现）：
// - span.start    → dirty = { spanId }
// - entity.create → dirty = { entity.producedBy }（非 null 时；下游闭包天然
//                   覆盖「实体后到补边」场景中层级需要抬升的消费者）
// - span.end / run.start / run.end → dirty = 空集（不改变图结构）
// - run.snapshot  → 清场重放后走 layoutGraph 全量重建，不要用增量
//
// 递归深度约定（T7 审查 S1，与上面的「环安全」是两个独立风险）：
// computeLayering 的 visit 递归深度上界 = **affected 子图内沿入边的未
// memo 链长**，不是全图规模。当前调用约定下实测深度 1–2：span.start 的
// dirty 单点 + 边界层号（boundaryOf）直接命中未受影响的 memo 边界，
// 递归链在首个边界节点处终止。但可构造反例——A→B 同时 A→C₁→…→C_k→B，
// 若 B 先于 C 链进入 affected（取决于 outgoing 边顺序与 DFS pop 顺序），
// visit(B)→visit(C_k)→…→visit(C₁) 深度达 k+1。**若未来出现万级深链 +
// 逆拓扑序入集的调用形态，此处是爆栈点，届时把 visit 改为显式栈迭代**
// （参考 query.ts traverse 的做法，语义对齐点见其文件头注释）。
import type {
  CausalEdge,
  CausalGraph,
  Layout,
  LayoutEdge,
  LayoutNode,
  SpanId,
} from '../types'

// —— 尺寸常量：布局与渲染（T5）必须复用同一份，禁止各写一套 ——
export const NODE_WIDTH = 180
export const NODE_HEIGHT = 60
/** 层间距：相邻两层节点左边缘的 x 距离（列间距） */
export const LAYER_GAP = 80
/** 同层相邻节点的 y 间距 */
export const NODE_GAP = 24

/** x 方向步长：节点左边缘 = layer * X_STRIDE */
const X_STRIDE = NODE_WIDTH + LAYER_GAP
/** y 方向步长：同层第 k 个节点的上边缘 = k * Y_STRIDE */
const Y_STRIDE = NODE_HEIGHT + NODE_GAP

/** 重心法迭代轮数上限（任务卡建议 4：交叉数最优是 NP 难，本项目不需要） */
const BARYCENTER_SWEEPS = 4

/** 分层结果：层号 + 回边集合（回边不参与层级约束与重心计算，但会被渲染） */
interface Layering {
  layers: Map<SpanId, number>
  backEdges: Set<CausalEdge>
}

/**
 * 最长路径分层（带环打破）。环安全的关键与 query.ts 的 traverse 一致：
 * - onPath：当前 DFS 路径上的节点；入边来源出现在其中 → 回边，跳过约束
 * - layers（备忘录）：已算完层号的节点；菱形汇合（A→B→D、A→C→D）不算环
 *
 * boundaryOf 是增量模式的边界查询（惰性）：不受影响节点的层号取自 prev
 * 布局，直接当已知值用、不再递归。环必然整体落在受影响集合内（或整体
 * 在外）——环上任一节点 dirty 时，沿出边的下游闭包会把整条环收进来——
 * 因此「不受影响 → 受影响」的入边不可能是回边，边界层号可以直接引用。
 * T7 优化：从「预构建 10k 条目的 fixedLayer Map」改为惰性函数——该 Map
 * 的逐事件重建是大图上每事件 O(N) 分配的大头（压测 M2 数据裁决）。
 */
function computeLayering(
  graph: CausalGraph,
  boundaryOf: (id: SpanId) => number | undefined,
  seeds: Iterable<SpanId>,
): Layering {
  const layers = new Map<SpanId, number>()
  const backEdges = new Set<CausalEdge>()
  const onPath = new Set<SpanId>()

  const visit = (id: SpanId): number => {
    const memo = layers.get(id)
    if (memo !== undefined) return memo
    onPath.add(id)
    let layer = 0
    for (const edge of graph.incoming.get(id) ?? []) {
      // 悬空边（producedBy 指向从未 start 的 span）不参与层级约束
      if (!graph.spans.has(edge.fromSpanId)) continue
      const boundary = boundaryOf(edge.fromSpanId)
      if (boundary !== undefined) {
        // 不受影响的边界节点：层号已知，无需递归
        layer = Math.max(layer, boundary + 1)
        continue
      }
      if (onPath.has(edge.fromSpanId)) {
        backEdges.add(edge)
        continue
      }
      layer = Math.max(layer, visit(edge.fromSpanId) + 1)
    }
    onPath.delete(id)
    layers.set(id, layer)
    return layer
  }

  for (const id of seeds) visit(id)
  return { layers, backEdges }
}

/**
 * 全量模式的层内排序：重心法。初始顺序 = span 入图顺序，之后做固定
 * BARYCENTER_SWEEPS 轮交替扫描：
 * - 下扫（自第 0 层起）：按上游邻居在各自层内序号的均值重排本层
 * - 上扫（自最深层起）：按下游邻居序号的均值重排本层
 * 无邻居的节点保持当前位次（bary = 自身序号）；排序稳定，结果可复现。
 * 只用约束边（非回边、两端都在图内）计算重心。
 */
function orderLayers(graph: CausalGraph, layering: Layering): Map<number, SpanId[]> {
  const byLayer = new Map<number, SpanId[]>()
  for (const [id, layer] of layering.layers) {
    let list = byLayer.get(layer)
    if (list === undefined) {
      list = []
      byLayer.set(layer, list)
    }
    list.push(id)
  }

  // 邻接表：约束边的上游 / 下游（回边与悬空边不参与重心计算）
  const upstream = new Map<SpanId, SpanId[]>()
  const downstream = new Map<SpanId, SpanId[]>()
  for (const edge of graph.edges) {
    if (layering.backEdges.has(edge)) continue
    if (!graph.spans.has(edge.fromSpanId) || !graph.spans.has(edge.toSpanId)) continue
    let up = upstream.get(edge.toSpanId)
    if (up === undefined) {
      up = []
      upstream.set(edge.toSpanId, up)
    }
    up.push(edge.fromSpanId)
    let down = downstream.get(edge.fromSpanId)
    if (down === undefined) {
      down = []
      downstream.set(edge.fromSpanId, down)
    }
    down.push(edge.toSpanId)
  }

  const slotOf = new Map<SpanId, number>()
  for (const list of byLayer.values()) {
    list.forEach((id, index) => slotOf.set(id, index))
  }

  const layerNums = [...byLayer.keys()].sort((a, b) => a - b)
  for (let round = 0; round < BARYCENTER_SWEEPS; round++) {
    const downward = round % 2 === 0
    const order = downward ? layerNums : [...layerNums].reverse()
    for (const layer of order) {
      const list = byLayer.get(layer)
      if (list === undefined) continue
      const scored = list.map((id, index) => {
        const neighbors = downward ? upstream.get(id) : downstream.get(id)
        if (neighbors === undefined || neighbors.length === 0) {
          return { id, bary: index }
        }
        let sum = 0
        for (const neighbor of neighbors) sum += slotOf.get(neighbor) ?? 0
        return { id, bary: sum / neighbors.length }
      })
      scored.sort((a, b) => a.bary - b.bary)
      const sorted = scored.map((s) => s.id)
      byLayer.set(layer, sorted)
      sorted.forEach((id, index) => slotOf.set(id, index))
    }
  }
  return byLayer
}

/**
 * 由图的因果边与节点位置生成视觉边。
 * 起点 = 源节点右缘中点，终点 = 目标节点左缘中点（自左向右布局）。
 * 回边同样渲染（它只是不参与层级约束，不是不存在）；端点不在图内的
 * 悬空边跳过。state 恒为 'normal'：高亮 / 置灰是交互状态，归渲染层与
 * store 决定，布局层只负责几何。
 */
function buildEdges(graph: CausalGraph, nodes: ReadonlyMap<SpanId, LayoutNode>): LayoutEdge[] {
  const edges: LayoutEdge[] = []
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromSpanId)
    const to = nodes.get(edge.toSpanId)
    if (from === undefined || to === undefined) continue
    edges.push({
      fromSpanId: edge.fromSpanId,
      toSpanId: edge.toSpanId,
      from: { x: from.x + from.width, y: from.y + from.height / 2 },
      to: { x: to.x, y: to.y + to.height / 2 },
      viaEntityId: edge.viaEntityId,
      state: 'normal',
    })
  }
  return edges
}

function makeNode(spanId: SpanId, layer: number, y: number): LayoutNode {
  return {
    spanId,
    layer,
    x: layer * X_STRIDE,
    y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }
}

/** 首次构建 / 快照（run.snapshot）后的全量重建 */
export function layoutGraph(graph: CausalGraph): Layout {
  const layering = computeLayering(graph, () => undefined, graph.spans.keys())
  const byLayer = orderLayers(graph, layering)
  const nodes = new Map<SpanId, LayoutNode>()
  let width = 0
  let height = 0
  for (const [layer, list] of byLayer) {
    list.forEach((id, slot) => {
      const node = makeNode(id, layer, slot * Y_STRIDE)
      nodes.set(id, node)
      if (node.x + node.width > width) width = node.x + node.width
      if (node.y + node.height > height) height = node.y + node.height
    })
  }
  return { nodes, edges: buildEdges(graph, nodes), bounds: { width, height }, version: 1 }
}

/**
 * 增量布局：只重算 dirty 节点及其下游闭包，其余节点逐字段保持不变。
 * 返回新的 Layout（纯函数，不修改 prev / graph）；version 仅在实际
 * 发生变更时自增（无变更时直接返回 prev 本身，渲染层可据此跳过重绘）。
 */
export function updateLayout(
  prev: Layout,
  graph: CausalGraph,
  dirtySpanIds: ReadonlySet<SpanId>,
): Layout {
  // —— 1. 受影响集合 = dirty ∪ 新节点（兜底）∪ 二者沿出边的下游闭包 ——
  // 兜底按插入序取尾（T7 压测裁决：全量 O(V) 成员扫描 + 逐节点 Map.has
  // 是 M2 p95 超线的大头）。正确性依据：Map 保持插入序且图内 span 只增
  // 不删，新 span 必为 graph.spans 的最后 added 个；净增 ≤ 0 时跳过扫描
  // ——图比布局小属剔除场景，由第 2 步处理。
  const affected = new Set<SpanId>()
  const queue: SpanId[] = []
  const seed = (id: SpanId): void => {
    if (!graph.spans.has(id) || affected.has(id)) return
    affected.add(id)
    queue.push(id)
  }
  for (const id of dirtySpanIds) seed(id)
  const added = graph.spans.size - prev.nodes.size
  if (added > 0) {
    const tailStart = graph.spans.size - added
    let index = 0
    for (const id of graph.spans.keys()) {
      index += 1
      if (index > tailStart) seed(id)
    }
  }
  while (queue.length > 0) {
    const id = queue.pop()
    if (id === undefined) break
    for (const edge of graph.outgoing.get(id) ?? []) seed(edge.toSpanId)
  }

  // —— 2. prev 里有、图里已不存在的节点（如 run.snapshot 清场）需要剔除。
  //    判据用规模差：无剔除时 prev ⊆ graph，图比布局小 ⇒ 必有节点消失。
  //    同数增删互换（清场后同数重加）不在增量调用约定内（run.snapshot
  //    的正确用法是 layoutGraph 全量重建，见本文件头）。
  const removed = graph.spans.size < prev.nodes.size

  // —— 3. 无变化：原样返回 prev，version 不自增 ——
  if (affected.size === 0 && !removed) return prev

  // —— 4. 增量分层：不受影响节点的 prev 层号作为已知边界（惰性查询，
  //    不逐事件重建边界 Map——T7 压测：10k 条目 Map 的构建是每事件
  //    O(N) 分配的大头）——
  const layering = computeLayering(
    graph,
    (id: SpanId): number | undefined => {
      if (affected.has(id)) return undefined
      const node = prev.nodes.get(id)
      if (node === undefined || !graph.spans.has(id)) return undefined
      return node.layer
    },
    affected,
  )

  // —— 5. 组装节点：不受影响的原样复用；受影响的按新层分配坐标 ——
  // 受影响节点先按新层分组（层号来自第 4 步的增量分层结果）
  const byLayer = new Map<number, SpanId[]>()
  for (const id of affected) {
    const layer = layering.layers.get(id)
    if (layer === undefined) continue
    let list = byLayer.get(layer)
    if (list === undefined) {
      list = []
      byLayer.set(layer, list)
    }
    list.push(id)
  }

  // 节点表用 Map 克隆快速路径构建（V8 对 Map 拷贝有原生优化，远快于
  // 逐条 set——T7 压测：逐条重建是每事件 O(N) 的剩余大头），再删掉
  // 受影响与已消失的节点、放回新坐标节点。克隆保留插入序，遍历语义不变。
  const nodes = new Map<SpanId, LayoutNode>(prev.nodes)
  for (const id of affected) {
    nodes.delete(id)
  }
  if (removed) {
    for (const id of prev.nodes.keys()) {
      if (!graph.spans.has(id)) nodes.delete(id)
    }
  }

  // 每层已固定节点的最大 y：新节点排到同层固定节点下方，避免重叠。
  // 在删除受影响节点后的克隆表上统计（天然只含固定节点，无需逐节点
  // affected.has）；只对「有新节点落位」的层记账，其余层零成本。
  const newLayers = new Set(byLayer.keys())
  const maxFixedY: number[] = []
  if (newLayers.size > 0) {
    for (const node of nodes.values()) {
      if (newLayers.has(node.layer) && node.y > (maxFixedY[node.layer] ?? -1)) {
        maxFixedY[node.layer] = node.y
      }
    }
  }

  // 层号升序处理：排某一层时其上游（约束边来自层号更小的节点）必已落位。
  // 层内顺序用增量版重心：按上游邻居（固定节点或已落位节点）y 中心的均值；
  // 无上游邻居时保持入图顺序。约束边保证上游层号严格更小，不会引用未落位节点。
  for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
    const list = byLayer.get(layer)
    if (list === undefined) continue
    const scored = list.map((id, index) => {
      const centers: number[] = []
      for (const edge of graph.incoming.get(id) ?? []) {
        if (layering.backEdges.has(edge)) continue
        if (!graph.spans.has(edge.fromSpanId)) continue
        const source = nodes.get(edge.fromSpanId)
        if (source === undefined) continue
        centers.push(source.y + source.height / 2)
      }
      if (centers.length === 0) return { id, bary: index }
      let sum = 0
      for (const center of centers) sum += center
      return { id, bary: sum / centers.length }
    })
    scored.sort((a, b) => a.bary - b.bary)
    let y = (maxFixedY[layer] ?? -Y_STRIDE) + Y_STRIDE
    for (const { id } of scored) {
      nodes.set(id, makeNode(id, layer, y))
      y += Y_STRIDE
    }
  }

  // —— 6. 边级增量（T7 压测裁决：M2 p95 = 4.05ms 超验收线 2ms，O(E)
  //    全量边重建是主要成本之一）：
  //    受影响节点的关联边重建——端点坐标可能变了，且新增边必挂受影响
  //    端点（ingestSpan 的边挂新 span ∈ affected；ingestEntity 补边挂
  //    dirty 标记的 producedBy ∈ affected，调用约定见本文件头）。
  //    其余边对象原样复用（两端节点都未动，几何不变；prev 可能携带
  //    视觉态，复用时归零）。悬空边与 buildEdges 同规则跳过。
  //    判定用 affected 集合的端点成员检查（两次 Set.has，零分配）——
  //    不构建字符串键：压测实测每边每事件一次模板字符串分配反而比
  //    对象重建更慢。顺序语义：复用边在前、重建边在后——渲染与标识
  //    定位（02 §10）都不依赖边序。节点剔除的防御路径仍走全量重建。
  let edges: LayoutEdge[]
  if (removed) {
    edges = buildEdges(graph, nodes)
  } else {
    const affectedEdges = new Set<CausalEdge>()
    for (const id of affected) {
      for (const e of graph.outgoing.get(id) ?? []) affectedEdges.add(e)
      for (const e of graph.incoming.get(id) ?? []) affectedEdges.add(e)
    }
    edges = []
    for (const edge of prev.edges) {
      if (affected.has(edge.fromSpanId) || affected.has(edge.toSpanId)) {
        continue // 受影响：下面按新坐标重建
      }
      // 复用：几何未变；state 非 normal 时归零（布局层契约：输出恒 normal）
      edges.push(edge.state === 'normal' ? edge : { ...edge, state: 'normal' })
    }
    for (const e of affectedEdges) {
      const from = nodes.get(e.fromSpanId)
      const to = nodes.get(e.toSpanId)
      if (from === undefined || to === undefined) continue
      edges.push({
        fromSpanId: e.fromSpanId,
        toSpanId: e.toSpanId,
        from: { x: from.x + from.width, y: from.y + from.height / 2 },
        to: { x: to.x, y: to.y + to.height / 2 },
        viaEntityId: e.viaEntityId,
        state: 'normal',
      })
    }
  }

  // —— 7. bounds 只增不减：不受影响节点天然落在 prev.bounds 内，只有
  //    受影响节点可能超出，对其取最大即可（作为视口范围的安全上界）——
  let width = prev.bounds.width
  let height = prev.bounds.height
  for (const id of affected) {
    const node = nodes.get(id)
    if (node === undefined) continue
    if (node.x + node.width > width) width = node.x + node.width
    if (node.y + node.height > height) height = node.y + node.height
  }

  return { nodes, edges, bounds: { width, height }, version: prev.version + 1 }
}
