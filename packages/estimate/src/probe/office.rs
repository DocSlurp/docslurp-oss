//! Office Open XML and EPUB: page or slide counts from `docProps/app.xml`, read through a small bounded zip reader
//! (central directory plus stored or deflated entries; no Zip64, which documents never need).
//!
//! Word and PowerPoint store the count from the last save (`<Pages>`, `<Slides>`). The worker counts pages after
//! converting the document, so for Word this is an approximation; slides map one to one.

use super::{u16_le, u32_le, ProbeInput, ProbeKind, ProbeResult, WHOLE_FILE_MAX_BYTES};
use crate::card::PageMix;

/// Inflated bytes of one entry read; `docProps/app.xml` and `mimetype` are a few KB at most.
const MAX_ENTRY_BYTES: usize = 256 * 1024;
/// Central directory entries considered; a document has dozens to a few thousand.
const MAX_ENTRIES: usize = 50_000;

const DOCX_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

pub(super) fn probe(input: &ProbeInput<'_>, extension: &str) -> ProbeResult {
    let unknown = |format: &str| ProbeResult::new(ProbeKind::Unknown, format, None);
    if input.size > WHOLE_FILE_MAX_BYTES || !input.is_whole() {
        return unknown(if extension.is_empty() { "zip" } else { extension })
            .note("archive probes need the whole file; priced from size");
    }
    let Some(archive) = Archive::open(input.head) else {
        return unknown("zip").note("archive did not open");
    };
    if archive.read("mimetype").is_some_and(|value| value.trim_ascii() == b"application/epub+zip") {
        let mut result = ProbeResult::new(ProbeKind::Ebook, "epub", Some("application/epub+zip"));
        result.mix = Some(PageMix::new(1.0, 0.0, 0.0));
        result.mix_confidence = Some(0.7);
        return result;
    }
    let (format, mime, count_tag) = if archive.has("word/document.xml") {
        ("docx", DOCX_MIME, Some("Pages"))
    } else if archive.has("ppt/presentation.xml") {
        ("pptx", PPTX_MIME, Some("Slides"))
    } else if archive.has("xl/workbook.xml") {
        ("xlsx", XLSX_MIME, None)
    } else {
        return unknown("zip").note("zip archive is not a recognized document");
    };
    let mut result = ProbeResult::new(ProbeKind::Office, format, Some(mime));
    let Some(tag) = count_tag else {
        return result.note("spreadsheets have no page count; priced from size");
    };
    match archive.read("docProps/app.xml").and_then(|xml| element_number(&xml, tag)) {
        Some(count) if count > 0 => result.pages = Some(count as f64),
        _ => result.notes.push(format!("no <{tag}> count in docProps/app.xml; priced from size")),
    }
    if format == "docx" {
        // Word documents are text-layer pages; embedded scans are the exception.
        result.mix = Some(PageMix::new(1.0, 0.0, 0.0));
        result.mix_confidence = Some(0.6);
    }
    result
}

struct Entry<'a> {
    name: &'a [u8],
    method: u16,
    compressed: usize,
    local_header: usize,
}

/// A zip archive's central directory over the whole file's bytes.
struct Archive<'a> {
    bytes: &'a [u8],
    entries: Vec<Entry<'a>>,
}

impl<'a> Archive<'a> {
    fn open(bytes: &'a [u8]) -> Option<Self> {
        // End of central directory: within the last 64 KB comment window.
        let window_start = bytes.len().saturating_sub(22 + 65_535);
        let eocd = (window_start..bytes.len().checked_sub(21)?).rev().find(|at| bytes[*at..].starts_with(b"PK\x05\x06"))?;
        let count = usize::from(u16_le(bytes, eocd + 10)?);
        let mut at = usize::try_from(u32_le(bytes, eocd + 16)?).ok()?;
        if count > MAX_ENTRIES {
            return None;
        }
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            if !bytes.get(at..)?.starts_with(b"PK\x01\x02") {
                return None;
            }
            let name_len = usize::from(u16_le(bytes, at + 28)?);
            let extra_len = usize::from(u16_le(bytes, at + 30)?);
            let comment_len = usize::from(u16_le(bytes, at + 32)?);
            let name_start = at.checked_add(46)?;
            entries.push(Entry {
                name: bytes.get(name_start..name_start.checked_add(name_len)?)?,
                method: u16_le(bytes, at + 10)?,
                compressed: usize::try_from(u32_le(bytes, at + 20)?).ok()?,
                local_header: usize::try_from(u32_le(bytes, at + 42)?).ok()?,
            });
            at = name_start.checked_add(name_len)?.checked_add(extra_len)?.checked_add(comment_len)?;
        }
        Some(Self { bytes, entries })
    }

    fn has(&self, name: &str) -> bool {
        self.entries.iter().any(|entry| entry.name == name.as_bytes())
    }

    /// One entry's content, inflated, at most [`MAX_ENTRY_BYTES`].
    fn read(&self, name: &str) -> Option<Vec<u8>> {
        let entry = self.entries.iter().find(|entry| entry.name == name.as_bytes())?;
        let header = entry.local_header;
        if !self.bytes.get(header..)?.starts_with(b"PK\x03\x04") {
            return None;
        }
        let name_len = usize::from(u16_le(self.bytes, header + 26)?);
        let extra_len = usize::from(u16_le(self.bytes, header + 28)?);
        let start = header.checked_add(30)?.checked_add(name_len)?.checked_add(extra_len)?;
        let data = self.bytes.get(start..start.checked_add(entry.compressed)?)?;
        match entry.method {
            0 => Some(data[..data.len().min(MAX_ENTRY_BYTES)].to_vec()),
            8 => match miniz_oxide::inflate::decompress_to_vec_with_limit(data, MAX_ENTRY_BYTES) {
                Ok(bytes) => Some(bytes),
                Err(error) if !error.output.is_empty() => Some(error.output),
                Err(_) => None,
            },
            _ => None,
        }
    }
}

/// The integer inside `<tag>...</tag>` (namespace prefixes allowed), e.g. `<Pages>12</Pages>`.
fn element_number(xml: &[u8], tag: &str) -> Option<u64> {
    let text = std::str::from_utf8(xml).ok()?;
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let close = rest.find('>')?;
        let name = &rest[..close];
        let local = name.rsplit(':').next().unwrap_or(name);
        rest = &rest[close + 1..];
        if local == tag {
            let end = rest.find('<')?;
            return rest[..end].trim().parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn reads_word_pages_and_powerpoint_slides() {
        let docx = archive(&[("word/document.xml", "<w:document/>"), ("docProps/app.xml", "<Properties><Pages>12</Pages></Properties>")]);
        let result = probe(&ProbeInput::whole("a.docx", None, &docx), "docx");
        assert_eq!((result.format.as_str(), result.pages), ("docx", Some(12.0)));
        assert_eq!(result.mime_type.as_deref(), Some(DOCX_MIME));

        let pptx = archive(&[("ppt/presentation.xml", "<p/>"), ("docProps/app.xml", "<ep:Properties><ep:Slides> 31 </ep:Slides></ep:Properties>")]);
        assert_eq!(probe(&ProbeInput::whole("a.pptx", None, &pptx), "pptx").pages, Some(31.0));
    }

    #[test]
    fn leaves_unknown_counts_to_the_size_assumption() {
        let docx = archive(&[("word/document.xml", "<w:document/>")]);
        let result = probe(&ProbeInput::whole("a.docx", None, &docx), "docx");
        assert_eq!(result.pages, None);
        assert!(!result.notes.is_empty());
        assert_eq!(probe(&ProbeInput::whole("a.zip", None, b"PK\x03\x04garbage"), "zip").kind, ProbeKind::Unknown);
        // A central directory claiming entries beyond the file, or offsets past it, opens as nothing.
        let mut lying = docx.clone();
        let eocd = lying.len() - 22;
        lying[eocd + 16..eocd + 20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(probe(&ProbeInput::whole("a.docx", None, &lying), "docx").kind, ProbeKind::Unknown);
    }
}
