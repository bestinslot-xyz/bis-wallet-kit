import { LOCAL } from '../provider/local'
import { registerProvider } from './providers'

// Side-effect module: registers the local (WIF) wallet provider.
// Imported by the server build entry (and the current browser build).
registerProvider('local', LOCAL)
