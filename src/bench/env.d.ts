// bench 环境的最小 Node API 类型声明（T8 环境指纹用）。
// 为什么不装 @types/node：依赖白名单未登记（docs/01 §2），而 bench 只
// 用到 os 的 4 个函数与 process 的 2 个字段——本地声明精确覆盖，
// 零新依赖。运行时（vitest bench 在 Node 下执行）这些 API 真实存在。
declare const process: {
  version: string
  versions: { v8: string }
}

declare module 'node:os' {
  export function cpus(): Array<{ model: string }>
  export function platform(): string
  export function arch(): string
  export function totalmem(): number
  export function loadavg(): number[]
}
