# Glossary

Domain terms used across the server, worker and SDKs.

## Run creation

Admitting, materialising, publishing and starting a Run as one step. A Run is either fully created (published, then started or deferred) or it does not exist. Callers describe the Run's sources (new files, or new versions of existing Documents); they never write Documents or sequence publish/start themselves.

## Page evidence

What is known, and what is not, about one page of a document, and the routing decisions that follow from it. Doppler's page facts, the layout walker and the native probe each measure pages; their adapters turn a page into page evidence once, applying the shared rules (page-size bounds, furniture, the low-confidence and truncation downgrades, which source's grids stand). Every quantity is known or unknown, and unknown is never read as zero, "no table" or "no image": a page whose ruled grids are unknown takes the table path, and a low-confidence page keeps only its size. Consumers (classify-route, the v2 router, cost stats, chart-export) read decisions from page evidence; they never re-decide a fact from a source themselves.
