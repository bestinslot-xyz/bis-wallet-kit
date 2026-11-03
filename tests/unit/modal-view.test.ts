// @vitest-environment jsdom
import type { ConnectCallbacks } from '../../src/types/common'
import { getWallets } from '@wallet-standard/app'
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
    expect([...buttons].map(b => b.getAttribute('data-provider'))).toEqual(
      expect.arrayContaining(['unisat', 'phantom', 'metamask'])
    )
  })

  // Registers a Wallet Standard wallet for the duration of `run`.
  function withWallet(
    name: string,
    icon: string,
    features: Record<string, unknown>,
    run: () => void
  ) {
    const unregister = getWallets().register({
      version: '1.0.0',
      name,
      icon: icon as `data:image/svg+xml;base64,${string}`,
      chains: ['bitcoin:mainnet'],
      accounts: [],
      features: features as never,
    })
    try {
      run()
    } finally {
      unregister()
    }
  }

  const logoOf = (provider: string) =>
    root.querySelector<HTMLImageElement>(`[data-provider="${provider}"] img`)!

  it("uses a wallet's icon from any of its registrations, such as Phantom's Solana one", () => {
    const icon = 'data:image/svg+xml,%3Csvg xmlns%3D%22http://www.w3.org/2000/svg%22/%3E'
    withWallet('Phantom', icon, { 'solana:signTransaction': {} }, () => {
      new BisModalView(root).showConnect({ onSelect: vi.fn(), onError: vi.fn() })
      expect(logoOf('phantom').src).toBe(icon)
    })
  })

  it('sets a wallet icon as a property, so quotes in it cannot add attributes', () => {
    const icon = 'data:image/svg+xml;base64," onerror="alert(1)'
    withWallet('MetaMask', icon, { 'bitcoin:connect': {} }, () => {
      new BisModalView(root).showConnect({ onSelect: vi.fn(), onError: vi.fn() })
      expect(logoOf('metamask').getAttribute('onerror')).toBeNull()
      expect(logoOf('metamask').getAttribute('src')).toBe(icon)
    })
  })

  it("keeps the letter badge for an icon that isn't image data", () => {
    withWallet('MetaMask', 'javascript:alert(1)', { 'bitcoin:connect': {} }, () => {
      new BisModalView(root).showConnect({ onSelect: vi.fn(), onError: vi.fn() })
      expect(logoOf('metamask').getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
    })
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
