import type { BISWalletProvider, ConnectCallbacks, ModalState, ModalTheme } from '../types/common'
import errorImage from '../assets/img/error.png'
import leatherLogo from '../assets/img/provider/leather.png'
import meLogo from '../assets/img/provider/me.png'
import okxLogo from '../assets/img/provider/okx.png'
import unisatLogo from '../assets/img/provider/unisat.png'
import xverseLogo from '../assets/img/provider/xverse.png'
import wooGIF from '../assets/img/woo.gif'
import { getWallets } from '../core/providers'

const PROVIDERS: Partial<Record<BISWalletProvider, { name: string, img: string }>> = {
  okx: { name: 'OKX', img: okxLogo },
  unisat: { name: 'Unisat', img: unisatLogo },
  xverse: { name: 'Xverse', img: xverseLogo },
  leather: { name: 'Leather', img: leatherLogo },
  me: { name: 'Magic Eden', img: meLogo },
}

const LINKS = {
  terms: 'https://bestinslot.xyz/legal/terms',
  privacy: 'https://bestinslot.xyz/legal/privacy',
  api: 'https://bestinslot.xyz/api',
}

const GENERIC_ERROR = 'An error occurred. Please try again.'

/**
 * Framework-free connect modal. Renders into the shadow-DOM root created by
 * `core/modal.ts`. Replaces the former Vue `Modal.vue` so the published browser
 * bundle no longer depends on Vue. The public method surface mirrors the old
 * component's `defineExpose`, so `core/modal.ts` is a drop-in caller.
 */
export class BisModalView {
  private root: HTMLElement
  private theme: ModalTheme = 'system'
  private visible = false
  private state: ModalState = 'connect'
  private errorMessage = ''
  private provider: BISWalletProvider | undefined
  private callbacks: ConnectCallbacks | null = null

  constructor(root: HTMLElement) {
    this.root = root
    this.render()
  }

  showConnect(callbacks: ConnectCallbacks): void {
    this.errorMessage = ''
    this.state = 'connect'
    this.visible = true
    this.callbacks = callbacks
    this.render()
    this.root.querySelector<HTMLButtonElement>('[data-provider]')?.focus()
  }

  showConnectConfirmation(provider: BISWalletProvider): void {
    this.errorMessage = ''
    this.state = 'confirm_connection'
    this.visible = true
    this.provider = provider
    this.render()
  }

  showError(message: string): void {
    this.state = 'error'
    this.errorMessage = message || GENERIC_ERROR
    this.visible = true
    this.render()
  }

  hide(): void {
    this.visible = false
    this.render()
  }

  setTheme(theme: ModalTheme): void {
    this.theme = theme
    this.render()
  }

  private onClose = (): void => {
    this.visible = false
    this.errorMessage = ''
    this.render()
    this.callbacks?.onError(new Error('User closed the modal.'))
  }

  private onRetry = (): void => {
    this.errorMessage = ''
    this.state = 'connect'
    this.visible = true
    this.render()
  }

  private onProviderSelect = async (providerName: BISWalletProvider): Promise<void> => {
    this.showConnectConfirmation(providerName)

    try {
      const data = await getWallets(providerName)
      if (!data)
        throw new Error(`Could not get wallets from the provider:${providerName}`)

      this.callbacks?.onSelect(data)
      this.visible = false
      this.render()
    }
    catch (error: any) {
      console.error('Error connecting to provider.')
      console.error(error)
      this.showError(error?.message)
    }
  }

  private themeClass(): string {
    if (this.theme === 'light')
      return 'bis-cw-theme-light'
    if (this.theme === 'dark')
      return 'bis-cw-theme-dark'
    return ''
  }

  private screenMarkup(): string {
    if (this.state === 'connect') {
      const items = Object.entries(PROVIDERS)
        .map(
          ([key, item]) => `
          <button
            type="button"
            data-provider="${key}"
            class="group flex items-center gap-x-4 p-2 border hover:border-primary border-border rounded-lg w-full text-left transition-colors cursor-pointer duration-300"
          >
            <img src="${item.img}" class="rounded-lg size-10" alt="${item.name}">
            <div class="font-semibold text-lg grow">${item.name}</div>
            <svg class="w-auto h-6 text-muted-foreground group-hover:text-foreground transition-colors duration-300" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 18l6-6l-6-6"/></svg>
          </button>`,
        )
        .join('')

      return `
        <div class="mb-6 font-medium text-xl text-center">Select your Bitcoin wallet</div>
        <div class="flex flex-col gap-y-3">${items}</div>`
    }

    if (this.state === 'confirm_connection') {
      const name = this.provider ? (PROVIDERS[this.provider]?.name ?? '') : ''
      return `
        <div class="mb-6 font-medium text-xl text-center">Confirm connection on ${name}</div>
        <div class="mx-auto mb-4 max-w-50 text-muted-foreground text-center">Check your extension and confirm the connection...</div>
        <img src="${wooGIF}" class="mx-auto size-16" alt="">`
    }

    // error
    return `
      <div class="text-center">
        <img src="${errorImage}" class="mx-auto mb-8 w-9 h-9.75" alt="">
        <div data-error-message class="mb-8 text-center"></div>
        <button type="button" data-retry class="hover:bg-primary border border-border rounded-lg w-24 h-10 font-semibold text-foreground text-lg text-center transition-colors cursor-pointer">Retry</button>
      </div>`
  }

  private render(): void {
    if (!this.visible) {
      this.root.innerHTML = ''
      return
    }

    this.root.innerHTML = `
      <div class="z-10 sm:z-50 fixed inset-0 flex justify-center items-center bg-black/90 font-sans ${this.themeClass()}">
        <div class="flex flex-col max-h-[90vh] bg-background shadow-lg border border-border rounded-lg w-[92%] max-w-sm text-foreground">
          <div class="relative flex justify-between items-center p-4 py-3 border-b border-border">
            <div class="font-semibold text-lg">Connect Wallet</div>
            <button type="button" data-close aria-label="Close" class="top-2 right-3 absolute flex -m-2 p-2 text-muted-foreground hover:text-foreground text-2xl transition-colors cursor-pointer">&times;</button>
          </div>
          <div class="overflow-y-auto px-4 sm:px-6 py-6 best-scrollbar">${this.screenMarkup()}</div>
          <div class="p-4 border-t border-border text-muted-foreground text-center">
            <div class="mb-2">Powered by <a class="font-medium text-foreground hover:underline underline-offset-4" href="${LINKS.api}" target="_blank">BiS API</a></div>
            <div class="text-sm">By connecting your wallet, you agree to Best in Slot's <a class="text-foreground hover:underline underline-offset-4" href="${LINKS.terms}" target="_blank">Terms of Service</a> and <a class="text-foreground hover:underline underline-offset-4" href="${LINKS.privacy}" target="_blank">Privacy Policy</a>.</div>
          </div>
        </div>
      </div>`

    // Error text is assigned as text (never HTML) to avoid injection.
    if (this.state === 'error') {
      const box = this.root.querySelector<HTMLElement>('[data-error-message]')
      if (box)
        box.textContent = this.errorMessage
      this.root
        .querySelector<HTMLButtonElement>('[data-retry]')
        ?.addEventListener('click', this.onRetry)
    }

    this.root
      .querySelector<HTMLButtonElement>('[data-close]')
      ?.addEventListener('click', this.onClose)

    if (this.state === 'connect') {
      this.root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((btn) => {
        btn.addEventListener('click', () => {
          void this.onProviderSelect(btn.dataset.provider as BISWalletProvider)
        })
      })
    }
  }
}
