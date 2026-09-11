import { useCallback, useRef } from 'react'

/**
 * Makes a horizontally overflowing element draggable, and steers the wheel into it.
 *
 * `overflow-x: auto` alone is only half an affordance. On a phone a finger
 * swipe works, but on a desktop there is no gesture at all: the mouse wheel
 * scrolls the page vertically and dragging selects text, so a row of filters
 * that overflows simply looks cut off. That is exactly what it looked like.
 *
 * Two handlers fix it. Pointer events turn a press-and-move into a scroll (and
 * capture the pointer, so leaving the element mid-drag does not strand it), and
 * a wheel handler maps vertical deltas onto the horizontal axis.
 */
export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startScroll = useRef(0)
  // A press that never moved is a click on a tab, not a drag. Without this a
  // plain click would land as a 0px drag and still swallow the selection.
  const moved = useRef(false)

  const onPointerDown = useCallback((event: React.PointerEvent<T>) => {
    // Touch already scrolls natively; hijacking it here would fight the browser
    // and lose the momentum that makes a flick feel right.
    if (event.pointerType === 'touch') return
    const el = ref.current
    if (!el || el.scrollWidth <= el.clientWidth) return

    dragging.current = true
    moved.current = false
    startX.current = event.clientX
    startScroll.current = el.scrollLeft
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<T>) => {
    if (!dragging.current) return
    const el = ref.current
    if (!el) return

    const delta = event.clientX - startX.current
    if (!moved.current && Math.abs(delta) > 3) {
      moved.current = true
      el.setPointerCapture(event.pointerId)
    }
    if (moved.current) el.scrollLeft = startScroll.current - delta
  }, [])

  const endDrag = useCallback((event: React.PointerEvent<T>) => {
    const el = ref.current
    if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
    dragging.current = false
  }, [])

  const onWheel = useCallback((event: React.WheelEvent<T>) => {
    const el = ref.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    // A trackpad already sends deltaX; a mouse only sends deltaY, and this is
    // what makes the wheel useful over a horizontal strip.
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta === 0) return
    el.scrollLeft += delta
  }, [])

  return {
    ref,
    dragProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onWheel,
    },
  }
}
