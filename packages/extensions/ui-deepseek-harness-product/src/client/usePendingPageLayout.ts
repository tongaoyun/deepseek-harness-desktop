/** Preserve the confirmed page footprint while its replacement is being read. */
import { useRef, useState, type RefObject } from 'react'

/** Reserve the current read area's height without displaying stale page content.
 * @param scope Resource and filter identity; another selection never inherits the reservation.
 * @param waiting Whether the replacement page is loading or has failed.
 * @returns Read-area ref, scoped minimum height, and a capture action for page navigation.
 */
export function usePendingPageLayout(scope: string, waiting: boolean): {
  readonly area: RefObject<HTMLDivElement>
  readonly style: { readonly minHeight: number } | undefined
  readonly reserve: () => void
} {
  const area = useRef<HTMLDivElement>(null)
  const [reservation, setReservation] = useState<{ scope: string; height: number }>()
  return {
    area,
    style: waiting && reservation?.scope === scope ? { minHeight: reservation.height } : undefined,
    reserve: () => { setReservation({ scope, height: area.current?.getBoundingClientRect().height ?? 0 }) },
  }
}
