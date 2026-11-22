# Run an artifact pipeline without the API

The TypeScript binding `@docslurp/worker/processor` runs the same artifact graph used
by the worker's local PDF graph. The binding takes installed adapters and a
document's prepared artifact references. It returns the graph result and has no
server, database, or queue startup.

```ts
import { createArtifactProcessor } from "@docslurp/worker/processor";

const processor = createArtifactProcessor(adapters);
const manifest = await processor.execute({
  sourceDocumentId,
  initial: [sourceArtifact],
  target: ["document/markdown"],
}, signal);
```

Run `pnpm --filter @docslurp/worker build` from the repo root to build the binding
and executable. The executable loads a trusted operator module from
`DOCSLURP_PROCESSOR_MODULE`:

```sh
DOCSLURP_PROCESSOR_MODULE=/opt/docslurp/adapters.mjs \
  node worker/dist/processor/cli.js input.pdf document/markdown
```

The module exports `configure(env)`, which returns an adapter list and
`prepare(input, targets, signal)`. Use environment configuration to select
installed tool and model adapters. Preparation returns a request plus an
optional cleanup callback for staging. Keep configuration free of per-job resources.
If preparation fails, it owns cleanup of any partial staging. Adapters publish artifacts to
caller-owned destinations and send diagnostics to stderr. The CLI writes the
graph result as JSON to stdout after cleanup. Target references must remain
usable after cleanup. Initial and intermediate references describe provenance
and may point to staging that has been removed. The CLI returns nonzero on an unsuccessful graph or
execution failure.

The caller owns authorization, staging, and the lifetime of output artifacts.
The processing graph itself handles references only. An adapter that parses
untrusted content must use a credential-free VM or equivalent isolation. A
module path is operator configuration and grants code execution in the host.
