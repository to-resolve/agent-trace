// 逆操作日志（docs/02 §11.3 / §11.4，T9 第一部分）。
//
// 设计原点（§11.2，不用 immer 的论证链）：CausalGraph 的写入是封闭的
// 五个操作点且全部为替换/追加语义 ⟹ prev 可安全只存对象引用 ⟹ 零拷贝
// 逆操作。前提（§11.8 条 6）由 build.test.ts 的冻结守卫测试保护。
//
// 逆操作全部是「设置回某个确定值」而非「增量删除」——幂等、可重复应用、
// 不依赖数组当前状态。必须按 LIFO 逆序应用（后产生的先还原）。
import type { CausalGraph, DataEntity, EntityId, Span, SpanId } from '../types'
import { invalidateConsumersIndex } from '../graph/consumers-index'

/**
 * 把一个 applyEvent 的变更还原回去。
 * 全部是「设置回某个确定值」而非「增量删除」——幂等、可重复应用、不依赖数组当前状态。
 */
export type InverseOp =
  /** spans.set(id, prev)；prev 为 null 表示删除该键 */
  | { kind: 'span.set'; spanId: SpanId; prev: Span | null }
  /** entities.set(id, prev)；prev 为 null 表示删除该键 */
  | { kind: 'entity.set'; entityId: EntityId; prev: DataEntity | null }
  /** graph.edges 截断到 length（新增的边总是 push 在尾部，见 §4） */
  | { kind: 'edges.truncate'; length: number }
  /** 邻接索引截断：outgoing/incoming 的某个 spanId 数组截断到 length */
  | { kind: 'adj.truncate'; table: 'outgoing' | 'incoming'; spanId: SpanId; length: number }

/**
 * 事件流的逆操作日志。ops[i] = 应用第 i 个事件所产生的逆操作序列
 * （已按产生顺序排列；invert 时需整组逆序）。
 */
export interface Journal {
  ops: InverseOp[][]
}

export function createJournal(): Journal {
  return { ops: [] }
}

/**
 * 按 LIFO 逆序应用一组逆操作，把图还原到应用该事件之前。
 * 直接改传入的 graph（与 applyEvent 同为原地语义；这是 §11 允许的
 * 时间旅行专用逆操作通道，只还原 applyEvent 产生过的变更）。
 *
 * 首先整体失效消费方索引（T9 审查 B1）：索引记录「哪些 span 消费过某
 * 实体」，invert 回滚 span.set(prev: null) 只删 spans 键、不动索引——
 * 若不失效，「回滚 + 重放」往返会让同一 spanId 在索引里累积（膨胀），
 * 且原图的索引常驻导致惰性重建永不触发。失效后下次 consumersOf 重建，
 * 「回滚后不重放」零成本、「回滚后重放」付一次性 O(spans×inputs) 重建。
 */
export function invert(graph: CausalGraph, ops: readonly InverseOp[]): void {
  invalidateConsumersIndex(graph)
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op === undefined) continue
    switch (op.kind) {
      case 'span.set':
        if (op.prev === null) graph.spans.delete(op.spanId)
        else graph.spans.set(op.spanId, op.prev)
        break
      case 'entity.set':
        if (op.prev === null) graph.entities.delete(op.entityId)
        else graph.entities.set(op.entityId, op.prev)
        break
      case 'edges.truncate':
        graph.edges.length = op.length
        break
      case 'adj.truncate': {
        const table = op.table === 'outgoing' ? graph.outgoing : graph.incoming
        // 硬约束（§11.3）：length 为 0 必须删除该键——空数组会让后续
        // `?? []` 分支与真实「无邻接边」产生歧义
        if (op.length === 0) table.delete(op.spanId)
        else {
          const list = table.get(op.spanId)
          if (list !== undefined) list.length = op.length
        }
        break
      }
    }
  }
}
