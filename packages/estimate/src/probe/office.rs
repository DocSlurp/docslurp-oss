//! Office Open XML and EPUB: page or slide counts from `docProps/app.xml`, read through a bounded zip reader.
//!
//! Word and PowerPoint store the count from the last save (`<Pages>`, `<Slides>`). The worker counts pages after
//! converting the document, so for Word this is an approximation; slides map one to one.

use std::io::{Cursor, Read};

use super::{ProbeInput, ProbeKind, ProbeResult, WHOLE_FILE_MAX_BYTES};
use crate::card::PageMix;

/// Bytes of `docProps/app.xml` read; real ones are a few KB.
const MAX_APP_XML_BYTES: u64 = 256 * 1024;
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
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(input.head)) else {
        return unknown("zip").note("archive did not open");
    };
    if archive.len() > MAX_ENTRIES {
        return unknown("zip").note("archive has too many entries to probe");
    }
    let has = |archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str| archive.index_for_name(name).is_some();
    if mimetype_is(&mut archive, b"application/epub+zip") {
        let mut result = ProbeResult::new(ProbeKind::Ebook, "epub", Some("application/epub+zip"));
        result.mix = Some(PageMix::new(1.0, 0.0, 0.0));
        result.mix_confidence = Some(0.7);
        return result;
    }
    let (format, mime, count_tag) = if has(&mut archive, "word/document.xml") {
        ("docx", DOCX_MIME, Some("Pages"))
    } else if has(&mut archive, "ppt/presentation.xml") {
        ("pptx", PPTX_MIME, Some("Slides"))
    } else if has(&mut archive, "xl/workbook.xml") {
        ("xlsx", XLSX_MIME, None)
    } else {
        return unknown("zip").note("zip archive is not a recognized document");
    };
    let mut result = ProbeResult::new(ProbeKind::Office, format, Some(mime));
    let Some(tag) = count_tag else {
        return result.note("spreadsheets have no page count; priced from size");
    };
    match read_entry(&mut archive, "docProps/app.xml").and_then(|xml| element_number(&xml, tag)) {
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

fn mimetype_is(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, expected: &[u8]) -> bool {
    read_entry(archive, "mimetype").is_some_and(|value| value.trim_ascii() == expected)
}

/// One archive entry, at most [`MAX_APP_XML_BYTES`] of it.
fn read_entry(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<Vec<u8>> {
    let entry = archive.by_name(name).ok()?;
    let mut bytes = Vec::new();
    entry.take(MAX_APP_XML_BYTES).read_to_end(&mut bytes).ok()?;
    Some(bytes)
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
    use std::io::Write;

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
    }
}
