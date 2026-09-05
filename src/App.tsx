// 三栏布局：左侧剧本列表 / 中间因果图 Canvas / 右侧检查器（docs/03 T5）。
import ScenarioList from './ui/ScenarioList'
import GraphCanvas from './ui/GraphCanvas'
import NodeInspector from './ui/NodeInspector'
import { useTraceStore } from './store/traceStore'

const RUN_STATE_LABEL: Record<string, string> = {
  idle: '待播放',
  running: '运行中',
  paused: '已暂停',
  done: '已结束',
  cancelled: '已取消',
  error: '出错',
}

export default function App() {
  const runState = useTraceStore((s) => s.runState)
  const runError = useTraceStore((s) => s.runError)
  const pauseRun = useTraceStore((s) => s.pauseRun)
  const resumeRun = useTraceStore((s) => s.resumeRun)
  const cancelRun = useTraceStore((s) => s.cancelRun)

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2">
        <span className="text-sm font-bold tracking-wide">agent-trace</span>
        <span className="text-xs text-slate-500">多 Agent 因果可追溯控制台</span>
        <div className="ml-auto flex items-center gap-2">
          {runError !== null && <span className="text-xs text-red-400">{runError}</span>}
          <span className="text-xs text-slate-400">{RUN_STATE_LABEL[runState]}</span>
          <button
            type="button"
            disabled={runState !== 'running'}
            onClick={pauseRun}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            暂停
          </button>
          <button
            type="button"
            disabled={runState !== 'paused'}
            onClick={resumeRun}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            继续
          </button>
          <button
            type="button"
            disabled={runState !== 'running' && runState !== 'paused'}
            onClick={cancelRun}
            className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            取消
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <ScenarioList />
        <GraphCanvas />
        <NodeInspector />
      </div>
    </div>
  )
}
