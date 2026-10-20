# Integration roadmap

The work listed below is **planned**, except where an existing implementation is explicitly identified. No package names or release dates are promised for planned work. Native HTTP and the shared widget are building blocks, not proof of a finished integration; remaining delivery requirements are recorded on this page. Shipped integrations live in the [Search & CMS integration guide](https://docslurp.io/docs/search-integrations).

Today, use the native [HTTP API](https://docslurp.io/docs/http) from any language, or the documented widget/component for an existing frontend. The integrations directory keeps native interfaces first, followed by search adapters, CMS platforms, frameworks, documentation sites and language clients.

## CMS platforms

The eight CMS targets are WordPress, Shopify, Wix, Squarespace, Joomla, Webflow, Drupal and Strapi. WordPress's source plugin is implemented; the remaining seven need dedicated connectors. This list combines widely used platforms with a headless CMS target, rather than claiming a strict top-eight ranking. [W3Techs adoption data](https://w3techs.com/technologies/overview/content_management) was reviewed on October 7, 2026. Astro is covered separately as a framework with a native component.

Every content connector must cover initial ingestion, update/delete propagation, canonical URLs, publication state and appropriate viewer access. Do not silently index drafts, private pages or member content into public search.

### Shopify

**Planned.** Build a theme app extension and server-held ingestion configuration; synchronize published products/pages, updates and deletes. Keep storefront search scoped to deliberately public content.

### Wix

**Planned.** Build a Velo backend bridge and site search component; synchronize published CMS collections and exclude private/member-only content unless viewer authorization is enforced.

### Squarespace

**Planned.** Validate code-injection availability by Squarespace plan, bundle a public search widget and document a supported published-content crawl/export refresh strategy.

### Joomla

**Planned.** Build an installable module/plugin, article ingestion and update/delete hooks; preserve Joomla access levels and canonical source routes.

### Webflow

**Planned.** Build a CMS publish/update/delete ingestion bridge and site embed recipe; keep tokens server-side and index only intended public items.

### Drupal

**Planned.** Build a Drupal module with entity/revision sync, a search block and access-aware retrieval; cover unpublish/delete events and canonical URLs.

### Strapi

**Planned.** Build lifecycle/webhook ingestion for published entries and media, including update/delete propagation; keep draft/private entries outside public search.

## Documentation sites

### Docusaurus

**Planned.** Build a Docusaurus plugin/theme integration with public search UI, build-time ingestion, version/locale routing and canonical document URLs. Validate keyboard behavior and deployment base paths.

### Slate

**Planned.** Build a Slate/Middleman recipe for generated HTML ingestion and search UI. Preserve section anchors, language tabs, deployment base paths and keyboard behavior.

## Language SDKs

Each client needs upload/URL ingestion, run waiting, cited search/chat, typed errors, retries that respect rate limits, cancellation and streaming with a nonstreaming fallback. Preserve server-side credentials, organization/workspace scope, usage metadata and executable examples. Validate a real indexed corpus before calling a package supported.

<a id="python-sdk"></a>

### Python SDK

**Planned.** Typed sync/async client, upload, wait, search, chat and streaming fallback; wheel/sdist packaging. Distribution target: PyPI. [Account setup](https://pypi.org/account/register/).

<a id="rust-sdk"></a>

### Rust SDK

**Planned.** Typed async client, streaming/multipart upload, cancellation and error enums; Cargo/crates.io release. Distribution target: crates.io. [Account setup](https://github.com/signup).

<a id="go-sdk"></a>

### Go / Golang SDK

**Planned.** Context cancellation, io.Reader uploads, typed errors and streaming fallback; tagged Go module. Distribution target: Go modules. [Account setup](https://github.com/signup).

<a id="elixir-sdk"></a>

### Elixir SDK

**Planned.** OTP-friendly HTTP client, tagged errors, uploads and run watching; Hex package and ExDoc. Distribution target: Hex. [Account setup](https://hex.pm/signup).

<a id="dotnet-sdk"></a>

### .NET / C# SDK

**Planned.** Async client with CancellationToken, streaming upload and typed results; NuGet package. Distribution target: NuGet. [Account setup](https://signup.live.com/).

<a id="jvm-sdk"></a>

### Java / Kotlin · JDK SDK

**Planned.** JDK HTTP client, typed models, futures/streaming and Kotlin usage; Maven Central namespace/release. Distribution target: Maven Central. [Account setup](https://central.sonatype.com/).

<a id="smalltalk-sdk"></a>

### Smalltalk SDK

**Planned.** Pharo-first HTTP/JSON client, stream uploads, errors and a Metacello baseline; assess other dialects explicitly. Distribution target: Metacello / source. [Account setup](https://github.com/signup).

<a id="cpp-sdk"></a>

### Modern C++ SDK

**Planned.** C++20 client, cancellation/streaming, typed errors and CMake exports; Conan/vcpkg distribution recipes. Distribution target: CMake · Conan / vcpkg. [Account setup](https://github.com/signup).

<a id="php-sdk"></a>

### PHP SDK

**Planned.** Reusable Composer client beyond the WordPress proxy; PSR-compatible HTTP, upload and typed responses. Distribution target: Packagist. [Account setup](https://packagist.org/register/).

<a id="ruby-sdk"></a>

### Ruby SDK

**Planned.** Gem with streaming uploads, run waiting, cited search and errors; Rails/server examples. Distribution target: RubyGems. [Account setup](https://rubygems.org/sign_up).

## Registry account setup

These links are for maintainers preparing distribution; consuming public packages or calling DocSlurp HTTP does not require publisher registration. No accounts are created by this guide.

- JavaScript/TypeScript: [npm signup](https://www.npmjs.com/signup).
- Python: [PyPI signup](https://pypi.org/account/register/).
- Rust: [crates.io](https://crates.io/) currently uses GitHub login; [create a GitHub account](https://github.com/signup) and follow the official [Cargo publishing guide](https://doc.rust-lang.org/cargo/reference/publishing.html).
- Go: publish a tagged source repository using [GitHub signup](https://github.com/signup) or your existing host. Go modules have no universal publisher signup; follow [Go module publishing](https://go.dev/doc/modules/publishing).
- Elixir: [Hex signup](https://hex.pm/signup).
- .NET: [Microsoft account signup](https://signup.live.com/), then [NuGet sign-in](https://www.nuget.org/users/account/LogOn) to register a NuGet identity. See [NuGet individual accounts](https://learn.microsoft.com/en-us/nuget/nuget-org/individual-accounts).
- JVM: [Maven Central](https://central.sonatype.com/) → Sign in → account creation; follow [Central Portal registration](https://central.sonatype.org/register/central-portal/) and namespace verification.
- Smalltalk: [GitHub signup](https://github.com/signup) for Metacello/source distribution; dialect-specific packaging still needs validation.
- Modern C++: [GitHub signup](https://github.com/signup) for source hosting and Conan Center/vcpkg contribution workflows. There is no single C++ registry account that covers both.
- PHP: [Packagist signup](https://packagist.org/register/).
- Ruby: [RubyGems signup](https://rubygems.org/sign_up).

Package names, namespace ownership, release CI and registry metadata are part of each SDK's delivery work. Follow the repository's release policy rather than publishing from a copied integration prompt.
