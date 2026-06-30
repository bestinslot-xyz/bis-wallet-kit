import type { BISNetwork } from '@bestinslot/wallet-kit/react'
import { modal, wallet } from '@bestinslot/wallet-kit'
import { useWallet } from '@bestinslot/wallet-kit/react'

export function App() {
  const { session, network, setNetwork, refresh } = useWallet()

  async function connect() {
    try {
      await modal.connect()
      refresh()
    }
    catch (e) {
      console.error('Connection failed:', e)
    }
  }

  function disconnect() {
    wallet.disconnect()
    refresh()
  }

  return (
    <main>
      <h1>BiS Wallet Kit — React</h1>
      <button type="button" onClick={connect}>Connect</button>
      <button type="button" onClick={disconnect}>Disconnect</button>
      <select value={network} onChange={e => setNetwork(e.target.value as BISNetwork)}>
        <option value="mainnet">mainnet</option>
        <option value="testnet">testnet</option>
        <option value="signet">signet</option>
      </select>
      <pre>{session ? JSON.stringify(session, null, 2) : 'Not connected'}</pre>
    </main>
  )
}
