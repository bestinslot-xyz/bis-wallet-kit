import { modal, wallet } from '@bestinslot/wallet-kit'
import { subscribeToNetwork } from '@bestinslot/wallet-kit/core'

const sessionEl = document.querySelector<HTMLPreElement>('#session')!
const networkEl = document.querySelector<HTMLSelectElement>('#network')!

function renderSession() {
  const session = wallet.getSession()
  sessionEl.textContent = session ? JSON.stringify(session, null, 2) : 'Not connected'
}

document.querySelector('#connect')!.addEventListener('click', async () => {
  try {
    await modal.connect()
    renderSession()
  }
  catch (e) {
    console.error('Connection failed:', e)
  }
})

document.querySelector('#disconnect')!.addEventListener('click', () => {
  modal.disconnect()
  renderSession()
})

networkEl.value = wallet.getNetwork()
networkEl.addEventListener('change', () => wallet.setNetwork(networkEl.value as any))
subscribeToNetwork((net) => {
  networkEl.value = net
})

renderSession()
