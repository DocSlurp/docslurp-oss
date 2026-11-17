//! How math and tables are encoded on a sampled page, as a bit mask (`PDF_PAGE_ENCODING_BITS` in `@docslurp/shared`),
//! from the page's own content stream and the document's structure tree. Written from the PDF specification (ISO 32000:
//! fonts, Type 3 glyph procedures, marked content and ActualText, logical structure, associated files) and the OpenType
//! table directory. Facts only: font names, text and element text are read to classify into the fixed vocabulary of the
//! bits and never leave this module.

use std::collections::HashSet;
use std::io::Read;

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::rules::PageEncodingRules;

/// Font classes, a bit set per font (cached per font object).
pub const FONT_MATH: u8 = 1;
/// A symbol font that sets math in some routes and bullets in others: its glyphs count as math only inside a line.
pub const FONT_SYMBOL: u8 = 2;
pub const FONT_TYPE3_BITMAP: u8 = 4;
pub const FONT_UNMAPPED: u8 = 8;

/// Runs, outline paths and images kept per page; past them the page's mask is partial.
const MAX_RUNS: usize = 2_048;
const MAX_OUTLINE_PATHS: usize = 4_096;
const MAX_IMAGES: usize = 64;
/// Box comparisons when clustering a page's outline paths.
const MAX_OUTLINE_COMPARISONS: usize = 4_000_000;
/// Type 3 glyph procedures and bytes of each read to tell a bitmap font, and bytes of a font program's head.
const TYPE3_PROCS_READ: usize = 8;
const TYPE3_PROC_BYTES: u64 = 64 * 1024;
const FONT_HEAD_BYTES: u64 = 4 * 1024;

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
        let run = Run { math, symbol: font & FONT_SYMBOL != 0 && !math, unmapped, glyphs, ..run };
        if self.runs.len() < MAX_RUNS { self.runs.push(run); } else { self.runs_overflow = true; }
    }

    /// A painted path: kept for outline clustering when it is filled, has curves and is small.
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

/// The page's encoding mask and its packed stat counts (`PDF_PAGE_STAT_COUNTS`).
pub fn page_mask(rules: &PageEncodingRules, page: &PageEncoding, view: &PageView<'_>) -> (u16, u32) {
    let bits = &rules.bits;
    // Symbol-font runs are math inside a line (another run on their baseline ends before them), bullets otherwise.
    let mut runs = page.runs.clone();
    let symbols: Vec<usize> = (0..runs.len()).filter(|i| runs[*i].symbol).take(512).collect();
    let (mut symbol_glyphs, mut symbol_unmapped) = (0.0, false);
    for i in symbols {
        let s = runs[i];
        let inside = runs.iter().take(MAX_RUNS).any(|o| !o.symbol && (o.y - s.y).abs() <= 0.3 * s.size.max(o.size) && o.x1 <= s.x0 + 0.5 * s.size && s.x0 - o.x1 <= 3.0 * s.size);
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
    set(bits.stacked_math, (page.mapped_math || page.unmapped_math || symbol_math) && (stacked(rules, &math_runs) || fraction_bar(rules, view, &runs)));
    set(bits.math_grid, math_grid(&math_runs, &runs, view.rules, view.rule_thickness, &page.outlines));
    set(bits.rule_grid, view.grids.is_some_and(|grids| grids > 0));
    let rule_table = if view.words_known && view.rules_known { horizontal_rule_table(rules, view) } else { false };
    set(bits.horizontal_rule_table, rule_table);
    let partial = view.exhausted || page.runs_overflow || page.outlines_overflow || page.images_overflow || !clusters_known
        || !view.words_known || !view.rules_known || view.grids.is_none();
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
fn stacked(rules: &PageEncodingRules, runs: &[&Run]) -> bool {
    let sorted: Vec<&Run> = sorted_keys(runs.iter().map(|run| run.x0)).into_iter().map(|(_, index)| runs[index]).collect();
    let mut budget = 200_000usize;
    for (k, a) in sorted.iter().enumerate() {
        for b in &sorted[k + 1..] {
            if b.x0 >= a.x1 { break; }
            budget = match budget.checked_sub(1) { Some(left) => left, None => return false };
            let em = a.size.max(b.size).max(1e-6);
            let apart = (a.y - b.y).abs() / em;
            if apart > rules.stacked_min_baseline_em && apart < rules.stacked_max_baseline_em { return true; }
        }
    }
    false
}

/// A short horizontal rule with a run starting right above it and another right below, both over its span.
fn fraction_bar(rules: &PageEncodingRules, view: &PageView<'_>, runs: &[Run]) -> bool {
    view.rules.iter().take(5_000).any(|r| {
        let (len, thick) = (r[2] - r[0], r[3] - r[1]);
        if !(thick <= view.rule_thickness.min(1.5) && len >= 3.0 && len <= rules.fraction_bar_max_length_pt) { return false; }
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
fn math_grid(runs: &[&Run], all: &[Run], rules: &[[f64; 4]], thin: f64, outlines: &[([f64; 4], u32)]) -> bool {
    if runs.len() < 4 { return false; }
    let mut rows: Vec<(f64, f64, Vec<f64>)> = Vec::new();
    for run in runs.iter().take(1_024) {
        let centre = (run.x0 + run.x1) / 2.0;
        match rows.iter_mut().find(|row| (row.0 - run.y).abs() <= 0.15 * run.size.max(row.1)) {
            Some(row) => row.2.push(centre),
            None => rows.push((run.y, run.size, vec![centre])),
        }
        if rows.len() > 256 { break; }
    }
    rows.retain(|row| row.2.len() >= 2);
    let order = sorted_keys(rows.iter().map(|row| row.0));
    let mut budget = 100_000usize;
    for (k, first) in order.iter().enumerate() {
        for second in &order[k + 1..] {
            let (a, b) = (&rows[first.1], &rows[second.1]);
            let em = a.1.max(b.1).max(1e-6);
            let apart = (b.0 - a.0) / em;
            if apart > 2.5 { break; }
            if apart < 0.9 { continue; }
            let mut columns: Vec<f64> = sorted_keys(a.2.iter().filter(|x| b.2.iter().any(|y| (*x - y).abs() <= 0.5 * em)).copied()).into_iter().map(|(x, _)| x).collect();
            columns.dedup_by(|x, y| (*x - *y).abs() < em);
            if columns.len() < 2 { continue; }
            budget = match budget.checked_sub(all.len() + rules.len() + outlines.len()) { Some(left) => left, None => return false };
            let (top, bottom, left) = (a.0, b.0, columns[0]);
            let right = *columns.last().unwrap_or(&left);
            // A horizontal rule between the rows under the columns is a fraction bar: stacked fractions, not a grid.
            if rules.iter().any(|r| r[3] - r[1] <= thin && r[2] - r[0] >= 0.5 * em && r[1] > top && r[3] < bottom && r[2] > left - em && r[0] < right + em) { continue; }
            let beside = |x: f64| x >= left - 3.0 * em && x <= left - 0.2 * em;
            let span = bottom - top;
            let pieces: Vec<&Run> = all.iter().filter(|run| beside((run.x0 + run.x1) / 2.0)).collect();
            let stacked = pieces.iter().any(|p| {
                let column: Vec<f64> = pieces.iter().filter(|q| (q.x0 - p.x0).abs() <= 0.3 * em).map(|q| q.y).collect();
                column.len() >= 2 && column.iter().copied().fold(f64::INFINITY, f64::min) <= top && column.iter().copied().fold(f64::NEG_INFINITY, f64::max) >= bottom - 0.3 * em
            });
            let tall = pieces.iter().any(|p| p.size >= 1.6 * em && p.y >= top && p.y <= bottom + p.size);
            let ruled = rules.iter().any(|r| r[2] - r[0] <= thin && beside((r[0] + r[2]) / 2.0) && r[1] <= top && r[3] >= bottom - 0.5 * em && r[3] - r[1] <= span + 4.0 * em);
            let drawn = outlines.iter().any(|(o, _)| beside((o[0] + o[2]) / 2.0) && o[1] <= top && o[3] >= bottom - 0.5 * em && o[3] - o[1] <= span + 4.0 * em);
            if stacked || tall || ruled || drawn { return true; }
        }
    }
    false
}

/// A table drawn with horizontal rules only: at least `rule_table_min_rules` rules sharing both ends, no vertical rule
/// across them, the first gap holding a header row, some gap holding two or more rows, and two rows with a column gap.
fn horizontal_rule_table(rules: &PageEncodingRules, view: &PageView<'_>) -> bool {
    let thin = view.rule_thickness;
    let tolerance = rules.rule_table_end_tolerance_pt;
    let horizontals: Vec<[f64; 4]> = view.rules.iter().filter(|r| r[3] - r[1] <= thin && r[2] - r[0] >= rules.rule_table_min_rule_length_pt).copied().collect();
    let verticals: Vec<[f64; 4]> = view.rules.iter().filter(|r| r[2] - r[0] <= thin && r[3] - r[1] >= 8.0).copied().collect();
    let page_height = view.visible[3] - view.visible[1];
    let mut tried: Vec<(f64, f64)> = Vec::new();
    for h in horizontals.iter().take(512) {
        if tried.iter().any(|(x0, x1)| (x0 - h[0]).abs() <= tolerance && (x1 - h[2]).abs() <= tolerance) { continue; }
        tried.push((h[0], h[2]));
        let mut ys: Vec<f64> = sorted_keys(horizontals.iter()
            .filter(|o| (o[0] - h[0]).abs() <= tolerance && (o[2] - h[2]).abs() <= tolerance)
            .map(|o| (o[1] + o[3]) / 2.0)).into_iter().map(|(y, _)| y).collect();
        ys.dedup_by(|a, b| (*a - *b).abs() <= 1.5);
        if ys.len() < rules.rule_table_min_rules as usize { continue; }
        let (top, bottom) = (ys[0], *ys.last().unwrap_or(&ys[0]));
        if bottom - top > 0.8 * page_height { continue; }
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
/// Unicode mapping (`unmapped`, decided by the caller's rule).
pub fn font_class(document: &Document, font: &Dictionary, unmapped: bool) -> u8 {
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
    // A subset tag (six capitals and a plus) is not part of the name.
    let base = if base.len() > 7 && base[6] == b'+' && base[..6].iter().all(u8::is_ascii_uppercase) { &base[7..] } else { &base[..] };
    class |= name_class(base).unwrap_or(0);
    if name_of(font, b"Subtype").is_some_and(|subtype| subtype == b"Type3") {
        // Type 3 glyphs are procedures: a bitmap font paints images.
        if type3_paints_images(document, font) { class |= FONT_TYPE3_BITMAP; }
        return class;
    }
    if class & (FONT_MATH | FONT_SYMBOL) != 0 { return class; }
    // An OpenType or TrueType program with a MATH table.
    if let Some(descriptor) = descriptor {
        for key in [&b"FontFile2"[..], b"FontFile3"] {
            if let Some((_, Object::Stream(program))) = descriptor.get(key).ok().and_then(|o| document.dereference(o).ok()) {
                if stream_head(program, FONT_HEAD_BYTES).is_some_and(|head| has_math_table(&head)) { return class | FONT_MATH; }
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
/// resources (a procedure drawing a form is vector drawing).
fn type3_paints_images(document: &Document, font: &Dictionary) -> bool {
    let resolve = |object: &Object| document.dereference(object).ok().map(|(_, value)| value).and_then(|value| match value {
        Object::Dictionary(dict) => Some(dict.clone()),
        Object::Stream(stream) => Some(stream.dict.clone()),
        _ => None,
    });
    let images = font.get(b"Resources").ok().and_then(resolve).and_then(|resources| resources.get(b"XObject").ok().and_then(resolve))
        .is_some_and(|xobjects| xobjects.iter().take(64).any(|(_, x)| resolve(x).is_some_and(|dict| matches!(dict.get(b"Subtype"), Ok(Object::Name(kind)) if kind == b"Image"))));
    let Some((_, Object::Dictionary(procs))) = font.get(b"CharProcs").ok().and_then(|o| document.dereference(o).ok()) else { return false };
    procs.iter().take(TYPE3_PROCS_READ).any(|(_, proc)| match document.dereference(proc).ok() {
        Some((_, Object::Stream(stream))) => stream_head(stream, TYPE3_PROC_BYTES).is_some_and(|content| has_token(&content, b"BI") || (images && has_token(&content, b"Do"))),
        _ => false,
    })
}

fn has_token(content: &[u8], token: &[u8]) -> bool {
    let delimiter = |byte: Option<&u8>| byte.is_none_or(|b| b.is_ascii_whitespace() || b"[]()<>/%".contains(b));
    content.windows(token.len()).enumerate().any(|(at, window)| window == token && delimiter(at.checked_sub(1).and_then(|i| content.get(i))) && delimiter(content.get(at + token.len())))
}

/// At most `max` decoded bytes from the start of a stream: unfiltered or Flate only; anything else is unknown.
pub fn stream_head(stream: &lopdf::Stream, max: u64) -> Option<Vec<u8>> {
    let filter = stream.dict.get(b"Filter").ok();
    let mut out = Vec::new();
    match filter {
        None => out.extend_from_slice(&stream.content[..stream.content.len().min(max as usize)]),
        Some(Object::Name(name)) if name == b"FlateDecode" || name == b"Fl" => {
            let _ = flate2::read::ZlibDecoder::new(&stream.content[..]).take(max).read_to_end(&mut out);
        }
        Some(Object::Array(filters)) if filters.len() == 1 && matches!(&filters[0], Object::Name(name) if name == b"FlateDecode" || name == b"Fl") => {
            let _ = flate2::read::ZlibDecoder::new(&stream.content[..]).take(max).read_to_end(&mut out);
        }
        _ => return None,
    }
    Some(out)
}

/// A PDF text string read for TeX-like source: a backslash command (`\frac`), or a braced script (`^{`, `_{`).
pub fn tex_like(bytes: &[u8]) -> bool {
    let text: Vec<u8> = if bytes.starts_with(&[0xfe, 0xff]) {
        bytes[2..].chunks(2).filter(|pair| pair.len() == 2 && pair[0] == 0).map(|pair| pair[1]).collect()
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        bytes[2..].chunks(2).filter(|pair| pair.len() == 2 && pair[1] == 0).map(|pair| pair[0]).collect()
    } else {
        bytes.to_vec()
    };
    text.windows(2).any(|pair| (pair[0] == b'\\' && pair[1].is_ascii_alphabetic()) || (matches!(pair[0], b'^' | b'_') && pair[1] == b'{'))
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
/// referenced object once (cycles end there). Element types resolve through the RoleMap (at most 8 hops).
pub fn struct_facts<'a>(document: &'a Document, rules: &PageEncodingRules, sampled: &HashSet<ObjectId>) -> StructFacts {
    let mut facts = StructFacts::default();
    let resolve = |object: &'a Object| -> Option<&'a Object> { document.dereference(object).ok().map(|(_, value)| value) };
    let catalog = document.catalog().ok();
    facts.document_mathml = catalog.is_some_and(|catalog| mathml_files(document, catalog));
    // A sampled page's own MathML associated file.
    for id in sampled {
        if document.get_dictionary(*id).is_ok_and(|page| mathml_files(document, page)) {
            facts.pages.push((*id, 1 << rules.bits.math_source));
        }
    }
    let Some(root) = catalog.and_then(|catalog| catalog.get(b"StructTreeRoot").ok()).and_then(resolve).and_then(|o| o.as_dict().ok()) else {
        return facts;
    };
    let role_map = root.get(b"RoleMap").ok().and_then(resolve).and_then(|o| o.as_dict().ok());
    let role = |name: &[u8]| -> Vec<u8> {
        let mut current = name.to_vec();
        for _ in 0..8 {
            if matches!(current.as_slice(), b"Formula" | b"Table" | b"math") { break; }
            match role_map.and_then(|map| map.get(&current).ok()).and_then(resolve) {
                Some(Object::Name(next)) if *next != current => current = next.clone(),
                _ => break,
            }
        }
        current
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
                if !visited.insert(*id) || visited.len() > cap { if visited.len() > cap { facts.truncated = true; break; } continue; }
                match document.get_object(*id) { Ok(value) => value, Err(_) => continue }
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
                let kind = match element.get(b"S").ok().and_then(resolve) { Some(Object::Name(name)) => role(name), _ => Vec::new() };
                let mut page_bits = 0u16;
                let mut formula = formula;
                match kind.as_slice() {
                    b"Formula" => {
                        facts.formulas += 1;
                        formula = Some(facts.formulas);
                        page_bits |= 1 << bits.tagged_formula;
                        if element_source(document, element) {
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
    facts
}

/// Mark formula `ordinal` (1-based) as sourced; false when it already was.
fn mark(sourced: &mut Vec<bool>, ordinal: u32) -> bool {
    let index = ordinal as usize;
    if sourced.len() <= index { sourced.resize(index + 1, false); }
    !std::mem::replace(&mut sourced[index], true)
}

/// A formula element whose source is recoverable: TeX-like Alt or ActualText, or an associated MathML file.
fn element_source<'a>(document: &'a Document, element: &'a Dictionary) -> bool {
    let resolve = |object: &'a Object| -> Option<&'a Object> { document.dereference(object).ok().map(|(_, value)| value) };
    for key in [&b"Alt"[..], b"ActualText"] {
        if let Some(Object::String(bytes, _)) = element.get(key).ok().and_then(resolve) {
            if tex_like(bytes) { return true; }
        }
    }
    mathml_files(document, element)
}

/// A dictionary's associated files (/AF) include a MathML file: by its name (`.mml`, "mathml") or its embedded stream's
/// subtype. At most 16 are looked at.
fn mathml_files<'a>(document: &'a Document, holder: &'a Dictionary) -> bool {
    let resolve = |object: &'a Object| -> Option<&'a Object> { document.dereference(object).ok().map(|(_, value)| value) };
    let files: Vec<&Object> = match holder.get(b"AF").ok().and_then(resolve) {
        Some(Object::Array(items)) => items.iter().take(16).collect(),
        Some(other) => vec![other],
        None => Vec::new(),
    };
    // An embedded file is MathML by its subtype, or by the MathML namespace in its first bytes (read to classify only).
    let mathml_stream = |stream: &'a lopdf::Stream| {
        matches!(stream.dict.get(b"Subtype").ok().and_then(resolve), Some(Object::Name(subtype)) if contains_mathml(subtype))
            || stream_head(stream, 4 * 1024).is_some_and(|head| head.windows(23).any(|window| window == b"w3.org/1998/Math/MathML"))
    };
    files.into_iter().filter_map(resolve).any(|file| match file {
        // A file stream listed directly (not through a file specification).
        Object::Stream(stream) => mathml_stream(stream),
        Object::Dictionary(spec) => {
            let named = [&b"UF"[..], b"F"].iter().any(|key| matches!(spec.get(key).ok().and_then(resolve), Some(Object::String(name, _)) if lowered(name).ends_with(b".mml") || contains_mathml(name)));
            named || spec.get(b"EF").ok().and_then(resolve).and_then(|o| o.as_dict().ok())
                .and_then(|ef| ef.get(b"F").ok().and_then(resolve))
                .is_some_and(|o| matches!(o, Object::Stream(stream) if mathml_stream(stream)))
        }
        _ => false,
    })
}

fn lowered(bytes: &[u8]) -> Vec<u8> { bytes.iter().filter(|b| **b != 0).map(u8::to_ascii_lowercase).collect() }
fn contains_mathml(bytes: &[u8]) -> bool { lowered(bytes).windows(6).any(|window| window == b"mathml") }

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
    }

    #[test]
    fn buckets_counts_by_log2() {
        assert_eq!([0.0, 1.0, 2.0, 3.0, 4.0, 7.0, 8.0, 16_384.0, 1e12].map(stat_bucket), [0, 1, 2, 2, 3, 3, 4, 15, 15]);
    }
}
