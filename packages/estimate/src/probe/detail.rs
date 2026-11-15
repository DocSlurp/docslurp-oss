//! Bounded, incremental, content-free PDF page evidence in JSONL form.

use super::*;
use crate::error::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, BinaryHeap};

const MAX_PAGES: usize = 100_000;
const MAX_DECODED: usize = 128 * 1024 * 1024;
const MAX_DOCUMENT_OPERATIONS: usize = 2_000_000;

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Options {
    pub max_deep_pages: usize,
    pub batch_pages: usize,
    pub groups: Vec<Group>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Text,
    Images,
    Vectors,
    Tables,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_deep_pages: 1000,
            batch_pages: 64,
            groups: vec![Group::Text, Group::Images, Group::Vectors, Group::Tables],
        }
    }
}

impl Options {
    fn validate(&self) -> Result<(), Error> {
        if self.max_deep_pages > 1000
            || !(1..=64).contains(&self.batch_pages)
            || self.groups.len() > 4
        {
            return Err(Error::invalid_request(
                "maxDeepPages must be 0..1000; batchPages 1..64; groups at most four",
            ));
        }
        for (index, group) in self.groups.iter().enumerate() {
            if self.groups[..index].contains(group) {
                return Err(Error::invalid_request("duplicate feature group"));
            }
        }
        Ok(())
    }
}

fn line(value: Value) -> String {
    format!("{}\n", value)
}

/// A retained parsed PDF, advanced by the host between bounded output batches.
/// There is no authority, filesystem access, network access or extracted text in this object.
pub struct Session {
    document: Document,
    pages: Vec<ObjectId>,
    selected: BTreeSet<usize>,
    options: Options,
    cursor: usize,
    decoded: usize,
    operations: usize,
    attempted: usize,
    measured: usize,
    partial: usize,
    chunk: usize,
    summary: Summary,
    total: Summary,
}

#[derive(Default)]
struct Summary {
    pages: usize,
    measured: usize,
    partial: usize,
    content_bytes: u64,
    content_known: usize,
    text_bytes: u64,
    table_bytes: u64,
    table_text_known: usize,
    text_known: usize,
    table_pages: usize,
    table_known: usize,
    image_pages: usize,
    image_known: usize,
    vector_pages: usize,
    vector_known: usize,
    text_histogram: [usize; 6],
}

impl Summary {
    fn add(&mut self, row: &Evidence) {
        self.pages += 1;
        self.measured += usize::from(row.status == 1);
        self.partial += usize::from(row.status == 2);
        if let Some(bytes) = row.content {
            self.content_bytes += bytes;
            self.content_known += 1;
        }
        // Only complete observations contribute to feature totals; no partial-as-zero bias.
        if row.status != 1 {
            return;
        }
        if let Some(text) = &row.text {
            self.text_known += 1;
            self.text_bytes += text[3];
            let index = [0, 1, 11, 30, 200, 500]
                .iter()
                .rposition(|bound| text[0] >= *bound)
                .unwrap_or(0);
            self.text_histogram[index] += 1;
        }
        if let Some(images) = &row.images {
            self.image_pages += usize::from(images[0] > 0);
            self.image_known += 1;
        }
        if let Some(vectors) = &row.vectors {
            self.vector_pages += usize::from(vectors[0] >= 60);
            self.vector_known += 1;
        }
        if let Some(tables) = &row.tables {
            self.table_known += usize::from(tables[0].is_some());
            if let Some(bytes) = tables[3] {
                self.table_bytes += bytes;
                self.table_text_known += 1;
            }
            self.table_pages += usize::from(tables[0].unwrap_or(0) > 0);
        }
    }

    fn record(&self, kind: &str, first: usize) -> Value {
        json!({"t":kind,"first":first,"pages":self.pages,"measured":self.measured,"partial":self.partial,
            "unknown":self.pages-self.measured-self.partial,
            "directContentStoredBytes":self.content_bytes,"contentKnownPages":self.content_known,
            "estimatedTextBytes":self.text_bytes,"textKnownPages":self.text_known,
            "estimatedTableTextBytes":self.table_bytes,"tableTextKnownPages":self.table_text_known,
            "tableCandidatePages":self.table_pages,"imagePages":self.image_pages,"vectorHeavyPages":self.vector_pages,
            "tableKnownPages":self.table_known,"imageKnownPages":self.image_known,"vectorKnownPages":self.vector_known,
            "wordsHistogram":self.text_histogram,"populationExtrapolated":false})
    }
}

struct Evidence {
    // 0 not selected, 1 complete, 2 partial, 3 unreadable, 4 document budget exhausted.
    status: u8,
    content: Option<u64>,
    text: Option<[u64; 4]>,
    images: Option<[u64; 4]>,
    vectors: Option<[u64; 1]>,
    tables: Option<[Option<u64>; 4]>,
}

/// Direct page content stream payload, deduplicated within a page. Shared references are
/// counted per page: this is not an additive allocation of the physical PDF file.
fn stored_content(document: &Document, page: ObjectId) -> Option<u64> {
    let dict = document.get_dictionary(page).ok()?;
    let value = match dict.get(b"Contents") {
        Ok(value) => value,
        Err(_) => return Some(0),
    };
    let (_, value) = deref(document, value)?;
    let values: Vec<&Object> = match value {
        Object::Array(values) => values.iter().collect(),
        other => vec![other],
    };
    if values.len() > 4096 {
        return None;
    }
    let mut seen = HashSet::new();
    let mut total = 0;
    for value in values {
        let (id, object) = deref(document, value)?;
        if id.is_some_and(|id| !seen.insert(id)) {
            continue;
        }
        let Object::Stream(stream) = object else {
            return None;
        };
        total += stream.content.len() as u64;
    }
    Some(total)
}

impl Session {
    pub fn open(bytes: &[u8], options: Options) -> Result<(Self, String), Error> {
        options.validate()?;
        if bytes.len() as u64 > WHOLE_FILE_MAX_BYTES || !bytes.starts_with(b"%PDF-") {
            return Err(Error::invalid_request(
                "detailed profiles require a PDF no larger than 64 MiB",
            ));
        }
        if has_name(bytes, b"Encrypt") {
            return Err(Error::invalid_request("encrypted PDF cannot be profiled"));
        }
        OBJECT_STREAM_BUDGET.with(|budget| budget.set(MAX_OBJECT_STREAM_BYTES));
        OBJECT_STREAM_BUDGET_EXCEEDED.with(|exceeded| exceeded.set(false));
        let document = Document::load_mem_with_options(
            bytes,
            LoadOptions {
                max_decompressed_size: Some(MAX_LOAD_STREAM_BYTES),
                filter: Some(budget_object_streams),
                ..LoadOptions::default()
            },
        )
        .map_err(|_| Error::invalid_request("PDF could not be parsed"))?;
        if OBJECT_STREAM_BUDGET_EXCEEDED.with(Cell::get) || document.is_encrypted() {
            return Err(Error::invalid_request(
                "encrypted PDF or object stream budget exceeded",
            ));
        }
        let pages: Vec<_> = document.page_iter().take(MAX_PAGES + 1).collect();
        if pages.is_empty() || pages.len() > MAX_PAGES {
            return Err(Error::invalid_request("PDF must have 1..100000 pages"));
        }
        // Uniformly spread core sample, plus bounded largest-stream outliers. Outliers
        // are never used to extrapolate population totals. Seed independent of content.
        let cap = options.max_deep_pages.min(pages.len());
        let baseline = if cap == pages.len() { cap } else { cap * 3 / 4 };
        let mut selected = BTreeSet::new();
        let mut seed = 0x9e3779b9u64;
        for i in 0..baseline {
            let start = i * pages.len() / baseline;
            let end = (i + 1) * pages.len() / baseline;
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            selected.insert(start + (seed % (end - start) as u64) as usize);
        }
        let remaining = cap - selected.len();
        let mut outliers = BinaryHeap::new();
        if remaining > 0 {
            for (index, page) in pages.iter().enumerate() {
                if selected.contains(&index) {
                    continue;
                }
                if let Some(bytes) = stored_content(&document, *page) {
                    outliers.push(std::cmp::Reverse((bytes, index)));
                    if outliers.len() > remaining {
                        outliers.pop();
                    }
                }
            }
            selected.extend(outliers.into_iter().map(|entry| entry.0 .1));
            for index in 0..pages.len() {
                if selected.len() == cap {
                    break;
                }
                selected.insert(index);
            }
        }
        let chunk = pages.len().div_ceil(100).clamp(1, 10);
        let header = line(
            json!({"t":"header","schema":"docslurp-page-profile@2","format":"jsonl",
            "fileBytes":bytes.len(),"pages":pages.len(),"deepSelected":selected.len(),"chunkPages":chunk,
            "groups":options.groups,"selection":"stratified-v1+largest-content-v1","populationExtrapolated":false,
            "limits":{"fileBytes":WHOLE_FILE_MAX_BYTES,"pages":MAX_PAGES,"decodedBytes":MAX_DECODED,"operations":MAX_DOCUMENT_OPERATIONS,"strictValidationStreamBytes":262144},
            "status":{"0":"not-selected","1":"complete","2":"partial","3":"unreadable","4":"budget-exhausted"},
            "columns":{"inventory":["page","widthPt10","heightPt10","directContentStoredBytes","status","rotation"],
            "text":["words","glyphs","lines","estimatedTextBytes"],
            "images":["placements","estimatedDrawnStoredBytes","coverage10000","raster"],
            "vectors":["pathOperations"],"tables":["ruledCandidates","maxRows","coverage10000","estimatedTableTextBytes"]},
            "methods":{"textBytes":"glyph-count-times-2-v1","tableTextBytes":"word-glyph-centres-in-ruled-grids-times-2-v1",
            "tables":"ruled-grid-candidates-only","captions":"unavailable","charts":"unavailable",
            "images":"drawn-significant-includes-furniture","byteTotals":"per-page-references-not-physical-file-allocation"}}),
        );
        Ok((
            Self {
                document,
                pages,
                selected,
                options,
                cursor: 0,
                decoded: 0,
                operations: 0,
                attempted: 0,
                measured: 0,
                partial: 0,
                chunk,
                summary: Summary::default(),
                total: Summary::default(),
            },
            header,
        ))
    }

    fn evidence(&mut self, index: usize) -> Evidence {
        let page = self.pages[index];
        let mut out = Evidence {
            status: 0,
            content: stored_content(&self.document, page),
            text: None,
            images: None,
            vectors: None,
            tables: None,
        };
        if !self.selected.contains(&index) {
            return out;
        }
        if self.decoded >= MAX_DECODED
            || self.operations + MAX_OPERATIONS_PER_PAGE + 1 > MAX_DOCUMENT_OPERATIONS
        {
            out.status = 4;
            return out;
        }
        // Release all form caches after each page; bound retained memory independently
        // from cumulative work. Reserve a full per-page budget before starting.
        if MAX_DECODED - self.decoded < MAX_DOCUMENT_CONTENT_BYTES {
            out.status = 4;
            return out;
        }
        self.attempted += 1;
        let mut forms = FormCache::default();
        let reading = classify_page_checked(
            &Rules::bundled().page_raster_routing,
            &self.document,
            page,
            &mut forms,
            true,
        );
        self.decoded += forms.decompressed;
        let Some(reading) = reading else {
            out.status = 3;
            return out;
        };
        self.operations += reading.operations;
        out.status = if reading.exhausted
            || reading.words_overflow
            || reading.rules.overflow
            || reading.unmapped_text
        {
            2
        } else {
            1
        };
        self.measured += usize::from(out.status == 1);
        self.partial += usize::from(out.status == 2);
        if self.options.groups.contains(&Group::Text) {
            out.text = Some([
                reading.words as u64,
                reading.text.chars as u64,
                reading.text.lines as u64,
                (reading.text.chars * 2.0) as u64,
            ]);
        }
        if self.options.groups.contains(&Group::Vectors) {
            out.vectors = Some([reading.path_operations as u64]);
        }
        if self.options.groups.contains(&Group::Images) {
            let mut seen = HashSet::new();
            let bytes = reading
                .images
                .iter()
                .filter(|image| image.id.is_none_or(|id| seen.insert(id)))
                .map(|image| image.width_px * image.height_px * image.bytes_per_pixel)
                .sum::<f64>() as u64;
            let boxes: Vec<_> = reading
                .images
                .iter()
                .filter_map(|image| image.placement.map(|entry| entry.0))
                .collect();
            let coverage = layout::union_coverage(
                &boxes,
                reading.display_visible,
                Rules::bundled().layout.coverage_raster,
            );
            let totals = reading.totals(&HashSet::new());
            out.images = Some([
                reading.images.len() as u64,
                bytes,
                (coverage * 10000.0).round() as u64,
                u64::from(is_raster_page(
                    &Rules::bundled().page_raster_routing,
                    reading.words,
                    &totals,
                )),
            ]);
        }
        if self.options.groups.contains(&Group::Tables) {
            if reading.rules.overflow || reading.exhausted {
                out.tables = Some([None; 4]);
            } else {
                let grids = layout::ruled_grids(&reading.rules.rules, &Rules::bundled().layout);
                let boxes: Vec<_> = grids.iter().map(|grid| grid.bbox).collect();
                let coverage = layout::union_coverage(
                    &boxes,
                    reading.display_visible,
                    Rules::bundled().layout.coverage_raster,
                );
                let glyphs: f64 = reading
                    .words_at
                    .iter()
                    .filter(|word| {
                        boxes.iter().any(|b| {
                            word.x >= b[0] && word.x <= b[2] && word.y >= b[1] && word.y <= b[3]
                        })
                    })
                    .map(|word| word.glyphs)
                    .sum();
                out.tables = Some([
                    Some(grids.len() as u64),
                    Some(grids.iter().map(|grid| grid.rows).max().unwrap_or(0) as u64),
                    Some((coverage * 10000.0).round() as u64),
                    (!reading.words_overflow
                        && !reading.unmapped_text
                        && reading.text.tiny_dropped == 0.0)
                        .then_some((glyphs * 2.0) as u64),
                ]);
            }
        }
        out
    }

    /// JSONL text for at most batchPages pages, or a terminal trailer. `None` after completion.
    pub fn next(&mut self) -> Option<String> {
        if self.cursor > self.pages.len() {
            return None;
        }
        if self.cursor == self.pages.len() {
            self.cursor += 1;
            return Some(line(
                json!({"t":"end","complete":true,"inventoryPages":self.pages.len(),
                "deepSelected":self.selected.len(),"deepAttempted":self.attempted,"deepMeasured":self.measured,
                "deepPartial":self.partial,"decodedBytes":self.decoded,"operations":self.operations,"deepComplete":self.measured==self.selected.len(),
                "totals":self.total.record("totals",1)}),
            ));
        }
        let first = self.cursor;
        let mut end = (first + self.options.batch_pages).min(self.pages.len());
        // At most eight selected pages per call, even with a larger inventory batch.
        let mut deep = 0;
        for index in first..end {
            if self.selected.contains(&index) {
                deep += 1;
            }
            if deep > 8 {
                end = index;
                break;
            }
        }
        let mut inventory = Vec::new();
        let mut features = serde_json::Map::new();
        let mut summaries = Vec::new();
        for index in first..end {
            let row = self.evidence(index);
            let visible = visible_box(&self.document, self.pages[index]);
            let rotation = page_rotate(&self.document, self.pages[index]);
            let displayed = visible.map(|b| {
                layout::DisplaySpace::new(
                    page_box(&self.document, self.pages[index], b"MediaBox").unwrap_or(b),
                    b,
                    rotation,
                )
                .visible
            });
            let width = displayed.map(|b| ((b[2] - b[0]).max(0.0) * 10.0).round() as u64);
            let height = displayed.map(|b| ((b[3] - b[1]).max(0.0) * 10.0).round() as u64);
            inventory.push(json!([
                index + 1,
                width,
                height,
                row.content,
                row.status,
                rotation
            ]));
            for (name, value) in [
                ("text", row.text.map(|v| json!(v))),
                ("images", row.images.map(|v| json!(v))),
                ("vectors", row.vectors.map(|v| json!(v))),
                ("tables", row.tables.map(|v| json!(v))),
            ] {
                if let Some(value) = value {
                    features
                        .entry(name)
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .unwrap()
                        .push(json!([index + 1, value]));
                }
            }
            self.total.add(&row);
            self.summary.add(&row);
            if (index + 1) % self.chunk == 0 || index + 1 == self.pages.len() {
                summaries.push(
                    self.summary
                        .record("summary", index + 2 - self.summary.pages),
                );
                self.summary = Summary::default();
            }
        }
        self.cursor = end;
        let mut output =
            line(json!({"t":"pages","first":first+1,"inventory":inventory,"features":features}));
        for summary in summaries {
            output.push_str(&line(summary));
        }
        Some(output)
    }
}
