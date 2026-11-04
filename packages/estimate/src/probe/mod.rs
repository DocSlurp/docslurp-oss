//! Local file probes: page counts, page mix and media duration, read from the bytes the caller already has.
//!
//! Inputs are the user's own files, read on their machine; nothing is uploaded. Every probe is bounded (sampled
//! pages, decompression and operation limits) and falls back to "unknown" rather than failing, so the quote can
//! always use the size-based assumption the server uses.
//!
//! Large media does not need to be read whole: pass the first and last bytes (`head`, `tail`) and the file `size`.
//! PDFs and Office files need the whole file (`head.len() == size`); with less they report no pages.

mod image;
mod media;
mod office;
mod pdf;

use serde::{Deserialize, Serialize};

use crate::card::PageMix;
use crate::quote::QuoteFile;

/// Bytes a caller should read for a probe: the whole file up to this size, else head and tail slices.
pub const WHOLE_FILE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Head slice for media larger than the whole-file limit (and for media in general: headers live here).
pub const MEDIA_HEAD_BYTES: u64 = 4 * 1024 * 1024;
/// Tail slice for media (MP4 `moov` boxes and Ogg final pages are often at the end).
pub const MEDIA_TAIL_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeKind {
    Pdf,
    Image,
    Office,
    Ebook,
    Text,
    Audio,
    Video,
    Unknown,
}

/// What a probe found. Fields it could not determine are absent; [`ProbeResult::apply`] merges it into a quote file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub kind: ProbeKind,
    /// Detected container or format (`pdf`, `mp4`, `docx`, `png`, ...).
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mix: Option<PageMix>,
    /// 0-1 trust in `mix`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mix_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    /// Pages whose content was inspected to measure `mix`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled_pages: Option<u32>,
    /// Why something is unknown or approximate (encrypted, truncated input, parse error).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub notes: Vec<String>,
}

impl ProbeResult {
    pub(crate) fn new(kind: ProbeKind, format: &str) -> Self {
        Self {
            kind,
            format: format.to_string(),
            pages: None,
            mix: None,
            mix_confidence: None,
            duration_seconds: None,
            sampled_pages: None,
            notes: Vec::new(),
        }
    }

    pub(crate) fn note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }

    /// Copy the measured fields into `file`, keeping any the caller already set.
    pub fn apply(&self, file: &mut QuoteFile) {
        if file.pages.is_none() {
            file.pages = self.pages;
        }
        if file.duration_seconds.is_none() {
            file.duration_seconds = self.duration_seconds;
        }
        if file.mix.is_none() && self.mix.is_some() {
            file.mix = self.mix;
            file.mix_confidence = self.mix_confidence;
        }
    }
}

/// A file to probe: the whole file, or its first bytes plus optionally its last bytes.
#[derive(Debug, Clone, Copy)]
pub struct ProbeInput<'a> {
    pub name: &'a str,
    pub mime_type: Option<&'a str>,
    /// Total file size in bytes.
    pub size: u64,
    /// The file's first bytes (all of it when `head.len() == size`).
    pub head: &'a [u8],
    /// The file's last bytes, when `head` is not the whole file.
    pub tail: Option<&'a [u8]>,
}

impl<'a> ProbeInput<'a> {
    /// A probe over a whole file.
    pub fn whole(name: &'a str, mime_type: Option<&'a str>, bytes: &'a [u8]) -> Self {
        Self { name, mime_type, size: bytes.len() as u64, head: bytes, tail: None }
    }

    pub(crate) fn is_whole(&self) -> bool {
        self.head.len() as u64 >= self.size
    }

    /// Bytes at `[offset, offset + len)` of the file, when the head or the tail holds them.
    pub(crate) fn range(&self, offset: u64, len: u64) -> Option<&'a [u8]> {
        let end = offset.checked_add(len)?;
        if end > self.size {
            return None;
        }
        if end <= self.head.len() as u64 {
            return self.head.get(offset as usize..end as usize);
        }
        let tail = self.tail?;
        let tail_start = self.size.checked_sub(tail.len() as u64)?;
        if offset >= tail_start {
            return tail.get((offset - tail_start) as usize..(end - tail_start) as usize);
        }
        None
    }

    fn extension(&self) -> String {
        self.name.rfind('.').map(|dot| self.name[dot + 1..].to_ascii_lowercase()).unwrap_or_default()
    }

    fn mime(&self) -> String {
        self.mime_type.unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase()
    }
}

/// Probe one file. Never panics on hostile input; unknown formats come back as [`ProbeKind::Unknown`].
pub fn probe(input: &ProbeInput<'_>) -> ProbeResult {
    let head = input.head;
    let extension = input.extension();
    let mime = input.mime();

    if head.starts_with(b"%PDF-") || (head.len() < 5 && extension == "pdf") || find(head, b"%PDF-", 1024).is_some() {
        return pdf::probe(input);
    }
    if let Some(result) = image::probe(input) {
        return result;
    }
    if head.starts_with(b"PK\x03\x04") {
        return office::probe(input, &extension);
    }
    if let Some(result) = media::probe(input) {
        return result;
    }
    match extension.as_str() {
        "pdf" => pdf::probe(input),
        "docx" | "pptx" | "xlsx" | "odt" | "odp" | "ods" | "epub" => office::probe(input, &extension),
        "txt" | "md" | "markdown" | "rst" | "csv" | "tsv" | "json" | "jsonl" | "xml" | "html" | "htm" | "rtf" => text(input, &extension),
        _ if mime.starts_with("text/") => text(input, &extension),
        _ => {
            let mut result = ProbeResult::new(ProbeKind::Unknown, if extension.is_empty() { "unknown" } else { &extension });
            if mime.starts_with("audio/") {
                result.kind = ProbeKind::Audio;
            } else if mime.starts_with("video/") {
                result.kind = ProbeKind::Video;
            }
            result.note("format not recognized; priced from size")
        }
    }
}

/// Text formats have a text layer by definition. Their page count is left to the server's size assumption.
fn text(_input: &ProbeInput<'_>, extension: &str) -> ProbeResult {
    let mut result = ProbeResult::new(ProbeKind::Text, if extension.is_empty() { "text" } else { extension });
    result.mix = Some(PageMix::new(1.0, 0.0, 0.0));
    // HTML and rich text can embed images that the pipeline reads; plain text cannot.
    result.mix_confidence = Some(if matches!(extension, "html" | "htm" | "rtf") { 0.7 } else { 0.9 });
    result
}

/// Position of `needle` within the first `limit` bytes of `haystack`.
pub(crate) fn find(haystack: &[u8], needle: &[u8], limit: usize) -> Option<usize> {
    let window = &haystack[..haystack.len().min(limit)];
    if needle.is_empty() || window.len() < needle.len() {
        return None;
    }
    window.windows(needle.len()).position(|candidate| candidate == needle)
}

pub(crate) fn u16_be(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}
pub(crate) fn u16_le(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}
pub(crate) fn u32_be(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}
pub(crate) fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}
pub(crate) fn u64_be(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}
pub(crate) fn u64_le(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}
