// 右侧检查器：选中实体显示 payload / time / source，选中 span 显示执行
// 详情与输入/输出实体（docs/03 T5、docs/04 §4）。
//
// graph 里的 span 对象被 span.end 原地更新（引用不变），靠订阅
// scene.version 触发重读 —— useMemo 依赖里挂 version 即可。
import { useMemo } from 'react'
import { useTraceStore, FRESHNESS_THRESHOLD_MS } from '../store/traceStore'
import { computeFreshness } from '../core/graph/query'
import { AGING_RATIO, type DataEntity, type FreshnessStatus, type Span } from '../core/types'

const DAY_MS = 86_400_000

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function formatAge(ageMs: number): string {
  if (ageMs < 0) return '0 分钟'
  const days = ageMs / DAY_MS
  if (days >= 1) return `${Math.floor(days)} 天`
  const hours = ageMs / 3_600_000
  if (hours >= 1) return `${Math.floor(hours)} 小时`
  return `${Math.max(1, Math.floor(ageMs / 60_000))} 分钟`
}

const FRESHNESS_LABEL: Record<FreshnessStatus, string> = {
  fresh: '新鲜',
  aging: '临近过期',
  stale: '已过期',
}

const FRESHNESS_CLASS: Record<FreshnessStatus, string> = {
  fresh: 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  aging: 'bg-amber-900/60 text-amber-300 border-amber-700',
  stale: 'bg-red-900/70 text-red-300 border-red-700',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1 text-xs">
      <span className="w-20 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 break-all text-slate-300">{children}</span>
    </div>
  )
}

function EntityDetail({ entity }: { entity: DataEntity }) {
  const freshness = computeFreshness(entity, FRESHNESS_THRESHOLD_MS)
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-slate-200">{entity.label}</h3>
      <Row label="实体 ID">{entity.id}</Row>
      <Row label="种类">{entity.kind}</Row>
      <Row label="来源">{entity.source}</Row>
      <Row label="产生时间">{formatTime(entity.time.createdAt)}</Row>
      <Row label="读取时间">{formatTime(entity.time.observedAt)}</Row>
      <Row label="数据年龄">
        <span
          className={`rounded border px-1.5 py-0.5 text-xs ${FRESHNESS_CLASS[freshness.status]}`}
        >
          {formatAge(freshness.ageMs)} · {FRESHNESS_LABEL[freshness.status]}
        </span>
      </Row>
      <Row label="判定阈值">
        过期线 {FRESHNESS_THRESHOLD_MS / DAY_MS} 天 · 预警线{' '}
        {(AGING_RATIO * FRESHNESS_THRESHOLD_MS) / DAY_MS} 天
      </Row>
      <div className="mt-1">
        <div className="py-1 text-xs text-slate-500">payload</div>
        <pre className="max-h-72 overflow-auto rounded bg-slate-950 p-2 text-xs leading-5 text-slate-300">
          {JSON.stringify(entity.payload, null, 2)}
        </pre>
      </div>
    </section>
  )
}

function SpanDetail({ span }: { span: Span }) {
  const selectEntity = useTraceStore((s) => s.selectEntity)
  const graph = useTraceStore((s) => s.graph)

  const freshnessOf = (entityId: string): FreshnessStatus | null => {
    const entity = graph?.entities.get(entityId)
    if (entity === undefined) return null
    return computeFreshness(entity, FRESHNESS_THRESHOLD_MS).status
  }

  const chips = (ids: string[], label: string) => (
    <div className="flex flex-wrap gap-1 py-1 text-xs">
      <span className="text-slate-500">{label}</span>
      {ids.length === 0 && <span className="text-slate-600">（无）</span>}
      {ids.map((id) => {
        const status = freshnessOf(id)
        return (
          <button
            key={id}
            type="button"
            onClick={() => selectEntity(id)}
            className={`rounded border px-1.5 py-0.5 hover:brightness-125 ${
              status !== null ? FRESHNESS_CLASS[status] : 'border-slate-700 bg-slate-800 text-slate-400'
            }`}
          >
            {id}
          </button>
        )
      })}
    </div>
  )

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-slate-200">{span.name}</h3>
      <Row label="Span ID">{span.id}</Row>
      <Row label="种类">{span.kind}</Row>
      <Row label="Agent">{span.agentId}</Row>
      <Row label="状态">
        <span
          className={`rounded border px-1.5 py-0.5 ${
            span.status === 'ok'
              ? 'border-emerald-700 bg-emerald-900/50 text-emerald-300'
              : span.status === 'error'
                ? 'border-red-700 bg-red-900/60 text-red-300'
                : 'border-slate-600 bg-slate-800 text-slate-300'
          }`}
        >
          {span.status}
        </span>
      </Row>
      <Row label="开始">{formatTime(span.startedAt)}</Row>
      <Row label="结束">{span.endedAt === null ? '未结束' : formatTime(span.endedAt)}</Row>
      {chips(span.inputEntityIds, '输入实体')}
      {chips(span.outputEntityIds, '输出实体')}
      <div>
        <div className="py-1 text-xs text-slate-500">attributes</div>
        <pre className="max-h-48 overflow-auto rounded bg-slate-950 p-2 text-xs leading-5 text-slate-300">
          {JSON.stringify(span.attributes, null, 2)}
        </pre>
      </div>
    </section>
  )
}

export default function NodeInspector() {
  const version = useTraceStore((s) => s.scene.version)
  const selectedSpanId = useTraceStore((s) => s.selectedSpanId)
  const selectedEntityId = useTraceStore((s) => s.selectedEntityId)
  const graph = useTraceStore((s) => s.graph)

  const entity = useMemo<DataEntity | null>(() => {
    if (graph === null || selectedEntityId === null) return null
    return graph.entities.get(selectedEntityId) ?? null
  }, [graph, selectedEntityId, version])

  const span = useMemo<Span | null>(() => {
    if (graph === null || selectedSpanId === null) return null
    return graph.spans.get(selectedSpanId) ?? null
  }, [graph, selectedSpanId, version])

  return (
    <aside className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto border-l border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-semibold text-slate-300">检查器</h2>
      {entity !== null ? (
        <EntityDetail entity={entity} />
      ) : span !== null ? (
        <SpanDetail span={span} />
      ) : (
        <p className="text-xs leading-6 text-slate-500">
          点击图中的 span 节点反向溯源影响链；点击边上的数据徽章查看
          payload / time / source。点击空白处取消高亮。
        </p>
      )}
    </aside>
  )
}
