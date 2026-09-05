// 绘制调度器：把「高频事件流」合并成每帧最多一次的 Canvas 重绘。
//
// - requestDraw 只登记最新一帧的 (scene, viewport)，实际绘制延迟到
//   requestAnimationFrame：一个帧间隙内无论 store 更新多少次（事件、
//   平移、缩放、选中），都只画最后一次 —— T5「禁止一个事件一次重绘」。
// - 版本签名比对：scene.version / viewport / 画布尺寸都没变时直接跳过，
//   这是当前规模下最务实的「脏检查」（全量脏矩形分块重绘留给 T7 万级
//   span 压测时再做，20 节点下全量重绘成本可忽略）。
import { drawScene, type Scene } from './draw-node'
import type { WorldRect } from './culling'
import type { Viewport } from './viewport'

const BACKGROUND = '#0f172a'

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D
  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1
  private rafId = 0
  private scene: Scene | null = null
  private viewport: Viewport | null = null
  private signature = ''

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (ctx === null) {
      throw new Error('Canvas 2D 上下文不可用')
    }
    this.ctx = ctx
  }

  /** 容器尺寸变化时调用。DPR 作为基线变换处理，业务绘制一律用 CSS 像素 */
  setSize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = cssWidth
    this.cssHeight = cssHeight
    this.dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.dpr))
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.dpr))
    this.canvas.style.width = `${cssWidth}px`
    this.canvas.style.height = `${cssHeight}px`
    this.schedule()
  }

  /** 登记最新一帧并调度重绘（rAF 合并，同一帧内多次调用只画一次） */
  requestDraw(scene: Scene, viewport: Viewport): void {
    this.scene = scene
    this.viewport = viewport
    this.schedule()
  }

  dispose(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  private schedule(): void {
    if (this.rafId !== 0) return
    this.rafId = requestAnimationFrame(this.frame)
  }

  private readonly frame = (): void => {
    this.rafId = 0
    const { scene, viewport } = this
    if (scene === null || viewport === null) return
    const signature = [
      scene.version,
      viewport.scale,
      viewport.offsetX,
      viewport.offsetY,
      this.cssWidth,
      this.cssHeight,
    ].join('|')
    if (signature === this.signature) return
    this.signature = signature
    this.draw(scene, viewport)
  }

  private draw(scene: Scene, viewport: Viewport): void {
    const { ctx } = this
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = BACKGROUND
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight)
    ctx.save()
    ctx.translate(viewport.offsetX, viewport.offsetY)
    ctx.scale(viewport.scale, viewport.scale)
    // 视口对应的可见世界矩形（画布四角经逆变换）：drawScene 只画矩形内
    // 的元素（T7 视口裁剪），10k 节点下绘制量与视口内元素数成正比
    const view: WorldRect = {
      minX: (0 - viewport.offsetX) / viewport.scale,
      minY: (0 - viewport.offsetY) / viewport.scale,
      maxX: (this.cssWidth - viewport.offsetX) / viewport.scale,
      maxY: (this.cssHeight - viewport.offsetY) / viewport.scale,
    }
    drawScene(ctx, scene, view)
    ctx.restore()
  }
}
