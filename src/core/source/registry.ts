// 剧本注册表（T6 修补 3，T5 审查必修 2）。
//
// scenarios/*.json 经 Vite 原生 import.meta.glob 懒加载：新增剧本只需往
// 目录放一个 JSON 文件，注册表自动生长（兑现 docs/04 §5「新增剧本只需
// 加 JSON 文件」）——业务代码与测试都不再直接 import 剧本 JSON，
// Phase 1 的多剧本不会因此打进额外产物。
//
// glob 是构建期能力（Vite 转译，vitest 同走 Vite 管道），非运行时框架
// 依赖，core 层可用；懒加载形态保证不播的剧本不占启动开销。
import { loadScenario } from './scenario'
import type { Scenario } from './scenario'

/** 懒加载器表：路径 → () => Promise<模块>，JSON 模块的 default 即解析结果 */
const loaders = import.meta.glob<{ default: unknown }>('../../../scenarios/*.json')

/**
 * 加载并校验目录下全部剧本（按文件名字母序）。
 * 非法剧本直接抛错且带文件路径——坏输入必须尽早暴露并可定位。
 */
export async function loadAllScenarios(): Promise<Scenario[]> {
  const scenarios: Scenario[] = []
  for (const [path, load] of Object.entries(loaders)) {
    try {
      const mod = await load()
      scenarios.push(loadScenario(mod.default))
    } catch (err) {
      throw new Error(
        `剧本文件 ${path} 加载失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return scenarios
}

/** 按 id 取单个剧本（测试与 store 共用的取件入口） */
export async function loadScenarioById(id: string): Promise<Scenario> {
  const found = (await loadAllScenarios()).find((s) => s.id === id)
  if (found === undefined) {
    throw new Error(`剧本不存在: ${id}`)
  }
  return found
}
