//! PDF profile: page count, and facts measured on sampled pages.
//!
//! Each sampled page is measured the way the worker reads its evidence (`decidePageRaster` in
//! `packages/shared/src/page-raster-routing.ts`, evidence from `worker/src/lib/page-image-evidence.ts`), with the
//! thresholds the profiler rules carry: native words, significant image placements and their coverage, vector drawing,
//! fonts without a Unicode mapping, and whether the page raster rule finds the page held by a full-page image. Words come
//! from text runs, image coverage from each image's placement matrix over the page's CropBox, so nothing is rendered. An image object drawn on at least
//! `repeatedImageMinPages` sampled pages and `repeatedImageMinShare` of them is page furniture (a logo, a letterhead,
//! a slide background) and counts for nothing, as in the worker; an image no bigger than `minSignificantImagePixels`
//! or `minSignificantImageCoverage` counts for nothing either, so a blank page with a 1x1 image is blank.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use lopdf::content::Content;
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId};

use super::{PdfProfile, ProbeInput, ProbeKind, ProbeResult, COVERAGE_BUCKETS, WHOLE_FILE_MAX_BYTES, WORDS_BUCKETS};
use crate::rules::{PageRasterRouting, Rules};

/// Decompressed bytes of one content stream or form XObject.
const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
/// Content bytes interpreted per page, page content and every form invocation together.
const MAX_INTERPRETED_BYTES_PER_PAGE: usize = 16 * 1024 * 1024;
/// Content operations interpreted per page, forms included.
const MAX_OPERATIONS_PER_PAGE: usize = 200_000;
/// Form XObject invocations per page.
const MAX_FORM_CALLS_PER_PAGE: usize = 2_000;
/// Nested form XObjects followed.
const MAX_FORM_DEPTH: u32 = 3;
/// Decompression limit per stream while loading the document (object and xref streams).
const MAX_LOAD_STREAM_BYTES: usize = 16 * 1024 * 1024;
/// Decompressed bytes of all object streams together (`budget_object_streams`): lopdf decodes and keeps every object
/// stream at load time with only a per-stream limit.
const MAX_OBJECT_STREAM_BYTES: usize = 64 * 1024 * 1024;
/// Decompressed page content and form bytes per document, cached forms included.
const MAX_DOCUMENT_CONTENT_BYTES: usize = 32 * 1024 * 1024;
/// A page with this much image coverage or this many path operations is layout-heavy (figures, charts, tables).
const LAYOUT_MIN_IMAGE_COVERAGE: f64 = 0.15;
const LAYOUT_MIN_PATH_OPERATIONS: usize = 60;
const DEFAULT_PAGE_AREA: f64 = 612.0 * 792.0;

pub(super) fn probe(rules: &Rules, input: &ProbeInput<'_>) -> ProbeResult {
    let result = ProbeResult::new(ProbeKind::Pdf, "pdf", Some("application/pdf"));
    if input.size > WHOLE_FILE_MAX_BYTES {
        return result.note("PDF larger than the probe limit; pages not counted");
    }
    if !input.is_whole() {
        return result.note("PDF profiles need the whole file; pages not counted");
    }
    // lopdf's encrypted-document path decodes object streams without the budget hook below, and the probe does not
    // measure encrypted content anyway: count pages from the raw objects instead of loading.
    if has_name(input.head, b"Encrypt") {
        let mut result = fallback_page_count(input.head, result).note("encrypted PDF; page facts not measured");
        result.encrypted = Some(true);
        return result;
    }
    OBJECT_STREAM_BUDGET.with(|budget| budget.set(MAX_OBJECT_STREAM_BYTES));
    OBJECT_STREAM_BUDGET_EXCEEDED.with(|exceeded| exceeded.set(false));
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_LOAD_STREAM_BYTES),
        filter: Some(budget_object_streams),
        ..LoadOptions::default()
    };
    let loaded = Document::load_mem_with_options(input.head, options);
    if OBJECT_STREAM_BUDGET_EXCEEDED.with(Cell::get) {
        return fallback_page_count(input.head, result)
            .note("compressed object streams exceed the profiler's budget; page facts not measured");
    }
    match loaded {
        Ok(document) => probe_document(rules, &document, input.head.len(), result),
        Err(error) => fallback_page_count(input.head, result).note(format!("PDF did not parse ({error})")),
    }
}

fn probe_document(rules: &Rules, document: &Document, file_bytes: usize, mut result: ProbeResult) -> ProbeResult {
    let routing = &rules.page_raster_routing;
    let pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    if pages.is_empty() {
        return result.note("PDF has no pages");
    }
    result.pages = Some(pages.len() as f64);
    if document.is_encrypted() {
        result.encrypted = Some(true);
        return result.note("encrypted PDF; page facts not measured");
    }
    let mut forms = FormCache::default();
    let mut readings: Vec<PageReading> = Vec::new();
    for index in sample_indices(pages.len(), rules.max_sampled_pages) {
        if forms.document_budget_spent() {
            break;
        }
        if let Some(reading) = classify_page(routing, document, pages[index], &mut forms) {
            readings.push(reading);
        }
    }
    if readings.is_empty() {
        return result.note("no page content could be read; page facts not measured");
    }
    let budget_hit = readings.iter().any(|reading| reading.exhausted) || forms.document_budget_spent();
    let repeated = repeated_images(routing, &readings);
    let drawn = readings.iter().all(|reading| reading.blank(&repeated)) && drawn_document(routing, document, file_bytes, pages.len());
    let mut profile = PdfProfile { sampled_pages: readings.len() as u32, drawn_content: drawn, budget_exhausted: budget_hit, ..PdfProfile::default() };
    profile.furniture_images = repeated.len() as u32;
    for reading in &readings {
        let totals = reading.totals(&repeated);
        let raster = is_raster_page(routing, reading.words, &totals);
        profile.words_per_page[bucket(&rules.words_per_page_buckets, reading.words, WORDS_BUCKETS)] += 1;
        profile.image_coverage[coverage_bucket(&rules.image_coverage_buckets, totals.coverage)] += 1;
        if reading.words > 0.0 {
            profile.text_layer_pages += 1;
        }
        if reading.words < routing.sparse_page_words {
            profile.low_text_pages += 1;
        }
        if reading.blank(&repeated) {
            profile.blank_pages += 1;
        }
        if raster {
            profile.raster_pages += 1;
        }
        if totals.count > 0 {
            profile.image_pages += 1;
        }
        profile.images += totals.count as u32;
        let vector_heavy = reading.path_operations >= LAYOUT_MIN_PATH_OPERATIONS;
        if vector_heavy {
            profile.vector_heavy_pages += 1;
        }
        if !raster && (totals.coverage >= LAYOUT_MIN_IMAGE_COVERAGE || vector_heavy) {
            profile.layout_heavy_pages += 1;
        }
        if reading.unmapped_text {
            profile.unmapped_font_pages += 1;
        }
        profile.sampled_words = profile.sampled_words.saturating_add(reading.words.min(f64::from(u32::MAX)) as u32);
        let volume = &reading.text;
        let count = |value: f64| value.max(0.0).min(u64::MAX as f64) as u64;
        profile.sampled_chars = profile.sampled_chars.saturating_add(count(volume.chars));
        profile.sampled_text_lines = profile.sampled_text_lines.saturating_add(count(volume.lines));
        for (bucket, glyphs) in volume.by_size.iter().enumerate() {
            profile.chars_by_font_size[bucket] = profile.chars_by_font_size[bucket].saturating_add(count(*glyphs));
        }
        profile.invisible_chars = profile.invisible_chars.saturating_add(count(volume.invisible));
        profile.off_crop_chars = profile.off_crop_chars.saturating_add(count(volume.off_crop));
        let text = rules.text_equivalents(volume.chars, volume.lines);
        let area = rules.area_equivalents(reading.area);
        profile.sampled_text_equivalents = profile.sampled_text_equivalents.saturating_add(count(text));
        profile.sampled_area_equivalents = profile.sampled_area_equivalents.saturating_add(count(area));
        let page = text.max(area);
        profile.sampled_page_equivalents = profile.sampled_page_equivalents.saturating_add(count(page));
        profile.max_page_equivalents = profile.max_page_equivalents.max(page.min(f64::from(u32::MAX)) as u32);
    }
    let mut areas: Vec<f64> = readings.iter().map(|reading| reading.area / (72.0 * 72.0)).collect();
    areas.sort_by(f64::total_cmp);
    let square_inches = |value: f64| value.round().clamp(0.0, 1_000_000.0) as u32;
    profile.median_page_area_sq_in = square_inches(areas[areas.len() / 2]);
    profile.max_page_area_sq_in = square_inches(*areas.last().unwrap_or(&0.0));
    if budget_hit {
        result.notes.push("a page hit the profiler's content budget; its facts are approximate".into());
    }
    result.pdf = Some(profile);
    result
}

/// Histogram bucket of `value` for ascending lower bounds `bounds` (the first bound is 0).
fn bucket(bounds: &[f64], value: f64, buckets: usize) -> usize {
    bounds.iter().take(buckets).rposition(|bound| value >= *bound).unwrap_or(0)
}

/// Coverage bucket: none, then the rules' lower bounds over (0, 1]; the second bound (0) is exclusive.
fn coverage_bucket(bounds: &[f64], coverage: f64) -> usize {
    if !(coverage > 0.0) {
        return 0;
    }
    bounds.iter().take(COVERAGE_BUCKETS).rposition(|bound| coverage >= *bound && (*bound > 0.0)).unwrap_or(1).max(1)
}

/// Image objects that are page furniture: drawn on at least `repeatedImageMinPages` of the sampled pages and on at least
/// `repeatedImageMinShare` of them (a scan is a different image on every page).
fn repeated_images(routing: &PageRasterRouting, readings: &[PageReading]) -> HashSet<ObjectId> {
    let mut pages: HashMap<ObjectId, usize> = HashMap::new();
    for reading in readings {
        let on_page: HashSet<ObjectId> = reading.images.iter().filter_map(|image| image.id).collect();
        for id in on_page {
            *pages.entry(id).or_insert(0) += 1;
        }
    }
    let scope = readings.len().max(1) as f64;
    pages
        .into_iter()
        .filter(|(_, count)| *count as f64 >= routing.repeated_image_min_pages && *count as f64 / scope >= routing.repeated_image_min_share)
        .map(|(id, _)| id)
        .collect()
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

/// Decompressed form XObject content, once per object for the whole document, and the document-wide budget for
/// decompressed content (page streams and forms).
#[derive(Default)]
struct FormCache {
    content: HashMap<ObjectId, Option<Rc<Vec<u8>>>>,
    decompressed: usize,
}

impl FormCache {
    fn document_budget_spent(&self) -> bool {
        self.decompressed >= MAX_DOCUMENT_CONTENT_BYTES
    }

    /// Bytes still allowed for one stream: the per-stream limit or what is left of the document budget.
    fn stream_limit(&self) -> usize {
        MAX_STREAM_BYTES.min(MAX_DOCUMENT_CONTENT_BYTES.saturating_sub(self.decompressed))
    }

    fn charge(&mut self, bytes: usize) {
        self.decompressed = self.decompressed.saturating_add(bytes);
    }

    fn get(&mut self, id: ObjectId, stream: &lopdf::Stream) -> Option<Rc<Vec<u8>>> {
        if let Some(cached) = self.content.get(&id) {
            return cached.clone();
        }
        let content = self.decompress(stream);
        self.content.insert(id, content.clone());
        content
    }

    fn decompress(&mut self, stream: &lopdf::Stream) -> Option<Rc<Vec<u8>>> {
        let limit = self.stream_limit();
        if limit == 0 {
            return None;
        }
        let content = stream.decompressed_content_with_limit(limit).ok()?;
        self.charge(content.len());
        Some(Rc::new(content))
    }
}

thread_local! {
    /// Decompressed object-stream bytes the current load may still decode (the module is single-threaded).
    static OBJECT_STREAM_BUDGET: Cell<usize> = const { Cell::new(0) };
    static OBJECT_STREAM_BUDGET_EXCEEDED: Cell<bool> = const { Cell::new(false) };
}

/// lopdf load hook, called on every raw object before lopdf decodes object streams: decode each object stream with
/// lopdf's own decoder (every filter in its chain, names as lopdf reads them) against the document-wide budget, and
/// drop it, and every later one, once the budget is spent. lopdf keeps only a per-stream limit.
fn budget_object_streams(id: ObjectId, object: &mut Object) -> Option<(ObjectId, Object)> {
    if let Object::Stream(stream) = object {
        if stream.dict.has_type(b"ObjStm") {
            if OBJECT_STREAM_BUDGET_EXCEEDED.with(Cell::get) {
                return None;
            }
            let remaining = OBJECT_STREAM_BUDGET.with(Cell::get);
            match stream.get_plain_content_with_limit(remaining) {
                Ok(content) => OBJECT_STREAM_BUDGET.with(|budget| budget.set(remaining.saturating_sub(content.len()))),
                Err(lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded { .. })) => {
                    OBJECT_STREAM_BUDGET_EXCEEDED.with(|exceeded| exceeded.set(true));
                    return None;
                }
                // Undecodable: lopdf will skip it as well.
                Err(_) => {}
            }
        }
    }
    // lopdf keeps the original top-level object after this hook and uses the returned value only for object-stream
    // members, which are never streams: streams return a placeholder, everything else a copy.
    match object {
        Object::Stream(_) => Some((id, Object::Null)),
        other => Some((id, other.clone())),
    }
}

/// Whether the file contains the PDF name `/<name>`, with `#xx` escapes decoded as a PDF parser decodes them.
fn has_name(bytes: &[u8], name: &[u8]) -> bool {
    // PDF white space includes NUL, as lopdf reads it.
    let delimiter = |byte: u8| byte.is_ascii_whitespace() || b"\0()<>[]{}/%".contains(&byte);
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut at = 0usize;
    while let Some(offset) = bytes.get(at..).and_then(|rest| rest.iter().position(|byte| *byte == b'/')) {
        let mut cursor = at + offset + 1;
        let mut decoded = Vec::with_capacity(name.len());
        while cursor < bytes.len() && !delimiter(bytes[cursor]) && decoded.len() <= name.len() {
            let byte = bytes[cursor];
            if byte == b'#' {
                if let (Some(high), Some(low)) = (bytes.get(cursor + 1).and_then(|b| hex(*b)), bytes.get(cursor + 2).and_then(|b| hex(*b))) {
                    decoded.push(high << 4 | low);
                    cursor += 3;
                    continue;
                }
            }
            decoded.push(byte);
            cursor += 1;
        }
        if decoded == name && (cursor >= bytes.len() || delimiter(bytes[cursor])) {
            return true;
        }
        at = cursor.max(at + offset + 1);
    }
    false
}

/// Native words as the worker counts them on extracted text (`pageEvidenceWordCount`): runs of 2+ letters or
/// digits, or letters and digits / 6 for scripts without spaces, whichever is larger. Shown strings are joined
/// the way text extraction joins them: text moves within a word's advance continue it, larger moves and line
/// changes break it. Two-byte (CID) strings carry glyph ids, not characters, so they count as letters only.
#[derive(Default)]
struct WordCounter {
    runs: f64,
    characters: f64,
    run_length: usize,
    /// Glyphs shown since the last text move, to tell a next-character move from a word gap.
    run_glyphs: f64,
}

impl WordCounter {
    fn end_run(&mut self) {
        if self.run_length >= 2 {
            self.runs += 1.0;
        }
        self.run_length = 0;
    }

    fn show(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let zero_high_bytes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
        if bytes.len() >= 4 && zero_high_bytes * 2 >= bytes.len() / 2 {
            let glyphs = bytes.len() as f64 / 2.0;
            self.end_run();
            self.characters += glyphs;
            self.run_glyphs += glyphs;
            return;
        }
        for byte in bytes {
            // Bytes above ASCII are accented letters in the common single-byte encodings.
            if byte.is_ascii_alphanumeric() || *byte >= 0xC0 {
                self.run_length += 1;
                self.characters += 1.0;
            } else {
                self.end_run();
            }
        }
        self.run_glyphs += bytes.len() as f64;
    }

    fn gap(&mut self) {
        self.end_run();
        self.run_glyphs = 0.0;
    }

    /// A relative text move (`Td`/`TD`) in unscaled text space with the current font size: same line and no further
    /// than the glyphs just shown (about half an em each, plus a little) continues the word.
    fn moved(&mut self, tx: f64, ty: f64, font_size: f64) {
        let advance = (self.run_glyphs * 0.6 + 0.3) * font_size.abs().max(1.0);
        if ty.abs() > 0.01 || tx < 0.0 || tx > advance {
            self.end_run();
        }
        self.run_glyphs = 0.0;
    }

    fn words(&self) -> f64 {
        let pending = if self.run_length >= 2 { 1.0 } else { 0.0 };
        (self.runs + pending).max((self.characters / 6.0).floor())
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
    /// Text was shown in a font with no Unicode mapping (`unmapped_font`).
    unmapped_text: bool,
    /// Text volume: glyphs shown and text lines started (both as extraction would see them).
    text: TextVolume,
    /// Significant images (pixels and placed area over the rules' floors), at most `MAX_TRACKED_IMAGES_PER_PAGE`; the
    /// totals the class is read from are taken after repeated objects are dropped (`ImageTotals`).
    images: Vec<ImageUse>,
}

const MAX_TRACKED_IMAGES_PER_PAGE: usize = 64;

#[derive(Debug, Clone, Copy)]
struct ImageUse {
    /// The image XObject, or none for an inline image (which has no identity to repeat).
    id: Option<ObjectId>,
    coverage: f64,
}

/// Significant, non-repeated image totals of one page.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct ImageTotals {
    count: usize,
    coverage: f64,
    largest: f64,
}

impl PageStats {
    fn totals(&self, repeated: &HashSet<ObjectId>) -> ImageTotals {
        let mut totals = ImageTotals::default();
        for image in &self.images {
            if image.id.is_some_and(|id| repeated.contains(&id)) {
                continue;
            }
            totals.count += 1;
            totals.coverage = (totals.coverage + image.coverage).min(1.0);
            totals.largest = totals.largest.max(image.coverage);
        }
        totals
    }
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
/// The page's visible box: its CropBox clipped to its MediaBox (either alone when only one is set).
fn visible_box(document: &Document, page_id: ObjectId) -> Option<[f64; 4]> {
    let media = page_box(document, page_id, b"MediaBox");
    let crop = page_box(document, page_id, b"CropBox");
    match (media, crop) {
        (Some(m), Some(c)) => Some([m[0].max(c[0]), m[1].max(c[1]), m[2].min(c[2]), m[3].min(c[3])]),
        (Some(b), None) | (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

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

/// A composite (Type0) font, or a simple font with an Identity encoding, that has no ToUnicode map: its shown bytes are
/// glyph ids, so the page's extracted text is likely unreadable.
fn unmapped_font(document: &Document, resources: &[&Dictionary], name: &[u8]) -> bool {
    let font = resources.iter().find_map(|resource| {
        let fonts = resource.get(b"Font").ok().and_then(|object| dictionary(document, object))?;
        fonts.get(name).ok().and_then(|object| dictionary(document, object))
    });
    let Some(font) = font else { return false };
    if font.get(b"ToUnicode").is_ok() {
        return false;
    }
    let name_of = |key: &[u8]| match font.get(key).ok().and_then(|object| deref(document, object)).map(|(_, value)| value) {
        Some(Object::Name(value)) => Some(value.clone()),
        _ => None,
    };
    name_of(b"Subtype").is_some_and(|subtype| subtype == b"Type0")
        || name_of(b"Encoding").is_some_and(|encoding| encoding.starts_with(b"Identity"))
}

fn lookup_xobject<'a>(document: &'a Document, resources: &[&'a Dictionary], name: &[u8]) -> Option<(Option<ObjectId>, &'a Object)> {
    resources.iter().find_map(|resource| {
        let xobjects = resource.get(b"XObject").ok().and_then(|object| dictionary(document, object))?;
        xobjects.get(name).ok().and_then(|object| deref(document, object))
    })
}

struct PageReading {
    words: f64,
    path_operations: usize,
    images: Vec<ImageUse>,
    exhausted: bool,
    /// Text was shown in a font with no Unicode mapping.
    unmapped_text: bool,
    /// Visible page area in square points.
    area: f64,
    text: TextVolume,
}

impl PageReading {
    fn totals(&self, repeated: &HashSet<ObjectId>) -> ImageTotals {
        PageStats { images: self.images.clone(), ..PageStats::default() }.totals(repeated)
    }

    /// Neither native words nor significant, non-repeated images.
    fn blank(&self, repeated: &HashSet<ObjectId>) -> bool {
        self.words == 0.0 && self.totals(repeated).count == 0
    }
}

fn classify_page(routing: &PageRasterRouting, document: &Document, page_id: ObjectId, forms: &mut FormCache) -> Option<PageReading> {
    let content = document.get_page_content_with_limit(page_id, forms.stream_limit()).ok()?;
    forms.charge(content.len());
    let resources = page_resources(document, page_id);
    let area = page_area(document, page_id);
    let visible = visible_box(document, page_id).unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let mut stats = PageStats::default();
    let mut context = Context { document, routing, forms, area, visible };
    context.interpret(&content, &resources, IDENTITY, 0, &mut stats);
    Some(PageReading { words: stats.words.words(), path_operations: stats.path_operations, images: stats.images, exhausted: stats.exhausted, unmapped_text: stats.unmapped_text, area, text: stats.text })
}

/// The worker's drawn-content rule (`classify-route.ts`): a document with no extractable text anywhere whose bytes,
/// less embedded images, exceed the threshold per page holds text drawn as paths, and its pages go to vision.
fn drawn_document(routing: &PageRasterRouting, document: &Document, file_bytes: usize, pages: usize) -> bool {
    let image_bytes: usize = document
        .objects
        .values()
        .filter_map(|object| match object {
            Object::Stream(stream) => Some(stream),
            _ => None,
        })
        .filter(|stream| matches!(stream.dict.get(b"Subtype"), Ok(Object::Name(kind)) if kind == b"Image"))
        .map(|stream| stream.content.len())
        .sum();
    let drawn_per_page = file_bytes.saturating_sub(image_bytes) as f64 / pages.max(1) as f64;
    drawn_per_page >= routing.drawn_content_min_bytes_per_page
}

/// `decidePageRaster` for the sampled page: a sparse page (fewer than `sparsePageWords` words) whose content is held by
/// significant, non-repeated images is a full-page raster (a scan or a photo of the page).
fn is_raster_page(routing: &PageRasterRouting, words: f64, images: &ImageTotals) -> bool {
    words < routing.sparse_page_words
        && ((words == 0.0
            && (images.largest >= routing.raster_page_min_largest_image_coverage || images.coverage >= routing.raster_page_min_total_image_coverage))
            || (words <= routing.stamp_text_max_words && images.largest >= routing.stamped_scan_min_image_coverage)
            || images.largest >= routing.sparse_text_full_page_image_coverage)
}

struct Context<'a, 'f> {
    document: &'a Document,
    routing: &'a PageRasterRouting,
    forms: &'f mut FormCache,
    area: f64,
    /// The page's visible box (CropBox within MediaBox), in default user space.
    visible: [f64; 4],
}

/// Lower bounds of the effective font size buckets, in points: under 1, 1-4, 4-6, 6-20, 20 and up.
const FONT_SIZE_BUCKETS: [f64; 5] = [0.0, 1.0, 4.0, 6.0, 20.0];

/// What a page's text adds up to, measured from its text-showing operators as extraction would read them.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct TextVolume {
    /// Glyphs shown (a two-byte string's pairs count once).
    chars: f64,
    /// Text lines started: a new text object, a line move or a next-line operator followed by shown text.
    lines: f64,
    /// Glyphs per effective font size bucket (FONT_SIZE_BUCKETS).
    by_size: [f64; 5],
    /// Glyphs in an invisible rendering mode (3 or 7).
    invisible: f64,
    /// Glyphs whose text position lies outside the visible box.
    off_crop: f64,
}

/// The text state the volume needs: text matrices, leading, rendering mode, and whether a new line awaits its first glyph.
#[derive(Clone, Copy)]
struct TextState {
    matrix: Matrix,
    line: Matrix,
    leading: f64,
    render_mode: i64,
    new_line: bool,
}

impl Default for TextState {
    fn default() -> Self {
        Self { matrix: IDENTITY, line: IDENTITY, leading: 0.0, render_mode: 0, new_line: true }
    }
}

/// Glyphs in a shown string: pairs for a two-byte (CID) string, bytes otherwise (the word counter's rule).
fn glyph_count(bytes: &[u8]) -> f64 {
    let zero_high_bytes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
    if bytes.len() >= 4 && zero_high_bytes * 2 >= bytes.len() / 2 { bytes.len() as f64 / 2.0 } else { bytes.len() as f64 }
}

impl<'a> Context<'a, '_> {
    /// Count a shown string into the page's text volume: its glyphs, the line it starts, their effective size, whether
    /// they are invisible or placed outside the visible box. The text position then advances by an estimate of the run's
    /// width (half an em a glyph), so a long run off the page edge is found.
    fn text_shown(&self, stats: &mut PageStats, text: &mut TextState, bytes: &[u8], font_size: f64, ctm: &Matrix) {
        let glyphs = glyph_count(bytes);
        if glyphs <= 0.0 {
            return;
        }
        let volume = &mut stats.text;
        volume.chars += glyphs;
        if text.new_line {
            volume.lines += 1.0;
            text.new_line = false;
        }
        let device = multiply(&text.matrix, ctm);
        let scale = (device[0] * device[3] - device[1] * device[2]).abs().sqrt();
        let size = (font_size.abs() * scale).max(0.0);
        let bucket = FONT_SIZE_BUCKETS.iter().rposition(|bound| size >= *bound).unwrap_or(0);
        volume.by_size[bucket] += glyphs;
        if matches!(text.render_mode, 3 | 7) {
            volume.invisible += glyphs;
        }
        let [x0, y0, x1, y1] = self.visible;
        let (x, y) = (device[4], device[5]);
        if !(x.is_finite() && y.is_finite()) || x < x0 || x > x1 || y < y0 || y > y1 {
            volume.off_crop += glyphs;
        }
        text.matrix = multiply(&[1.0, 0.0, 0.0, 1.0, glyphs * 0.5 * font_size, 0.0], &text.matrix);
    }

    fn record_image(&self, stats: &mut PageStats, id: Option<ObjectId>, ctm: &Matrix, width: f64, height: f64) {
        let placed = (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs();
        let coverage = (placed / self.area).min(1.0);
        if !coverage.is_finite()
            || coverage < self.routing.min_significant_image_coverage
            || width.min(height) < self.routing.min_significant_image_pixels
        {
            return;
        }
        if stats.images.len() < MAX_TRACKED_IMAGES_PER_PAGE {
            stats.images.push(ImageUse { id, coverage });
        } else if let Some(smallest) = stats.images.iter_mut().min_by(|a, b| a.coverage.total_cmp(&b.coverage)) {
            // A page of hundreds of images keeps the largest ones: they decide the class.
            if coverage > smallest.coverage {
                *smallest = ImageUse { id, coverage };
            }
        }
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
        let mut font_unmapped = false;
        let mut text = TextState::default();
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
                "BT" => {
                    stats.words.gap();
                    text = TextState { render_mode: text.render_mode, leading: text.leading, ..TextState::default() };
                }
                "ET" => stats.words.gap(),
                "T*" => {
                    stats.words.gap();
                    text.line = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -text.leading], &text.line);
                    text.matrix = text.line;
                    text.new_line = true;
                }
                "Tm" => {
                    stats.words.gap();
                    if let Some(matrix) = matrix_from(operands) {
                        if (matrix[5] - text.line[5]).abs() > 0.01 || (matrix[3] - text.line[3]).abs() > 0.01 {
                            text.new_line = true;
                        }
                        text.line = matrix;
                        text.matrix = matrix;
                    }
                }
                "TL" => text.leading = operands.first().and_then(number).unwrap_or(text.leading),
                "Tr" => text.render_mode = operands.first().and_then(number).map(|mode| mode as i64).unwrap_or(text.render_mode),
                "Tf" => {
                    font_size = operands.get(1).and_then(number).unwrap_or(font_size);
                    if let Some(Object::Name(name)) = operands.first() {
                        font_unmapped = unmapped_font(self.document, resources, name);
                    }
                }
                "Td" | "TD" => {
                    let tx = operands.first().and_then(number).unwrap_or(0.0);
                    let ty = operands.get(1).and_then(number).unwrap_or(0.0);
                    stats.words.moved(tx, ty, font_size);
                    if operation.operator == "TD" {
                        text.leading = -ty;
                    }
                    text.line = multiply(&[1.0, 0.0, 0.0, 1.0, tx, ty], &text.line);
                    text.matrix = text.line;
                    if ty.abs() > 0.01 {
                        text.new_line = true;
                    }
                }
                "Tj" => {
                    if let Some(Object::String(bytes, _)) = operands.last() {
                        stats.words.show(bytes);
                        stats.unmapped_text |= font_unmapped && !bytes.is_empty();
                        self.text_shown(stats, &mut text, bytes, font_size, &ctm);
                    }
                }
                "'" | "\"" => {
                    stats.words.gap();
                    text.line = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -text.leading], &text.line);
                    text.matrix = text.line;
                    text.new_line = true;
                    if let Some(Object::String(bytes, _)) = operands.last() {
                        stats.words.show(bytes);
                        stats.unmapped_text |= font_unmapped && !bytes.is_empty();
                        self.text_shown(stats, &mut text, bytes, font_size, &ctm);
                    }
                }
                "TJ" => {
                    if let Some(Object::Array(parts)) = operands.first() {
                        for part in parts {
                            match part {
                                Object::String(bytes, _) => {
                                    stats.words.show(bytes);
                                    stats.unmapped_text |= font_unmapped && !bytes.is_empty();
                                    self.text_shown(stats, &mut text, bytes, font_size, &ctm);
                                }
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
                        self.record_image(stats, None, &ctm, width, height);
                    }
                }
                "Do" => {
                    let Some(Object::Name(name)) = operands.first() else { continue };
                    let Some((id, Object::Stream(xobject))) = lookup_xobject(self.document, resources, name) else { continue };
                    let subtype = xobject.dict.get(b"Subtype").ok().and_then(|object| deref(self.document, object)).map(|(_, value)| value);
                    match subtype {
                        Some(Object::Name(kind)) if kind == b"Image" => {
                            let (width, height) = self.image_size(&xobject.dict, b"Width", b"Height");
                            self.record_image(stats, id, &ctm, width, height);
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
                                None => self.forms.decompress(xobject),
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
        Rules::bundled().page_raster_routing.clone()
    }

    #[test]
    fn finds_names_with_escapes_and_ignores_prefixes() {
        assert!(has_name(b"<< /Encrypt 5 0 R >>", b"Encrypt"));
        assert!(has_name(b"<</Encr#79pt 5 0 R>>", b"Encrypt"));
        assert!(has_name(b"<< /Encrypt\x005 0 R >>", b"Encrypt"));
        assert!(!has_name(b"<< /Encrypted true /EncryptMetadata false >>", b"Encrypt"));
        assert!(!has_name(b"(no names here)", b"Encrypt"));
    }

    #[test]
    fn samples_evenly_with_both_ends() {
        assert_eq!(sample_indices(5, 24), vec![0, 1, 2, 3, 4]);
        let sample = sample_indices(1000, 24);
        assert_eq!(sample.len(), 24);
        assert_eq!((sample[0], sample[23]), (0, 999));
    }

    #[test]
    fn applies_the_page_raster_rule_like_the_worker_router() {
        let routing = routing();
        let images = |count: usize, largest: f64, total: f64| ImageTotals { count, coverage: total, largest };
        assert!(is_raster_page(&routing, 0.0, &images(1, 0.9, 0.9)));
        assert!(is_raster_page(&routing, 8.0, &images(1, 0.6, 0.6)));
        assert!(is_raster_page(&routing, 25.0, &images(1, 0.9, 0.9)));
        // A caption-sized amount of text over a mid-size image is not a full-page raster.
        assert!(!is_raster_page(&routing, 25.0, &images(1, 0.6, 0.6)));
        assert!(!is_raster_page(&routing, 400.0, &images(1, 0.9, 0.9)));
        assert!(!is_raster_page(&routing, 0.0, &images(0, 0.0, 0.0)));
        // Minor images alone never make a raster page.
        assert!(!is_raster_page(&routing, 0.0, &images(1, 0.1, 0.1)));
        assert!(!is_raster_page(&routing, 0.0, &images(4, 0.1, 0.34)));
        assert!(is_raster_page(&routing, 0.0, &images(4, 0.1, 0.36)));
    }

    #[test]
    fn buckets_words_and_coverage_on_the_rules_edges() {
        let rules = Rules::bundled();
        let words = |value: f64| bucket(&rules.words_per_page_buckets, value, WORDS_BUCKETS);
        assert_eq!([words(0.0), words(1.0), words(10.0), words(11.0), words(29.0), words(30.0), words(499.0), words(500.0), words(1e9)], [0, 1, 1, 2, 2, 3, 4, 5, 5]);
        let coverage = |value: f64| coverage_bucket(&rules.image_coverage_buckets, value);
        assert_eq!([coverage(0.0), coverage(0.01), coverage(0.15), coverage(0.49), coverage(0.5), coverage(0.9), coverage(1.0), coverage(f64::NAN)], [0, 1, 2, 2, 3, 4, 4, 0]);
    }

    #[test]
    fn drops_images_drawn_on_many_pages_as_page_furniture() {
        let routing = routing();
        let id = |number: u32| (number, 0);
        let page = |ids: &[u32]| PageReading {
            words: 0.0,
            path_operations: 0,
            images: ids.iter().map(|number| ImageUse { id: Some(id(*number)), coverage: 0.9 }).collect(),
            exhausted: false,
            unmapped_text: false,
            area: DEFAULT_PAGE_AREA,
            text: TextVolume::default(),
        };
        // The same full-bleed background on four pages: furniture, so the pages are blank.
        let slides = vec![page(&[7]), page(&[7]), page(&[7]), page(&[7])];
        let repeated = repeated_images(&routing, &slides);
        assert!(repeated.contains(&id(7)));
        assert!(slides.iter().all(|reading| reading.blank(&repeated)));
        // A different image on every page is a scan on every page.
        let scans = vec![page(&[1]), page(&[2]), page(&[3]), page(&[4])];
        let repeated = repeated_images(&routing, &scans);
        assert!(repeated.is_empty());
        assert!(scans.iter().all(|reading| !reading.blank(&repeated)));
        // Two pages sharing an object are not furniture (a duplicated scan), nor three of a hundred.
        assert!(repeated_images(&routing, &[page(&[9]), page(&[9])]).is_empty());
        let mut hundred: Vec<PageReading> = (0..100).map(|number| page(&[100 + number])).collect();
        for reading in hundred.iter_mut().take(3) {
            reading.images = vec![ImageUse { id: Some(id(9)), coverage: 0.9 }];
        }
        assert!(repeated_images(&routing, &hundred).is_empty());
    }

    #[test]
    fn counts_words_from_text_runs() {
        let mut counter = WordCounter::default();
        counter.show(b"hello brave new world, a b");
        // Single letters are not words to the worker.
        assert_eq!(counter.words(), 4.0);

        // A title drawn one character at a time with next-character moves is one word, not one per glyph.
        let mut title = WordCounter::default();
        for glyph in b"Contract" {
            title.show(&[*glyph]);
            title.moved(7.0, 0.0, 12.0);
        }
        assert_eq!(title.words(), 1.0);

        // A move to the next line starts a new word.
        let mut lines = WordCounter::default();
        lines.show(b"first");
        lines.moved(0.0, -14.0, 12.0);
        lines.show(b"second");
        assert_eq!(lines.words(), 2.0);

        let mut cid = WordCounter::default();
        cid.show(&[0, 41, 0, 42, 0, 43, 0, 44, 0, 45, 0, 46, 0, 47, 0, 48, 0, 49, 0, 50, 0, 51, 0, 52]);
        assert_eq!(cid.words(), 2.0);
    }
}
