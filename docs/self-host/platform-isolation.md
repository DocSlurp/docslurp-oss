# Choosing isolation per platform

The worker runs parsers (poppler, ffmpeg, pandoc, LibreOffice, ImageMagick, OCR) on untrusted files. [Parser sandbox providers](sandbox-providers.md) covers the providers DocSlurp ships. This page covers the other half: what each hosting platform gives you on its own, and which mode to pick there.

Read it before you pick a provider for a cloud platform. The platform boundary decides what a parser breakout costs. Per-command sandboxes such as bubblewrap and landlock only work where the platform lets them.

## Modes

| Mode | What it is | DocSlurp today |
| --- | --- | --- |
| In-process sandbox | `bubblewrap` or `landlock` wraps each parser command inside the worker's own host or container. | Supported |
| Remote sandbox | `modal` runs the commands in a Modal sandbox with the network blocked. | Supported |
| Platform task | The parser runs in a separate ECS task, Cloud Run job or Fly Machine with no network and no credentials. The operator attests this; the job probes itself and fails closed. | Planned (`platform-task` provider). Not available yet. |
| Runtime class | gVisor or Kata runtime for the parser pod, set by the cluster. | Not planned. You can run the worker in such a pod, but DocSlurp has no provider for it, and bubblewrap and landlock do not work under gVisor. |
| Other remote sandboxes | Vercel Sandbox, Cloudflare Sandbox, E2B and similar. | Not planned. The provider interface allows them later. |

If the platform has no supported mode, the worker does not start in production. It never falls back to unsandboxed parsing. The `none` provider needs the explicit `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true` override.

## What production accepts

The production policy accepts a provider that reports filesystem isolation and a network level of `tcp-only` or `full`. In practice that means the parser process has:

1. no network, or at minimum no TCP,
2. no cloud credentials or worker secrets within reach,
3. a filesystem limited to its inputs and scratch, and
4. a kill timeout and resource limits.

Two rules follow from that:

- **Never run the parser as a sidecar in the worker's own task or pod.** Containers in one Fargate task share the network namespace, localhost, ephemeral storage and the task credentials endpoint ([Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)). Containers of one Kubernetes pod share a network namespace too. Use a separate task or pod.
- **A container is not a security boundary.** AWS says so directly: "Containers are not a security boundary and the use of task IAM roles does not change this" ([ECS task IAM roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html)). Google says packaging code in a container is "not a strong enough security boundary" ([Cloud Run multi-tenant](https://docs.cloud.google.com/run/docs/securing/multi-tenant)).

Where a platform boundary already gives you a microVM, no network and no credentials, per-command bubblewrap or landlock inside it is extra depth, not a requirement.

## Recommendation by platform

"Supported" means a DocSlurp provider exists today. Modes marked planned or not planned are recommendations for when they exist, or for how to operate the platform yourself.

| Platform | Platform boundary | Recommended mode | Key caveats |
| --- | --- | --- | --- |
| Self-hosted VM or bare metal | The host kernel | `bubblewrap` (supported). `landlock` if the kernel exposes Landlock ABI v9 (supported). `modal` to offload (supported). | This is where the current implementation works. |
| ECS on EC2 | Shared kernel. The instance role and IMDS are reachable unless blocked. | `bubblewrap` if the AMI and Docker seccomp profile allow user namespaces (supported). Otherwise a separate task on an isolated capacity pool (platform task, planned). | Set `ECS_AWSVPC_BLOCK_IMDS=true` for awsvpc tasks, or drop traffic to `169.254.169.254` in `DOCKER-USER` for bridge mode ([task IAM roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html)). Give parser tasks no task role. |
| AWS Fargate | A microVM per task. AWS: each task "has its own isolation boundary and does not share the underlying kernel". | `modal` today (supported). A per-job hardened task later (platform task, planned). | Bubblewrap and landlock do not work on Fargate (measured; see [Fargate results](sandbox-providers.md#aws-fargate)). Custom seccomp is not documented for Fargate. A sidecar is not isolated. The [spike](sandbox-providers.md#running-parsers-in-a-separate-fargate-task-no-bubblewrap-or-landlock) shows a no-role, no-egress task passes its checks, with scratch writable after an init-container `chown`, but takes 12 to 48 s to start. |
| EKS (EC2 nodes) | Shared node kernel | Run the worker's parsers with `bubblewrap` where the pod may create user namespaces (supported), or `modal` (supported). A separate parser pod is the platform-task form (planned). | Require IMDSv2 only with hop limit 1, `seccompProfile: RuntimeDefault`, dropped capabilities and a deny-all egress NetworkPolicy ([EKS identity](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html), [EKS runtime security](https://docs.aws.amazon.com/eks/latest/best-practices/runtime-security.html)). Pod user namespaces (`hostUsers: false`) need a recent node stack ([Kubernetes docs](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/)). Whether EKS AMIs ship it is unverified. |
| AWS Lambda | A Firecracker microVM per execution environment, but environments are reused across invocations. | `modal` (supported). A dedicated parser function with no role is possible only with care, and is not planned. | The care: treat each invocation's `/tmp` as hostile and wipe it, never share the function with secrets, and note that no user-namespace, seccomp or capability controls are documented. `/tmp` and background processes persist across invocations of one environment ([runtime environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)), so a compromised parser can persist. The function's credentials are in the environment. 15-minute limit. Lambda MicroVMs ([announcement](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms)) have an optional execution role and are a closer fit, but are untested here. |
| Google Cloud Run | A VMM boundary per instance. Second generation is a microVM; first generation is gVisor. | `modal` today (supported). A separate gen2 Cloud Run job with a no-permission service account (platform task, planned). | Jobs are believed to run only on the second generation; that came from a search summary, not a primary page, so treat it as unverified. Do not expect bubblewrap or landlock on gen1. Whether gen2 allows user namespaces is unverified: run the probe. The metadata server is reachable by default. Egress deny is only partly documented ([security](https://docs.cloud.google.com/run/docs/securing/security), [execution environments](https://docs.cloud.google.com/run/docs/about-execution-environments)). Cloud Run sandboxes are a Preview feature with no network and no credentials by default ([code execution](https://docs.cloud.google.com/run/docs/code-execution)); DocSlurp does not use them. |
| GKE | Shared node kernel. GKE Sandbox runs pods under gVisor. | `modal` (supported). GKE Sandbox pods with a deny-all NetworkPolicy and no Workload Identity bindings are the platform-level option (runtime class, not planned). | Sandboxed pods do not support seccomp, AppArmor or SELinux, so bubblewrap and landlock are not usable in them. Only a subset of syscalls is available, so ffmpeg and LibreOffice may be slower. Not benchmarked ([GKE Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods)). |
| Fly.io | A Firecracker microVM per Machine ([architecture](https://docs.fly.io/reference/architecture)). | `bubblewrap` inside the Machine if the probe passes (supported), or `modal` (supported). One Machine per job in a separate secret-free app (platform task, planned). | Fly secrets are injected as environment variables, so keep the parser app free of secrets. Per-Machine egress filtering is unverified. Whether the guest kernel allows user namespaces is unverified: run the probe. |
| Vercel | Functions are Lambda-like. Vercel Sandbox is a Firecracker microVM ([docs](https://vercel.com/docs/vercel-sandbox)). | `modal` (supported). Vercel Sandbox is a fit but is not planned. | Do not run the parsers inside Functions. A Vercel Sandbox allows outbound HTTP by default, so set a deny policy, and use a non-persistent sandbox so one upload's files do not reach the next. |
| Cloudflare | Workers are isolates and cannot run native binaries. Containers and the Sandbox SDK are Firecracker microVMs ([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)). | `modal` (supported). Sandbox SDK is a fit but is not planned. | Containers cold start in about 1 to 3 s per the architecture page. A container starts with `enableInternet: false`. Needs the Workers Paid plan ([Sandbox SDK](https://developers.cloudflare.com/sandbox/)). |
| Generic Kubernetes | Depends on the runtime | `bubblewrap` or `modal` (supported). With gVisor or Kata via `runtimeClassName`, treat the pod as the sandbox (runtime class, not planned). | Use the Pod Security `restricted` profile, `hostUsers: false` where available, a deny-all egress NetworkPolicy, no automounted service account token and blocked cloud metadata. Keep the parser in a different pod from the worker. |
| Modal | gVisor by default, with a VM runtime available ([sandbox guide](https://modal.com/docs/guide/sandbox)) | `modal` (supported) | Your document contents go to a third party. Modal itself advises egress limits, resource limits and keeping secrets out. DocSlurp blocks the network and passes no secrets. |

Start with `bubblewrap` wherever the platform allows user namespaces. Run the probe (see [sandbox providers](sandbox-providers.md#where-these-providers-work-in-containers)) on your platform before relying on any claim above that this page marks unverified.

## Tool hardening

These are recommendations for adding depth inside any sandbox. Only the ffmpeg flags are current behaviour.

- **ffmpeg and ffprobe.** The worker already passes `-protocol_whitelist file,pipe` (and a `-format_whitelist` for the formats it handles) to ffmpeg and ffprobe in `worker/src/media/` and `worker/scripts/video_scan.py`. ffmpeg allows every protocol by default ([ffmpeg protocols](https://ffmpeg.org/ffmpeg-protocols.html)), so keep these flags on any new ffmpeg call. Playlist formats such as HLS can still reference other files, which is why filesystem and network confinement still matter.
- **ImageMagick.** The full worker image installs Debian's `imagemagick` with its default policy. The repository does not ship a custom `policy.xml`. For untrusted input, ImageMagick documents a hardened policy that denies delegates, filters and modules, blocks pipe input, allows only needed formats and sets resource caps ([security policy](https://imagemagick.org/security-policy/)). Adding one is a recommendation. PDF and PostScript coders go through Ghostscript and need separate handling.
- **LibreOffice, pandoc and poppler.** The vendors publish no hardening guidance to cite. Rely on filesystem and network confinement, a private `HOME` and profile directory (the local providers already set one) and timeouts.
- **Limits.** Set a wall-clock timeout, a memory cap, an output size cap and a process cap on every sandbox.

## Further reading

- [Parser sandbox providers](sandbox-providers.md)
- [Security](security.md#parser-sandbox)
- [Wikimedia Shellbox](https://www.mediawiki.org/wiki/Shellbox) runs binaries in a separate unprivileged container with no external network. DocSlurp's design follows the same two-layer idea: a separate trust zone plus a per-command sandbox.
