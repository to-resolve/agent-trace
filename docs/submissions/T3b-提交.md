# T3b 提交

**任务卡**：T3b · 核心层修补
**提交时间**：2026-09-05
**状态**：submitted

## 1. 实现记录

四项修补全部完成，逐条说明做法：

### 修补 1：`findStaleInfluencedDecisions` 漏判（`query.ts`）

`traverse` 的 `visit` 中，在访问每个 span 时把 `graph.spans.get(id).inputEntityIds` 逐个并入 `entityIds`（`query.ts:60-63`），与既有的「边上的 `viaEntityId` 收集」（`query.ts:68`）取并集。语义与 `02` §6 修订后的注释一致：「子图涉及的全部数据实体」。函数头部注释同步说明了收集口径及理由（`producedBy === null` 的实体无边，只靠边收集会漏掉）。

### 修补 2：`consumersIndex` 降级路径改为重建（`build.ts`）

`consumersOf` 在 WeakMap 缓存未命中时（`build.ts:72-89`），扫描 `graph.spans.values()`，按每个 span 的 `inputEntityIds` 反向重建「实体 id → 消费 span 列表」完整索引，写回 WeakMap 后再查。索引由此退化为纯缓存：`createGraph()` 构造的图首建索引为空表、增量路径只做 push，行为不变；非 `createGraph` 出品的图（反序列化）首次查询即重建，补边正确。

### 修补 3：`pause()` 在 `onEvent` 内失效（`simulated.ts`）

按任务卡三条规定逐条落实：

- `pause()` / `cancel()` 只判 `state`，不再把 `timer === null` 当提前返回条件；先置状态，`timer` 非空再清理（`simulated.ts:127-161`）
- `fire()` 在自然结束分支与 `armTimer()` 前各补一次 `state !== 'running'` 检查（`simulated.ts:113`、`simulated.ts:119`）——`onEvent` 内同步调用过 `pause`/`cancel` 时，`done` 不覆盖状态、不误触 `onDone`、不再排下一个事件
- 新增 `remainingMs: number | null` 字段区分两种暂停时机（见第 4 节决策 1）

### 修补 4：覆盖率量化

- 安装 `@vitest/coverage-v8@^2.1.9`（devDependencies，版本与 vitest `2.1.9` 对齐，符合裁决 2 约束 1）
- `package.json` 加 `npm run coverage` 脚本
- `vite.config.ts` 配置 `provider: 'v8'`、`reporter: ['text', 'html']`、`include: ['src/core/**']`、`exclude: ['**/*.test.ts']`
- `.gitignore` 加 `coverage/`
- `src/` 下无任何对 coverage 包的 import（符合裁决 2 约束 2）

### 附带（裁决 3 固化要求）

`AGING_RATIO = 0.5` 作为具名导出常量放在 `src/core/types.ts:67`（与 `Freshness` 放在一起，与 `02` §3 一致），`computeFreshness` 的判定式改为引用该常量（`query.ts:98`），不在两处各写一份魔数。

## 2. 变更文件清单

### 新增

- （无）

### 修改

- `src/core/graph/query.ts` —— 修补 1：`traverse` 并入被访问 span 自身的 `inputEntityIds`；`computeFreshness` 改用 `AGING_RATIO` 常量
- `src/core/graph/build.ts` —— 修补 2：`consumersOf` 缓存未命中时扫描 `graph.spans` 重建索引
- `src/core/source/simulated.ts` —— 修补 3：`pause`/`cancel`/`fire` 状态机重排，`remainingMs` 可空
- `src/core/types.ts` —— 新增 `AGING_RATIO` 具名导出常量及其注释
- `src/core/graph/query.test.ts` —— 两处断言变更（见第 4 节决策 3）+ 新增修补 1 测试（`:211`）
- `src/core/graph/build.test.ts` —— 新增修补 2 测试（`:180`）
- `src/core/source/simulated.test.ts` —— 新增修补 3 测试两个（`:173`、`:199`）
- `package.json` —— `coverage` 脚本 + `@vitest/coverage-v8` devDependency
- `package-lock.json` —— 随安装自动更新的锁文件
- `vite.config.ts` —— coverage 配置
- `.gitignore` —— 加 `coverage/`

## 3. 自测输出

### `npm run tsc`

```
> agent-trace@0.1.0 tsc
> tsc --noEmit
```

（无输出，exit 0，零错误）

### `npm test`

```
> agent-trace@0.1.0 test
> vitest run


 RUN  v2.1.9 E:/Code/agent-trace

 ✓ src/core/source/simulated.test.ts (12 tests) 13ms
 ✓ src/core/graph/build.test.ts (12 tests) 10ms
 ✓ src/core/graph/query.test.ts (12 tests) 7ms

 Test Files  3 passed (3)
      Tests  36 passed (36)
   Start at  10:31:58
   Duration  1.85s (transform 194ms, setup 0ms, collect 342ms, tests 30ms, environment 1ms, prepare 453ms)
```

### `npm run coverage`

```
> agent-trace@0.1.0 coverage
> vitest run --coverage


 RUN  v2.1.9 E:/Code/agent-trace
      Coverage enabled with v8

 ✓ src/core/graph/build.test.ts (12 tests) 12ms
 ✓ src/core/source/simulated.test.ts (12 tests) 15ms
 ✓ src/core/graph/query.test.ts (12 tests) 8ms

 Test Files  3 passed (3)
      Tests  36 passed (36)
   Start at  10:32:05
   Duration  1.32s (transform 197ms, setup 0ms, collect 357ms, tests 34ms, environment 483ms, prepare 453ms)

 % Coverage report from v8
---------------|---------|----------|---------|---------|-------------------
File           | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
---------------|---------|----------|---------|---------|-------------------
All files      |   96.47 |     84.3 |     100 |   96.47 |
 core          |   93.06 |     62.5 |     100 |   93.06 |
  events.ts    |      93 |     62.5 |     100 |      93 | 121-126,129
  types.ts     |    100 |      100 |     100 |     100 |
 core/graph    |      99 |    94.11 |     100 |      99 |
  build.ts     |    98.3 |    91.89 |     100 |   98.3 | 53-54
  query.ts     |     100 |    96.77 |     100 |     100 | 56
 core/source   |   95.67 |     82.5 |     100 |   95.67 |
  scenario.ts  |   94.04 |       80 |     100 |   94.04 | 76-77,90-91,134
  simulated.ts |   96.77 |    84.61 |     100 |   96.77 | 145-148
  types.ts     |       0 |        0 |       0 |       0 |
---------------|---------|----------|---------|---------|-------------------
```

**`src/core/**` 整体 96.47% / 84.3% / 100% / 96.47%，≥80% 达标。** 逐文件未覆盖行说明（低于 80% 的按裁决 2 如实报告，不擅自补测凑数）：

- `events.ts`（branch 62.5%，**低于 80%**）：未覆盖行 121-126（`isAgentEvent` 的 `run.snapshot` 校验分支）、129（`default` 分支）。原因：`isAgentEvent` 仅经 `loadScenario` → `isScenarioEvent` 路径间接测试，而剧本按 `02` §9 契约**不允许含 `run.snapshot`**，该分支在现有测试路径上不可达；`build.test.ts` 的 `run.snapshot` 测试直接构造类型化事件对象，不走守卫。是否补 `events.test.ts` 直测该分支，留待裁决。
- `core/source/types.ts`（0%）：纯类型模块（仅有 `import type`），无运行时代码，属裁决 2 所述可豁免类别。
- `build.ts` 53-54：`addEdge` 幂等去重命中分支（同 from/to/via 重复入列），现有测试未构造重复事件流。
- `query.ts` 56：`visit` 的 `visited` 二次到达提前返回（菱形汇合不重复入列），被 `onPath` 环判定分支先行覆盖的剩余路径。
- `scenario.ts` 76-77、90-91、134：`loadScenario` 对非法剧本的各条抛错分支（非对象、非法 `expectedRootCause`、`observedAtMs` 非法类型），仅测了代表性子集。
- `simulated.ts` 145-148：`resume()` 时 `nextIndex` 已到末尾的补收尾分支（见第 4 节决策 2，触发条件为「暂停发生在最后一个事件的 `onEvent` 内」，与修补 3 的 cancel 测试路径互斥，未单独构造）。

### `npm run dev`

（本卡不涉及 UI 变更，dev server 正常运行中：VITE v5.4.21 ready，`http://localhost:5174/`）

## 4. 决策点与偏离说明

1. **`remainingMs` 可空语义（修补 3 的配套设计）**：任务卡只规定 `pause`/`cancel`/`fire` 的行为，未规定 `resume` 如何区分「timer 排期中暂停」与「`onEvent` 回调内暂停」。我引入 `remainingMs: number | null`：`null` 表示暂停发生在事件间隙（timer 未挂），`resume` 时按下一事件的**完整 `delayMs`** 重排，不沿用旧残值——因为暂停点不在任何 timer 的排期中，没有「剩余」可言。卡片描述的「在 `onEvent` 内调 `pause()` 后 `advanceTimersByTime(10_000)` 不得再产生新事件」即依赖此语义。

2. **`resume()` 的补收尾分支（`simulated.ts:144-147`）**：若暂停发生在最后一个事件的 `onEvent` 内，`fire()` 的自然结束分支被 `state !== 'running'` 守卫跳过（不置 `done`、不调 `onDone`）。`resume` 此时事件已全部吐完，必须补上 `done` 收尾，否则状态永远悬在 `paused`。这是修补 3「自然结束分支先判 state」的必然推论，审查要求未明说，属我自行拍板。

3. **两处断言变更**（任务卡明确要求，理由是语义修正而非放松测试）：
   - `query.test.ts:90` `entityIds.has('e-policy')` `false` → `true`：`e-policy` 是 `s-decide` 的直接输入（`producedBy === null`，无边），修补 1 后计入集合，**本来就该在溯源结果里**。
   - `query.test.ts:124` `traceDownstream(s-decide).entityIds.size` `0` → `2`：`s-decide` 是叶子，无下游边，但其自身输入 `e-score` + `e-policy` 计入（新语义「子图涉及的全部数据实体」）。

4. **新增测试数量为 4 个，超出任务卡列举的 3 个**：卡上「三个新增测试」对应修补 1 一个、修补 2 一个、修补 3 一个；我多加了 `simulated.test.ts:199`（最后一个事件的 `onEvent` 内 `cancel()` 不被 `done` 覆盖、不误触 `onDone`）。理由：任务卡修补 3 的描述**显式点名了 cancel 被 done 覆盖这个 bug**，且「自然结束分支也先判 state」是明确规定，不加该测试这条规定无法验证。无其他超范围改动。

5. **`events.ts` branch 62.5% 未擅自补测**：按裁决 2「如实报数字与未覆盖行，我来判是补测还是豁免」，未新增 `events.test.ts`。若审查认为该分支需要直测，我可以在修订中补（`isAgentEvent` 对合法/非法 `run.snapshot` 与未知 `type` 的判定，均为有意义的协议分支，非凑数测试）。

6. **测试总数 32 → 36**：4 个新增测试全部通过，既有断言除任务卡点名的两处外零改动。

## 5. BLOCKER

- 无
