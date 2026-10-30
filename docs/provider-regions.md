# Provider regions and China-based providers

DocSlurp's default models come mostly from Chinese labs (DeepSeek, Qwen, GLM), and by default those models
may be served by China-based hosts when those hosts are the cheapest that meet quality. Organizations and
workspaces can turn China-based providers off. This page covers the default, the opt-out, how a provider's
region is decided, and what DocSlurp records.

## Default

China-based providers are **allowed** by default (`allowChinaProviders: true` on organizations and workspaces).

- **Vision (Rich pages):** the default model, `deepseek/deepseek-v4.1-flash-1017`, is served by Together,
  Fireworks or Parasail. OpenRouter picks the cheapest of them at request time
  (`provider.only` plus `provider.sort: "price"`). Every request carries `provider.max_price`, so no host can
  bill above the route's price ceiling ($0.30 / $1.20 per million tokens).
- **Text and chat:** GLM and DeepSeek models are sorted by price among hosts serving FP8 or better weights
  (`packages/shared/src/openrouter-routing.ts`). Other models use OpenRouter's default routing.

**Candidate-host evidence (not rollout approval)** (2026-10-29, frozen `tune` and `select` splits, 95 pages, judge v3.6; holdout
not run):

| Host | Region | Content F1 | Tables | Math | Fail rate | p50 / p95 s | USD per 1,000 pages | Pages per $1 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Together (retained production host, select) | US | 0.962 | 0.648 | 0.947 | 0% | 2.2 / 5.3 | 1.03 | 972 |
| StreamLake (select) | CN | 0.962 | 0.662 | 0.947 | 0% | 4.3 / 10.6 | 0.51 | 1,940 |
| StreamLake (tune) | CN | 0.970 | 0.677 | 0.968 | 0% | 4.1 / 11.5 | 0.49 | 2,051 |
| DeepSeek (tune, billed at weekday peak) | CN | 0.969 | 0.672 | 0.968 | 0% | 3.3 / 9.8 | 0.98 | 1,023 |

Costs are OpenRouter-reported charges. StreamLake against Together on `select`: no component differs
significantly (95% paired bootstrap CIs include 0). StreamLake roughly doubles per-page latency. DeepSeek's own
endpoint costs $0.15 / $0.60 per million tokens off-peak and $0.30 / $1.20 on weekdays 01:00–04:00 and
06:00–10:00 UTC; the price sort follows that schedule. Raw runs are kept with the maintainers' evaluation
records (`china-ds1017-20261029-{tune,select}`). Endpoint prices: `docs/evals/vision-route-prices-2026-10-29.json`.

## Turning China-based providers off

- **Organization (owners and admins):** `PATCH /v1/organizations/:orgId { "allowChinaProviders": false }`
  (SDK `updateOrganization`).
- **Workspace:** `PATCH /v1/workspaces/:workspace { "allowChinaProviders": false }` (SDK `updateWorkspace`). A
  workspace can only narrow its organization's setting: a request may use China-based providers only when the
  organization **and** every workspace whose content the request sends allow them. Setting a workspace to
  `true` inside an organization that turned them off changes nothing.

Changes apply within 30 seconds on the API and at the next run on the worker.

When the setting is off, every hosted model request made for that organization or workspace is restricted:

- **OpenRouter:** the request carries `provider.only`, an allowlist of the providers with a known headquarters
  outside China, and `provider.ignore` with every China-based provider. Any `only` or `order` entry the code
  or a model profile set that is not on the allowlist is dropped. A request with no allowed provider left is
  refused before it is sent. This applies to every attempt: first tries, inline retries, alternate routes after
  a refusal or degenerate output, streaming-to-JSON fallbacks, chat, search helpers, summaries and other
  pipeline text, embeddings, output moderation and chat-instructions Improve. Restricted voice transcription
  is refused before sending audio; its endpoint does not have verified provider routing.
- **Direct routes:** a page-router decision model is refused when its upstream (the endpoint's provider, or the
  model's lab behind OpenRouter's `/systemone`) is not on the allowlist, and the page router falls back as it
  does for any unavailable model.
- **Unknown scope fails closed.** Worker calls outside a run's provider scope, API calls with no user,
  organization or workspace, and a missing organization or workspace are all treated as turned off.

The vision route retains the same three hosts with either setting. Turning the setting off can make
some text models unavailable:

- **`qwen/qwen3.5-flash-02-23` (the default pipeline text model) is served only by Alibaba.** With China-based
  providers off, text stages that use it (summaries, document maps, propositions, structured extraction) have no
  allowed host and fail. Choose a text model with non-China hosts for such workspaces
  (`pipeline.textGeneration.model`). This was already the case before this change.
- Providers whose region is unknown (for example Relace, Typesafe, Liquid, NEAR AI, Makora) are never used
  while the setting is off.

The setting picks hosts. It does not block models built by Chinese labs, which also run on hosts elsewhere.

## Privacy modes win

`pipeline.privacyMode` (`local-only`, `strict-privacy`) is checked first and blocks hosted calls outright,
whatever this setting says. The China-provider setting can only remove hosts; it never re-enables a call a
privacy mode, an operator-registered private endpoint rule or the non-free-software opt-out blocks.

## The provider-region table

`packages/shared/src/provider-regions.ts` lists every provider with its region:

| Region | Rule | Count (2026-10-29) |
|---|---|---:|
| `cn` | Headquartered in China, or a Chinese-owned company listed under an international entity (the owner is named in the row's `basis`) | 13 |
| `other` | OpenRouter lists a headquarters outside China, and the company is not Chinese-owned | 67 |
| `unknown` | OpenRouter lists no headquarters; never guessed, never allowed when the setting is off | 35 |

`cn`: Alibaba, Baidu, DeepSeek, MiniMax, Moonshot AI, Nex AGI, ByteDance Seed, SiliconFlow, StepFun, StreamLake
(Kuaishou), Tencent, Xiaomi and Z.AI.

**Source:** OpenRouter provider metadata, `https://openrouter.ai/api/v1/providers` (`headquarters`,
`datacenters`), fetched 2026-10-29. A Chinese-owned provider stays `cn` even when its listed datacenters are
outside China (MiniMax and SiliconFlow list US datacenters).

**Refresh:** fetch the providers endpoint, regenerate the rows, keep the Chinese-owned list, review every
changed row, and update the date. A provider missing from the table is `unknown` until a row is added.

## Usage records

Vision and OpenRouter text usage records carry `servedProvider` (the host OpenRouter reported),
`servedProviderSlug` and `servedProviderRegion` in their metadata, so spend can be broken down by host region.
Billing still uses the served host's reported charge (`usage.cost`); list prices only bound requests.

## Public disclosures

Which hosts may process customer content is a subprocessor question. Changes to the privacy policy, DPA or
subprocessor list are decided by the owner and legal@docslurp.io, not by this page.

## Merge and deployment gate

The default vision profile retains its existing Together, Fireworks and Parasail
allowlist. StreamLake and DeepSeek are **not enabled** by this release. Adding
those hosts requires a separately reviewed rollout after public disclosures,
notice commitments and representative held-out quality evidence are complete.
The default catalog pricing and runtime route use the same three retained hosts.

Restricted audio transcription is refused before uploading any audio because
provider-routing enforcement on that endpoint has not been verified. Use typed
input or an explicitly configured private transcription service. Request-object
bodies receive the same enforcement as fetch init bodies. Users without an
organization membership fail closed.
