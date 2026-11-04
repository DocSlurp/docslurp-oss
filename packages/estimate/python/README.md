# docslurp-estimate

[Package docs](https://docslurp.io/docs/packages/estimate) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/estimate) · PyPI · not published yet

Offline DocSlurp credit estimates for Python. Probes files on your machine (PDF pages and page mix, media duration,
Office page counts) and prices an upload with the published price card, as `POST /v1/uploads/estimate` would.
Nothing is uploaded. It runs the same WebAssembly module as `@docslurp/estimate` on npm, through wasmtime.

```python
from docslurp_estimate import Estimator, fetch_estimate_card

estimator = Estimator()                                  # bundled price card
# estimator = Estimator(card=fetch_estimate_card())      # current card from docslurp.io
quote = estimator.quote_paths(["contract.pdf", "call.mp3"])
print(quote["estimate"]["credits"], quote["card"]["version"])
```

Pass a workspace's `profile` (returned by `POST /v1/uploads/estimate`) to quote with its settings; without one, a
new hosted workspace with default settings is assumed.
