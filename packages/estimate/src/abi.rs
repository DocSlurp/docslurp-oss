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
        let input = ProbeInput { name: &meta.name, mime_type: meta.mime_type.as_deref(), size: meta.size, head, tail, bounded: meta.bounded };
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

/// Why the module last trapped, readable after the trap without allocating: a panic's message (the panic hook writes it
/// into a fixed static buffer) or the size of an allocation the allocator refused (an out-of-memory abort never reaches
/// the panic hook). Hosts call `ds_init` once after instantiating, `ds_clear_trap` before each call, and
/// `ds_last_panic` / `ds_last_failed_alloc` when a call traps.
#[cfg(target_arch = "wasm32")]
mod trap_note {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CAP: usize = 1024;
    // `{"panic":"...","failedAlloc":N}` is assembled by the host from these two; the buffer holds the message only.
    static mut MESSAGE: [u8; CAP] = [0; CAP];
    static MESSAGE_LEN: AtomicUsize = AtomicUsize::new(0);
    static FAILED_ALLOC: AtomicUsize = AtomicUsize::new(0);

    struct Note(usize);
    impl core::fmt::Write for Note {
        fn write_str(&mut self, text: &str) -> core::fmt::Result {
            let bytes = text.as_bytes();
            let n = bytes.len().min(CAP - self.0);
            // SAFETY: single-threaded module; the hook is the only writer and the host reads only after a trap.
            unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), core::ptr::addr_of_mut!(MESSAGE).cast::<u8>().add(self.0), n) };
            self.0 += n;
            Ok(())
        }
    }

    /// Forget the last call's note: a refusal a dependency handled (`try_reserve`) must not label a later panic.
    pub fn clear() {
        MESSAGE_LEN.store(0, Ordering::SeqCst);
        FAILED_ALLOC.store(0, Ordering::SeqCst);
    }

    pub fn install() {
        clear();
        // The message and the source file's name and line only: the full location would carry the build machine's
        // dependency paths into the host's error text.
        std::panic::set_hook(Box::new(|info| {
            let mut note = Note(0);
            let message = info.payload_as_str().unwrap_or("panic");
            let _ = match info.location() {
                Some(at) => {
                    let file = at.file().rsplit(['/', '\\']).next().unwrap_or("");
                    core::fmt::write(&mut note, format_args!("{message} ({file}:{})", at.line()))
                }
                None => core::fmt::write(&mut note, format_args!("{message}")),
            };
            MESSAGE_LEN.store(note.0, Ordering::SeqCst);
        }));
    }

    /// `(ptr << 32) | len` of the message, and the refused allocation size (0 for none).
    pub fn last() -> (u64, u64) {
        let ptr = core::ptr::addr_of!(MESSAGE) as usize as u64;
        ((ptr << 32) | MESSAGE_LEN.load(Ordering::SeqCst) as u64, FAILED_ALLOC.load(Ordering::SeqCst) as u64)
    }

    /// The system allocator, recording the size of a refused allocation before the abort it leads to.
    pub struct Recording;
    unsafe impl GlobalAlloc for Recording {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = System.alloc(layout);
            if ptr.is_null() { FAILED_ALLOC.store(layout.size(), Ordering::SeqCst); }
            ptr
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let ptr = System.alloc_zeroed(layout);
            if ptr.is_null() { FAILED_ALLOC.store(layout.size(), Ordering::SeqCst); }
            ptr
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            let out = System.realloc(ptr, layout, size);
            if out.is_null() { FAILED_ALLOC.store(size, Ordering::SeqCst); }
            out
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { System.dealloc(ptr, layout) }
    }
}

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: trap_note::Recording = trap_note::Recording;

/// Install the trap note (the panic hook). Call once after instantiating; calling again resets the note.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_init() { trap_note::install() }

/// Clear the trap note before a call, so it describes only that call.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_clear_trap() { trap_note::clear() }

/// The last trap's panic message as `(ptr << 32) | len` into a static buffer (not freed by the host; 0 length for none).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_last_panic() -> u64 { trap_note::last().0 }

/// The size of the allocation the allocator last refused (0 for none): the module ran out of its memory.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn ds_last_failed_alloc() -> u64 { trap_note::last().1 }
