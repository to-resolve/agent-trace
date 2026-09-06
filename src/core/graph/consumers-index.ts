// 消费方索引（乱序容错旁路缓存）——从 build.ts 抽出为独立模块（T9 审查 B1）：
// journal.invert 回滚时需要让索引失效，此前它是 build.ts 模块私有，
// timeline/ 访问不到。抽取后 build.ts 与 timeline/journal.ts 都 import，
// 无循环依赖（build → journal 是 type-only import）。
//
// 缓存生命周期（T9 审查 B1 的教训）：「纯缓存」的免责声明是个陷阱——
// 内容完全可从 graph.spans 推导（重建逻辑就在下面），但「可推导」≠
// 「永远正确」：惰性重建只在 get(graph) === undefined 时触发，而原图的
// 索引一直存在，永远命中。若 invert 只回滚 spans 不动索引，每次
// 「回滚 + 重放」循环都会让同一 spanId 累积一次（往返膨胀）。
// 因此 invert 每次回滚前主动失效，下次查询惰性重建——为一个可随时
// 重建的缓存维护精确逆操作，是让它付出不可变数据结构的代价；
// 「整体失效」才是缓存的正确语义（T9 审查 B1 裁决，不新增第五种
// InverseOp，§11.3 四类契约保持不变）。
import type { CausalGraph, EntityId, SpanId } from '../types'

const consumersIndex = new WeakMap<CausalGraph, Map<EntityId, SpanId[]>>()

/** 图的消费方索引：实体 id → 已把它记入 inputEntityIds 的 span 列表。
 *  索引只是纯缓存：未命中时扫描 spans 重建——绝不能返回空列表，否则
 *  非 createGraph 构造的图（反序列化结果）或 invert 后的图会静默丢补边。 */
export function consumersOf(graph: CausalGraph, entityId: EntityId): SpanId[] {
  let index = consumersIndex.get(graph)
  if (index === undefined) {
    index = new Map()
    for (const span of graph.spans.values()) {
      for (const inputId of span.inputEntityIds) {
        let list = index.get(inputId)
        if (list === undefined) {
          list = []
          index.set(inputId, list)
        }
        list.push(span.id)
      }
    }
    consumersIndex.set(graph, index)
  }
  let list = index.get(entityId)
  if (list === undefined) {
    list = []
    index.set(entityId, list)
  }
  return list
}

/** 索引整体失效：下次 consumersOf 惰性重建。invert 回滚前调用（B1 修复）；
 *  run.snapshot 清场后同样调用（图已重置，旧索引内容全部作废）。幂等。 */
export function invalidateConsumersIndex(graph: CausalGraph): void {
  consumersIndex.delete(graph)
}

/** 测试可见的查询入口（B1 验收：往返后断言索引无重复膨胀） */
export function peekConsumers(
  graph: CausalGraph,
  entityId: EntityId,
): readonly SpanId[] | undefined {
  return consumersIndex.get(graph)?.get(entityId)
}
