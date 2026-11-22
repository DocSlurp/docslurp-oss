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
and executable. The built-in selectable-text PDF recipe uses the Modal parser
VM and the standard Modal client credentials. Point it at an approved, digest-pinned parser
image with `DOCSLURP_MODAL_IMAGE` and `DOCSLURP_MODAL_IMAGE_DIGEST`. It does not require an
app account, a database or Temporal.

```sh
DOCSLURP_PARSER_SANDBOX=modal \
DOCSLURP_PROCESSOR_OUTPUT_DIR=./processed \
  node worker/dist/processor/cli.js input.pdf document/markdown page/chunks
```

Choose a fresh output directory. Request `page/markdown` or `page/chunks` for
larger PDFs and advance `DOCSLURP_PROCESSOR_FIRST_PAGE` in 64-page increments,
using a fresh destination for each window. Whole-document Markdown is limited
to 64 pages. The recipe reads the PDF text layer from files up to 128 MiB.
Page chunks are JSON arrays of text slices up to 2,000 Unicode code points. OCR, structured extraction
and embedding require additional adapters. The same recipe is available as
`@docslurp/worker/processor/pdf-reference` for TypeScript callers.

To use custom adapters, set `DOCSLURP_PROCESSOR_MODULE` to a trusted operator
module:

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
