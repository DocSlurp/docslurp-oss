//! Local file probes: page counts, page mix, media duration and the file's real type, read from bytes the caller
//! already has on its own machine. Nothing is uploaded, and probing never runs on DocSlurp infrastructure.
//!
//! Every probe is bounded (sampled pages, decompression, operation and byte budgets) and reports "unknown" rather
//! than failing, so a quote can always fall back to the server's size-based assumption. Hosts ask [`read_plan`]
//! how much of a file to read: PDFs and Office files whole (up to a limit), media only its head and tail.

mod media;
mod office;
mod pdf;

use serde::{Deserialize, Serialize};

use crate::card::{Card, PageMix};
use crate::quote::QuoteFile;

/// PDFs and Office files up to this size are read whole; larger ones are priced from size. Parsing needs about
/// twice the file in memory, which must stay well inside the module's memory limit.
pub const WHOLE_FILE_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Text files up to this size are read whole to count their pages; larger ones are priced from size.
pub const TEXT_WHOLE_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// Bytes read from the start of a file that is not read whole (headers, magic numbers).
pub const HEAD_BYTES: u64 = 4 * 1024 * 1024;
/// Bytes read from the end of a media file (MP4 `moov` boxes and Ogg final pages are often there).
pub const MEDIA_TAIL_BYTES: u64 = 8 * 1024 * 1024;
/// Bytes read to sniff a file whose format needs no more (images, text, unknown).
pub const SNIFF_BYTES: u64 = 64 * 1024;

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
    /// MIME type of the detected format, so pricing treats media and images as such without an extension.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
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
    /// Why something is unknown or approximate (encrypted, truncated input, budget reached, parse error).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub notes: Vec<String>,
}

impl ProbeResult {
    pub(crate) fn new(kind: ProbeKind, format: &str, mime_type: Option<&str>) -> Self {
        Self {
            kind,
            format: format.to_string(),
            mime_type: mime_type.map(str::to_string),
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
        if file.mime_type.is_none() {
            file.mime_type = self.mime_type.clone();
        }
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

/// What a probe needs of the file: `head` bytes from the start and `tail` bytes from the end (0 for none).
/// `head == size` means the whole file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadPlan {
    pub head: u64,
    pub tail: u64,
}

/// Name, declared type and size of a file, before any bytes are read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub name: String,
    #[serde(default, rename = "type")]
    pub mime_type: Option<String>,
    pub size: u64,
}

impl FileMeta {
    fn extension(&self) -> String {
        self.name.rfind('.').map(|dot| self.name[dot + 1..].to_ascii_lowercase()).unwrap_or_default()
    }

    fn mime(&self) -> String {
        self.mime_type.as_deref().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase()
    }
}

fn is_media(card: &Card, meta: &FileMeta) -> bool {
    crate::price::upload_media_kind(card, &meta.name, meta.mime_type.as_deref()).is_some()
}

/// How much of a file to read for [`probe`]. PDFs and Office files whole up to [`WHOLE_FILE_MAX_BYTES`], media head
/// and tail, everything else (including unknown types) a sniff of the head, which still detects PDFs and media by
/// magic number; a PDF found that way is reported as needing the whole file.
pub fn read_plan(card: &Card, meta: &FileMeta) -> ReadPlan {
    let size = meta.size;
    let extension = meta.extension();
    let mime = meta.mime();
    // TIFF frames are chained through offsets anywhere in the file, so counting them needs the whole file.
    let whole_formats = ["pdf", "docx", "pptx", "epub", "tif", "tiff"];
    let wants_whole = whole_formats.contains(&extension.as_str())
        || mime == "application/pdf"
        || mime == "image/tiff"
        || mime.starts_with("application/vnd.openxmlformats-officedocument.");
    if wants_whole {
        return if size <= WHOLE_FILE_MAX_BYTES { ReadPlan { head: size, tail: 0 } } else { ReadPlan { head: SNIFF_BYTES.min(size), tail: 0 } };
    }
    if crate::price::is_text_file(card, &meta.name, meta.mime_type.as_deref()) {
        return if size <= TEXT_WHOLE_MAX_BYTES { ReadPlan { head: size, tail: 0 } } else { ReadPlan { head: SNIFF_BYTES.min(size), tail: 0 } };
    }
    // A file with neither extension nor type may be media: read it as media, which also sniffs PDFs.
    if is_media(card, meta) || (extension.is_empty() && mime.is_empty()) {
        if size <= HEAD_BYTES + MEDIA_TAIL_BYTES {
            return ReadPlan { head: size, tail: 0 };
        }
        return ReadPlan { head: HEAD_BYTES, tail: MEDIA_TAIL_BYTES };
    }
    ReadPlan { head: SNIFF_BYTES.min(size), tail: 0 }
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

    /// Bytes at `[offset, offset + len)` of the file, when the head or the tail holds all of them.
    pub(crate) fn range(&self, offset: u64, len: u64) -> Option<&'a [u8]> {
        let end = offset.checked_add(len)?;
        if end > self.size {
            return None;
        }
        if end <= self.head.len() as u64 {
            return self.head.get(usize::try_from(offset).ok()?..usize::try_from(end).ok()?);
        }
        let tail = self.tail?;
        let tail_start = self.size.checked_sub(tail.len() as u64)?;
        if offset >= tail_start {
            return tail.get(usize::try_from(offset - tail_start).ok()?..usize::try_from(end - tail_start).ok()?);
        }
        None
    }

    /// The longest readable run of bytes starting at `offset`, at most `max` long.
    pub(crate) fn available(&self, offset: u64, max: u64) -> Option<&'a [u8]> {
        let head_len = self.head.len() as u64;
        if offset < head_len {
            let end = head_len.min(offset.checked_add(max)?);
            return self.head.get(usize::try_from(offset).ok()?..usize::try_from(end).ok()?);
        }
        let tail = self.tail?;
        let tail_start = self.size.checked_sub(tail.len() as u64)?;
        if offset >= tail_start && offset < self.size {
            let end = self.size.min(offset.checked_add(max)?);
            return tail.get(usize::try_from(offset - tail_start).ok()?..usize::try_from(end - tail_start).ok()?);
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

/// Probe one file. Unknown formats come back as [`ProbeKind::Unknown`]; hostile input hits a budget, not a hang.
pub fn probe(card: &Card, input: &ProbeInput<'_>) -> ProbeResult {
    let mut result = sniff(card, input);
    // Billing reads the type intake stores (the declared type, else the extension), never a sniffed one. Report the
    // sniffed type only for files whose name and declared type say nothing.
    if named_format(card, input) {
        result.mime_type = None;
    }
    result
}

/// Whether the declared type or the extension already names a format the quote rules know.
fn named_format(card: &Card, input: &ProbeInput<'_>) -> bool {
    let mime = input.mime();
    if !(mime.is_empty() || mime == "application/octet-stream") {
        return true;
    }
    let extension = input.extension();
    let documents = ["pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "odt", "rtf", "epub"];
    let lists = [&card.extensions.audio, &card.extensions.video, &card.extensions.image, &card.extensions.text];
    documents.contains(&extension.as_str()) || lists.iter().any(|list| list.iter().any(|known| *known == extension))
}

fn sniff(card: &Card, input: &ProbeInput<'_>) -> ProbeResult {
    let head = input.head;
    let extension = input.extension();
    // A text file is counted as text even when it quotes a PDF header or starts like a media file.
    if crate::price::is_text_file(card, input.name, input.mime_type) {
        return text(card, input, if extension.is_empty() { "text" } else { &extension });
    }

    if head.starts_with(b"%PDF-") || find(head, b"%PDF-", 1024).is_some() {
        return pdf::probe(card, input);
    }
    if let Some(result) = image(card, input) {
        return result;
    }
    if head.starts_with(b"PK\x03\x04") {
        return office::probe(input, &extension);
    }
    if let Some(result) = media::probe(input) {
        return result;
    }
    if extension == "pdf" {
        return pdf::probe(card, input);
    }
    ProbeResult::new(ProbeKind::Unknown, if extension.is_empty() { "unknown" } else { &extension }, None)
        .note("format not recognized; priced from its name, type and size")
}

/// Text files: pages counted from the whole text exactly as the API counts them. Their page mix needs no probe
/// (the quote rules treat text files as text pages).
fn text(card: &Card, input: &ProbeInput<'_>, format: &str) -> ProbeResult {
    let mut result = ProbeResult::new(ProbeKind::Text, format, None);
    if input.is_whole() && input.size <= TEXT_WHOLE_MAX_BYTES {
        // HTML is counted by its visible text, as the API counts it (the stored type is text/html).
        let markup = input.mime().starts_with("text/html")
            || (matches!(input.mime().as_str(), "" | "application/octet-stream") && matches!(input.extension().as_str(), "html" | "htm" | "mhtml"));
        result.pages = Some(crate::price::text_page_count(card, input.head, markup));
    } else {
        result.notes.push("text file larger than the probe limit; pages estimated from size".into());
    }
    result
}

/// Image files by magic number. Pricing counts an image file as one scanned page, except a TIFF, whose frames are its pages:
/// those are counted from the frame chain when the whole file was read.
fn image(card: &Card, input: &ProbeInput<'_>) -> Option<ProbeResult> {
    let head = input.head;
    let (format, mime) = if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("png", "image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        ("jpeg", "image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        ("gif", "image/gif")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        ("webp", "image/webp")
    } else if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        ("tiff", "image/tiff")
    } else if head.starts_with(b"BM") && head.len() >= 26 && u32_le(head, 14).is_some_and(|size| matches!(size, 12 | 40 | 56 | 108 | 124)) {
        ("bmp", "image/bmp")
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" && matches!(&head[8..12], b"heic" | b"heix" | b"mif1" | b"msf1") {
        ("heic", "image/heic")
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" && matches!(&head[8..12], b"avif" | b"avis") {
        ("avif", "image/avif")
    } else {
        return None;
    };
    let mut result = ProbeResult::new(ProbeKind::Image, format, Some(mime));
    if format != "tiff" {
        result.pages = Some(1.0);
        return Some(result);
    }
    if !input.is_whole() {
        return Some(result.note("TIFF not read whole; frames not counted, priced from size"));
    }
    let max = card.multi_frame_images.max_frames;
    match tiff_frames(head) {
        TiffFrames::Counted(frames) => {
            result.pages = Some(frames as f64);
            if frames as f64 > max {
                result.notes.push(format!("TIFF holds {frames} frames; a file with more than {max} is refused"));
            }
        }
        TiffFrames::AtLeast(frames) => {
            result.pages = Some(frames as f64);
            result.notes.push(format!("TIFF holds at least {frames} frames (count stopped); a file with more than {max} is refused"));
        }
        TiffFrames::Malformed(reason) => result.notes.push(format!("TIFF frame chain unreadable ({reason}); frames not counted, priced from size")),
    }
    Some(result)
}

/// Frames walked at most: far past the card's `multiFrameImages.maxFrames`, so a count that stops here still says the file is refused.
const TIFF_FRAME_WALK_LIMIT: u64 = 4_096;

enum TiffFrames {
    Counted(u64),
    AtLeast(u64),
    Malformed(&'static str),
}

/// The TIFF (or BigTIFF) top-level frame chain: each image file directory (IFD) is a frame, linked by next-IFD offsets. SubIFDs
/// (thumbnails, reduced resolutions) are not frames. Bounded by the walk limit and a visited set, so a looping chain cannot hang.
fn tiff_frames(bytes: &[u8]) -> TiffFrames {
    let little = match bytes.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return TiffFrames::Malformed("byte order"),
    };
    let u16_at = |at: usize| if little { u16_le(bytes, at) } else { u16_be(bytes, at) };
    let u32_at = |at: usize| if little { u32_le(bytes, at) } else { u32_be(bytes, at) };
    let u64_at = |at: usize| if little { u64_le(bytes, at) } else { u64_be(bytes, at) };
    let big = match u16_at(2) {
        Some(42) => false,
        Some(43) => true,
        _ => return TiffFrames::Malformed("magic"),
    };
    let first = if big {
        if u16_at(4) != Some(8) {
            return TiffFrames::Malformed("BigTIFF offset size");
        }
        u64_at(8)
    } else {
        u32_at(4).map(u64::from)
    };
    let Some(mut offset) = first else { return TiffFrames::Malformed("header") };
    let mut visited = std::collections::BTreeSet::new();
    let mut frames = 0u64;
    while offset != 0 {
        if frames >= TIFF_FRAME_WALK_LIMIT {
            return TiffFrames::AtLeast(frames);
        }
        if !visited.insert(offset) {
            return TiffFrames::Malformed("frame chain loops");
        }
        let Ok(at) = usize::try_from(offset) else { return TiffFrames::Malformed("offset") };
        let next = if big {
            u64_at(at).and_then(|count| usize::try_from(count).ok()).and_then(|count| count.checked_mul(20)).and_then(|entries| at.checked_add(8 + entries))
                .and_then(u64_at)
        } else {
            u16_at(at).and_then(|count| at.checked_add(2 + usize::from(count) * 12)).and_then(|next_at| u32_at(next_at).map(u64::from))
        };
        let Some(next) = next else { return TiffFrames::Malformed("directory past the end of the file") };
        frames += 1;
        offset = next;
    }
    if frames == 0 {
        return TiffFrames::Malformed("no frames");
    }
    TiffFrames::Counted(frames)
}

/// Position of `needle` within the first `limit` bytes of `haystack`.
pub(crate) fn find(haystack: &[u8], needle: &[u8], limit: usize) -> Option<usize> {
    let window = &haystack[..haystack.len().min(limit)];
    if needle.is_empty() || window.len() < needle.len() {
        return None;
    }
    window.windows(needle.len()).position(|candidate| candidate == needle)
}

pub(crate) fn u16_le(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at.checked_add(2)?)?.try_into().ok()?))
}
pub(crate) fn u16_be(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at.checked_add(2)?)?.try_into().ok()?))
}
pub(crate) fn u32_be(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at.checked_add(4)?)?.try_into().ok()?))
}
pub(crate) fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at.checked_add(4)?)?.try_into().ok()?))
}
pub(crate) fn u64_be(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(at..at.checked_add(8)?)?.try_into().ok()?))
}
pub(crate) fn u64_le(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.get(at..at.checked_add(8)?)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_file_quoting_a_pdf_header_is_counted_as_text() {
        let text = format!("Notes on the %PDF-1.7 header\n{}", "line\n".repeat(299));
        let result = probe(Card::bundled(), &ProbeInput::whole("notes.md", None, text.as_bytes()));
        assert_eq!(result.kind, ProbeKind::Text);
        assert_eq!(result.pages, Some(6.0)); // 301 lines
        assert_eq!(result.mime_type, None);
    }

    /// A little- or big-endian TIFF with `frames` empty IFDs chained in order (or looping back to the first).
    fn tiff(frames: usize, little: bool, looping: bool) -> Vec<u8> {
        let mut bytes = if little { b"II*\0".to_vec() } else { b"MM\0*".to_vec() };
        let u16b = |value: u16| if little { value.to_le_bytes() } else { value.to_be_bytes() };
        let u32b = |value: u32| if little { value.to_le_bytes() } else { value.to_be_bytes() };
        bytes.extend_from_slice(&u32b(8));
        for index in 0..frames {
            // One entry (12 bytes) per IFD, then the next offset.
            let at = bytes.len() as u32;
            bytes.extend_from_slice(&u16b(1));
            bytes.extend_from_slice(&[0u8; 12]);
            let next = if index + 1 < frames { at + 2 + 12 + 4 } else if looping { 8 } else { 0 };
            bytes.extend_from_slice(&u32b(next));
        }
        bytes
    }

    #[test]
    fn counts_tiff_frames_and_notes_a_file_over_the_cap() {
        let card = Card::bundled();
        for little in [true, false] {
            let three = probe(card, &ProbeInput::whole("fax.tiff", None, &tiff(3, little, false)));
            assert_eq!((three.kind, three.pages), (ProbeKind::Image, Some(3.0)));
            assert!(three.notes.is_empty());
        }
        let many = probe(card, &ProbeInput::whole("archive.tif", None, &tiff(70, true, false)));
        assert_eq!(many.pages, Some(70.0));
        assert!(many.notes.iter().any(|note| note.contains("more than 64")));
        // A looping chain, a truncated file and a head-only read leave the count unknown.
        assert_eq!(probe(card, &ProbeInput::whole("loop.tiff", None, &tiff(5, true, true))).pages, None);
        let truncated = tiff(5, true, false);
        assert_eq!(probe(card, &ProbeInput::whole("cut.tiff", None, &truncated[..truncated.len() - 6])).pages, None);
        let whole = tiff(5, true, false);
        let partial = ProbeInput { name: "fax.tiff", mime_type: None, size: whole.len() as u64 + 10, head: &whole, tail: None };
        assert_eq!(probe(card, &partial).pages, None);
        assert_eq!(read_plan(card, &FileMeta { name: "fax.TIFF".into(), mime_type: None, size: 1_000 }), ReadPlan { head: 1_000, tail: 0 });
    }

    #[test]
    fn sniffed_types_are_reported_only_for_unnamed_files() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert_eq!(probe(Card::bundled(), &ProbeInput::whole("scan", None, png)).mime_type.as_deref(), Some("image/png"));
        assert_eq!(probe(Card::bundled(), &ProbeInput::whole("scan.pdf", None, png)).mime_type, None);
    }
}
