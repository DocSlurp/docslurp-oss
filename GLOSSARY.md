# Glossary

Domain terms used across the server, worker and SDKs.

## Run creation

Admitting, materialising, publishing and starting a Run as one step. A Run is either fully created (published, then started or deferred) or it does not exist. Callers describe the Run's sources (new files, or new versions of existing Documents); they never write Documents or sequence publish/start themselves.

## Run admission

The decision that a Run may become spendable work, and everything that must be true when it is made: the organization's admission lock is held, the Run belongs to that organization and project, the spend rule passes with the Run's own reservation counted, and the Run holds its first credit lease, all in the transaction that inserts or re-queues it. Run creation, retry, resume and recover, re-index and full-index batches, blocked and spend-paused runs and on-demand page runs are each admitted through it; none of them takes the lock, reads spend or grants a lease themselves. A refusal leaves nothing behind, or leaves the Run saved as blocked when its caller's own change must still commit.

## Page evidence

What is known, and what is not, about one page of a document, and the routing decisions that follow from it. Doppler's page facts, the layout walker and the native probe each measure pages; their adapters turn a page into page evidence once, applying the shared rules (page-size bounds, furniture, the low-confidence and truncation downgrades, which source's grids stand). Every quantity is known or unknown, and unknown is never read as zero, "no table" or "no image": a page whose ruled grids are unknown takes the table path, and a low-confidence page keeps only its size. Consumers (classify-route, the v2 router, cost stats, chart-export) read decisions from page evidence; they never re-decide a fact from a source themselves.

## Page basis

The pages a Document is split, indexed and billed on (its page count, and the billing pages measured when they differ), together with the spend check every change to them owes. A Run's documents change their page basis only by recording a measurement (a counted page tree, frames read from an image, Office pages counted from the extractor's text, page equivalents); the page basis decides which count changes, applies the floors, keeps the Run's page total in step and re-checks the Run's spend across all of its documents, pausing the Run or refusing the Document when the balance no longer covers it. Callers never write page counts or sum other documents' extra pages themselves, and a page basis that cannot check refuses rather than skips.

## Run ledger

A Run's durable lifecycle: loading and hydrating its state, its run and document stage transitions and the progress checkpoints that commit each stage's usage, artifacts and vector indexes, page checkpoints, milestones, sandbox strikes and its terminal outcome. Every loaded state is bound to the run ledger, which carries the ports stages write through (document content, document records, assets, knowledge graph, fleet budgets, OCR escalation reads, page basis), each required and owned by its own module. Periodic sweeps and alerts are maintenance, never the run ledger's.
