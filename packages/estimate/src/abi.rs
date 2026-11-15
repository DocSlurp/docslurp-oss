//! The JSON ABI every host calls (JS, Python on wasmtime, Go on wazero). No wasm-bindgen: plain `extern "C"`
//! functions over linear memory.
//!
//! - `ds_alloc(len) -> ptr` / `ds_free(ptr, len)`: the host copies inputs into module memory.
//! - Every call returns a `u64` packing `(ptr << 32) | len` of a UTF-8 JSON envelope the host reads and then frees
//!   with `ds_free`: `{"ok":true,"value":...}` or `{"ok":false,"error":{"code":...,"message":...}}`.
//! - `ds_info()`: `{ profileSchema, profiler }`. `ds_read_plan(meta)`: bytes to read for a profile.
//!   `ds_probe(meta, head, tail)`: the file's profile (`tail_len` 0 for none).
//!
//! The `ds_*` exports exist only on wasm32, where a pointer fits the packed `u64`; native callers use the `*_json`
//! functions. A panic traps the module (WebAssembly aborts on panic); hosts discard the instance and create a new one.

use serde::Serialize;

use crate::error::Error;
use crate::probe::{probe, read_plan, FileMeta, ProbeInput};
use crate::rules::{Rules, PROFILE_SCHEMA};
use crate::probe::{DetailOptions, DetailSession};
use std::cell::RefCell;
use crate::probe::{RangeSession,RangeRequest};
use std::cell::Cell;

thread_local! {
    // One active detailed session per module; explicit close and trap recovery release it.
    static DETAIL: RefCell<Option<DetailSession>> = const { RefCell::new(None) };
    static RANGE: RefCell<Option<RangeSession>> = const { RefCell::new(None) };
    static RANGE_EPOCH: Cell<u64> = const { Cell::new(0) };
}

pub fn range_open_json(options:&[u8],meta:&[u8])->String {
    envelope((|| {
        #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Meta{size:u64}
        let meta:Meta=parse("range metadata",meta)?;
        let options:DetailOptions=parse("range options",options)?;
        if DETAIL.with(|slot|slot.borrow().is_some()) {return Err(Error::invalid_request("close the active detailed session first"));}
        RANGE.with(|slot|{
            let mut slot=slot.borrow_mut();if slot.is_some(){return Err(Error::invalid_request("close the active range session first"));}
            let epoch=RANGE_EPOCH.with(|epoch|{let next=epoch.get().checked_add(1u64<<32).filter(|next|*next<(1u64<<53)-(1u64<<32)).ok_or_else(||Error::invalid_request("session epoch overflow"))?;epoch.set(next);Ok::<_,Error>(next)})?;
            *slot=Some(RangeSession::new(meta.size,options,epoch)?);Ok(true)
        })
    })())
}
pub fn range_step_json()->String {
    envelope(RANGE.with(|slot|slot.borrow_mut().as_mut().ok_or_else(||Error::invalid_request("no active range session"))?.step()))
}
pub fn range_supply_json(meta:&[u8],bytes:&[u8])->String {
    envelope((||{let request:RangeRequest=parse("range response",meta)?;
        RANGE.with(|slot|{slot.borrow_mut().as_mut().ok_or_else(||Error::invalid_request("no active range session"))?.supply(request,bytes)?;Ok(true)})
    })())
}
pub fn range_close_json()->String { RANGE.with(|slot|*slot.borrow_mut()=None);envelope(Ok::<_,Error>(true)) }

#[cfg(target_arch="wasm32")] #[no_mangle]
pub unsafe extern "C" fn ds_range_open(options:*const u8,options_len:usize,meta:*const u8,meta_len:usize)->u64 {into_host(range_open_json(slice(options,options_len),slice(meta,meta_len)))}
#[cfg(target_arch="wasm32")] #[no_mangle]
pub extern "C" fn ds_range_step()->u64 {into_host(range_step_json())}
#[cfg(target_arch="wasm32")] #[no_mangle]
pub unsafe extern "C" fn ds_range_supply(meta:*const u8,meta_len:usize,bytes:*const u8,len:usize)->u64 {into_host(range_supply_json(slice(meta,meta_len),slice(bytes,len)))}
#[cfg(target_arch="wasm32")] #[no_mangle]
pub extern "C" fn ds_range_close()->u64 {into_host(range_close_json())}

pub fn detail_open_json(options: &[u8], bytes: &[u8]) -> String {
    envelope((|| {
        if RANGE.with(|slot|slot.borrow().is_some()){return Err(Error::invalid_request("close the active range session first"));}
        DETAIL.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_some() { return Err(Error::invalid_request("close the active detail session first")); }
            let options: DetailOptions = parse("detail options", options)?;
            let (session, header) = DetailSession::open(bytes, options)?;
            *slot = Some(session);
            Ok(header)
        })
    })())
}

pub fn detail_next_json() -> String {
    envelope(DETAIL.with(|slot| {
        let mut slot = slot.borrow_mut();
        let session = slot.as_mut().ok_or_else(||Error::invalid_request("no active detail session"))?;
        let output = session.next();
        if output.is_none() { *slot = None; }
        Ok(output)
    }))
}

pub fn detail_close_json() -> String {
    DETAIL.with(|slot| *slot.borrow_mut() = None);
    envelope(Ok::<_, Error>(true))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn ds_detail_open(options: *const u8, options_len: usize, bytes: *const u8, bytes_len: usize) -> u64 {
    into_host(detail_open_json(slice(options, options_len), slice(bytes, bytes_len)))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_detail_next() -> u64 { into_host(detail_next_json()) }

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_detail_close() -> u64 { into_host(detail_close_json()) }

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

/// `ds_probe` without the memory plumbing.
pub fn probe_json(meta: &[u8], head: &[u8], tail: Option<&[u8]>) -> String {
    envelope((|| {
        let meta: FileMeta = parse("file meta", meta)?;
        if (head.len() as u64) > meta.size || tail.is_some_and(|tail| tail.len() as u64 > meta.size) {
            return Err(Error::invalid_request("head and tail cannot be longer than the file"));
        }
        let input = ProbeInput { name: &meta.name, mime_type: meta.mime_type.as_deref(), size: meta.size, head, tail };
        Ok(probe(Rules::bundled(), &input))
    })())
}

/// `ds_read_plan` without the memory plumbing.
pub fn read_plan_json(meta: &[u8]) -> String {
    envelope(parse::<FileMeta>("file meta", meta).map(|meta| read_plan(Rules::bundled(), &meta)))
}

/// `ds_info` without the memory plumbing: the profile schema and profiler version this build emits.
pub fn info_json() -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Info {
        profile_schema: u32,
        profiler: &'static str,
    }
    envelope(Ok(Info { profile_schema: PROFILE_SCHEMA, profiler: env!("CARGO_PKG_VERSION") }))
}

/// `ds_rules` without the memory plumbing: the neutral profiler rules the probe routes with (`profiler-rules.json`).
pub fn rules_json() -> String {
    envelope(Ok(crate::rules::Rules::bundled()))
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
pub extern "C" fn ds_info() -> u64 {
    into_host(info_json())
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
