# docslurp-estimate

[Package docs](https://docslurp.io/docs/packages/estimate) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/estimate) · PyPI · not published yet

The offline DocSlurp file profiler for Python. It measures files on your machine (file type, page counts, aggregate PDF
page facts, media duration) and returns small file profiles; send them to `POST /v1/uploads/estimate` for a credit
estimate. Nothing is uploaded, and nothing here prices anything. It runs the same WebAssembly module as
`@docslurp/estimate` on npm, through wasmtime.

```python
from docslurp_estimate import Estimator, request_quote

estimator = Estimator()
result = estimator.estimate_paths(["contract.pdf", "call.mp3"])
print([file["profile"] for file in result["files"]])                 # neutral facts, no credits
quote = request_quote(result["request"]["files"], api_key=API_KEY)   # the server's estimate
```

Offline, show the profiles without credits. See the npm package README for the profile fields.

For dense per-page evidence, `estimator.profile_jsonl(path)` yields numeric JSONL through bounded local range reads (up to 2 GiB). It inventories every page, deeply inspects up to 1,000, and includes optional table/caption/vector candidates, text-byte composition, chunk summaries and rankings. Close a partially consumed generator explicitly. See [the JSONL contract](../../../docs/offline-page-profile-jsonl.md); this stream is separate from the small quote profile.
