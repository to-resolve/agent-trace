// 时间轴（T9 第五部分）：可拖回任意 step + 分支标记 + 分支切换。
//
// 交互模型：run 结束（done）→「进入时间旅行」建会话 → 拖滑块 seek（混合
// 策略：回退 invert / 大步 checkpoint）→「在此分叉」fork → 分支面板注入
// 修改事件 / 切换对比。live 运行中该栏只显示进度（不可拖）。
import { useState } from 'react'
import { useTraceStore } from '../store/traceStore'
import type { Branch } from '../core/timeline/branch'

export default function TimelineBar() {
  const runState = useTraceStore((s) => s.runState)
  const timelinePosition = useTraceStore((s) => s.timelinePosition)
  const timelineTotal = useTraceStore((s) => s.timelineTotal)
  const branches = useTraceStore((s) => s.branches)
  const activeBranchId = useTraceStore((s) => s.activeBranchId)
  const enterTimeline = useTraceStore((s) => s.enterTimeline)
  const seek = useTraceStore((s) => s.seek)
  const fork = useTraceStore((s) => s.fork)
  const switchBranch = useTraceStore((s) => s.switchBranch)

  const [note, setNote] = useState('')

  const inTimeline = timelinePosition !== null
  const canEnter =
    (runState === 'done' || runState === 'cancelled') && !inTimeline && timelineTotal > 0

  if (runState === 'idle' || runState === 'error') return null

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-slate-800 bg-slate-900 px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-slate-300">时间轴</span>
        {canEnter && (
          <button
            type="button"
            onClick={enterTimeline}
            className="rounded bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-600"
          >
            进入时间旅行
          </button>
        )}
        {inTimeline && (
          <>
            <input
              type="range"
              min={0}
              max={timelineTotal}
              step={1}
              value={timelinePosition}
              onChange={(e) => seek(Number(e.target.value))}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-amber-500"
              aria-label="拖动到任意 step"
            />
            <span className="w-24 shrink-0 text-right font-mono text-xs text-slate-400">
              {timelinePosition} / {timelineTotal}
            </span>
          </>
        )}
        {!inTimeline && <span className="text-xs text-slate-500">运行结束后可回溯</span>}
      </div>

      {inTimeline && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            type="text"
            value={note}
            placeholder="分支说明（如：把简历换成 v3）"
            onChange={(e) => setNote(e.target.value)}
            className="w-56 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600"
          />
          <button
            type="button"
            onClick={() => {
              const b = fork(note || '未命名分支')
              if (b !== null) setNote('')
            }}
            disabled={activeBranchId !== null}
            title={activeBranchId !== null ? '先切回主线再分叉（分叉只发生在主时间线上）' : undefined}
            className="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            在此分叉
          </button>
          <button
            type="button"
            onClick={() => switchBranch(null)}
            disabled={activeBranchId === null}
            className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            主线
          </button>
          {branches.map((b) => (
            <BranchChip key={b.id} branch={b} active={b.id === activeBranchId} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 分支标记：note + 起点 + 激活高亮（点击切换） */
function BranchChip({ branch, active }: { branch: Branch; active: boolean }) {
  const switchBranch = useTraceStore((s) => s.switchBranch)
  return (
    <button
      type="button"
      onClick={() => switchBranch(branch.id)}
      className={`max-w-64 truncate rounded border px-2 py-1 text-left text-xs ${
        active
          ? 'border-amber-500 bg-amber-900/60 text-amber-200'
          : 'border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700'
      }`}
      title={`${branch.note}（自 step ${branch.baseEventIndex} 分叉）`}
    >
      ↳ {branch.note} <span className="text-slate-500">@{branch.baseEventIndex}</span>
    </button>
  )
}
