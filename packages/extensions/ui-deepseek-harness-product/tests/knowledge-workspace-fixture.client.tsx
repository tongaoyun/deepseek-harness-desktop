/** Open a library explicitly before exercising its document management behavior. */
import type { ReactElement } from 'react'
import { fireEvent, render } from '@testing-library/react'

export function renderKnowledgeWorkspace(element: ReactElement) {
  const view = render(element)
  const library = view.container.querySelector<HTMLButtonElement>('[data-knowledge-base][data-scope="PERSONAL"]')
    ?? view.container.querySelector<HTMLButtonElement>('[data-knowledge-base]')
  if (library) fireEvent.click(library)
  return view
}
