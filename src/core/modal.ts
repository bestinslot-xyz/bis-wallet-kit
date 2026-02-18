import type { BISWalletProvider, ConnectCallbacks, ModalTheme } from '../main'
import { createApp } from 'vue'
import css from '../assets/style/main.css?inline' // https://vite.dev/guide/features#import-inlining-and-rebasing
import Modal from '../components/Modal.vue'

type ModalInstance = InstanceType<typeof Modal>

let modalInstance: ModalInstance | null = null

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

  const app = createApp(Modal)
  modalInstance = app.mount(appRoot) as ModalInstance

  document.body.appendChild(container)
}

function showConnect(callbacks: ConnectCallbacks) {
  modalInstance?.showConnect(callbacks)
}

function showConnectConfirmation(_provider: BISWalletProvider) {
  modalInstance?.showConnectConfirmation(_provider)
}

function showError(msg: string | null | undefined = null) {
  const genericMsg = 'An error occurred. Please try again.'

  modalInstance?.showError(msg || genericMsg)
}

function hide() {
  // SSR-SAFU
  if (typeof window === 'undefined')
    return

  modalInstance?.hide()
}

function setTheme(theme: ModalTheme) {
  modalInstance?.setTheme(theme)
}

export const modal = {
  create,
  showConnect,
  showConnectConfirmation,
  showError,
  hide,
  setTheme,
}
