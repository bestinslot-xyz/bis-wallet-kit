import { LEATHER } from '../provider/leather'
import { ME } from '../provider/me'
import { OKX } from '../provider/okx'
import { UNISAT } from '../provider/unisat'
import { XVERSE } from '../provider/xverse'
import { registerProvider } from './providers'

// Side-effect module: registers the browser extension wallet providers.
// Imported by the browser build entry.
registerProvider('leather', LEATHER)
registerProvider('me', ME)
registerProvider('okx', OKX)
registerProvider('unisat', UNISAT)
registerProvider('xverse', XVERSE)
