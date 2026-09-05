// 本文件是项目的技术核心契约，内容与 docs/02-数据模型与事件协议.md
// 第 3、4、5、7、10 节一一对应。任何修改必须先改文档，再改代码。

// ---------- 标识 ----------
export type RunId = string
export type SpanId = string
export type EntityId = string
export type AgentId = string

// ---------- 时间：业务时间 vs 事件时间 ----------
/**
 * 一次「观测」记录两个时间：
 * - createdAt：这份数据**本身**是什么时候产生的（业务时间）
 * - observedAt：本次运行**读取**它的时刻（事件时间）
 * 两者之差即数据新鲜度，是本项目检测「过期上下文」类根因的基础。
 */
export interface ObservedAt {
  createdAt: number
  observedAt: number
}

// ---------- 数据实体：因果图的节点之一 ----------
export type EntityKind =
  | 'user_input'    // 用户输入
  | 'context'       // 检索/召回的上下文
  | 'tool_result'   // 工具返回值
  | 'llm_output'    // 模型输出
  | 'decision'      // 决策结论

export interface DataEntity {
  id: EntityId
  kind: EntityKind
  label: string
  /** 产出该实体的 span；null 表示外部输入（用户提问、种子数据） */
  producedBy: SpanId | null
  payload: unknown
  time: ObservedAt
  source: string
  /** 0–1，供置信度传播（Phase 1 的 belief 积分用） */
  trustScore?: number
}

// ---------- 新鲜度：由 time 推导，不存储 ----------
export type FreshnessStatus = 'fresh' | 'aging' | 'stale'

export interface Freshness {
  ageMs: number          // observedAt - createdAt
  status: FreshnessStatus
  /**
   * 仅用于「回记录」本次判定所用的阈值，供 UI 显示「91 天 / 阈值 7 天」。
   * 阈值是查询参数（见 findStaleEntities 的入参），不是数据本身的属性。
   * 同一次运行可以用不同阈值查询多次，得到不同的 Freshness 判定结果。
   */
  thresholdMs: number
}

/**
 * aging 档的判定比例：ageMs ≥ thresholdMs * AGING_RATIO 即进入预警区。
 *
 * 为什么用比例而不是绝对时长：aging 的语义是「距离过期还剩多少余量」，
 * 天然应当相对阈值来量。绝对时长（如固定 1 天）在阈值 7 天与 90 天两种
 * 配置下占比相差一个量级，同一个「预警」标签的分量会随配置漂移。
 * 代价是阈值调大时预警区间同比变大——这是特性，不是缺陷。
 *
 * UI 必须复用此常量渲染「aging 区间 3.5–7 天」，禁止在组件里另写 thresholdMs / 2。
 */
export const AGING_RATIO = 0.5

// 三档判定式（唯一权威定义，query.ts 的 computeFreshness 与之保持一致）：
// - ageMs >= thresholdMs                       → 'stale'
// - thresholdMs * AGING_RATIO <= ageMs < 阈值   → 'aging'
// - ageMs < thresholdMs * AGING_RATIO           → 'fresh'

// ---------- Span：执行树的节点 ----------
export type SpanKind = 'agent' | 'llm' | 'tool' | 'retrieval' | 'decision'
export type SpanStatus = 'running' | 'ok' | 'error'

export interface Span {
  id: SpanId
  runId: RunId
  /** 执行树：调用者 span。顶层为 null */
  parentId: SpanId | null
  agentId: AgentId
  kind: SpanKind
  name: string
  status: SpanStatus
  startedAt: number
  endedAt: number | null
  /** 本 span 消费了哪些数据实体 —— 因果图的入边依据 */
  inputEntityIds: EntityId[]
  /** 本 span 产出了哪些数据实体 —— 因果图的出边依据 */
  outputEntityIds: EntityId[]
  attributes: Record<string, unknown>
  error?: string
}

// ---------- 因果边（docs/02 第 4 节） ----------
export interface CausalEdge {
  fromSpanId: SpanId     // 数据生产者
  toSpanId: SpanId       // 数据消费者
  viaEntityId: EntityId  // 经由哪份数据连接
}

// ---------- 图容器（docs/02 第 5 节） ----------
export interface CausalGraph {
  runId: RunId
  spans: Map<SpanId, Span>
  entities: Map<EntityId, DataEntity>
  edges: CausalEdge[]
  /** 正向索引：我的输出影响了谁 */
  outgoing: Map<SpanId, CausalEdge[]>
  /** 反向索引：我被谁的数据影响 */
  incoming: Map<SpanId, CausalEdge[]>
}

// ---------- 事件协议（docs/02 第 7 节，自研 AG-UI 子集，不安装 @ag-ui/*） ----------
export type AgentEvent =
  | { type: 'run.start';    runId: RunId; startedAt: number; scenarioName?: string }
  | { type: 'run.end';      runId: RunId; endedAt: number; status: 'ok' | 'error' }
  | { type: 'span.start';   runId: RunId; span: Span }
  | { type: 'span.end';     runId: RunId; spanId: SpanId; endedAt: number
                           status: SpanStatus; outputEntityIds: EntityId[]; error?: string }
  | { type: 'entity.create'; runId: RunId; entity: DataEntity }
  /** 全量快照：用于断线重连与离线回放 */
  | { type: 'run.snapshot'; runId: RunId; spans: Span[]; entities: DataEntity[] }

// ---------- 布局结果（docs/02 第 10 节） ----------
export interface LayoutNode {
  spanId: SpanId
  layer: number
  x: number; y: number; width: number; height: number
}

export type EdgeVisualState = 'normal' | 'highlighted' | 'dimmed'

export interface LayoutEdge {
  /** 边的端点标识（docs/02 §10，T4 审查裁决 5）：store 把溯源结果映射到
   * 视觉态时按标识定位，禁止依赖「graph.edges 与 layout.edges 下标对齐」
   * 这类跨文件隐式顺序约定。渲染层绘制不读这两个字段。 */
  fromSpanId: SpanId
  toSpanId: SpanId
  from: { x: number; y: number }
  to: { x: number; y: number }
  viaEntityId: EntityId
  state: EdgeVisualState
}

export interface Layout {
  nodes: Map<SpanId, LayoutNode>
  edges: LayoutEdge[]
  bounds: { width: number; height: number }
  /** 每次变更自增，供渲染层判断是否需要重绘 */
  version: number
}
