import { METAMASK } from '../provider/metamask'
import { OKX } from '../provider/okx'
import { PHANTOM } from '../provider/phantom'
import { UNISAT } from '../provider/unisat'
import { XVERSE } from '../provider/xverse'
import { registerProvider } from './providers'

// Side-effect module: registers the browser extension wallet providers.
// Imported by the browser build entry.
registerProvider('okx', OKX)
registerProvider('unisat', UNISAT)
registerProvider('xverse', XVERSE)
registerProvider('phantom', PHANTOM)
registerProvider('metamask', METAMASK)
