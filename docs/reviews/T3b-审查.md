# T3b 审查结论

**任务**：T3b · 核心层修补
**审查日期**：2026-09-05
**结论**：✅ **通过**（覆盖率遗留 1 项裁决 → 进 T6）

## 一、红线检查

- 依赖：顶层 14 项 = 原 13 + `@vitest/coverage-v8@2.1.9`，与裁决 2 完全一致（版本对齐、devDependencies、`src/` 无 import）✅
- `src/core/` 无 react / 上层引用 ✅；独立复现 tsc exit 0、67 tests passed ✅

## 二、四项修补逐条验证

| 修补 | 结论 | 核查点 |
|---|---|---|
| 1. 漏判修补 | ✅ | `traverse` 并入被访问 span 自身 `inputEntityIds`（`query.ts:60-63`），注释写明理由；两处断言变更与新测试与卡要求逐条对应 |
| 2. 索引重建 | ✅ | `consumersOf` 未命中时扫描 `spans` 重建（`build.ts:71-96`），索引退化为纯缓存；重建逻辑与增量路径的登记规则一致 |
| 3. pause/cancel 状态机 | ✅ | 只判 `state`、`fire` 两处补守卫；`remainingMs: number | null` 区分「排期中暂停」与「事件间隙暂停」 |
| 4. 覆盖率 | ✅ | 独立复现 `npm run coverage`，数字与提交材料**完全一致**：97.54 / 87.36 / 100 / 97.54 |

**超出卡面要求的两个判断，均认可**：

1. **`resume()` 补收尾分支**（`simulated.ts:144-148`）——「暂停发生在最后一个事件的 `onEvent` 内」时，`fire` 的自然结束分支被 state 守卫跳过，事件其实已发完，`resume` 必须补 `done` + `onDone`。这是我卡上没写明的必然推论，执行者自己推出来、实现了、还配了测试。这种「把规定推演到边界情况并补验证」正是想要的执行质量。
2. **多加的第 4 个测试**（cancel 在最后一个事件内不被 done 覆盖）——卡面点名了这个 bug，不加测试该规定无法验证，加得对。

**AGING_RATIO 固化**：放在 `core/types.ts` 而非 `query.ts` —— 这个位置选得好。`01` §4 规定 `render/` 只能依赖 `core/types.ts`，放这里 UI 层才能合法引用（`NodeInspector` 的「预警线 3.5 天」已在用），放 `query.ts` 就死锁了。裁决 3 的固化要求完整落地。

## 三、裁决 4 —— `events.ts` branch 62.5%：**补测，进 T6**

`events.ts` 是自研 AG-UI 协议解析层——简历上「协议解析层自己实现」那条 bullet 的实体。未覆盖的 121-126（`run.snapshot` 校验分支）与 129（未知 type 的 default）**不是凑数场景，而是协议边界的真实分支**：Phase 2 接真实 SSE 时，解析守卫是脏数据的第一道防线，恰好是最该测的代码。

执行者如实报告未覆盖行并请求裁决、没有擅自补凑数测试——处理方式完全正确。

**裁决**：

- T6 中新增 `src/core/events.test.ts`，直测 `isAgentEvent`：六种事件的合法 / 非法形态、`run.snapshot` 的嵌套校验（spans/entities 内元素非法）、未知 `type` 返回 false
- `core/source/types.ts` 0%：**正式豁免**（纯类型模块，无运行时代码），此豁免写死，后续审查不再讨论

## 四、对后续计划的影响

无新增风险。裁决项并入 T6（见看板），T4 / T5 审查发现的契约修订是下一批的主体。
