# Syntax parser attribution

The WASM also links `fax` 0.3.0 (MIT, copyright 2021 pdf-rs contributors). `fax-MIT.txt` accompanies both distributions. The strict Group 4 adapter uses its public prefix-code tables and follows its public decoder traversal with explicit position/termination/dimension validation rather than the decoder's recovery behavior. Source: https://github.com/pdf-rs/fax . No proprietary implementation is used.

The WASM module links `otf-pdf-syntax` 0.2.0, copyright Open Tech Foundation and contributors, licensed Apache-2.0. Only its low-level grammar is used; no source was copied into this package. The Cargo lockfile pins registry provenance/checksums.

`Apache-2.0.txt` contains that license. `otf-pdf-NOTICE.txt` reproduces the upstream project's notice, including notices for components outside this syntax-only build. Source: https://github.com/Open-Tech-Foundation/PDF . These files accompany both npm and Python WASM distributions.
