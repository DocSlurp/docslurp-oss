# Extractor plugins

DocSlurp ships an open default for every extraction path. A deployment can add two optional providers without
changing core code:

- a **sandboxed PDF extractor**, served as the `vm-pdf` extractor id;
- an **image orientation provider**, used for quarter-turn correction of page and embedded images.

Plugins are loaded by configuration, never imported by core. Core builds, typechecks and tests with none present.

## Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `DOCSLURP_EXTRACTOR_PLUGINS` | worker | Comma-separated absolute module paths (or `file:` URLs) loaded at startup. |
| `DOCSLURP_PDF_EXTRACTOR=vm-pdf` | worker | Make `vm-pdf` the default PDF extractor. |
| `DOCSLURP_VM_PDF_INSTALLED=1` | API (and worker) | List `vm-pdf` in `GET /v1/extractors` and admit PDFs up to its source limit. |

Workspaces select the extractor with `documentExtraction.order.pdf: ["vm-pdf"]` and pass its options under
`documentExtraction.options["vm-pdf"]` (`images.enabled`, `images.minWidth`, `images.minHeight`,
`pdf.extractImages`).

## Fail closed

- A module that cannot load, or that exports no `register`, stops the worker at startup.
- `DOCSLURP_PDF_EXTRACTOR=vm-pdf` or `DOCSLURP_VM_PDF_INSTALLED=1` without a registered provider stops the worker.
- Preparing `vm-pdf` without a provider, or with one whose `assertConfigured()` throws, refuses the candidate. The
  VM route never falls back to parsing on the worker host.
- With a sandboxed PDF provider registered, embedded image extraction requires the `vm-pdf` route alone. Without
  one, the local artifact graph serves image targets.
- Image orientation without a provider is off; it never decodes pixels on the host.

## Module contract

A plugin module exports `register(host)` and returns an `ExtractorPlugin` (`worker/src/extractors/plugins.ts`):

```ts
export function register(host: ExtractorPluginHost): ExtractorPlugin {
  return {
    apiVersion: 1,
    name: "example",
    sandboxedPdf: {
      id: "example-vm",
      maxSourceBytes: 500 * 1024 * 1024,
      assertConfigured() { /* throw when the VM image or credentials are missing */ },
      async run(job, context, signal) { /* one fresh VM; write Markdown to job.output */ return { exitCode: 0, stdout: "{}", stderr: "" }; },
      timeoutMs: (pages) => 180_000,
      embeddedImages: { producerId: "example-embedded-images", optionsDigest: "…", read: async (output) => imageSet },
      shardProfile: { key: "extract-markdown:example-vm", prior },
    },
    imageOrientation: { id: "example-orientation", maxCostCents: 1, orient: async (input, output) => ({ result, usage }) },
  };
}
```

- `host` carries the worker's own runtime values (`SandboxRunError`, the Modal SDK loader, `planPageShards`,
  `currentPerfContext`). A plugin imports only types from the worker, so the errors and usage it raises are the
  worker's own classes.
- `run` writes Markdown with one form-feed-separated slot per page. Throw `host.SandboxRunError(message, usage)` on
  failure so the usage is recorded; never put raw provider or parser text in the message.
- `embeddedImages.read(output)` returns an `EmbeddedImageSet`. Core validates it again
  (`validateEmbeddedImageSet`): strict facts, hashes that match bytes, size limits and page range.
- `shardProfile` registers the provider's prior cost profile; calibration refines it from the shard timings it
  records through `context.recordTiming`.

## Isolation requirements

Untrusted files are processed behind a VM or microVM boundary (`AGENTS.md`). A provider must:

- run each job in a fresh VM with no network, no credentials and no cloud metadata access;
- bound input, output, memory and time, and terminate the VM on every exit path;
- return only framed, bounded output that the host validates without decoding pixels or parsing the PDF.
