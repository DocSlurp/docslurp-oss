# Deployment profile and kill switches

Two variables say who runs a deployment and what it may not do. The worker and the API resolve them at startup into one
posture (`resolveDeploymentProfile`, `packages/shared/src/deployment-profile.ts`), log it, and refuse to start when it
does not add up.

## `DOCSLURP_PROFILE`: `service` | `selfhost` | `dev`

| | `service` | `selfhost` | `dev` |
|---|---|---|---|
| Who | a hosted multi-tenant service | a customer-owned install | a developer machine |
| `NODE_ENV=production` (or any non-development value) | VM-only parsing | VM-only parsing | refused at startup |
| `NODE_ENV` development, test or unset | refused at startup | host sandbox allowed | host sandbox allowed |
| In-process native engine, page probe, `local-cli` vision reader | refused | refused under VM-only; development opt-in otherwise | development opt-in |
| OCR default | `vm` (a VM OCR provider is required) | `off` until you choose a mode | `off` |

`service` requires `NODE_ENV=production` exactly. Unset: the worker refuses to start outside development (from this
release: worker images set `NODE_ENV=production`, so a worker started outside `compose.selfhost.yml` needs
`DOCSLURP_PROFILE`, or the old `DOCSLURP_SERVICE_PROFILE`, before it upgrades); the API logs a warning instead. In
development an unset profile runs as `dev` with a warning. `compose.selfhost.yml` sets `DOCSLURP_PROFILE=selfhost`.
`selfhost` with `NODE_ENV` unset counts as development (host sandboxes allowed) and logs a warning: set
`NODE_ENV=production` on a real install.

**Isolation floor.** Parsing customer files is VM-only in every non-development environment, whatever the profile says.
Development means `NODE_ENV` empty, `development` or `test` (trimmed, ASCII case ignored) in both the configured and the
process environment, and never under `service`. No profile, switch or other setting lowers this floor: a profile that
would contradict it (`dev` in production, `service` in development) refuses to start instead. `scripts/start-worker.sh`
classifies the environment with the same rule (a parity test keeps the two in step).

The worker logs its posture once at startup:

```text
[deployment-profile] profile=selfhost source=DOCSLURP_PROFILE vmOnlyParsing=true disabled=none digest=sha256:…
```

## `DOCSLURP_DISABLE`: kill switches

A comma list, trimmed and lower-cased, from a closed vocabulary. An unknown token refuses startup. Set it identically on
the API and the worker: the worker enforces it at execution, the API uses it for estimates, suggestions and validation.
Switches only ever lower what runs; a project keeps its stored settings.

| Token | Turns off |
|---|---|
| `ai` | Every model read in extraction: rescue reads (also at query time), OCR escalation, the page image reader, the page router (deterministic extraction only), the document-map siphon, self-critique re-reads, AI chart reads, vision reads of video frames, `hosted` OCR and the `local-cli` reader. `smartest` runs as `fastest` (OCR, no vision). Audio and video transcription keep running (the baseline read of media, like OCR for scans). |
| `ai-rescue` | Vision rescue reads of pages the text layer or OCR could not read (`visionFallback`, at ingest and at query time) and self-critique re-reads. A `smartest` run keeps its vision reads, its primary reads (use `ai` to stop them). |
| `ai-escalation` | Hosted OCR escalation (as `DOCSLURP_OCR_ESCALATION=off`). |
| `page-reader` | The page image reader, in its OCR and vision-transcription modes. |
| `ocr` | OCR (as `DOCSLURP_OCR_MODE=off`); the OCR page reader has nothing to read. As with `DOCSLURP_OCR_MODE=off` today, a document that only OCR could read (an image, a scan without a text layer) fails rather than being kept as an image. |
| `router` | The page router (as `PAGE_ROUTER_MODE=off`): this release turns the whole router off, which is stricter than "deterministic rules only". |
| `figures` | The PDF figure pass (as `DOCSLURP_DOPPLER_IMAGE_EXTRACT=0`). |
| `charts` | All chart export (as `DOCSLURP_CHART_EXPORT=off`). |
| `charts-ai` | AI chart reads (as `DOCSLURP_CHART_EXPORT=free`). |
| `figure-resume` | The figure resume runner and on-demand resume (as `DOCSLURP_FIGURE_RESUME=off`); partial levels stay resumable. |

A switch and an older variable combine to the lower of the two. Turning a switch on never refuses startup because of
an older setting it overrides (an emergency switch must not take the deployment down); with the reader or mode switched
off, its readiness checks no longer apply.

## Old names (compatibility release)

This release reads both the old and the new names. `DOCSLURP_SERVICE_PROFILE=service` means `DOCSLURP_PROFILE=service`
and `DOCSLURP_SERVICE_PROFILE=self-hosted` means `DOCSLURP_PROFILE=selfhost`. Setting both is allowed when they agree
(a warning asks you to drop the old one) and refused when they disagree. An older variable that repeats a switch (for
example `DOCSLURP_OCR_MODE=off` beside `DOCSLURP_DISABLE=ocr`) logs a warning. A later release refuses the retired
variables at startup, so move to the new names now.

## Mixed fleets and the worker-fleet view

Workers advertise the `extraction.config-v1` capability and their posture digest in the capability registry
(`worker_capabilities.config`, migration 0182). `GET /ops/worker-fleet` (metrics bearer) shows, beside the gated flags:

- `extractionConfig.app`: the API's own profile and switches;
- `extractionConfig.fleetEnforcesSwitches`: true only when every counted worker advertises `extraction.config-v1`;
- `extractionConfig.workerPostureDigests`: the distinct worker postures (more than one: a mixed fleet);
- `extractionConfig.switchSkew`: workers whose switches differ from the API's.

`DOCSLURP_DISABLE` is also listed under `features` as a worker-gated flag: `configured` when set, `effective` once the
whole fleet enforces it. The API applies its own lowering either way (switches only lower, so that is always safe); it
relies on worker-side enforcement only once the fleet advertises it. Until then, older workers still read their older
variables, so keep those set during a rolling upgrade.

## Upgrading and rolling back

1. Upgrade to the compatibility release with your current variables; it starts with the old names and logs what to
   change. A worker outside development needs a profile on either name (the stock compose file sets one).
2. Set `DOCSLURP_PROFILE` (and `DOCSLURP_DISABLE` for any switches) on the API and the worker, then remove the old
   variables once every worker reports `extraction.config-v1`.
3. A later release refuses the retired variables. Roll back from it only to the compatibility release, with the image,
   environment and configuration together: the compatibility release understands both the old and the new names and the
   whole switch vocabulary, so it never meets an unknown token.
