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
| `DOCSLURP_PDF_EXTRACTOR=vm-pdf` | API and worker | Make `vm-pdf` the default PDF extractor. Empty keeps the built-in order; any other value stops the process. |
| `DOCSLURP_VM_PDF_INSTALLED=1` | API (and worker) | List `vm-pdf` in `GET /v1/extractors` and admit PDFs up to its source limit. Must be empty, `0` or `1`. |
| `DOCSLURP_EXTRACTOR_ID_ALIASES` | API and worker | Legacy extractor ids, `<old>:<new>[,<old>:<new>]`; see [Renaming an extractor](#renaming-an-extractor). |

Workspaces select the extractor with `documentExtraction.order.pdf: ["vm-pdf"]` and pass its options under
`documentExtraction.options["vm-pdf"]` (`images.enabled`, `images.minWidth`, `images.minHeight`,
`pdf.extractImages`).

## Fail closed

- A module that cannot load, or that exports no `register`, stops the worker at startup.
- `DOCSLURP_PDF_EXTRACTOR` is trimmed and must be empty or `vm-pdf`; any other value (a typo, a retired id) stops
  the worker and the API at startup instead of silently routing PDFs to the built-in host parsers. Worker and API
  read it through one resolver (`resolvePdfExtractorSetting` / `sandboxedPdfConfigured` in `@docslurp/shared`).
- `DOCSLURP_PDF_EXTRACTOR=vm-pdf` or `DOCSLURP_VM_PDF_INSTALLED=1` without a registered provider stops the worker.
- Either setting makes the API cap PDF uploads at the sandboxed provider's source limit.
- At load the worker logs one line with the plugin API version and the generic ids of the loaded capabilities
  (`[extractor-plugins] loaded api=1 providers=vm-pdf,image-orientation`). A plugin's own name and details are the
  plugin's to log.
- Preparing `vm-pdf` without a provider, or with one whose `assertConfigured()` throws, refuses the candidate. The
  VM route never falls back to parsing on the worker host.
- With a sandboxed PDF provider registered, embedded image extraction requires the `vm-pdf` route alone. Without
  one, the local artifact graph serves image targets.
- Image orientation without a provider is off; it never decodes pixels on the host.

## Renaming an extractor

When a deployment's stored configs name an extractor by an id it no longer serves (for example after moving a
provider behind the `vm-pdf` id), set `DOCSLURP_EXTRACTOR_ID_ALIASES=<old>:<new>` on the API and the worker:

- Parsing rewrites the old id to the new one wherever a `documentExtraction` config names an extractor: `order`,
  `components`, `pages`, `enrich`, `voting.secondary` and the `options` key. It applies to requests and to stored
  workspace, run and upload-session configs alike, so nothing written after the deploy carries the old id. Free text
  elsewhere in a pipeline is never touched.
- Startup refuses an alias whose target the process does not serve (`vm-pdf` without a provider on the worker, or
  without `DOCSLURP_VM_PDF_INSTALLED=1` on the API), an alias that names a built-in id, a chain, or a malformed
  entry. Ids that are neither aliased nor known still fail validation as before.
- A config holding options under both the old and the new key is never merged: requests are rejected, and stored
  reads keep the new key's options and log the dropped old key.

Order of a rename:

1. Deploy the API and the worker with the alias and the provider under its new id, in one release. Runs created
   before the deploy, and runs in flight across it, load their stored config through the alias and complete.
2. Old configs keep working; new and updated configs are written with the new id.
3. Optionally rewrite stored rows (a deployment's own tested script), so nothing still names the old id.
4. Remove the alias in a later release, once nothing stored names the old id.

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
