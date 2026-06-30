import type { BISWalletProvider, ConnectCallbacks, ModalTheme } from '../types/common'
import css from '../assets/style/main.css?inline' // https://vite.dev/guide/features#import-inlining-and-rebasing
import { BisModalView } from '../components/connect-modal-view'

let modalInstance: BisModalView | null = null

/**
 * NOTE: The modal instance is created once and reused for subsequent calls to showConnect or showError. This ensures that only one modal is present in the DOM at any given time, and it can be easily shown or hidden as needed without creating multiple instances.
 *
 * The create function checks if the modal instance already exists before creating a new one. If it does exist, it simply returns without doing anything. This prevents multiple modals from being created if create is called multiple times.
 *
 * The showConnect, showConnectConfirmation, and showError functions all check if the modal instance exists before attempting to call methods on it. If the modal instance does not exist (e.g., if create has not been called), these functions will simply do nothing, which is a safe fallback behavior.
 *
 * This design allows for a single modal instance to be created and reused throughout the application, ensuring efficient resource usage and consistent user experience.
 */
export function create() {
  // SSR-SAFU
  if (typeof window === 'undefined')
    return

  if (modalInstance)
    return

  // Remove if already exists
  const existingContainer = document.getElementById('bis-cw-shadow-host')
  if (existingContainer) {
    existingContainer.remove()
  }

  // Create a shadow DOM container
  const container = document.createElement('div')
  container.id = 'bis-cw-shadow-host' // Add a unique ID for detection
  const shadowRoot = container.attachShadow({ mode: 'open' })

  const appRoot = document.createElement('div')
  appRoot.id = 'bis-cw-modal-root'
  shadowRoot.appendChild(appRoot)

  // Inject the CSS into the shadow DOM
  const style = document.createElement('style')
  style.textContent = css
  shadowRoot.appendChild(style)

  modalInstance = new BisModalView(appRoot)

  document.body.appendChild(container)
}

export function showConnect(callbacks: ConnectCallbacks) {
  modalInstance?.showConnect(callbacks)
}

export function showConnectConfirmation(_provider: BISWalletProvider) {
  modalInstance?.showConnectConfirmation(_provider)
}

export function showError(msg: string | null | undefined = null) {
  const genericMsg = 'An error occurred. Please try again.'

  modalInstance?.showError(msg || genericMsg)
}

export function hide() {
  // SSR-SAFU
  if (typeof window === 'undefined')
    return

  modalInstance?.hide()
}

/**
 * Sets the theme for the modal.
 *
 * @param theme The theme to set for the modal, which can be 'light', 'dark', or 'auto'.
 */
export function setTheme(theme: ModalTheme) {
  modalInstance?.setTheme(theme)
}
