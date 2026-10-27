# Document image VM repair contract

The WebP encoder and decoder now dispatch to a fresh Modal `runtime: "vm"` sandbox before activity scopes, vendor bundles or vector-backend shortcuts. The control client keeps its credentials on the host. The guest receives one explicitly staged input, no secrets, volumes or identity token, no network, two hard CPU cores, 1 GiB hard memory and a 60-second lifetime. The guest validates dimensions and rejects animation before decoding; maximum image size is 4096 pixels per side, 16 million pixels and 64 MiB input/output. stdout/stderr are read incrementally with 16 KiB caps. Exactly one declared output is streamed with a 64 MiB cap. The VM is terminated on success and errors. No local parser fallback exists on these paths. Encoder unavailability preserves PNG; decoder unavailability refuses the unsupported image/model combination.

## Required release evidence (not yet available)

Set `DOCSLURP_DOCUMENT_VM_IMAGE` to a verified `repository@sha256:...` image containing Python 3, Pillow with WebP support and cwebp. An optional matching `DOCSLURP_DOCUMENT_VM_IMAGE_DIGEST` may pin it separately. Mutable tags are refused. No digest is invented by this change. Build/publish/signature verification and a live VM smoke test remain release blockers. No VM or model workload was authorized or run for this repair.

The legacy generic Modal provider remains distinct; its activity-wide sessions and recursive staging are not the new document executor. These repairs do not claim to close the separately tracked legacy parser isolation gap.

Before merge, the coordinator must obtain two independent council reviews, including an adversarial reviewer, and human owner approval. Offline SDK contract tests do not prove operational VM readiness or a hostile-code escape boundary.
