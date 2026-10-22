# Stripe catalog feed

Generate a discovery-only CSV of the prepaid credit packs ($25, $50 and $100; `CREDIT_PACK_CENTS` in `packages/shared/src/billing.ts`) and optional Stripe products with the server's `catalog:feed` command. DocSlurp sells no plans or subscriptions. All rows disable agent checkout and link buyers to the pricing page; this command does not create organization-scoped credit purchases. After the move from plans to packs, upload once with `--mode replace` so the retired plan rows leave the Stripe catalog.

## Environment files and precedence

Run commands from the workspace root. The loader finds the outermost ancestor containing `pnpm-workspace.yaml`: the standalone core root, or the private app root when core is checked out inside it.

- The default (`--env local`) loads the root `.env` only.
- `--env production` overlays the root `.env.production` on `.env`. It fails if `.env.production` is missing.
- Existing shell or CI variables take precedence over both files, including explicitly empty values.
- Explicit `--link` and `--stripe-product` arguments override the corresponding environment defaults.

The effective precedence is **shell/CI → `.env.production` → `.env`** for production runs. Environment selection does not depend on `NODE_ENV`. The CLI reads file settings before resolving catalog defaults and checking the Stripe key. Keep both environment files private and untracked.

Configure:

- `STRIPE_SECRET_KEY`: the Stripe key used for product lookup and uploads.
- `APP_URL`: the base URL for the default `/pricing` link. Set a public production URL; the fallback is `http://localhost:4321`.
- `STRIPE_CATALOG_LINK`: optional public landing-page override.
- `STRIPE_CATALOG_PRODUCTS`: optional comma-separated product IDs. Each must have an active, fixed USD default price.

## Generate and inspect

```sh
pnpm --filter @docslurp/server catalog:feed --out feed.csv
pnpm --filter @docslurp/server catalog:feed --env production --out feed.csv
```

Without `--upload`, no catalog import is created. Configured extra products still trigger Stripe reads to retrieve their default prices. Check the CSV's destination links, prices, images and product selection before uploading. `--credits-image` overrides the default public image URL.

## Upload

Validate with a sandbox key in `.env` first:

```sh
pnpm --filter @docslurp/server catalog:feed --upload
```

For a production key configured in the production overlay:

```sh
pnpm --filter @docslurp/server catalog:feed --env production --upload --live
```

`--env production` selects files; `--live` permits uploading with a live key. Neither flag implies the other, and `--live` alone does not load `.env.production`. Shell overrides can select a different key, so confirm the intended environment before execution.

Uploads default to `--mode upsert`. Use `--mode replace` only when the file is intended to replace the entire catalog: products absent from that feed are deleted. The command polls the import, prints its status and available error CSV, and exits unsuccessfully unless the final status is `succeeded`.

Merging this code does not upload a feed or deploy the service; uploading is a separate manual command.
