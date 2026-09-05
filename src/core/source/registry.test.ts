// T6 修补 3：剧本注册表测试——glob 懒加载、校验透传、按 id 取件与未命中报错。
// 非法剧本文件的 catch 包装分支（错误带上文件路径）依赖 scenarios/ 目录里
// 真实存在坏 JSON 才能触发，不做注入式测试——防御性包装，不属验收路径。
import { describe, it, expect } from 'vitest'
import { loadAllScenarios, loadScenarioById } from './registry'

describe('剧本注册表', () => {
  it('loadAllScenarios 加载 scenarios/ 目录下全部剧本且已过校验', async () => {
    const scenarios = await loadAllScenarios()
    expect(scenarios.length).toBeGreaterThanOrEqual(1)
    const stale = scenarios.find((s) => s.id === 'stale-context')
    expect(stale).toBeDefined()
    // 过了 loadScenario 校验才有 steps 结构；字段值与剧本文件一致
    expect(stale?.steps.length).toBe(15)
    expect(stale?.expectedRootCause.spanId).toBe('s-retrieve')
  })

  it('loadScenarioById 命中返回该剧本', async () => {
    const scenario = await loadScenarioById('stale-context')
    expect(scenario.id).toBe('stale-context')
    expect(scenario.name).toBe('过期上下文导致错误拒绝')
  })

  it('loadScenarioById 未命中抛出含 id 的错误', async () => {
    await expect(loadScenarioById('no-such-scenario')).rejects.toThrow(
      '剧本不存在: no-such-scenario',
    )
  })
})
