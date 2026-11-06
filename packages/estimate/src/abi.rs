//! The JSON ABI every host calls (JS, Python on wasmtime, Go on wazero). No wasm-bindgen: plain `extern "C"`
//! functions over linear memory.
//!
//! - `ds_alloc(len) -> ptr` / `ds_free(ptr, len)`: the host copies inputs into module memory.
//! - Every call returns a `u64` packing `(ptr << 32) | len` of a UTF-8 JSON envelope the host reads and then frees
//!   with `ds_free`: `{"ok":true,"value":...}` or `{"ok":false,"error":{"code":...,"message":...}}`.
//! - `ds_card()`: the bundled card. `ds_read_plan(meta)`: bytes to read for a probe.
//!   `ds_probe(meta, head, tail)`: probe result (`tail_len` 0 for none). `ds_quote(request, card)`: quote
//!   (`card_len` 0 for the bundled card).
//!
//! The `ds_*` exports exist only on wasm32, where a pointer fits the packed `u64`; native callers use the `*_json`
//! functions. A panic traps the module (WebAssembly aborts on panic); hosts discard the instance and create a new one.

use serde::Serialize;

use crate::card::Card;
use crate::error::Error;
use crate::probe::{probe, read_plan, FileMeta, ProbeInput};
use crate::{quote, QuoteRequest};

/// Envelope JSON for a result.
pub fn envelope<T: Serialize>(result: Result<T, Error>) -> String {
    #[derive(Serialize)]
    struct Ok<'a, T> {
        ok: bool,
        value: &'a T,
    }
    #[derive(Serialize)]
    struct Err<'a> {
        ok: bool,
        error: &'a Error,
    }
    let json = match &result {
        Result::Ok(value) => serde_json::to_string(&Ok { ok: true, value }),
        Result::Err(error) => serde_json::to_string(&Err { ok: false, error }),
    };
    json.unwrap_or_else(|error| format!(r#"{{"ok":false,"error":{{"code":"invalid_request","message":"{error}"}}}}"#))
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, bytes: &[u8]) -> Result<T, Error> {
    serde_json::from_slice(bytes).map_err(|error| Error::invalid_request(format!("invalid {what}: {error}")))
}

/// `ds_quote` without the memory plumbing.
pub fn quote_json(request: &[u8], card: Option<&[u8]>) -> String {
    envelope((|| {
        let request: QuoteRequest = parse("quote request", request)?;
        let card = match card {
            Some(bytes) => Some(Card::from_json(std::str::from_utf8(bytes).map_err(|_| Error::invalid_card("not UTF-8"))?)?),
            None => None,
        };
        quote(card.as_ref(), &request)
    })())
}

/// `ds_probe` without the memory plumbing.
pub fn probe_json(meta: &[u8], head: &[u8], tail: Option<&[u8]>) -> String {
    envelope((|| {
        let meta: FileMeta = parse("file meta", meta)?;
        if (head.len() as u64) > meta.size || tail.is_some_and(|tail| tail.len() as u64 > meta.size) {
            return Err(Error::invalid_request("head and tail cannot be longer than the file"));
        }
        let input = ProbeInput { name: &meta.name, mime_type: meta.mime_type.as_deref(), size: meta.size, head, tail };
        Ok(probe(Card::bundled(), &input))
    })())
}

/// `ds_read_plan` without the memory plumbing.
pub fn read_plan_json(meta: &[u8]) -> String {
    envelope(parse::<FileMeta>("file meta", meta).map(|meta| read_plan(Card::bundled(), &meta)))
}

/// `ds_card` without the memory plumbing.
pub fn card_json() -> String {
    envelope(Ok(Card::bundled()))
}

/// `ds_rules` without the memory plumbing: the neutral profiler rules the probe routes with (`profiler-rules.json`).
pub fn rules_json() -> String {
    envelope(Ok(crate::rules::ProfilerRules::bundled()))
}

#[cfg(target_arch = "wasm32")]
fn into_host(json: String) -> u64 {
    let mut bytes = json.into_bytes().into_boxed_slice();
    let len = bytes.len() as u64;
    let ptr = bytes.as_mut_ptr() as usize as u64;
    std::mem::forget(bytes);
    (ptr << 32) | len
}

/// # Safety
/// `ptr`/`len` must describe memory the host wrote into after `ds_alloc(len)`; zero `len` reads nothing.
#[cfg(target_arch = "wasm32")]
unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_alloc(len: usize) -> *mut u8 {
    let mut bytes = vec![0u8; len].into_boxed_slice();
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `ds_alloc` or a returned envelope, freed once.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn ds_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_card() -> u64 {
    into_host(card_json())
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_rules() -> u64 {
    into_host(rules_json())
}

/// # Safety
/// See [`slice`].
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn ds_read_plan(meta_ptr: *const u8, meta_len: usize) -> u64 {
    into_host(read_plan_json(slice(meta_ptr, meta_len)))
}

/// # Safety
/// See [`slice`].
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn ds_probe(
    meta_ptr: *const u8,
    meta_len: usize,
    head_ptr: *const u8,
    head_len: usize,
    tail_ptr: *const u8,
    tail_len: usize,
) -> u64 {
    let tail = (tail_len > 0).then(|| slice(tail_ptr, tail_len));
    into_host(probe_json(slice(meta_ptr, meta_len), slice(head_ptr, head_len), tail))
}

/// # Safety
/// See [`slice`].
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn ds_quote(request_ptr: *const u8, request_len: usize, card_ptr: *const u8, card_len: usize) -> u64 {
    let card = (card_len > 0).then(|| slice(card_ptr, card_len));
    into_host(quote_json(slice(request_ptr, request_len), card))
}
