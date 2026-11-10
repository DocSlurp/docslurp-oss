//! Offline DocSlurp file profiler.
//!
//! [`probe()`] reads a file on the user's own machine and returns a [`FileProfile`]: the real file type, page, slide or
//! frame counts, media duration, and aggregate facts about a PDF's sampled pages (text-layer words, full-page raster
//! pages, image coverage, vector drawing, fonts without a Unicode mapping). A profile holds neutral facts only, never
//! file content and never a price: send it to `POST /v1/uploads/estimate` and the server quotes it.
//!
//! One WebAssembly build serves every host through the JSON ABI in [`abi`]: the `@docslurp/estimate` npm package
//! (browsers, Node, Deno, Workers), Python on wasmtime, Go on wazero. See DESIGN.md.

pub mod abi;
pub mod error;
pub mod probe;
pub mod rules;

pub use error::{Error, ErrorCode};
pub use probe::{probe, read_plan, FileMeta, FileProfile, OfficeProfile, PdfProfile, ProbeInput, ProbeKind, ReadPlan};
pub use rules::Rules;
