//! Bounded, incremental, content-free PDF page evidence in JSONL form.

use super::*;
use crate::error::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, BinaryHeap};

const MAX_PAGES: usize = 100_000;
const MAX_DECODED: usize = 128 * 1024 * 1024;
const MAX_DOCUMENT_OPERATIONS: usize = 2_000_000;
// Separate geometry work from interpreter operations. With at most 1,000
// selected pages, this also bounds pair visits to 65,536,000 per document.
const MAX_GRID_COMPARISONS_PER_PAGE: usize = 65_536;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Options {
    pub max_deep_pages: usize,
    pub batch_pages: usize,
    pub groups: Vec<Group>,
    pub ranked_pages: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Text,
    Images,
    Vectors,
    Tables,
    Captions,
    Charts,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_deep_pages: 1000,
            batch_pages: 64,
            groups: vec![
                Group::Text,
                Group::Images,
                Group::Vectors,
                Group::Tables,
                Group::Captions,
                Group::Charts,
            ],
            ranked_pages: 32,
        }
    }
}

impl Options {
    pub(super) fn validate(&self) -> Result<(), Error> {
        if self.max_deep_pages > 1000
            || !(1..=64).contains(&self.batch_pages)
            || self.groups.len() > 6
            || self.ranked_pages > 128
        {
            return Err(Error::invalid_request(
                "maxDeepPages must be 0..1000; batchPages 1..64; groups at most six; rankedPages 0..128",
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
    image_lengths: HashMap<ObjectId, usize>,
    rankings: Rankings,
}

#[derive(Default)]
pub(super) struct Summary {
    pub(super) pages: usize,
    measured: usize,
    partial: usize,
    content_bytes: u64,
    content_known: usize,
    text_bytes: u64,
    table_bytes: u64,
    table_text_known: usize,
    text_known: usize,
    table_pages: usize,
    ruled_grid_pages: usize,
    table_known: usize,
    image_pages: usize,
    image_known: usize,
    vector_pages: usize,
    vector_known: usize,
    text_histogram: [usize; 6],
    layout_known: usize,
    unruled_pages: usize,
    caption_pages: usize,
    chart_pages: usize,
    layout_text: u64,
    all_table_text: u64,
    caption_text: u64,
}

impl Summary {
    pub(super) fn add(&mut self, row: &Evidence) {
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
            self.ruled_grid_pages += usize::from(tables[0].unwrap_or(0) > 0);
        }
        if row
            .extra
            .get("tableCandidates")
            .is_some_and(|values| values[0].is_some_and(|count| count > 0))
        {
            self.table_pages += 1;
        }
        if let Some(composition) = row
            .extra
            .get("composition")
            .filter(|values| values.last() == Some(&Some(1)))
        {
            self.layout_known += 1;
            self.layout_text += composition[0].unwrap_or(0);
            self.all_table_text += composition[1].unwrap_or(0);
            self.caption_text += composition[2].unwrap_or(0);
        }
        for (name, count) in [
            ("unruledTables", &mut self.unruled_pages),
            ("captions", &mut self.caption_pages),
            ("charts", &mut self.chart_pages),
        ] {
            if row
                .extra
                .get(name)
                .is_some_and(|values| values[0].is_some_and(|count| count > 0))
            {
                *count += 1;
            }
        }
    }

    pub(super) fn record(&self, kind: &str, first: usize) -> Value {
        if kind == "summary" {
            return json!({"t":kind,"first":first,"v":[self.pages,self.measured,self.partial,self.pages-self.measured-self.partial,self.content_known,self.content_bytes,
                self.text_known,self.text_bytes,self.table_known,self.table_bytes,self.layout_known,self.all_table_text,self.caption_text,self.table_pages,
                self.image_known,self.image_pages,self.vector_known,self.vector_pages,self.unruled_pages,self.caption_pages,self.chart_pages],"wordsHistogram":self.text_histogram});
        }
        json!({"t":kind,"first":first,"pages":self.pages,"measured":self.measured,"partial":self.partial,
            "unknown":self.pages-self.measured-self.partial,
            "directContentStoredBytes":self.content_bytes,"contentKnownPages":self.content_known,
            "estimatedTextBytes":self.text_bytes,"textKnownPages":self.text_known,
            "estimatedTableTextBytes":self.table_bytes,"tableTextKnownPages":self.table_text_known,
            "tableCandidatePages":self.table_pages,"imagePages":self.image_pages,"vectorHeavyPages":self.vector_pages,
            "ruledGridPages":self.ruled_grid_pages,
            "tableKnownPages":self.table_known,"imageKnownPages":self.image_known,"vectorKnownPages":self.vector_known,
            "layoutKnownPages":self.layout_known,"unruledCandidatePages":self.unruled_pages,"captionCandidatePages":self.caption_pages,"vectorFigureCandidatePages":self.chart_pages,
            "compositionTextBytes":self.layout_text,"allTableCandidateTextBytes":self.all_table_text,"captionCandidateTextBytes":self.caption_text,
            "wordsHistogram":self.text_histogram,"populationExtrapolated":false})
    }
}

fn supported_grids(grids: &[layout::Grid], rules: &[[f64; 4]]) -> Option<Vec<[f64; 4]>> {
    let mut work = 0usize;
    let mut out = Vec::new();
    for grid in grids {
        let b = grid.bbox;
        let width = b[2] - b[0];
        let height = b[3] - b[1];
        let mut horizontal = 0;
        let mut vertical = 0;
        for rule in rules {
            work += 1;
            if work > 100000 {
                return None;
            }
            let overlap_x = (rule[2].min(b[2]) - rule[0].max(b[0])).max(0.0);
            let overlap_y = (rule[3].min(b[3]) - rule[1].max(b[1])).max(0.0);
            horizontal += usize::from(
                rule[3] - rule[1] <= 2.0
                    && overlap_x >= width * 0.6
                    && rule[1] >= b[1] - 2.0
                    && rule[3] <= b[3] + 2.0,
            );
            vertical += usize::from(
                rule[2] - rule[0] <= 2.0
                    && overlap_y >= height * 0.6
                    && rule[0] >= b[0] - 2.0
                    && rule[2] <= b[2] + 2.0,
            );
        }
        // Axis ticks alone connect into a grid but do not enclose repeated cells.
        if horizontal >= 2 && vertical >= 2 {
            out.push(b);
        }
    }
    Some(out)
}

pub(super) struct Evidence {
    // 0 not selected, 1 complete, 2 partial, 3 unreadable, 4 document budget exhausted.
    pub(super) status: u8,
    content: Option<u64>,
    text: Option<[u64; 4]>,
    images: Option<[u64; 4]>,
    vectors: Option<[u64; 2]>,
    tables: Option<[Option<u64>; 4]>,
    extra: std::collections::BTreeMap<&'static str, Vec<Option<u64>>>,
}

impl Evidence {
    pub(super) fn inventory(content: Option<u64>) -> Self {
        Self {
            status: 0,
            content,
            text: None,
            images: None,
            vectors: None,
            tables: None,
            extra: Default::default(),
        }
    }
    pub(super) fn features(&self, page: usize) -> Value {
        let mut output = serde_json::Map::new();
        for (name, value) in [
            ("text", self.text.map(|v| json!(v))),
            ("images", self.images.map(|v| json!(v))),
            ("vectors", self.vectors.map(|v| json!(v))),
            ("tables", self.tables.map(|v| json!(v))),
        ] {
            if let Some(value) = value {
                output.insert(name.into(), json!([[page, value]]));
            }
        }
        for (name, values) in &self.extra {
            output.insert((*name).into(), json!([[page, values]]));
        }
        Value::Object(output)
    }
}

#[derive(Default)]
pub(super) struct Rankings(std::collections::BTreeMap<&'static str, Vec<(u64, usize)>>);
impl Rankings {
    pub(super) fn add(&mut self, page: usize, row: &Evidence, cap: usize) {
        if cap == 0 || row.status != 1 {
            return;
        }
        for (name, score) in [
            ("images", row.images.map(|v| v[2])),
            ("vectors", row.vectors.map(|v| v[0])),
            (
                "tables",
                row.extra.get("tableCandidates").and_then(|v| v[1]),
            ),
            ("captions", row.extra.get("captions").and_then(|v| v[1])),
            ("charts", row.extra.get("charts").and_then(|v| v[1])),
        ] {
            if let Some(score) = score.filter(|score| *score > 0) {
                let list = self.0.entry(name).or_default();
                list.push((score, page));
                list.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
                list.truncate(cap);
            }
        }
    }
    pub(super) fn record(&self) -> Value {
        json!({"t":"rankings","columns":["score","page"],"scope":"measured-selected-pages","scores":self.0})
    }
}

pub(super) fn header(
    file_bytes: u64,
    pages: usize,
    selected: usize,
    chunk: usize,
    options: &Options,
) -> String {
    line(
        json!({"t":"header","schema":"docslurp-page-profile@3","format":"jsonl",
        "fileBytes":file_bytes,"pages":pages,"deepSelected":selected,"chunkPages":chunk,
        "groups":options.groups,"selection":"stratified-v1+largest-content-v1","populationExtrapolated":false,
        "limits":{"fileBytes":WHOLE_FILE_MAX_BYTES,"pages":MAX_PAGES,"decodedBytes":MAX_DECODED,"operations":MAX_DOCUMENT_OPERATIONS,"strictValidationStreamBytes":MAX_STREAM_BYTES,"strictInlineStreamBytes":262144,"gridComparisonsPerPage":MAX_GRID_COMPARISONS_PER_PAGE,"layoutComparisonsPerPage":100000,"layoutWordsPerPage":4096},
        "status":{"0":"not-selected","1":"complete","2":"partial","3":"unreadable","4":"budget-exhausted"},
        "columns":{"inventory":["page","widthPt10","heightPt10","directContentStoredBytes","status","rotation"],
        "diagnostics":["interpretationIncomplete","wordRetentionOverflow","ruleRetentionOverflow","unmappedText","gridWorkExhausted","interpreterFailureFlags","derivedWorkIncomplete","strictFailureClass"],
        "work":["retainedWords","retainedEligibleRules","derivedComparisons","assignedGlyphs","totalEstimatedGlyphs"],
        "text":["words","glyphs","lines","estimatedTextBytes"],"images":["placements","estimatedDrawnStoredBytes","coverage10000","raster"],
        "vectors":["pathOperations","boundsCoverage10000"],"tables":["ruledCandidates","maxRows","coverage10000","estimatedTableTextBytes"],
        "tableCandidates":["count","coverage10000","estimatedTextBytes","confidence"],"unruledTables":["count","coverage10000","estimatedTextBytes","confidence"],
        "captions":["count","coverage10000","estimatedTextBytes","confidence"],"charts":["vectorFigureCandidates","coverage10000","axisEvidence","shortEligibleRules","confidence"],
        "composition":["totalEstimatedTextBytes","tableCandidateBytes","captionCandidateBytes","otherWordBytes","unattributedBytes","known"]},
        "confidence":{"0":"unknown","1":"weak-geometric-evidence","2":"repeated-geometric-evidence","calibrated":false},
        "summaryColumns":["pages","measured","partial","unknown","contentKnownPages","directContentStoredBytes","textKnownPages","estimatedTextBytes","tableKnownPages","estimatedRuledTableTextBytes","layoutKnownPages","allTableCandidateTextBytes","captionCandidateTextBytes","tableCandidatePages","imageKnownPages","imagePages","vectorKnownPages","vectorHeavyPages","unruledCandidatePages","captionCandidatePages","vectorFigureCandidatePages"],
        "interpreterFailureFlags":{"1":"interpreted-byte-budget","2":"invalid-transform","4":"content-decoder","8":"operation-budget","16":"missing-xobject","32":"form-call-budget","64":"form-decode","128":"form-depth","256":"strict-content-validation","512":"image-retention"},
        "methods":{"text":"encoded-string-glyph-estimates-not-unicode-extraction","grid":"orthogonal-contact-sweep-v1","textBytes":"glyph-count-times-2-v1","tableTextBytes":"word-glyph-centres-in-ruled-grids-times-2-v1",
        "tables":"ruled-and-repeated-short-cell-alignment-candidates-v1","captions":"adjacent-short-text-candidates-v1","charts":"non-table-vector-footprint-with-axis-evidence-v1-not-semantic-chart",
        "composition":"exclusive-word-glyphs-table-then-caption-then-other; remainder-unattributed; two-bytes-per-glyph",
        "images":"drawn-significant-includes-furniture","byteTotals":"per-page-references-not-physical-file-allocation"}}),
    )
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
        let header = header(
            bytes.len() as u64,
            pages.len(),
            selected.len(),
            chunk,
            &options,
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
                image_lengths: HashMap::new(),
                rankings: Rankings::default(),
            },
            header,
        ))
    }

    pub(super) fn measure(
        document: Document,
        page: ObjectId,
        options: &Options,
        decoded: usize,
        operations: usize,
        image_lengths: HashMap<ObjectId, usize>,
    ) -> (Evidence, usize, usize) {
        let mut session = Self {
            document,
            pages: vec![page],
            selected: BTreeSet::from([0]),
            options: options.clone(),
            cursor: 0,
            decoded,
            operations,
            attempted: 0,
            measured: 0,
            partial: 0,
            chunk: 1,
            summary: Summary::default(),
            total: Summary::default(),
            image_lengths,
            rankings: Rankings::default(),
        };
        let row = session.evidence(0);
        (row, session.decoded, session.operations)
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
            extra: Default::default(),
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
        let Some(mut reading) = reading else {
            out.status = 3;
            return out;
        };
        for image in &mut reading.images {
            if let Some(length) = image.id.and_then(|id| self.image_lengths.get(&id)) {
                image.bytes_per_pixel =
                    *length as f64 / (image.width_px * image.height_px).max(1.0);
            }
        }
        self.operations += reading.operations;
        out.extra.insert("diagnostics", vec![
            Some(u64::from(reading.exhausted)),
            Some(u64::from(reading.words_overflow)),
            Some(u64::from(reading.rules.overflow)),
            Some(u64::from(reading.unmapped_text)),
            Some(0),
            Some(reading.failure_bits & 65535),
            Some(0),
            Some(reading.failure_bits >> 16),
        ]);
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
            let v = reading.display_visible;
            let coverage = reading
                .vector_bounds
                .map(|b| {
                    ((b[2].min(v[2]) - b[0].max(v[0])).max(0.0)
                        * (b[3].min(v[3]) - b[1].max(v[1])).max(0.0)
                        / ((v[2] - v[0]) * (v[3] - v[1])).max(1e-9))
                    .clamp(0.0, 1.0)
                })
                .unwrap_or(0.0);
            out.vectors = Some([
                reading.path_operations as u64,
                (coverage * 10000.0).round() as u64,
            ]);
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
        let grids = if self.options.groups.iter().any(|g| matches!(g, Group::Tables | Group::Captions | Group::Charts)) {
            layout::ruled_grids_checked(&reading.rules.rules, &Rules::bundled().layout, MAX_GRID_COMPARISONS_PER_PAGE)
        } else { None };
        if grids.is_none() && self.options.groups.iter().any(|g| matches!(g, Group::Tables | Group::Captions | Group::Charts)) {
            out.extra.get_mut("diagnostics").unwrap()[4] = Some(1);
            if out.status == 1 { out.status=2;self.measured-=1;self.partial+=1; }
        }
        if self.options.groups.contains(&Group::Tables) {
            if reading.rules.overflow || reading.exhausted {
                out.tables = Some([None; 4]);
            } else {
                let Some(grids) = grids.as_ref() else {
                    out.tables = Some([None; 4]);
                    out.extra.get_mut("diagnostics").unwrap()[4] = Some(1);
                    if out.status == 1 {
                        out.status = 2;
                        self.measured -= 1;
                        self.partial += 1;
                    }
                    return out;
                };
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
        if self
            .options
            .groups
            .iter()
            .any(|group| matches!(group, Group::Tables | Group::Captions | Group::Charts))
        {
            let supported = grids
                .as_ref()
                .and_then(|grids| supported_grids(grids, &reading.rules.rules));
            let grid_known = supported.is_some() && !reading.rules.overflow;
            if !grid_known {
                out.extra.get_mut("diagnostics").unwrap()[6] = Some(1);
                if out.status == 1 { out.status=2;self.measured-=1;self.partial+=1; }
            }
            let boxes = supported.unwrap_or_default();
            let images: Vec<_> = reading
                .images
                .iter()
                .filter_map(|image| image.placement.map(|p| p.0))
                .collect();
            let words: Vec<_> = reading
                .words_at
                .iter()
                .map(|word| features::Word {
                    x: word.x - word.width / 2.0,
                    y: word.y - word.height / 2.0,
                    width: word.width,
                    height: word.height,
                    glyphs: word.glyphs,
                })
                .collect();
            let layout = features::analyze(
                &words,
                &images,
                &boxes,
                reading.vector_bounds,
                reading.path_operations,
                reading.display_visible,
            );
            let raster = is_raster_page(
                &Rules::bundled().page_raster_routing,
                reading.words,
                &reading.totals(&HashSet::new()),
            );
            out.extra.get_mut("diagnostics").unwrap()[6] = Some(u64::from(layout.partial || !grid_known));
            if layout.partial && out.status == 1 {
                out.status = 2;
                self.measured -= 1;
                self.partial += 1;
            }
            out.extra.insert("work", vec![Some(reading.words_at.len() as u64), Some(reading.rules.rules.len() as u64), Some(layout.pair_comparisons as u64), Some(layout.text.total_glyphs as u64), Some(reading.text.chars as u64)]);
            let known = out.status == 1
                && grid_known
                && !layout.partial
                && !reading.text.estimated
                && reading.text.tiny_dropped == 0.0
                && layout.text.total_glyphs <= reading.text.chars
                && !(raster && reading.words == 0.0);
            let feature = |region: &features::RegionFeature| -> Vec<Option<u64>> {
                if !known {
                    return vec![None, None, None, Some(0)];
                }
                vec![
                    Some(region.regions.len() as u64),
                    region.coverage.map(|v| (v * 10000.0).round() as u64),
                    Some((region.glyphs * 2.0) as u64),
                    Some(match region.confidence {
                        features::Confidence::Low => 1,
                        features::Confidence::Moderate => 2,
                    }),
                ]
            };
            if self.options.groups.contains(&Group::Tables) {
                out.extra.insert("tableCandidates", feature(&layout.tables));
                out.extra
                    .insert("unruledTables", feature(&layout.unruled_tables));
            }
            if self.options.groups.contains(&Group::Captions) {
                out.extra.insert("captions", feature(&layout.captions));
            }
            if self.options.groups.contains(&Group::Charts) {
                let mut horizontal = 0;
                let mut vertical = 0;
                let mut short = 0;
                for b in &reading.rules.rules {
                    let w = b[2] - b[0];
                    let h = b[3] - b[1];
                    horizontal += usize::from(w > 30.0 && h < 2.0);
                    vertical += usize::from(h > 30.0 && w < 2.0);
                    short += usize::from(w.max(h) < 20.0);
                }
                out.extra.insert(
                    "charts",
                    if known {
                        vec![
                            Some(layout.vector_figures.regions.len() as u64),
                            layout
                                .vector_figures
                                .coverage
                                .map(|v| (v * 10000.0).round() as u64),
                            Some(u64::from(horizontal > 0 && vertical > 0)),
                            Some(short as u64),
                            Some(1),
                        ]
                    } else {
                        vec![None, None, None, None, Some(0)]
                    },
                );
            }
            let total = (reading.text.chars * 2.0) as u64;
            let table = (layout.text.table_glyphs * 2.0) as u64;
            let caption = (layout.text.caption_glyphs * 2.0) as u64;
            let other = (layout.text.other_glyphs * 2.0) as u64;
            out.extra.insert(
                "composition",
                if known {
                    vec![
                        Some(total),
                        Some(table),
                        Some(caption),
                        Some(other),
                        Some(total.saturating_sub(table + caption + other)),
                        Some(1),
                    ]
                } else {
                    vec![None, None, None, None, None, Some(0)]
                },
            );
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
            let mut output = if self.options.ranked_pages > 0 {
                line(self.rankings.record())
            } else {
                String::new()
            };
            output.push_str(&line(
                json!({"t":"end","complete":true,"inventoryPages":self.pages.len(),
                "deepSelected":self.selected.len(),"deepAttempted":self.attempted,"deepMeasured":self.measured,
                "deepPartial":self.partial,"decodedBytes":self.decoded,"operations":self.operations,"deepComplete":self.measured==self.selected.len(),
                "totals":self.total.record("totals",1)}),
            ));
            return Some(output);
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
            if let Value::Object(groups) = row.features(index + 1) {
                for (name, values) in groups {
                    features
                        .entry(name)
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .unwrap()
                        .extend(values.as_array().unwrap().iter().cloned());
                }
            }
            self.rankings
                .add(index + 1, &row, self.options.ranked_pages);
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
