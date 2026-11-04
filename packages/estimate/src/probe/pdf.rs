//! PDF probe: page count, and a page mix measured on sampled pages.
//!
//! Each sampled page is classified the way the worker routes it (`authorizeRasterPageOcr` in
//! `worker/src/stages/classify-route.ts`, evidence from `worker/src/lib/page-image-evidence.ts`), with the thresholds
//! the card carries: a page with no or almost no native words whose content is a large placed image is `scanned`
//! (read by a vision model, billed Rich); a text page with sizeable images or heavy vector drawing is `complex`; the
//! rest, blank pages included, are `text`. Words come from text runs, image coverage from each image's placement
//! matrix over the page's CropBox, so nothing is rendered.

use std::collections::HashMap;
use std::rc::Rc;

use lopdf::content::Content;
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId};

use super::{ProbeInput, ProbeKind, ProbeResult, WHOLE_FILE_MAX_BYTES};
use crate::card::{Card, PageMix, PageRasterRouting};

/// Pages whose content is inspected; larger documents are sampled evenly.
const MAX_SAMPLED_PAGES: usize = 24;
/// Decompressed bytes of one content stream or form XObject.
const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
/// Content bytes interpreted per page, page content and every form invocation together.
const MAX_INTERPRETED_BYTES_PER_PAGE: usize = 32 * 1024 * 1024;
/// Content operations interpreted per page, forms included.
const MAX_OPERATIONS_PER_PAGE: usize = 200_000;
/// Form XObject invocations per page.
const MAX_FORM_CALLS_PER_PAGE: usize = 2_000;
/// Nested form XObjects followed.
const MAX_FORM_DEPTH: u32 = 3;
/// Decompression limit per stream while loading the document (object and xref streams).
const MAX_LOAD_STREAM_BYTES: usize = 16 * 1024 * 1024;
/// Estimator-only: what makes a text page `complex` (layout-aware extraction) rather than prose. Time, not credits.
const COMPLEX_MIN_IMAGE_COVERAGE: f64 = 0.15;
const COMPLEX_MIN_PATH_OPERATIONS: usize = 60;
const DEFAULT_PAGE_AREA: f64 = 612.0 * 792.0;

#[derive(Debug, Clone, Copy, PartialEq)]
enum PageClass {
    Text,
    Complex,
    Scanned,
}

pub(super) fn probe(card: &Card, input: &ProbeInput<'_>) -> ProbeResult {
    let result = ProbeResult::new(ProbeKind::Pdf, "pdf", Some("application/pdf"));
    if input.size > WHOLE_FILE_MAX_BYTES {
        return result.note("PDF larger than the probe limit; priced from size");
    }
    if !input.is_whole() {
        return result.note("PDF probes need the whole file; priced from size");
    }
    let options = LoadOptions { max_decompressed_size: Some(MAX_LOAD_STREAM_BYTES), ..LoadOptions::default() };
    match Document::load_mem_with_options(input.head, options) {
        Ok(document) => probe_document(&card.page_raster_routing, &document, result),
        Err(error) => fallback_page_count(input.head, result).note(format!("PDF did not parse ({error})")),
    }
}

fn probe_document(routing: &PageRasterRouting, document: &Document, mut result: ProbeResult) -> ProbeResult {
    let pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    if pages.is_empty() {
        return result.note("PDF has no pages");
    }
    result.pages = Some(pages.len() as f64);
    if document.is_encrypted() {
        return result.note("encrypted PDF; page mix not measured");
    }
    let mut forms = FormCache::default();
    let mut counts = [0usize; 3];
    let mut budget_hit = false;
    for index in sample_indices(pages.len(), MAX_SAMPLED_PAGES) {
        let Some((class, exhausted)) = classify_page(routing, document, pages[index], &mut forms) else { continue };
        budget_hit |= exhausted;
        counts[class as usize] += 1;
    }
    let measured = counts.iter().sum::<usize>();
    if measured == 0 {
        return result.note("no page content could be read; page mix not measured");
    }
    let total = measured as f64;
    result.mix = Some(PageMix::new(counts[0] as f64 / total, counts[1] as f64 / total, counts[2] as f64 / total));
    // Classification approximates the worker's routing, which also sends some sparse form and table pages to vision
    // and bills dense scans as several Rich pages; a full read is therefore not certain, and sampling part of a long
    // document lowers trust further.
    let coverage = measured as f64 / pages.len() as f64;
    let mut confidence = 0.6 + 0.25 * coverage.sqrt();
    if budget_hit {
        confidence -= 0.2;
        result.notes.push("a page hit the probe's content budget; its class is approximate".into());
    }
    result.mix_confidence = Some((confidence * 1000.0).round() / 1000.0);
    result.sampled_pages = Some(measured as u32);
    result
}

/// `count` indices spread evenly over `0..total`, first and last included.
fn sample_indices(total: usize, count: usize) -> Vec<usize> {
    if total <= count {
        return (0..total).collect();
    }
    let mut indices: Vec<usize> = (0..count).map(|i| i * (total - 1) / (count - 1)).collect();
    indices.dedup();
    indices
}

/// When the document does not parse, count `/Type /Page` objects in the raw bytes (misses compressed object streams).
fn fallback_page_count(bytes: &[u8], mut result: ProbeResult) -> ProbeResult {
    let mut count = 0usize;
    let mut at = 0usize;
    while let Some(found) = bytes[at..].windows(5).position(|window| window == b"/Type") {
        let mut cursor = at + found + 5;
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\r' | b'\n' | b'\t') {
            cursor += 1;
        }
        if bytes[cursor..].starts_with(b"/Page") && !bytes[cursor..].starts_with(b"/Pages") {
            count += 1;
        }
        at = cursor.max(at + found + 1);
    }
    if count > 0 {
        result.pages = Some(count as f64);
        result.notes.push("page count read from raw page objects".into());
    }
    result
}

/// Decompressed form XObject content, once per object for the whole document.
#[derive(Default)]
struct FormCache {
    content: HashMap<ObjectId, Option<Rc<Vec<u8>>>>,
}

impl FormCache {
    fn get(&mut self, id: ObjectId, stream: &lopdf::Stream) -> Option<Rc<Vec<u8>>> {
        self.content
            .entry(id)
            .or_insert_with(|| stream.decompressed_content_with_limit(MAX_STREAM_BYTES).ok().map(Rc::new))
            .clone()
    }
}

/// Words in shown text, counted the way extracted text splits: runs of non-space glyphs, broken by spaces and by
/// text moves that leave a gap. Two-byte (CID) strings rarely contain a space code, so they count glyphs per word.
#[derive(Default)]
struct WordCounter {
    words: f64,
    in_word: bool,
    /// Glyphs shown since the last text move, to tell a next-character move from a word gap.
    run_glyphs: f64,
}

impl WordCounter {
    fn show(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let zero_high_bytes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
        if bytes.len() >= 4 && zero_high_bytes * 2 >= bytes.len() / 2 {
            let glyphs = bytes.len() as f64 / 2.0;
            self.words += (glyphs / 6.0).ceil();
            self.in_word = false;
            self.run_glyphs += glyphs;
            return;
        }
        for byte in bytes {
            if byte.is_ascii_whitespace() {
                self.in_word = false;
            } else if !self.in_word {
                self.in_word = true;
                self.words += 1.0;
            }
        }
        self.run_glyphs += bytes.len() as f64;
    }

    fn gap(&mut self) {
        self.in_word = false;
        self.run_glyphs = 0.0;
    }

    /// A relative text move (`Td`/`TD`) in unscaled text space with the current font size: same line and no further
    /// than the glyphs just shown (about half an em each, plus a little) continues the word.
    fn moved(&mut self, tx: f64, ty: f64, font_size: f64) {
        let advance = (self.run_glyphs * 0.6 + 0.3) * font_size.abs().max(1.0);
        if ty.abs() > 0.01 || tx < 0.0 || tx > advance {
            self.in_word = false;
        }
        self.run_glyphs = 0.0;
    }
}

#[derive(Default)]
struct PageStats {
    words: WordCounter,
    path_operations: usize,
    operations: usize,
    interpreted_bytes: usize,
    form_calls: usize,
    exhausted: bool,
    image_count: usize,
    image_coverage: f64,
    largest_image_coverage: f64,
}

impl PageStats {
    fn charge_bytes(&mut self, bytes: usize) -> bool {
        self.interpreted_bytes = self.interpreted_bytes.saturating_add(bytes);
        if self.interpreted_bytes > MAX_INTERPRETED_BYTES_PER_PAGE {
            self.exhausted = true;
        }
        !self.exhausted
    }
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a × b` for PDF matrices `[a b c d e f]` (row vectors: a point transforms by `a`, then `b`).
fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn number(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(value) => Some(*value as f64),
        Object::Real(value) => Some(f64::from(*value)),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn matrix_from(operands: &[Object]) -> Option<Matrix> {
    if operands.len() != 6 {
        return None;
    }
    let mut matrix = [0.0; 6];
    for (slot, operand) in matrix.iter_mut().zip(operands) {
        *slot = number(operand)?;
    }
    Some(matrix)
}

fn deref<'a>(document: &'a Document, object: &'a Object) -> Option<(Option<ObjectId>, &'a Object)> {
    document.dereference(object).ok()
}

fn dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match deref(document, object)?.1 {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

/// A page box (`MediaBox`, `CropBox`) inherited through the page tree, as `[x0, y0, x1, y1]` normalized.
fn page_box(document: &Document, page_id: ObjectId, key: &[u8]) -> Option<[f64; 4]> {
    let mut node = document.get_dictionary(page_id).ok();
    for _ in 0..32 {
        let current = node?;
        if let Some((_, Object::Array(values))) = current.get(key).ok().and_then(|object| deref(document, object)) {
            let numbers: Vec<f64> =
                values.iter().filter_map(|value| deref(document, value).and_then(|(_, value)| number(value))).collect();
            if numbers.len() == 4 {
                return Some([
                    numbers[0].min(numbers[2]),
                    numbers[1].min(numbers[3]),
                    numbers[0].max(numbers[2]),
                    numbers[1].max(numbers[3]),
                ]);
            }
        }
        node = current.get(b"Parent").ok().and_then(|parent| dictionary(document, parent));
    }
    None
}

/// Visible page area: the CropBox clipped to the MediaBox, as the worker measures coverage.
fn page_area(document: &Document, page_id: ObjectId) -> f64 {
    let media = page_box(document, page_id, b"MediaBox");
    let crop = page_box(document, page_id, b"CropBox");
    let visible = match (media, crop) {
        (Some(m), Some(c)) => Some([m[0].max(c[0]), m[1].max(c[1]), m[2].min(c[2]), m[3].min(c[3])]),
        (Some(b), None) | (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    visible
        .map(|b| (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0))
        .filter(|area| area.is_finite() && *area > 1.0)
        .unwrap_or(DEFAULT_PAGE_AREA)
}

/// Resource dictionaries in lookup order (nearest first).
fn page_resources(document: &Document, page_id: ObjectId) -> Vec<&Dictionary> {
    let Ok((direct, ids)) = document.get_page_resources(page_id) else { return Vec::new() };
    let mut resources: Vec<&Dictionary> = direct.into_iter().collect();
    resources.extend(ids.into_iter().filter_map(|id| document.get_dictionary(id).ok()));
    resources
}

fn lookup_xobject<'a>(document: &'a Document, resources: &[&'a Dictionary], name: &[u8]) -> Option<(Option<ObjectId>, &'a Object)> {
    resources.iter().find_map(|resource| {
        let xobjects = resource.get(b"XObject").ok().and_then(|object| dictionary(document, object))?;
        xobjects.get(name).ok().and_then(|object| deref(document, object))
    })
}

fn classify_page(
    routing: &PageRasterRouting,
    document: &Document,
    page_id: ObjectId,
    forms: &mut FormCache,
) -> Option<(PageClass, bool)> {
    let content = document.get_page_content_with_limit(page_id, MAX_STREAM_BYTES).ok()?;
    let resources = page_resources(document, page_id);
    let area = page_area(document, page_id);
    let mut stats = PageStats::default();
    let mut context = Context { document, routing, forms, area };
    context.interpret(&content, &resources, IDENTITY, 0, &mut stats);
    Some((classify(routing, &stats), stats.exhausted))
}

fn classify(routing: &PageRasterRouting, stats: &PageStats) -> PageClass {
    let words = stats.words.words;
    // A page with neither words nor images is blank to the worker (it bills Fast), even if it draws vectors.
    if words == 0.0 && stats.image_count == 0 {
        return PageClass::Text;
    }
    let raster = (words == 0.0
        && (stats.largest_image_coverage >= routing.raster_page_min_largest_image_coverage
            || stats.image_coverage >= routing.raster_page_min_total_image_coverage))
        || (words <= routing.stamp_text_max_words && stats.largest_image_coverage >= routing.stamped_scan_min_image_coverage)
        || (words < routing.sparse_page_words && stats.largest_image_coverage >= routing.sparse_text_full_page_image_coverage);
    if raster {
        return PageClass::Scanned;
    }
    if stats.image_coverage >= COMPLEX_MIN_IMAGE_COVERAGE || stats.path_operations >= COMPLEX_MIN_PATH_OPERATIONS {
        return PageClass::Complex;
    }
    PageClass::Text
}

struct Context<'a, 'f> {
    document: &'a Document,
    routing: &'a PageRasterRouting,
    forms: &'f mut FormCache,
    area: f64,
}

impl<'a> Context<'a, '_> {
    fn record_image(&self, stats: &mut PageStats, ctm: &Matrix, width: f64, height: f64) {
        let placed = (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs();
        let coverage = (placed / self.area).min(1.0);
        if !coverage.is_finite()
            || coverage < self.routing.min_significant_image_coverage
            || width.min(height) < self.routing.min_significant_image_pixels
        {
            return;
        }
        stats.image_count += 1;
        stats.image_coverage = (stats.image_coverage + coverage).min(1.0);
        stats.largest_image_coverage = stats.largest_image_coverage.max(coverage);
    }

    fn image_size(&self, dict: &Dictionary, width_key: &[u8], height_key: &[u8]) -> (f64, f64) {
        let read = |key: &[u8]| {
            dict.get(key).ok().and_then(|object| deref(self.document, object)).and_then(|(_, value)| number(value)).unwrap_or(0.0)
        };
        (read(width_key), read(height_key))
    }

    fn interpret(&mut self, content: &[u8], resources: &[&'a Dictionary], base: Matrix, depth: u32, stats: &mut PageStats) {
        if !stats.charge_bytes(content.len()) {
            return;
        }
        let mut ctm = base;
        let mut stack: Vec<Matrix> = Vec::new();
        let mut font_size = 12.0;
        for operation in Content::decode_iter(content) {
            let Ok(operation) = operation else { break };
            stats.operations += 1;
            if stats.operations > MAX_OPERATIONS_PER_PAGE {
                stats.exhausted = true;
                return;
            }
            let operands = &operation.operands;
            match operation.operator.as_str() {
                "q" if stack.len() < 256 => stack.push(ctm),
                "Q" => ctm = stack.pop().unwrap_or(base),
                "cm" => {
                    if let Some(matrix) = matrix_from(operands) {
                        ctm = multiply(&matrix, &ctm);
                    }
                }
                "BT" | "ET" | "T*" | "Tm" => stats.words.gap(),
                "Tf" => font_size = operands.get(1).and_then(number).unwrap_or(font_size),
                "Td" | "TD" => {
                    let tx = operands.first().and_then(number).unwrap_or(0.0);
                    let ty = operands.get(1).and_then(number).unwrap_or(0.0);
                    stats.words.moved(tx, ty, font_size);
                }
                "Tj" => {
                    if let Some(Object::String(bytes, _)) = operands.last() {
                        stats.words.show(bytes);
                    }
                }
                "'" | "\"" => {
                    stats.words.gap();
                    if let Some(Object::String(bytes, _)) = operands.last() {
                        stats.words.show(bytes);
                    }
                }
                "TJ" => {
                    if let Some(Object::Array(parts)) = operands.first() {
                        for part in parts {
                            match part {
                                Object::String(bytes, _) => stats.words.show(bytes),
                                // A large negative adjustment is a word gap in kerned text.
                                other if number(other).is_some_and(|gap| gap <= -200.0) => stats.words.gap(),
                                _ => {}
                            }
                        }
                    }
                }
                "re" | "m" | "l" | "c" | "v" | "y" => stats.path_operations += 1,
                "BI" => {
                    if let Some(Object::Stream(image)) = operands.first() {
                        let (mut width, mut height) = self.image_size(&image.dict, b"W", b"H");
                        if width == 0.0 {
                            (width, height) = self.image_size(&image.dict, b"Width", b"Height");
                        }
                        self.record_image(stats, &ctm, width, height);
                    }
                }
                "Do" => {
                    let Some(Object::Name(name)) = operands.first() else { continue };
                    let Some((id, Object::Stream(xobject))) = lookup_xobject(self.document, resources, name) else { continue };
                    let subtype = xobject.dict.get(b"Subtype").ok().and_then(|object| deref(self.document, object)).map(|(_, value)| value);
                    match subtype {
                        Some(Object::Name(kind)) if kind == b"Image" => {
                            let (width, height) = self.image_size(&xobject.dict, b"Width", b"Height");
                            self.record_image(stats, &ctm, width, height);
                        }
                        Some(Object::Name(kind)) if kind == b"Form" && depth < MAX_FORM_DEPTH => {
                            stats.form_calls += 1;
                            if stats.form_calls > MAX_FORM_CALLS_PER_PAGE {
                                stats.exhausted = true;
                                return;
                            }
                            // A direct (unreferenced) form stream cannot be cached; it is decompressed per call,
                            // still bounded by the per-page byte budget.
                            let form_content = match id {
                                Some(id) => self.forms.get(id, xobject),
                                None => xobject.decompressed_content_with_limit(MAX_STREAM_BYTES).ok().map(Rc::new),
                            };
                            let Some(form_content) = form_content else { continue };
                            let matrix = xobject
                                .dict
                                .get(b"Matrix")
                                .ok()
                                .and_then(|object| match deref(self.document, object) {
                                    Some((_, Object::Array(values))) => matrix_from(values),
                                    _ => None,
                                })
                                .unwrap_or(IDENTITY);
                            let own = xobject.dict.get(b"Resources").ok().and_then(|object| dictionary(self.document, object));
                            let mut form_resources: Vec<&Dictionary> = own.into_iter().collect();
                            form_resources.extend_from_slice(resources);
                            self.interpret(&form_content, &form_resources, multiply(&matrix, &ctm), depth + 1, stats);
                            if stats.exhausted {
                                return;
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routing() -> PageRasterRouting {
        Card::bundled().page_raster_routing.clone()
    }

    #[test]
    fn samples_evenly_with_both_ends() {
        assert_eq!(sample_indices(5, 24), vec![0, 1, 2, 3, 4]);
        let sample = sample_indices(1000, 24);
        assert_eq!(sample.len(), 24);
        assert_eq!((sample[0], sample[23]), (0, 999));
    }

    #[test]
    fn classifies_like_the_worker_router() {
        let page = |words: f64, largest: f64, total: f64, images: usize| {
            let mut stats = PageStats { largest_image_coverage: largest, image_coverage: total, image_count: images, ..PageStats::default() };
            stats.words.words = words;
            stats
        };
        let routing = routing();
        assert_eq!(classify(&routing, &page(0.0, 0.9, 0.9, 1)), PageClass::Scanned);
        assert_eq!(classify(&routing, &page(8.0, 0.6, 0.6, 1)), PageClass::Scanned);
        assert_eq!(classify(&routing, &page(25.0, 0.9, 0.9, 1)), PageClass::Scanned);
        assert_eq!(classify(&routing, &page(400.0, 0.9, 0.9, 1)), PageClass::Complex);
        assert_eq!(classify(&routing, &page(400.0, 0.0, 0.0, 0)), PageClass::Text);
        // Blank or vector-only pages bill Fast in the worker.
        let mut drawn = page(0.0, 0.0, 0.0, 0);
        drawn.path_operations = 5_000;
        assert_eq!(classify(&routing, &drawn), PageClass::Text);
    }

    #[test]
    fn counts_words_from_text_runs() {
        let mut counter = WordCounter::default();
        counter.show(b"hello brave new world");
        assert_eq!(counter.words, 4.0);

        // A title drawn one character at a time with next-character moves is one word, not one per glyph.
        let mut title = WordCounter::default();
        for glyph in b"Contract" {
            title.show(&[*glyph]);
            title.moved(7.0, 0.0, 12.0);
        }
        assert_eq!(title.words, 1.0);

        // A move to the next line starts a new word.
        let mut lines = WordCounter::default();
        lines.show(b"first");
        lines.moved(0.0, -14.0, 12.0);
        lines.show(b"second");
        assert_eq!(lines.words, 2.0);

        let mut cid = WordCounter::default();
        cid.show(&[0, 41, 0, 42, 0, 43, 0, 44, 0, 45, 0, 46, 0, 47]);
        assert_eq!(cid.words, 2.0);
    }
}
