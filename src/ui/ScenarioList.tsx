// 左侧剧本列表：列出故障剧本 + 播放入口（docs/03 T5）。
import { useEffect } from 'react'
import { useTraceStore } from '../store/traceStore'

export default function ScenarioList() {
  const scenarios = useTraceStore((s) => s.scenarios)
  const scenarioId = useTraceStore((s) => s.scenarioId)
  const runState = useTraceStore((s) => s.runState)
  const init = useTraceStore((s) => s.init)
  const startRun = useTraceStore((s) => s.startRun)

  useEffect(() => {
    init()
  }, [init])

  const busy = runState === 'running' || runState === 'paused'

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-semibold text-slate-300">故障剧本</h2>
      {scenarios.map((scenario) => {
        const active = scenario.id === scenarioId && busy
        return (
          <div
            key={scenario.id}
            className={`rounded-lg border p-3 ${
              active ? 'border-indigo-500 bg-slate-800' : 'border-slate-700 bg-slate-800/40'
            }`}
          >
            <div className="text-sm font-medium text-slate-200">{scenario.name}</div>
            <p className="mt-1 text-xs leading-5 text-slate-400">{scenario.description}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => startRun(scenario.id)}
              className="mt-2 rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {active ? '运行中…' : '播放'}
            </button>
          </div>
        )
      })}
      {scenarios.length === 0 && <p className="text-xs text-slate-500">剧本加载中…</p>}
    </aside>
  )
}
