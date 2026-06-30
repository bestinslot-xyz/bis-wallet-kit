// @vitest-environment jsdom
import type { ConnectCallbacks } from '../../src/types/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BisModalView } from '../../src/components/connect-modal-view'

describe('bisModalView', () => {
  let root: HTMLElement

  beforeEach(() => {
    document.body.innerHTML = ''
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  it('renders nothing until shown', () => {
    // eslint-disable-next-line no-new
    new BisModalView(root)
    expect(root.children.length).toBe(0)
  })

  it('renders the provider list on showConnect', () => {
    const view = new BisModalView(root)
    view.showConnect({ onSelect: vi.fn(), onError: vi.fn() })
    const buttons = root.querySelectorAll('[data-provider]')
    expect(buttons.length).toBe(5)
    expect([...buttons].map(b => b.getAttribute('data-provider'))).toContain('unisat')
  })

  it('clears the DOM on hide', () => {
    const view = new BisModalView(root)
    view.showConnect({ onSelect: vi.fn(), onError: vi.fn() })
    view.hide()
    expect(root.children.length).toBe(0)
  })

  it('calls onError when the close button is clicked', () => {
    const onError = vi.fn()
    const callbacks: ConnectCallbacks = { onSelect: vi.fn(), onError }
    const view = new BisModalView(root)
    view.showConnect(callbacks)
    root.querySelector<HTMLButtonElement>('[data-close]')!.click()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(root.children.length).toBe(0)
  })

  it('shows the error screen with safe text and a working retry', () => {
    const view = new BisModalView(root)
    view.showConnect({ onSelect: vi.fn(), onError: vi.fn() })
    view.showError('<img src=x onerror=alert(1)>')
    const errorBox = root.querySelector('[data-error-message]')!
    // Set as text, not HTML — no nested element should be created.
    expect(errorBox.querySelector('img')).toBeNull()
    expect(errorBox.textContent).toContain('<img src=x onerror=alert(1)>')
    root.querySelector<HTMLButtonElement>('[data-retry]')!.click()
    expect(root.querySelectorAll('[data-provider]').length).toBe(5)
  })

  it('applies the forced theme class', () => {
    const view = new BisModalView(root)
    view.setTheme('light')
    view.showConnect({ onSelect: vi.fn(), onError: vi.fn() })
    expect(root.querySelector('.bis-cw-theme-light')).not.toBeNull()
  })
})
