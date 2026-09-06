// 反事实实验面板（T9 第五部分 5-2 验收演示闭环）。
//
// 流程对着验收硬要求：回溯到简历实体创建前 → fork 分支 → 注入「新鲜
// 简历 + 推定的下游重跑」（store.injectStaleResumeRerun，推导与 e2e 测试
// 同一函数 counterfactual.ts——所见即所测）→ 决策对比行给出「主线 拒绝
// ↔ 分支 邀请面试」。分支对比做最小可用：实体的 label + 新鲜度并排，
// 不做 diff 可视化（卡面明令）。
import { useState } from 'react'
import { useTraceStore, FRESHNESS_THRESHOLD_MS } from '../store/traceStore'
import { computeFreshness } from '../core/graph/query'
import { formatAge } from './NodeInspector'
import type { DataEntity } from '../core/types'

/** 新鲜度中文标签（与 NodeInspector 的展示口径一致） */
function freshnessLabel(entity: DataEntity): string {
  const { status, ageMs } = computeFreshness(entity, FRESHNESS_THRESHOLD_MS)
  const label = status === 'stale' ? '已过期' : status === 'aging' ? '临近过期' : '新鲜'
  return `${formatAge(ageMs)} · ${label}`
}

export default function BranchPanel() {
  const graph = useTraceStore((s) => s.graph)
  const inTimeline = useTraceStore((s) => s.timelinePosition !== null)
  const activeBranchId = useTraceStore((s) => s.activeBranchId)
  const entityOnMain = useTraceStore((s) => s.entityOnMain)
  const injectStaleResumeRerun = useTraceStore((s) => s.injectStaleResumeRerun)
  // 视图版本号：seek/switch/inject 都会重建 scene（version+1）。时间旅行的
  // seek 走原地改图（同引用），graph 选择器不触发重渲染——依赖 version
  // 保证对比行跟随当前视图状态（NodeInspector 同款模式）
  const viewVersion = useTraceStore((s) => s.scene.version)
  void viewVersion

  const [hint, setHint] = useState<string | null>(null)
  const [rerunDone, setRerunDone] = useState(false)

  if (!inTimeline) return null

  const onClick = (): void => {
    if (injectStaleResumeRerun()) {
      setRerunDone(true)
      setHint(null)
    } else {
      // store 守卫拒绝且按钮未被本地状态禁用 ⟹ 分叉点形态不适用
      // （已注入的情况按钮已禁用，走不到这里）
      setHint('推演未执行：分叉点不在「简历 v1 创建前」——先把时间轴拖到该 step 再分叉')
    }
  }

  // 决策对比：注入推演后分支出现 e-decision，与主线终态并排（卡面定义的
  // 「最小可用分支对比」——同一决策 span 的输出差异，无 diff 可视化）。
  // 仅在分支视图显示——主线视图下当前 graph 就是主线自身，对比无意义
  // （主线不受分支污染的证据 = 主线侧数字始终来自 enterTimeline 捕获的
  // 终态基准图）
  const onBranch = activeBranchId !== null
  const branchDecision = onBranch ? graph?.entities.get('e-decision') ?? null : null
  const mainDecision = entityOnMain('e-decision')
  const branchResume = onBranch ? graph?.entities.get('e-resume-v1') ?? null : null
  const mainResume = entityOnMain('e-resume-v1')

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-slate-800 bg-slate-900 px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold text-slate-300">反事实实验</span>
        {!onBranch ? (
          <span className="text-slate-500">
            先把时间轴拖到「简历 v1 创建前」，点「在此分叉」，再切到分支
          </span>
        ) : (
          <button
            type="button"
            onClick={onClick}
            disabled={rerunDone}
            title={rerunDone ? '该分支已注入过推演序列——换一条分支可做另一种假设' : undefined}
            className="rounded bg-amber-700 px-2 py-1 text-xs text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            换成新鲜简历并推演重跑
          </button>
        )}
        {hint !== null && <span className="text-red-400">{hint}</span>}
        {rerunDone && onBranch && hint === null && (
          <span className="text-amber-300">已注入：新鲜简历 v3 + 推定的下游重跑（评分 85 → 邀请面试）</span>
        )}
      </div>
      {branchDecision !== null && mainDecision !== null && (
        <div className="flex flex-wrap items-center gap-2 text-slate-300">
          <span className="font-semibold text-amber-400">决策对比</span>
          <span>主线：「{mainDecision.label}」</span>
          <span className="text-slate-500">↔</span>
          <span className="text-emerald-400">分支：「{branchDecision.label}」</span>
        </div>
      )}
      {branchResume !== null && mainResume !== null && (
        <div className="flex flex-wrap items-center gap-2 text-slate-300">
          <span className="font-semibold text-amber-400">根因数据</span>
          <span>主线：{mainResume.label} · {freshnessLabel(mainResume)}</span>
          <span className="text-slate-500">↔</span>
          <span className="text-emerald-400">
            分支：{branchResume.label} · {freshnessLabel(branchResume)}
          </span>
        </div>
      )}
    </div>
  )
}
