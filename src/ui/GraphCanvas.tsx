// Canvas 容器 + 事件绑定（docs/03 T5）。
//
// 绘制链路：store 变化 → renderer.requestDraw（rAF 合并，一帧最多画一次，
// 组件本身不随高频事件重渲染）。交互链路：滚轮缩放 / 拖拽平移 / 点击选中，
// 命中测试先把屏幕坐标经 viewport 变回世界坐标。
import { useEffect, useRef } from 'react'
import { useTraceStore } from '../store/traceStore'
import { Renderer } from '../render/renderer'
import { hitTestBadge, hitTestNode } from '../render/hit-test'
import { contentBounds } from '../render/draw-node'
import { fitViewport, panBy, screenToWorld, zoomAt } from '../render/viewport'

/** 拖动位移超过此像素视为平移，松开时不触发点击选中 */
const CLICK_SLOP = 4

export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  /** 用户是否已手动缩放/平移过：置位后停止自动适配，把镜头交给用户 */
  const userMovedRef = useRef(false)

  const nodeCount = useTraceStore((s) => s.scene.layout.nodes.size)

  const fitView = (): void => {
    const container = containerRef.current
    if (container === null) return
    const { scene, setViewport } = useTraceStore.getState()
    setViewport(fitViewport(contentBounds(scene), container.clientWidth, container.clientHeight))
  }

  // 绘制调度：订阅 store，一切变化都交给 renderer 的 rAF 合并
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const renderer = new Renderer(canvas)
    rendererRef.current = renderer
    const draw = (): void => {
      const { scene, viewport } = useTraceStore.getState()
      renderer.requestDraw(scene, viewport)
    }
    const unsubscribe = useTraceStore.subscribe(draw)
    draw()
    return () => {
      unsubscribe()
      renderer.dispose()
      rendererRef.current = null
    }
  }, [])

  // 容器尺寸自适应（DPR 处理在 Renderer.setSize 内）
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const resize = (): void => {
      rendererRef.current?.setSize(container.clientWidth, container.clientHeight)
      const { scene, viewport } = useTraceStore.getState()
      rendererRef.current?.requestDraw(scene, viewport)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // 图生长期间的自动适配：首个节点出现时首层 fitViewport 会顶到 MAX_SCALE=2，
  // 后续节点（层间距 80px 叠加徽章）很快长出画布——决策节点与右侧徽章直接
  // 不可见。因此在用户手动缩放/平移之前，每次节点数变化都重新适配，让
  // 「逐步生长」全程在视野内；用户一动镜头就永久交还控制权，重开 run 时恢复。
  useEffect(() => {
    if (nodeCount === 0) {
      userMovedRef.current = false
      return
    }
    if (!userMovedRef.current) fitView()
  }, [nodeCount])

  // 交互：wheel 必须 passive:false 才能 preventDefault，React 合成事件做不到
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return

    const screenPointOf = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      userMovedRef.current = true
      const { viewport, setViewport: apply } = useTraceStore.getState()
      apply(zoomAt(viewport, screenPointOf(e), Math.exp(-e.deltaY * 0.0012)))
    }

    let dragging = false
    let moved = 0
    let lastX = 0
    let lastY = 0

    const onPointerDown = (e: PointerEvent): void => {
      dragging = true
      moved = 0
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      moved += Math.abs(dx) + Math.abs(dy)
      if (moved >= CLICK_SLOP) userMovedRef.current = true
      const { viewport, setViewport: apply } = useTraceStore.getState()
      apply(panBy(viewport, dx, dy))
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      if (moved >= CLICK_SLOP) return // 这次是平移，不是点击
      const { scene, viewport, selectSpan, selectEntity, clearSelection } = useTraceStore.getState()
      const world = screenToWorld(viewport, screenPointOf(e))
      // 徽章先于节点判定：徽章画在节点之上（宽徽章必然盖住节点边缘），
      // 命中顺序与视觉层级一致——点到看到的东西
      const entityId = hitTestBadge(scene.badges, world)
      if (entityId !== null) {
        selectEntity(entityId)
        return
      }
      const spanId = hitTestNode(scene.layout.nodes.values(), world)
      if (spanId !== null) {
        selectSpan(spanId)
        return
      }
      clearSelection()
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full cursor-grab" />
      <button
        type="button"
        onClick={fitView}
        className="absolute right-3 top-3 rounded border border-slate-700 bg-slate-800/80 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
      >
        适配视图
      </button>
      {nodeCount === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-600">
          从左侧选择故障剧本并播放
        </div>
      )}
    </div>
  )
}
