// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExtensionAuthoringModal } from './ExtensionAuthoringModal'
import { createDeveloperExtension } from './expertKits'

vi.mock('./expertKits', () => ({
  createDeveloperExtension: vi.fn(),
  listInstalledExtensions: vi.fn(),
  packageDeveloperExtension: vi.fn(),
  readDeveloperExtension: vi.fn(),
  removeDeveloperExtension: vi.fn(),
}))
vi.mock('./extensionSubmissions', () => ({
  loadMySubmissions: vi.fn(),
  loadPersonalConnectors: vi.fn(() => []),
  submitConnector: vi.fn(),
  submitPackage: vi.fn(),
}))
vi.mock('./ExtensionPreviewPanel', () => ({ ExtensionPreviewPanel: () => null }))
vi.mock('./ExpertKitComposer', () => ({
  deriveSkillDependencies: () => ({ connectorIds: [], tools: [] }),
  ExpertKitComposer: () => null,
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(createDeveloperExtension).mockResolvedValue({ bytes: [1, 2, 3] } as never)
})

it('saves the implicit invocation choice in a new skill manifest', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExtensionAuthoringModal
      sessionToken="token"
      connectorSecrets={{}}
      connectors={[]}
      employeeId="employee"
      initialKind="skill"
      onChanged={vi.fn()}
      onClose={vi.fn()}
      onPreviewRunningChange={vi.fn()}
      skills={[]}
    />))

    const switchControl = container.querySelector<HTMLInputElement>('input[aria-label="允许自动调用"]')!
    expect(switchControl.checked).toBe(true)
    await act(async () => switchControl.click())
    expect(switchControl.checked).toBe(false)

    setInput(container, 'ID', 'private-review')
    setInput(container, '名称', '私有审查')
    setInput(container, '说明', '只在明确选择时执行')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(createDeveloperExtension).toHaveBeenCalledOnce()
    expect(vi.mocked(createDeveloperExtension).mock.calls[0]![0]).toMatchObject({
      id: 'private-review',
      allowImplicitInvocation: false,
      minimumDesktopVersion: '0.1.41',
    })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

function setInput(container: HTMLElement, labelText: string, value: string) {
  const label = [...container.querySelectorAll('label')].find((item) => item.firstChild?.textContent === labelText)
  const input = label?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error(`Missing input: ${labelText}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
