# Examples

Each example links the kit via the pnpm workspace (`workspace:*`), so build the
library first, then run an example:

```bash
pnpm install
pnpm build            # builds @bestinslot/wallet-kit into dist/

pnpm example:react    # or example:vue / example:vanilla
```

| Example | Entry points used |
| --- | --- |
| `vanillajs` | `@bestinslot/wallet-kit`, `/core` |
| `react` | `@bestinslot/wallet-kit`, `/react` |
| `vue` | `@bestinslot/wallet-kit`, `/vue` |

`examples/server` is a standalone Node example (npm, `file:` link) and is not
part of the workspace.
