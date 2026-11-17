//! How math and tables are encoded on a sampled page, as a bit mask (`PDF_PAGE_ENCODING_BITS` in `@docslurp/shared`),
//! from the page's own content stream and the document's structure tree. Written from the PDF specification (ISO 32000:
//! fonts, Type 3 glyph procedures, marked content and ActualText, logical structure, associated files) and the OpenType
//! table directory. Facts only: font names, text and element text are read to classify into the fixed vocabulary of the
//! bits and never leave this module.

use std::collections::{HashMap, HashSet};

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::rules::PageEncodingRules;

/// Font classes, a bit set per font (cached per font object).
pub const FONT_MATH: u8 = 1;
/// A symbol font that sets math in some routes and bullets in others: its glyphs count as math only inside a line.
pub const FONT_SYMBOL: u8 = 2;
pub const FONT_TYPE3_BITMAP: u8 = 4;
pub const FONT_UNMAPPED: u8 = 8;
/// The class could not be decided (a read refused by the budget, an unsupported filter, too many glyph procedures):
/// glyphs shown in it make the page partial.
pub const FONT_UNKNOWN: u8 = 16;

/// Runs, outline paths and images kept per page; past them the page's mask is partial.
const MAX_RUNS: usize = 8_192;
const MAX_OUTLINE_PATHS: usize = 4_096;
const MAX_IMAGES: usize = 64;
/// Box comparisons when clustering a page's outline paths.
const MAX_OUTLINE_COMPARISONS: usize = 4_000_000;
/// Type 3 glyph procedures and decoded bytes of each read to tell a bitmap font (an image is painted at the start of a
/// procedure), and bytes of a font program's head (its table directory, up to 63 tables).
const TYPE3_PROCS_READ: usize = 256;
const TYPE3_PROC_BYTES: u64 = 4 * 1024;
const FONT_HEAD_BYTES: u64 = 12 + 16 * 63;
/// Compressed bytes read from any stream: a Flate stream of empty blocks decodes to nothing however long it is.
const MAX_COMPRESSED_READ: usize = 64 * 1024;
/// Bytes of a text string (ActualText, Alt) or a file name looked at, and ActualText strings checked per page.
const TEXT_PREFIX_BYTES: usize = 4 * 1024;
const NAME_PREFIX_BYTES: usize = 256;
/// Bytes of ActualText prefixes checked per page; past them the page is partial.
const MAX_TEXT_BYTES_PER_PAGE: usize = 1024 * 1024;
/// Work units (comparisons) the page-level geometry may spend per page; past it the page is partial.
const PAGE_WORK: usize = 4_000_000;

/// Bytes the encoding facts may still read (compressed plus decoded), charged to the document's content budget by the
/// caller; `refused` once a read did not fit.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub left: usize,
    pub refused: bool,
}

impl Budget {
    pub fn new(left: usize) -> Self { Self { left, refused: false } }
    fn take(&mut self, bytes: usize) -> bool {
        match self.left.checked_sub(bytes) {
            Some(left) => { self.left = left; true }
            None => { self.left = 0; self.refused = true; false }
        }
    }
}

/// Comparisons left for one page's geometry; `spend` is false (and stays false) once they run out.
struct Work(usize, bool);

impl Work {
    fn spend(&mut self, units: usize) -> bool {
        match self.0.checked_sub(units) {
            Some(left) if self.1 => { self.0 = left; true }
            _ => { self.0 = 0; self.1 = false; false }
        }
    }
}

/// One shown string in displayed coordinates (y down): its start and estimated end along the baseline, its baseline,
/// its effective size, and whether its font is math-class.
#[derive(Debug, Clone, Copy)]
pub struct Run {
    pub x0: f64,
    pub x1: f64,
    pub y: f64,
    pub size: f64,
    pub math: bool,
    /// Shown in a symbol font (math inside a line, a bullet at its start; decided when the page is done).
    pub symbol: bool,
    pub unmapped: bool,
    pub glyphs: f64,
}

/// What the interpreter collects on one page for the mask.
#[derive(Debug, Default, Clone)]
pub struct PageEncoding {
    /// The class of the font in force (`Tf`).
    pub font: u8,
    pub runs: Vec<Run>,
    pub runs_overflow: bool,
    /// Filled paths with curves: their displayed box and curve count.
    pub outlines: Vec<([f64; 4], u32)>,
    pub outlines_overflow: bool,
    /// Formula-strip and table-shaped images (their object, if any, so furniture can be dropped).
    pub strips: Vec<Option<ObjectId>>,
    pub table_images: Vec<Option<ObjectId>>,
    pub images_overflow: bool,
    pub math_glyphs: f64,
    pub mapped_math: bool,
    pub unmapped_math: bool,
    pub type3_bitmap: bool,
    pub actual_text: bool,
    pub tex_source: bool,
    /// Bytes of ActualText prefixes checked for TeX-like source on the page.
    pub text_checked: usize,
    /// A fact on the page could not be decided (a font class, a capped check): the mask is partial.
    pub unknown: bool,
}

impl PageEncoding {
    /// A string of `glyphs` glyphs shown in the font in force.
    pub fn shown(&mut self, run: Run, glyphs: f64) {
        let font = self.font;
        let math = font & FONT_MATH != 0;
        let unmapped = font & FONT_UNMAPPED != 0;
        if math {
            self.math_glyphs += glyphs;
            if unmapped { self.unmapped_math = true; } else { self.mapped_math = true; }
        }
        if font & FONT_TYPE3_BITMAP != 0 { self.type3_bitmap = true; }
        if font & FONT_UNKNOWN != 0 { self.unknown = true; }
        let run = Run { math, symbol: font & FONT_SYMBOL != 0 && !math, unmapped, glyphs, ..run };
        if self.runs.len() < MAX_RUNS { self.runs.push(run); } else { self.runs_overflow = true; }
    }

    /// A painted path: kept for outline clustering when it is filled, has curves and is small.
    /// Replacement text marked on the page: TeX-like text is a recoverable source. A bounded prefix of each string is
    /// checked, `MAX_TEXT_BYTES_PER_PAGE` of them a page (short ligature texts barely count); past that the page is
    /// partial.
    pub fn actual_text(&mut self, text: &[u8]) {
        self.actual_text = true;
        if self.tex_source { return; }
        let prefix = text.len().min(TEXT_PREFIX_BYTES);
        if self.text_checked + prefix > MAX_TEXT_BYTES_PER_PAGE { self.unknown = true; return; }
        self.text_checked += prefix;
        self.tex_source = tex_like(text);
    }

    pub fn painted(&mut self, fill: bool, curves: u32, bbox: Option<[f64; 4]>, rules: &PageEncodingRules) {
        let Some(b) = bbox else { return };
        if !fill || curves == 0 || (b[2] - b[0]).max(b[3] - b[1]) > rules.outline_max_side_pt { return; }
        if self.outlines.len() < MAX_OUTLINE_PATHS { self.outlines.push((b, curves)); } else { self.outlines_overflow = true; }
    }

    /// An image placed at displayed box `b` on a page whose visible box is `v`: a formula strip by its shape, a
    /// table-shaped image by shape, size and a lossless encoding. `significant` images only can be table-shaped.
    #[allow(clippy::too_many_arguments)]
    pub fn image(&mut self, rules: &PageEncodingRules, id: Option<ObjectId>, b: [f64; 4], v: [f64; 4], pixels: (f64, f64), significant: bool, lossy: bool) {
        let (w, h) = (b[2] - b[0], b[3] - b[1]);
        let (vw, vh) = ((v[2] - v[0]).max(1e-9), (v[3] - v[1]).max(1e-9));
        if !(w > 0.0 && h > 0.0) { return; }
        let strip = h >= rules.strip_min_height_pt && h <= rules.strip_max_height_pt && w / h >= rules.strip_min_aspect
            && w * h <= rules.strip_max_page_share * vw * vh && w <= rules.strip_max_width_share * vw
            && pixels.0 >= 16.0 && pixels.1 >= 4.0;
        let share = w * h / (vw * vh);
        let table = significant && !lossy && h >= rules.table_image_min_height_pt && share >= rules.table_image_min_page_share
            && share <= rules.table_image_max_page_share && w >= rules.table_image_min_width_share * vw
            && w / h >= rules.table_image_min_aspect && w / h <= rules.table_image_max_aspect;
        for (wanted, list) in [(strip, &mut self.strips), (table, &mut self.table_images)] {
            if wanted {
                if list.len() < MAX_IMAGES { list.push(id); } else { self.images_overflow = true; }
            }
        }
    }
}

/// The rest of a page's reading the mask needs.
pub struct PageView<'a> {
    pub visible: [f64; 4],
    pub chars: f64,
    pub words: f64,
    /// Word boxes in displayed coordinates; `words_known` false when the page kept fewer than it had.
    pub words_at: &'a [[f64; 4]],
    pub words_known: bool,
    /// Ruling lines in displayed coordinates; `rules_known` false past the walker's cap.
    pub rules: &'a [[f64; 4]],
    pub rules_known: bool,
    pub rule_thickness: f64,
    /// Ruled grids found (None: unknown).
    pub grids: Option<usize>,
    pub exhausted: bool,
    pub images: usize,
    pub path_operations: usize,
    pub repeated: &'a HashSet<ObjectId>,
    /// Bits from the structure tree for this page.
    pub tagged: u16,
    /// The document carries a MathML associated file.
    pub document_mathml: bool,
}

/// Sort values ascending, keeping where each came from: the one sort the encoding facts instantiate (each sort
/// closure costs the module its own copy of the sort).
pub fn sorted_keys(keys: impl Iterator<Item = f64>) -> Vec<(f64, usize)> {
    let mut keys: Vec<(f64, usize)> = keys.enumerate().map(|(index, key)| (key, index)).collect();
    keys.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    keys
}

/// The page's encoding mask and its packed stat counts (`PDF_PAGE_STAT_COUNTS`). The geometry below shares one work
/// budget per page (`PAGE_WORK`); a check that runs out of it is unknown and the page partial.
pub fn page_mask(rules: &PageEncodingRules, page: &PageEncoding, view: &PageView<'_>) -> (u16, u32) {
    let bits = &rules.bits;
    let mut work = Work(PAGE_WORK, true);
    // Symbol-font runs are math inside a line (another run on their baseline ends before them), bullets otherwise.
    let mut runs = page.runs.clone();
    let symbols: Vec<usize> = (0..runs.len()).filter(|i| runs[*i].symbol).take(512).collect();
    let (mut symbol_glyphs, mut symbol_unmapped) = (0.0, false);
    for i in symbols {
        if !work.spend(runs.len()) { break; }
        let s = runs[i];
        let inside = runs.iter().any(|o| !o.symbol && (o.y - s.y).abs() <= 0.3 * s.size.max(o.size) && o.x1 <= s.x0 + 0.5 * s.size && s.x0 - o.x1 <= 3.0 * s.size);
        if inside {
            runs[i].math = true;
            symbol_glyphs += s.glyphs;
            symbol_unmapped |= s.unmapped;
        }
    }
    let symbol_math = symbol_glyphs >= 2.0;
    let mut mask = view.tagged;
    let mut set = |bit: u8, on: bool| if on { mask |= 1 << bit };
    // Symbol fonts count as math with two or more glyphs inside lines.
    set(bits.math_font, page.mapped_math || (symbol_math && !symbol_unmapped));
    set(bits.unmapped_math_font, page.unmapped_math || (symbol_math && symbol_unmapped));
    set(bits.type3_bitmap_font, page.type3_bitmap);
    set(bits.actual_text, page.actual_text);
    set(bits.math_source, page.tex_source);
    let kept = |list: &Vec<Option<ObjectId>>| list.iter().filter(|id| !id.is_some_and(|id| view.repeated.contains(&id))).count();
    let strips = if view.chars >= rules.strip_min_page_chars { kept(&page.strips) } else { 0 };
    set(bits.formula_strip, strips > 0);
    set(bits.table_image, view.words >= rules.table_image_min_page_words && kept(&page.table_images) > 0);
    let (clusters, clusters_known) = outline_clusters(rules, &page.outlines);
    set(bits.glyph_outlines, clusters >= rules.outline_min_clusters as usize);
    let math_runs: Vec<&Run> = runs.iter().filter(|run| run.math).collect();
    let any_math = page.mapped_math || page.unmapped_math || symbol_math;
    set(bits.stacked_math, any_math && (stacked(rules, &math_runs, &mut work) || fraction_bar(rules, view, &runs, &mut work)));
    set(bits.math_grid, math_grid(&math_runs, &runs, view.rules, view.rule_thickness, &page.outlines, &mut work));
    set(bits.rule_grid, view.grids.is_some_and(|grids| grids > 0));
    let rule_table = if view.words_known && view.rules_known { horizontal_rule_table(rules, view, &mut work) } else { false };
    set(bits.horizontal_rule_table, rule_table);
    // Unknown words matter only where a horizontal-rule table could be: enough long horizontal rules.
    let table_rules = view.rules.iter().filter(|r| r[3] - r[1] <= view.rule_thickness && r[2] - r[0] >= rules.rule_table_min_rule_length_pt).count();
    let words_matter = table_rules >= rules.rule_table_min_rules as usize;
    let partial = view.exhausted || page.runs_overflow || page.outlines_overflow || page.images_overflow || !clusters_known
        || (!view.words_known && words_matter) || !view.rules_known || view.grids.is_none() || page.unknown || !work.1;
    set(bits.partial, partial);
    // A document-level MathML file is the source of the math this page shows.
    let math_bits: u16 = (1 << bits.math_font) | (1 << bits.unmapped_math_font) | (1 << bits.formula_strip) | (1 << bits.glyph_outlines) | (1 << bits.type3_bitmap_font);
    if view.document_mathml && mask & math_bits != 0 { mask |= 1 << bits.math_source; }
    let mut counts = 0u32;
    let values = [view.words, view.chars, page.math_glyphs + if symbol_math { symbol_glyphs } else { 0.0 }, view.images as f64, view.path_operations as f64, view.rules.len() as f64, clusters as f64, strips as f64];
    for (index, value) in values.into_iter().enumerate() {
        counts |= u32::from(stat_bucket(value)) << (4 * index);
    }
    (mask, counts)
}

/// `pdfPageStatBucket`: 0 for none, else min(15, floor(log2 n) + 1).
pub fn stat_bucket(value: f64) -> u8 {
    if !(value >= 1.0) { return 0; }
    (value.log2().floor() as i64 + 1).clamp(1, 15) as u8
}

/// Qualifying glyph-outline clusters: filled curve paths merged when their boxes come within the gap; a cluster counts
/// when it stays small and is curve-dense. The second value is false when the comparison budget ran out.
fn outline_clusters(rules: &PageEncodingRules, paths: &[([f64; 4], u32)]) -> (usize, bool) {
    if paths.len() < rules.outline_min_clusters as usize { return (0, true); }
    let gap = rules.outline_gap_pt;
    let order: Vec<usize> = sorted_keys(paths.iter().map(|path| path.0[0])).into_iter().map(|(_, index)| index).collect();
    let mut parent: Vec<usize> = (0..paths.len()).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i { parent[i] = parent[parent[i]]; i = parent[i]; }
        i
    }
    let mut compared = 0usize;
    let mut known = true;
    'outer: for (k, &i) in order.iter().enumerate() {
        let a = paths[i].0;
        for &j in &order[k + 1..] {
            let b = paths[j].0;
            if b[0] > a[2] + gap { break; }
            compared += 1;
            if compared > MAX_OUTLINE_COMPARISONS { known = false; break 'outer; }
            if b[1] <= a[3] + gap && a[1] <= b[3] + gap {
                let (x, y) = (find(&mut parent, i), find(&mut parent, j));
                parent[x] = y;
            }
        }
    }
    let mut groups: Vec<([f64; 4], u32, u32)> = vec![([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], 0, 0); paths.len()];
    for (i, (b, curves)) in paths.iter().enumerate() {
        let root = find(&mut parent, i);
        let entry = &mut groups[root];
        entry.0 = [entry.0[0].min(b[0]), entry.0[1].min(b[1]), entry.0[2].max(b[2]), entry.0[3].max(b[3])];
        entry.1 += curves;
        entry.2 += 1;
    }
    let count = groups.iter().filter(|(b, curves, members)| {
        *members > 0 && (b[2] - b[0]).max(b[3] - b[1]) <= rules.outline_max_side_pt && *curves >= rules.outline_min_curves
            && *curves >= rules.outline_min_curves_per_path * members
    }).count();
    (count, known)
}

/// Two math runs over each other: their spans overlap across and their baselines lie between the stacked bounds apart.
fn stacked(rules: &PageEncodingRules, runs: &[&Run], work: &mut Work) -> bool {
    let sorted: Vec<&Run> = sorted_keys(runs.iter().map(|run| run.x0)).into_iter().map(|(_, index)| runs[index]).collect();
    for (k, a) in sorted.iter().enumerate() {
        for b in &sorted[k + 1..] {
            if b.x0 >= a.x1 { break; }
            if !work.spend(1) { return false; }
            let em = a.size.max(b.size).max(1e-6);
            let apart = (a.y - b.y).abs() / em;
            if apart > rules.stacked_min_baseline_em && apart < rules.stacked_max_baseline_em { return true; }
        }
    }
    false
}

/// A short horizontal rule with a run starting right above it and another right below, both over its span.
fn fraction_bar(rules: &PageEncodingRules, view: &PageView<'_>, runs: &[Run], work: &mut Work) -> bool {
    view.rules.iter().any(|r| {
        let (len, thick) = (r[2] - r[0], r[3] - r[1]);
        if !(thick <= view.rule_thickness.min(1.5) && len >= 3.0 && len <= rules.fraction_bar_max_length_pt) { return false; }
        if !work.spend(2 * runs.len()) { return false; }
        let y = (r[1] + r[3]) / 2.0;
        let over = |run: &&Run| run.x1 > r[0] && run.x0 < r[2];
        let reach = |run: &&Run| rules.fraction_bar_reach_em * run.size.max(1.0);
        // Displayed y grows downwards: a numerator's baseline sits above the bar, a denominator's below.
        let above = runs.iter().filter(over).any(|run| run.y < y && y - run.y <= reach(&run));
        let below = runs.iter().filter(over).any(|run| run.y > y && run.y - y <= reach(&run) + run.size);
        above && below
    })
}

/// Math runs in a grid: two rows of two or more runs each (baselines 0.9 to 2.5 em apart) sharing two or more columns
/// (centres within half an em, columns at least an em apart), with a delimiter left of the first column spanning both
/// rows (stacked glyph pieces, one tall glyph, a short vertical rule or a tall filled path) and no fraction bar between
/// the rows. Rows of one run are ignored; aligned equations and tables have no such delimiter.
fn math_grid(runs: &[&Run], all: &[Run], rules: &[[f64; 4]], thin: f64, outlines: &[([f64; 4], u32)], work: &mut Work) -> bool {
    if runs.len() < 4 { return false; }
    let mut rows: Vec<(f64, f64, Vec<f64>)> = Vec::new();
    for run in runs.iter().take(1_024) {
        if !work.spend(rows.len().max(1)) { return false; }
        let centre = (run.x0 + run.x1) / 2.0;
        match rows.iter_mut().find(|row| (row.0 - run.y).abs() <= 0.15 * run.size.max(row.1)) {
            Some(row) => row.2.push(centre),
            None => rows.push((run.y, run.size, vec![centre])),
        }
        if rows.len() > 256 { break; }
    }
    // Script-size rows (limits and indices beside a big operator, pieces of a drawn bracket) are not matrix rows:
    // entries are set at about the page's usual text size.
    let sizes = sorted_keys(all.iter().map(|run| run.size));
    if sizes.is_empty() { return false; }
    let usual = sizes[sizes.len() / 2].0;
    rows.retain(|row| row.2.len() >= 2 && row.1 >= 0.8 * usual);
    let order = sorted_keys(rows.iter().map(|row| row.0));
    for (k, first) in order.iter().enumerate() {
        for second in &order[k + 1..] {
            let (a, b) = (&rows[first.1], &rows[second.1]);
            let em = a.1.max(b.1).max(1e-6);
            let apart = (b.0 - a.0) / em;
            if apart > 2.5 { break; }
            if apart < 0.9 { continue; }
            if !work.spend(a.2.len() * b.2.len()) { return false; }
            let mut columns: Vec<f64> = sorted_keys(a.2.iter().filter(|x| b.2.iter().any(|y| (*x - y).abs() <= 0.5 * em)).copied()).into_iter().map(|(x, _)| x).collect();
            columns.dedup_by(|x, y| (*x - *y).abs() < em);
            if columns.len() < 2 { continue; }
            if !work.spend(all.len() + 2 * rules.len() + outlines.len()) { return false; }
            let (top, bottom, left) = (a.0, b.0, columns[0]);
            let right = *columns.last().unwrap_or(&left);
            // A horizontal rule between the rows under the columns is a fraction bar: stacked fractions, not a grid.
            if rules.iter().any(|r| r[3] - r[1] <= thin && r[2] - r[0] >= 0.5 * em && r[1] > top && r[3] < bottom && r[2] > left - em && r[0] < right + em) { continue; }
            let span = bottom - top;
            // A delimiter in the window `[from, to]` spanning both rows: extension pieces of one tall glyph (at one x,
            // baselines at most 1.2 em apart, chained from the first row to the second; a column of "=" signs starting
            // aligned lines sits a line apart), one glyph set large, a short vertical rule, or a tall filled path.
            let mut delimiter = |from: f64, to: f64| -> Option<bool> {
                let beside = |x: f64| x >= from && x <= to;
                let pieces: Vec<&Run> = all.iter().filter(|run| beside((run.x0 + run.x1) / 2.0) && run.y >= top - 3.0 * em && run.y <= bottom + 3.0 * em).collect();
                if !work.spend(pieces.len() * pieces.len() + rules.len() + outlines.len()) { return None; }
                let stacked = pieces.iter().any(|p| {
                    let column: Vec<f64> = sorted_keys(pieces.iter().filter(|q| (q.x0 - p.x0).abs() <= 0.3 * em).map(|q| q.y)).into_iter().map(|(y, _)| y).collect();
                    let mut start = f64::NAN;
                    column.iter().enumerate().any(|(i, y)| {
                        if i == 0 || *y - column[i - 1] > 1.2 * em { start = *y; }
                        i > 0 && start != *y && start <= top && *y >= bottom - 0.3 * em
                    })
                });
                let tall = pieces.iter().any(|p| p.math && p.size >= 1.6 * em && p.y >= top && p.y <= bottom + p.size);
                let ruled = rules.iter().any(|r| r[2] - r[0] <= thin && beside((r[0] + r[2]) / 2.0) && r[1] <= top && r[3] >= bottom - 0.5 * em && r[3] - r[1] <= span + 4.0 * em);
                let drawn = outlines.iter().any(|(o, _)| beside((o[0] + o[2]) / 2.0) && o[1] <= top && o[3] >= bottom - 0.5 * em && o[3] - o[1] <= span + 4.0 * em);
                Some(stacked || tall || ruled || drawn)
            };
            // Delimiters on both sides: a big operator's limits (an integral sign left, the integrand right) or aligned
            // lines are not a matrix.
            let (Some(opens), Some(closes)) = (delimiter(left - 3.0 * em, left - 0.2 * em), delimiter(right + 0.2 * em, right + 3.0 * em)) else { return false };
            if opens && closes { return true; }
        }
    }
    false
}

/// A table drawn with horizontal rules only: at least `rule_table_min_rules` rules sharing both ends, no vertical rule
/// across them, the first gap holding a header row, some gap holding two or more rows, and two rows with a column gap.
fn horizontal_rule_table(rules: &PageEncodingRules, view: &PageView<'_>, work: &mut Work) -> bool {
    let thin = view.rule_thickness;
    let tolerance = rules.rule_table_end_tolerance_pt;
    let horizontals: Vec<[f64; 4]> = view.rules.iter().filter(|r| r[3] - r[1] <= thin && r[2] - r[0] >= rules.rule_table_min_rule_length_pt).copied().collect();
    let verticals: Vec<[f64; 4]> = view.rules.iter().filter(|r| r[2] - r[0] <= thin && r[3] - r[1] >= 8.0).copied().collect();
    let page_height = view.visible[3] - view.visible[1];
    let mut tried: Vec<(f64, f64)> = Vec::new();
    for h in horizontals.iter().take(512) {
        if !work.spend(tried.len() + horizontals.len()) { return false; }
        if tried.iter().any(|(x0, x1)| (x0 - h[0]).abs() <= tolerance && (x1 - h[2]).abs() <= tolerance) { continue; }
        tried.push((h[0], h[2]));
        let mut ys: Vec<f64> = sorted_keys(horizontals.iter()
            .filter(|o| (o[0] - h[0]).abs() <= tolerance && (o[2] - h[2]).abs() <= tolerance)
            .map(|o| (o[1] + o[3]) / 2.0)).into_iter().map(|(y, _)| y).collect();
        ys.dedup_by(|a, b| (*a - *b).abs() <= 1.5);
        if ys.len() < rules.rule_table_min_rules as usize { continue; }
        let (top, bottom) = (ys[0], *ys.last().unwrap_or(&ys[0]));
        if bottom - top > 0.8 * page_height { continue; }
        if !work.spend(verticals.len() + view.words_at.len()) { return false; }
        if verticals.iter().any(|v| v[0] >= h[0] - tolerance && v[2] <= h[2] + tolerance && v[1] < bottom && v[3] > top) { continue; }
        let words: Vec<&[f64; 4]> = view.words_at.iter().filter(|w| {
            let (cx, cy) = ((w[0] + w[2]) / 2.0, (w[1] + w[3]) / 2.0);
            cx >= h[0] && cx <= h[2] && cy > top && cy < bottom
        }).collect();
        let rows = rows_of(&words);
        let in_gap = |a: f64, b: f64| rows.iter().filter(|row| row.0 > a && row.0 < b).count();
        if in_gap(ys[0], ys[1]) == 0 || !ys.windows(2).any(|pair| in_gap(pair[0], pair[1]) >= 2) { continue; }
        let gapped = rows.iter().filter(|row| row.1).count();
        if gapped >= 2 { return true; }
    }
    false
}

/// Word rows by centre line: each row's centre and whether two neighbouring words in it sit a column gap (an em) apart.
fn rows_of(words: &[&[f64; 4]]) -> Vec<(f64, bool)> {
    let words = &words[..words.len().min(4_096)];
    let mut rows: Vec<(f64, f64, Vec<[f64; 4]>)> = Vec::new();
    for (_, index) in sorted_keys(words.iter().map(|w| w[1] + w[3])) {
        let w = &words[index];
        let (cy, height) = ((w[1] + w[3]) / 2.0, w[3] - w[1]);
        match rows.last_mut() {
            Some(row) if (cy - row.0).abs() <= 0.4 * height.max(row.1) => row.2.push(**w),
            _ => rows.push((cy, height, vec![**w])),
        }
    }
    rows.into_iter().map(|(cy, height, boxes)| {
        let boxes: Vec<[f64; 4]> = sorted_keys(boxes.iter().map(|b| b[0])).into_iter().map(|(_, index)| boxes[index]).collect();
        let gapped = boxes.windows(2).any(|pair| pair[1][0] - pair[0][2] >= height.max(1.0));
        (cy, gapped)
    }).collect()
}

/// A font's class: math by name or by an OpenType MATH table, a symbol font, a Type 3 font that paints images, and no
/// Unicode mapping (`unmapped`, decided by the caller's rule). Stream reads are charged to `budget`; one it refuses, an
/// unsupported filter or glyph procedures past the cap make the class `FONT_UNKNOWN` rather than "not math".
pub fn font_class(document: &Document, font: &Dictionary, unmapped: bool, budget: &mut Budget) -> u8 {
    let name_of = |dict: &Dictionary, key: &[u8]| match dict.get(key).ok().and_then(|o| document.dereference(o).ok()).map(|(_, v)| v) {
        Some(Object::Name(value)) => Some(value.clone()),
        _ => None,
    };
    let mut class = if unmapped { FONT_UNMAPPED } else { 0 };
    let descendant = match font.get(b"DescendantFonts").ok().and_then(|o| document.dereference(o).ok()).map(|(_, v)| v) {
        Some(Object::Array(fonts)) => fonts.first().and_then(|o| document.dereference(o).ok()).and_then(|(_, v)| v.as_dict().ok()),
        _ => None,
    };
    let descriptor = descendant.unwrap_or(font).get(b"FontDescriptor").ok().and_then(|o| document.dereference(o).ok()).and_then(|(_, v)| v.as_dict().ok());
    // The font's name: BaseFont, a Type 3 font's Name, else its descriptor's FontName (browsers name Type 3 fonts there).
    let base = name_of(font, b"BaseFont").or_else(|| name_of(font, b"Name")).or_else(|| descriptor.and_then(|d| name_of(d, b"FontName"))).unwrap_or_default();
    let base = &base[..base.len().min(NAME_PREFIX_BYTES)];
    // A subset tag (six capitals and a plus) is not part of the name.
    let base = if base.len() > 7 && base[6] == b'+' && base[..6].iter().all(u8::is_ascii_uppercase) { &base[7..] } else { base };
    class |= name_class(base).unwrap_or(0);
    if name_of(font, b"Subtype").is_some_and(|subtype| subtype == b"Type3") {
        // Type 3 glyphs are procedures: a bitmap font paints images.
        return class | match type3_paints_images(document, font, budget) { Some(true) => FONT_TYPE3_BITMAP, Some(false) => 0, None => FONT_UNKNOWN };
    }
    if class & (FONT_MATH | FONT_SYMBOL) != 0 { return class; }
    // An OpenType or TrueType program with a MATH table.
    if let Some(descriptor) = descriptor {
        for key in [&b"FontFile2"[..], b"FontFile3"] {
            if let Some((_, Object::Stream(program))) = descriptor.get(key).ok().and_then(|o| document.dereference(o).ok()) {
                match stream_head(program, FONT_HEAD_BYTES, budget) {
                    Some(head) if has_math_table(&head) => return class | FONT_MATH,
                    Some(_) => {}
                    None => class |= FONT_UNKNOWN,
                }
            }
        }
    }
    class
}

/// The fixed vocabulary of math font names: TeX math families (Computer Modern, AMS, Euler, newtx/px, Latin Modern
/// math), any name with "math" (OpenType math fonts, Cambria Math, KaTeX_Math), web math fonts (KaTeX_*, MathJax_*),
/// the math-only STIX 1 families;
/// Symbol and OpenSymbol are symbol fonts.
pub fn name_class(name: &[u8]) -> Option<u8> {
    let lower: Vec<u8> = name.iter().map(u8::to_ascii_lowercase).collect();
    let starts = |prefix: &[u8]| lower.starts_with(prefix);
    let contains = |needle: &[u8]| lower.windows(needle.len()).any(|window| window == needle);
    const TEX: [&[u8]; 22] = [b"cmmi", b"cmsy", b"cmex", b"cmbsy", b"msam", b"msbm", b"eufm", b"eufb", b"eusm", b"eusb", b"euex",
        b"rsfs", b"txmi", b"txsy", b"txex", b"pxmi", b"pxsy", b"pxex", b"ntxmi", b"ntxsy", b"ntxex", b"zplm"];
    // STIX 1 sets math in its size, integral, variant and non-Unicode families (STIXGeneral also sets text).
    const STIX: [&[u8]; 4] = [b"stixsize", b"stixintegrals", b"stixvariants", b"stixnonunicode"];
    if contains(b"math") || TEX.iter().any(|prefix| starts(prefix)) || STIX.iter().any(|prefix| starts(prefix)) || starts(b"katex_") || starts(b"mathjax_") || starts(b"newtxmi") {
        return Some(FONT_MATH);
    }
    if starts(b"symbol") || starts(b"standardsym") || starts(b"opensymbol") {
        return Some(FONT_SYMBOL);
    }
    None
}

/// The OpenType table directory lists a MATH table.
pub fn has_math_table(head: &[u8]) -> bool {
    if head.len() < 12 || !matches!(&head[..4], [0, 1, 0, 0] | b"OTTO" | b"true") { return false; }
    let tables = usize::from(u16::from_be_bytes([head[4], head[5]]));
    (0..tables).map(|i| 12 + 16 * i).take_while(|at| at + 4 <= head.len()).any(|at| &head[at..at + 4] == b"MATH")
}

/// Whether a Type 3 font's glyph procedures paint images: an inline image, or an image XObject from the font's own
/// resources (a procedure drawing a form is vector drawing). None when a procedure could not be read or there were more
/// than `TYPE3_PROCS_READ` and none painted an image.
fn type3_paints_images<'a>(document: &'a Document, font: &'a Dictionary, budget: &mut Budget) -> Option<bool> {
    // Borrowed, never copied: many fonts may share one huge resource dictionary; 64 entries are looked at.
    let dict_of = |object: &'a Object| -> Option<&'a Dictionary> {
        match document.dereference(object).ok()?.1 {
            Object::Dictionary(dict) => Some(dict),
            Object::Stream(stream) => Some(&stream.dict),
            _ => None,
        }
    };
    let images = font.get(b"Resources").ok().and_then(|resources| dict_of(resources)).and_then(|resources| resources.get(b"XObject").ok()).and_then(|xobjects| dict_of(xobjects))
        .is_some_and(|xobjects| xobjects.iter().take(64).any(|(_, x)| dict_of(x).is_some_and(|dict| matches!(dict.get(b"Subtype"), Ok(Object::Name(kind)) if kind == b"Image"))));
    let Some((_, Object::Dictionary(procs))) = font.get(b"CharProcs").ok().and_then(|o| document.dereference(o).ok()) else { return Some(false) };
    for (_, proc) in procs.iter().take(TYPE3_PROCS_READ) {
        if let Some((_, Object::Stream(stream))) = document.dereference(proc).ok() {
            let content = stream_head(stream, TYPE3_PROC_BYTES, budget)?;
            if has_token(&content, b"BI") || (images && has_token(&content, b"Do")) { return Some(true); }
        }
    }
    (procs.len() <= TYPE3_PROCS_READ).then_some(false)
}

fn has_token(content: &[u8], token: &[u8]) -> bool {
    let delimiter = |byte: Option<&u8>| byte.is_none_or(|b| b.is_ascii_whitespace() || b"[]()<>/%".contains(b));
    content.windows(token.len()).enumerate().any(|(at, window)| window == token && delimiter(at.checked_sub(1).and_then(|i| content.get(i))) && delimiter(content.get(at + token.len())))
}

/// At most `max` decoded bytes from the start of a stream, reading at most `MAX_COMPRESSED_READ` compressed bytes:
/// unfiltered or Flate only. The bytes read and decoded are charged to `budget`; None when it refuses them or the filter is
/// another (unknown, not "absent").
pub fn stream_head(stream: &lopdf::Stream, max: u64, budget: &mut Budget) -> Option<Vec<u8>> {
    let flate = |name: &Vec<u8>| name == b"FlateDecode" || name == b"Fl";
    let compressed = match stream.dict.get(b"Filter").ok() {
        None => false,
        Some(Object::Name(name)) if flate(name) => true,
        Some(Object::Array(filters)) if filters.len() == 1 && matches!(&filters[0], Object::Name(name) if flate(name)) => true,
        _ => return None,
    };
    if !compressed {
        let head = &stream.content[..stream.content.len().min(max as usize)];
        return budget.take(head.len()).then(|| head.to_vec());
    }
    let input = &stream.content[..stream.content.len().min(MAX_COMPRESSED_READ)];
    // Refuse before decoding once the budget cannot hold the output; the input consumed is charged after (a decode
    // reads at most the capped slice).
    if budget.left < max as usize { budget.take(usize::MAX); return None; }
    // Fed 1 KiB at a time, so the decoder consumes about the input the output needs (it would otherwise fill its
    // whole window from a larger slice), and stops at `max` bytes or the end of the stream.
    let mut decoder = flate2::Decompress::new(true);
    let mut out = Vec::with_capacity(max as usize);
    let mut ended = false;
    while out.len() < max as usize && (decoder.total_in() as usize) < input.len() {
        let at = decoder.total_in() as usize;
        let chunk = &input[at..input.len().min(at + 1024)];
        let before = (decoder.total_in(), out.len());
        match decoder.decompress_vec(chunk, &mut out, flate2::FlushDecompress::None) {
            Ok(flate2::Status::StreamEnd) => { ended = true; break; }
            Ok(_) if (decoder.total_in(), out.len()) == before => break,
            Ok(_) => {}
            Err(_) => { budget.take(decoder.total_in() as usize + out.len()); return None; }
        }
    }
    // Charge what was consumed and produced, not the slice offered.
    if !budget.take(decoder.total_in() as usize + out.len()) { return None; }
    // A stream cut by the compressed cap (or stalled) before `max` bytes or its end is unknown, not empty.
    if out.len() < max as usize && !ended { return None; }
    out.truncate(max as usize);
    Some(out)
}

/// TeX commands whose presence marks replacement text as formula source.
const TEX_COMMANDS: [&[u8]; 32] = [b"frac", b"dfrac", b"tfrac", b"sqrt", b"sum", b"int", b"prod", b"lim", b"infty", b"partial", b"nabla",
    b"alpha", b"beta", b"gamma", b"delta", b"epsilon", b"theta", b"lambda", b"mu", b"pi", b"sigma", b"omega", b"cdot", b"times",
    b"left", b"right", b"begin", b"mathrm", b"mathbf", b"binom", b"pm", b"leq"];

/// A PDF text string read for TeX-like source, over its first `TEXT_PREFIX_BYTES` and without copying: a known TeX
/// command (`\frac`), a command taking a braced argument (`\hat{x}`), or a braced script (`^{`, `_{`). A path such as
/// `C:\Users` is none of these.
pub fn tex_like(bytes: &[u8]) -> bool {
    let bytes = &bytes[..bytes.len().min(TEXT_PREFIX_BYTES)];
    // UTF-16 strings: keep the low byte of each unit (ASCII is all that matters here).
    let (start, step, offset) = if bytes.starts_with(&[0xfe, 0xff]) { (2, 2, 1) } else if bytes.starts_with(&[0xff, 0xfe]) { (2, 2, 0) } else { (0, 1, 0) };
    let at = |index: usize| -> Option<u8> { bytes.get(start + index * step + offset).copied() };
    let units = (bytes.len().saturating_sub(start)) / step;
    for index in 0..units {
        let Some(byte) = at(index) else { break };
        match byte {
            b'^' | b'_' if at(index + 1) == Some(b'{') => return true,
            b'\\' => {
                let mut word = [0u8; 8];
                let mut length = 0;
                while let Some(next) = at(index + 1 + length).filter(u8::is_ascii_alphabetic) {
                    if length == word.len() { break; }
                    word[length] = next;
                    length += 1;
                }
                if length == 0 { continue; }
                let follows = at(index + 1 + length);
                // A path segment (`C:\Program Files\beta\x`) continues with a separator or an extension.
                if matches!(follows, Some(b'\\' | b'/' | b'.' | b':')) || (index >= 1 && at(index - 1) == Some(b':')) { continue; }
                if TEX_COMMANDS.contains(&&word[..length]) || follows == Some(b'{') { return true; }
            }
            _ => {}
        }
    }
    false
}

/// Document-level structure-tree facts, and the tagged bits of the sampled pages.
#[derive(Debug, Default)]
pub struct StructFacts {
    pub formulas: u32,
    pub tables: u32,
    pub sources: u32,
    pub truncated: bool,
    /// The document (its catalog) carries a MathML associated file: the source of the math on its pages.
    pub document_mathml: bool,
    /// Tagged bits per sampled page (at most one entry a sampled page).
    pub pages: Vec<(ObjectId, u16)>,
}

/// Walk the structure tree, bounded: at most `struct_max_elements` element visits, `struct_max_depth` levels, each
/// referenced object once (cycles end there), and the bytes `budget` allows for reading formula sources (text prefixes
/// and associated files, each object read once). Element types resolve through the RoleMap (at most 8 hops). A tree
/// that cannot be read to the end (a cap, a spent budget, a root or kid that does not resolve) is `truncated`: its counts
/// are lower bounds.
pub fn struct_facts<'a>(document: &'a Document, rules: &PageEncodingRules, sampled: &HashSet<ObjectId>, budget: &mut Budget) -> StructFacts {
    let mut facts = StructFacts::default();
    let resolve = |object: &'a Object| -> Option<&'a Object> { document.dereference(object).ok().map(|(_, value)| value) };
    let mut files = Associated::default();
    let catalog = document.catalog().ok();
    // An associated file that could not be read leaves the answer unknown: the tree's facts are then lower bounds.
    let mut unknown = false;
    let found = catalog.map_or(Some(false), |catalog| files.mathml(document, catalog, budget));
    facts.document_mathml = found == Some(true);
    unknown |= found.is_none();
    // A sampled page's own MathML associated file.
    for id in sampled {
        if let Ok(page) = document.get_dictionary(*id) {
            match files.mathml(document, page, budget) {
                Some(true) => facts.pages.push((*id, 1 << rules.bits.math_source)),
                Some(false) => {}
                None => unknown = true,
            }
        }
    }
    facts.truncated |= unknown;
    let Some(root_entry) = catalog.and_then(|catalog| catalog.get(b"StructTreeRoot").ok()) else {
        facts.truncated |= budget.refused;
        return facts;
    };
    // A root that is named but does not resolve is unknown, not untagged.
    let Some(root) = resolve(root_entry).and_then(|o| o.as_dict().ok()) else {
        facts.truncated = true;
        return facts;
    };
    let role_map = root.get(b"RoleMap").ok().and_then(resolve).and_then(|o| o.as_dict().ok());
    // The standard type a custom one maps to, and whether the map went on past 8 hops (unknown).
    let role = |name: &[u8]| -> (Vec<u8>, bool) {
        let mut current = name[..name.len().min(NAME_PREFIX_BYTES)].to_vec();
        for _ in 0..8 {
            if matches!(current.as_slice(), b"Formula" | b"Table" | b"math") { return (current, false); }
            match role_map.and_then(|map| map.get(&current).ok()).and_then(resolve) {
                Some(Object::Name(next)) if *next != current => current = next[..next.len().min(NAME_PREFIX_BYTES)].to_vec(),
                _ => return (current, false),
            }
        }
        let more = !matches!(current.as_slice(), b"Formula" | b"Table" | b"math") && role_map.is_some_and(|map| map.get(&current).is_ok());
        (current, more)
    };
    let bits = &rules.bits;
    let mut visited: HashSet<ObjectId> = HashSet::new();
    // Formulas (by ordinal) whose source was found.
    let mut sourced: Vec<bool> = Vec::new();
    let mut visits = 0u32;
    // (kid, depth, page in force, formula ordinal in force, bits of the tagged ancestors)
    let mut stack: Vec<(&Object, u32, Option<ObjectId>, Option<u32>, u16)> = Vec::new();
    if let Ok(kids) = root.get(b"K") { stack.push((kids, 0, None, None, 0)); }
    let cap = rules.struct_max_elements as usize;
    while let Some((object, depth, page, formula, carried)) = stack.pop() {
        if depth > rules.struct_max_depth { facts.truncated = true; continue; }
        let value = match object {
            Object::Reference(id) => {
                if !visited.insert(*id) { continue; }
                if visited.len() > cap { facts.truncated = true; break; }
                match document.get_object(*id) { Ok(value) => value, Err(_) => { facts.truncated = true; continue; } }
            }
            other => other,
        };
        match value {
            Object::Array(items) => {
                // The first kids that fit, in order; the rest are past the cap.
                let room = cap.saturating_sub(stack.len());
                if items.len() > room { facts.truncated = true; }
                for item in items[..items.len().min(room)].iter().rev() {
                    stack.push((item, depth + 1, page, formula, carried));
                }
            }
            Object::Dictionary(element) => {
                visits += 1;
                if visits > rules.struct_max_elements { facts.truncated = true; break; }
                let own_page = match element.get(b"Pg") { Ok(Object::Reference(id)) => Some(*id), _ => None };
                let page = own_page.or(page);
                let kind = match element.get(b"S").ok().and_then(resolve) {
                    Some(Object::Name(name)) => { let (kind, unresolved) = role(name); facts.truncated |= unresolved; kind }
                    _ => Vec::new(),
                };
                let mut page_bits = 0u16;
                let mut formula = formula;
                match kind.as_slice() {
                    b"Formula" => {
                        facts.formulas += 1;
                        formula = Some(facts.formulas);
                        page_bits |= 1 << bits.tagged_formula;
                        let source = element_source(document, element, &mut files, budget);
                        facts.truncated |= source.is_none();
                        if source == Some(true) {
                            mark(&mut sourced, facts.formulas);
                            facts.sources += 1;
                            page_bits |= 1 << bits.math_source;
                        }
                    }
                    b"Table" => { facts.tables += 1; page_bits |= 1 << bits.tagged_table; }
                    // MathML structure (PDF 2.0 namespaces): its formula's source is recoverable.
                    b"math" => {
                        page_bits |= 1 << bits.math_source;
                        if let Some(ordinal) = formula { if mark(&mut sourced, ordinal) { facts.sources += 1; } }
                    }
                    _ => {}
                }
                // A tagged element marks its page, and its descendants mark the pages they name (a table whose cells
                // carry the page references).
                let marked = if own_page.is_some() { page_bits | carried } else { page_bits };
                if marked != 0 {
                    if let Some(id) = page.filter(|id| sampled.contains(id)) {
                        match facts.pages.iter_mut().find(|entry| entry.0 == id) {
                            Some(entry) => entry.1 |= marked,
                            None => facts.pages.push((id, marked)),
                        }
                    }
                }
                if let Ok(kids) = element.get(b"K") {
                    if stack.len() >= cap { facts.truncated = true; break; }
                    stack.push((kids, depth + 1, page, formula, carried | page_bits));
                }
            }
            _ => {}
        }
    }
    facts.truncated |= budget.refused;
    facts
}

/// Mark formula `ordinal` (1-based) as sourced; false when it already was.
fn mark(sourced: &mut Vec<bool>, ordinal: u32) -> bool {
    let index = ordinal as usize;
    if sourced.len() <= index { sourced.resize(index + 1, false); }
    !std::mem::replace(&mut sourced[index], true)
}

/// A formula element whose source is recoverable: TeX-like Alt or ActualText (a bounded prefix, charged to the
/// budget), or an associated MathML file.
fn element_source<'a>(document: &'a Document, element: &'a Dictionary, files: &mut Associated, budget: &mut Budget) -> Option<bool> {
    for key in [&b"Alt"[..], b"ActualText"] {
        if let Some(Object::String(bytes, _)) = element.get(key).ok().and_then(|o| document.dereference(o).ok()).map(|(_, v)| v) {
            if !budget.take(bytes.len().min(TEXT_PREFIX_BYTES)) { return None; }
            if tex_like(bytes) { return Some(true); }
        }
    }
    files.mathml(document, element, budget)
}

/// Associated-file answers by object (an /AF array, a file specification or an embedded file), so a file many
/// elements share is read once.
#[derive(Default)]
struct Associated {
    known: HashMap<ObjectId, usize>,
}

impl Associated {
    /// A dictionary's associated files (/AF) include a MathML file: by its name (`.mml`, "mathml") or its embedded
    /// stream's subtype or namespace. At most 16 are looked at. None when a read was refused.
    fn mathml(&mut self, document: &Document, holder: &Dictionary, budget: &mut Budget) -> Option<bool> {
        let Ok(entry) = holder.get(b"AF") else { return Some(false) };
        let id = match entry { Object::Reference(id) => Some(*id), _ => None };
        if let Some(answer) = id.and_then(|id| self.known.get(&id)) { return Self::answer(*answer); }
        if budget.refused { return None; }
        let files: Vec<&Object> = match document.dereference(entry).ok().map(|(_, v)| v) {
            Some(Object::Array(items)) => items.iter().take(16).collect(),
            Some(_) => vec![entry],
            None => Vec::new(),
        };
        let mut answer = Some(false);
        for file in files {
            match self.file(document, file, budget) {
                Some(true) => { answer = Some(true); break; }
                Some(false) => {}
                None => answer = None,
            }
        }
        if let Some(id) = id { self.remember(id, answer); }
        answer
    }

    /// Remembered answers: 0 no, 1 yes, 2 unknown (an unreadable file stays unknown, and is not read again).
    fn remember(&mut self, id: ObjectId, answer: Option<bool>) {
        if self.known.len() < 4_096 { self.known.insert(id, answer.map_or(2, usize::from)); }
    }

    fn answer(known: usize) -> Option<bool> {
        (known != 2).then_some(known == 1)
    }

    /// One associated file: a file specification (its names, then its embedded file) or an embedded file stream.
    fn file(&mut self, document: &Document, file: &Object, budget: &mut Budget) -> Option<bool> {
        let id = match file { Object::Reference(id) => Some(*id), _ => None };
        if let Some(answer) = id.and_then(|id| self.known.get(&id)) { return Self::answer(*answer); }
        let answer = match document.dereference(file).ok().map(|(_, v)| v) {
            Some(Object::Stream(stream)) => mathml_stream(document, stream, budget),
            Some(Object::Dictionary(spec)) => {
                let named = [&b"UF"[..], b"F"].iter().any(|key| matches!(spec.get(key).ok().and_then(|o| document.dereference(o).ok()).map(|(_, v)| v), Some(Object::String(name, _)) if mathml_name(name)));
                if named { Some(true) } else {
                    // The embedded file must be a stream: nothing is followed further (no cycles, no chains).
                    match spec.get(b"EF").ok().and_then(|o| document.dereference(o).ok()).and_then(|(_, v)| v.as_dict().ok()).and_then(|ef| ef.get(b"F").ok()).and_then(|o| document.dereference(o).ok()).map(|(_, v)| v) {
                        Some(Object::Stream(stream)) => mathml_stream(document, stream, budget),
                        _ => Some(false),
                    }
                }
            }
            _ => Some(false),
        };
        if let Some(id) = id { self.remember(id, answer); }
        answer
    }
}

/// An embedded file is MathML by its subtype, or by the MathML namespace in its first bytes (read to classify only).
fn mathml_stream(document: &Document, stream: &lopdf::Stream, budget: &mut Budget) -> Option<bool> {
    if matches!(stream.dict.get(b"Subtype").ok().and_then(|o| document.dereference(o).ok()).map(|(_, v)| v), Some(Object::Name(subtype)) if folded_contains(subtype, b"mathml")) {
        return Some(true);
    }
    let head = stream_head(stream, 4 * 1024, budget)?;
    Some(head.windows(23).any(|window| window == b"w3.org/1998/Math/MathML"))
}

/// A file name naming MathML: ending in `.mml` or containing "mathml", over its first `NAME_PREFIX_BYTES` (UTF-16
/// zero bytes skipped, case folded) without copying the string.
fn mathml_name(name: &[u8]) -> bool {
    let mut folded = [0u8; NAME_PREFIX_BYTES];
    let mut length = 0;
    for byte in name.iter().take(2 * NAME_PREFIX_BYTES).filter(|b| **b != 0) {
        if length == folded.len() { break; }
        folded[length] = byte.to_ascii_lowercase();
        length += 1;
    }
    let folded = &folded[..length];
    folded.ends_with(b".mml") || folded.windows(6).any(|window| window == b"mathml")
}

fn folded_contains(bytes: &[u8], needle: &[u8]) -> bool {
    bytes.iter().take(NAME_PREFIX_BYTES).collect::<Vec<_>>().windows(needle.len()).any(|window| window.iter().zip(needle).all(|(a, b)| a.to_ascii_lowercase() == *b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_font_names_into_the_fixed_vocabulary() {
        for name in ["CMMI10", "CMSY7", "MSBM10", "LMMathItalic10-Regular", "STIXTwoMath-Regular", "CambriaMath", "KaTeX_Main-Regular", "MathJax_Size3-Regular", "STIXSizeOneSym-Regular", "txmiaX", "NewTXMI7", "PazoMath", "XITSMath-Regular"] {
            assert_eq!(name_class(name.as_bytes()), Some(FONT_MATH), "{name}");
        }
        for name in ["Symbol", "StandardSymL-Slant_167", "OpenSymbol", "SymbolMT"] {
            assert_eq!(name_class(name.as_bytes()), Some(FONT_SYMBOL), "{name}");
        }
        for name in ["CMR10", "STIXTwoText-Regular", "STIXGeneral-Regular", "LiberationSerif", "TeXGyreTermes-Regular", "CMSS10", "ArialUnicodeMS", "Georgia"] {
            assert_eq!(name_class(name.as_bytes()), None, "{name}");
        }
    }

    #[test]
    fn finds_a_math_table_in_the_opentype_directory_only() {
        let mut head = vec![0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0];
        head.extend_from_slice(b"GSUB\0\0\0\0\0\0\0\0\0\0\0\0MATH\0\0\0\0\0\0\0\0\0\0\0\0");
        assert!(has_math_table(&head));
        head[5] = 1;
        assert!(!has_math_table(&head), "a MATH tag past numTables does not count");
        assert!(!has_math_table(b"%!PS-AdobeFont-1.0 MATH"));
    }

    #[test]
    fn tex_like_text_needs_a_command_or_a_braced_script() {
        assert!(tex_like(b"x=\\frac{-b}{2a}"));
        assert!(tex_like(&[0xfe, 0xff, 0, b'x', 0, b'^', 0, b'{', 0, b'2', 0, b'}']));
        assert!(!tex_like("Total: 5 \u{20ac} \u{b1} 2\u{b0}".as_bytes()));
        assert!(!tex_like(b"C:\\ path"));
        assert!(!tex_like(b"C:\\Users\\me\\notes.txt"), "a Windows path");
        assert!(tex_like(b"\\hat{x}"), "a command with a braced argument");
        assert!(tex_like(b"\\alpha + 1"), "a known command");
    }

    #[test]
    fn buckets_counts_by_log2() {
        assert_eq!([0.0, 1.0, 2.0, 3.0, 4.0, 7.0, 8.0, 16_384.0, 1e12].map(stat_bucket), [0, 1, 2, 2, 3, 3, 4, 15, 15]);
    }
}
