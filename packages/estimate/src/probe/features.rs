//! Clean-room, content-free geometry candidates. No OCR, semantic classifier, or prices.
//!
//! Coordinates are displayed page points, with a top-left origin and positive height.
//! A table/caption is only a geometric candidate. In particular, short aligned prose
//! can be indistinguishable from a table without text semantics.

const MAX_WORDS: usize = 4_096;
const MAX_REGIONS: usize = 64;
const MAX_PAIR_COMPARISONS: usize = 100_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Word {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub glyphs: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confidence {
    /// Weak geometric evidence; this is not a calibrated probability.
    Low,
    /// Multiple repeated structural observations, still not semantic verification.
    Moderate,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegionFeature {
    pub regions: Vec<[f64; 4]>,
    /// Union area / visible page area. None when geometry work was exhausted.
    pub coverage: Option<f64>,
    /// Glyphs of word centres assigned to the region family; no byte conversion.
    pub glyphs: f64,
    pub method: &'static str,
    pub confidence: Confidence,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextOwnership {
    pub total_glyphs: f64,
    pub table_glyphs: f64,
    pub caption_glyphs: f64,
    pub other_glyphs: f64,
    /// False means these are observed-subset totals, not complete page totals.
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Features {
    /// Ruled input regions plus new unruled candidates, deduplicated by ownership.
    pub tables: RegionFeature,
    pub unruled_tables: RegionFeature,
    pub captions: RegionFeature,
    /// Vector-figure candidate, not a claimed semantic chart. The input has no axes.
    pub vector_figures: RegionFeature,
    pub text: TextOwnership,
    pub words_observed: usize,
    pub partial: bool,
    pub pair_comparisons: usize,
}

#[derive(Default)]
struct Budget {
    used: usize,
    exhausted: bool,
}

impl Budget {
    fn tick(&mut self) -> bool {
        if self.used == MAX_PAIR_COMPARISONS {
            self.exhausted = true;
            false
        } else {
            self.used += 1;
            true
        }
    }
}

fn clip(a: [f64; 4], visible: [f64; 4]) -> Option<[f64; 4]> {
    if !a.iter().chain(visible.iter()).all(|n| n.is_finite()) {
        return None;
    }
    let b = [
        a[0].max(visible[0]),
        a[1].max(visible[1]),
        a[2].min(visible[2]),
        a[3].min(visible[3]),
    ];
    (b[2] > b[0] && b[3] > b[1]).then_some(b)
}

fn area(a: [f64; 4]) -> f64 {
    (a[2] - a[0]).max(0.0) * (a[3] - a[1]).max(0.0)
}
fn bounds(w: Word) -> [f64; 4] {
    [w.x, w.y, w.x + w.width, w.y + w.height]
}
fn centre(w: Word) -> (f64, f64) {
    (w.x + w.width / 2.0, w.y + w.height / 2.0)
}
fn contains(b: [f64; 4], p: (f64, f64)) -> bool {
    p.0 >= b[0] && p.0 <= b[2] && p.1 >= b[1] && p.1 <= b[3]
}
fn joined(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

fn inside_any(w: Word, regions: &[[f64; 4]], budget: &mut Budget) -> Option<bool> {
    for &region in regions {
        if !budget.tick() {
            return None;
        }
        if contains(region, centre(w)) {
            return Some(true);
        }
    }
    Some(false)
}

/// Exact rectangle-union sweep. Storage is bounded by 64 rectangles per family;
/// the overlap loop consumes the same shared budget as classification.
fn coverage(regions: &[[f64; 4]], visible: [f64; 4], budget: &mut Budget) -> Option<f64> {
    let page_area = area(visible);
    if !page_area.is_finite() || page_area <= 0.0 {
        return None;
    }
    let mut xs: Vec<f64> = regions.iter().flat_map(|b| [b[0], b[2]]).collect();
    xs.sort_by(f64::total_cmp);
    xs.dedup();
    let mut union = 0.0;
    for x in xs.windows(2) {
        let mut ys = Vec::new();
        for b in regions {
            if !budget.tick() {
                return None;
            }
            if b[0] < x[1] && b[2] > x[0] {
                ys.push((b[1], b[3]));
            }
        }
        ys.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut height = 0.0;
        let mut current: Option<(f64, f64)> = None;
        for (top, bottom) in ys {
            match current {
                Some((a, b)) if top <= b => current = Some((a, b.max(bottom))),
                Some((a, b)) => {
                    height += b - a;
                    current = Some((top, bottom));
                }
                None => current = Some((top, bottom)),
            }
        }
        if let Some((a, b)) = current {
            height += b - a;
        }
        union += (x[1] - x[0]) * height;
    }
    Some((union / page_area).clamp(0.0, 1.0))
}

#[derive(Clone)]
struct Row {
    words: Vec<usize>,
    bbox: [f64; 4],
    centre_y: f64,
}

fn rows(words: &[Word], line_height: f64) -> Vec<Row> {
    let mut indices: Vec<usize> = (0..words.len()).collect();
    indices.sort_by(|&a, &b| {
        centre(words[a])
            .1
            .total_cmp(&centre(words[b]).1)
            .then_with(|| words[a].x.total_cmp(&words[b].x))
    });
    let mut rows: Vec<Row> = Vec::new();
    for index in indices {
        let w = words[index];
        if let Some(row) = rows.last_mut() {
            if (centre(w).1 - row.centre_y).abs() <= line_height * 0.45 {
                row.words.push(index);
                row.bbox = joined(row.bbox, bounds(w));
                continue;
            }
        }
        rows.push(Row {
            words: vec![index],
            bbox: bounds(w),
            centre_y: centre(w).1,
        });
    }
    for row in &mut rows {
        row.words
            .sort_by(|&a, &b| words[a].x.total_cmp(&words[b].x));
    }
    rows
}

#[derive(Clone)]
struct Cells {
    starts: Vec<f64>,
    bbox: [f64; 4],
}

fn row_cells(row: &Row, words: &[Word], owned: &[u8], h: f64) -> Option<Cells> {
    let free: Vec<usize> = row
        .words
        .iter()
        .copied()
        .filter(|&i| owned[i] == 0)
        .collect();
    if free.len() < 2 {
        return None;
    }
    let mut cells: Vec<([f64; 4], f64)> = Vec::new();
    for index in free {
        let w = words[index];
        if let Some(cell) = cells.last_mut() {
            // Ordinary inter-word spaces stay inside a cell; a large gutter starts one.
            if w.x - cell.0[2] < h * 2.0 {
                cell.0 = joined(cell.0, bounds(w));
                cell.1 += w.glyphs;
                continue;
            }
        }
        cells.push((bounds(w), w.glyphs));
    }
    if !(2..=8).contains(&cells.len()) || cells.iter().any(|(_, glyphs)| *glyphs > 48.0) {
        return None;
    }
    let bbox = cells.iter().map(|v| v.0).reduce(joined)?;
    // A bullet / short numbering prefix beside one prose cell is weak list evidence.
    let narrow_first = cells[0].1 <= 3.0 && cells[0].0[2] - cells[0].0[0] < h * 2.5;
    if cells.len() == 2 && narrow_first {
        return None;
    }
    Some(Cells {
        starts: cells.iter().map(|v| v.0[0]).collect(),
        bbox,
    })
}

fn aligned(a: &Cells, b: &Cells, h: f64, budget: &mut Budget) -> bool {
    if a.starts.len() != b.starts.len() || b.bbox[1] - a.bbox[3] > h * 2.0 {
        return false;
    }
    for (&x, &y) in a.starts.iter().zip(&b.starts) {
        if !budget.tick() || (x - y).abs() > h * 0.8 {
            return false;
        }
    }
    true
}

fn region_feature(
    regions: Vec<[f64; 4]>,
    glyphs: f64,
    method: &'static str,
    confidence: Confidence,
    visible: [f64; 4],
    budget: &mut Budget,
) -> RegionFeature {
    let share = coverage(&regions, visible, budget);
    RegionFeature {
        regions,
        coverage: share,
        glyphs,
        method,
        confidence,
    }
}

/// Analyze a bounded observed page subset. Extra/invalid input and exhausted work
/// make the result partial. Glyph ownership is exclusive: table, caption, then other.
/// Vector figures do not take text ownership from their labels.
pub fn analyze(
    words: &[Word],
    image_boxes: &[[f64; 4]],
    ruled_boxes: &[[f64; 4]],
    vector_box: Option<[f64; 4]>,
    path_ops: usize,
    visible: [f64; 4],
) -> Features {
    let mut budget = Budget::default();
    let mut partial = words.len() > MAX_WORDS
        || image_boxes.len() > MAX_REGIONS
        || ruled_boxes.len() > MAX_REGIONS;
    let valid_page =
        visible.iter().all(|n| n.is_finite()) && area(visible).is_finite() && area(visible) > 0.0;
    let page = if valid_page {
        visible
    } else {
        partial = true;
        [0.0, 0.0, 1.0, 1.0]
    };
    let input_words = words;
    let words: Vec<Word> = input_words
        .iter()
        .take(MAX_WORDS)
        .copied()
        .filter(|w| {
            let valid = [w.x, w.y, w.width, w.height, w.glyphs]
                .iter()
                .all(|n| n.is_finite())
                && w.width >= 0.0
                && w.height > 0.0
                && w.glyphs >= 0.0
                && w.glyphs <= 1e12
                && bounds(*w).iter().all(|n| n.is_finite());
            if !valid {
                partial = true;
            }
            // Text outside the visible crop is not missing evidence. Its
            // glyphs remain in the caller's unattributed text denominator.
            valid && contains(page, centre(*w))
        })
        .collect();
    let mut heights: Vec<f64> = words.iter().map(|w| w.height).collect();
    heights.sort_by(f64::total_cmp);
    let h = heights
        .get(heights.len() / 2)
        .copied()
        .unwrap_or(10.0)
        .max(0.01);
    let mut tables: Vec<[f64; 4]> = ruled_boxes
        .iter()
        .take(MAX_REGIONS)
        .filter_map(|&b| clip(b, page))
        .collect();
    let images: Vec<[f64; 4]> = image_boxes
        .iter()
        .take(MAX_REGIONS)
        .filter_map(|&b| clip(b, page))
        .collect();
    if ruled_boxes
        .iter()
        .take(MAX_REGIONS)
        .chain(image_boxes.iter().take(MAX_REGIONS))
        .any(|b| !b.iter().all(|n| n.is_finite()) || b[2] <= b[0] || b[3] <= b[1])
    {
        partial = true;
    }
    if vector_box.is_some_and(|b| !b.iter().all(|n| n.is_finite()) || b[2] <= b[0] || b[3] <= b[1])
    {
        partial = true;
    }
    let mut owned = vec![0u8; words.len()];
    for (index, &word) in words.iter().enumerate() {
        match inside_any(word, &tables, &mut budget) {
            Some(true) => owned[index] = 1,
            Some(false) => {}
            None => {
                partial = true;
                break;
            }
        }
    }
    let lines = rows(&words, h);
    let mut unruled = Vec::new();
    let mut run: Vec<Cells> = Vec::new();
    let flush = |run: &mut Vec<Cells>, unruled: &mut Vec<[f64; 4]>| -> bool {
        let overflow = run.len() >= 3 && unruled.len() == MAX_REGIONS;
        if run.len() >= 3 && !overflow {
            if let Some(bbox) = run
                .iter()
                .map(|cell| cell.bbox)
                .reduce(joined)
                .and_then(|b| clip(b, page))
            {
                unruled.push(bbox);
            }
        }
        run.clear();
        overflow
    };
    if !budget.exhausted {
        for row in &lines {
            let next = row_cells(row, &words, &owned, h);
            match next {
                Some(next) => {
                    if run
                        .last()
                        .is_some_and(|last| !aligned(last, &next, h, &mut budget))
                    {
                        partial |= flush(&mut run, &mut unruled);
                    }
                    if budget.exhausted {
                        partial = true;
                        break;
                    }
                    run.push(next);
                }
                None => {
                    partial |= flush(&mut run, &mut unruled);
                }
            }
        }
        partial |= flush(&mut run, &mut unruled);
    }
    // At most 64 combined table regions. Additional candidates are partial evidence.
    if tables.len() + unruled.len() > MAX_REGIONS {
        partial = true;
    }
    unruled.truncate(MAX_REGIONS.saturating_sub(tables.len()));
    tables.extend(unruled.iter().copied());
    if !budget.exhausted {
        for (index, &word) in words.iter().enumerate() {
            if owned[index] != 0 {
                continue;
            }
            match inside_any(word, &unruled, &mut budget) {
                Some(true) => owned[index] = 1,
                Some(false) => {}
                None => {
                    partial = true;
                    break;
                }
            }
        }
    }
    let mut objects = images;
    objects.extend(tables.iter().copied());
    let mut captions: Vec<[f64; 4]> = Vec::new();
    let mut last_target: Option<usize> = None;
    if !budget.exhausted {
        for row in &lines {
            let free: Vec<_> = row
                .words
                .iter()
                .copied()
                .filter(|&i| owned[i] == 0)
                .collect();
            let glyphs: f64 = free.iter().map(|&i| words[i].glyphs).sum();
            if free.is_empty() || glyphs > 120.0 || row.bbox[3] - row.bbox[1] > h * 1.25 {
                last_target = None;
                continue;
            }
            let mut target = None;
            for (index, object) in objects.iter().enumerate() {
                if !budget.tick() {
                    partial = true;
                    break;
                }
                let overlap = (row.bbox[2].min(object[2]) - row.bbox[0].max(object[0])).max(0.0);
                let minimum_width = (row.bbox[2] - row.bbox[0]).min(object[2] - object[0]);
                let gap = if row.bbox[1] >= object[3] {
                    row.bbox[1] - object[3]
                } else if row.bbox[3] <= object[1] {
                    object[1] - row.bbox[3]
                } else {
                    continue;
                };
                if gap <= h * 2.0
                    && overlap >= minimum_width * 0.5
                    && row.bbox[2] - row.bbox[0] <= (object[2] - object[0]) * 1.25
                {
                    target = Some(index);
                    break;
                }
            }
            if budget.exhausted {
                break;
            }
            if let Some(target) = target {
                let merge = last_target == Some(target)
                    && captions.last().is_some_and(|b| {
                        row.bbox[1] - b[3] <= h * 1.5 && row.bbox[3] - b[1] <= h * 4.0
                    });
                if merge {
                    if let Some(last) = captions.last_mut() {
                        if let Some(bbox) = clip(joined(*last, row.bbox), page) {
                            *last = bbox;
                        }
                    }
                } else if captions.len() < MAX_REGIONS {
                    if let Some(bbox) = clip(row.bbox, page) {
                        captions.push(bbox);
                    }
                } else {
                    partial = true;
                    continue;
                }
                for index in free {
                    owned[index] = 2;
                }
                last_target = Some(target);
            } else {
                last_target = None;
            }
        }
    }
    let mut figures = Vec::new();
    if path_ops >= 16 && !budget.exhausted {
        if let Some(b) = vector_box.and_then(|b| clip(b, page)) {
            let mut table_overlap = 0.0;
            for &table in &tables {
                if !budget.tick() {
                    partial = true;
                    break;
                }
                if let Some(intersection) = clip(table, b) {
                    table_overlap += area(intersection);
                }
            }
            // A vector box largely accounted for by tables is not another chart.
            if !budget.exhausted && area(b) / area(page) >= 0.01 && table_overlap < area(b) * 0.5 {
                figures.push(b);
            }
        }
    }
    let mut table_glyphs = 0.0;
    let mut unruled_glyphs = 0.0;
    let mut caption_glyphs = 0.0;
    let mut other_glyphs = 0.0;
    for (index, &word) in words.iter().enumerate() {
        match owned[index] {
            1 => {
                table_glyphs += word.glyphs;
                if inside_any(word, &unruled, &mut budget) == Some(true) {
                    unruled_glyphs += word.glyphs;
                }
            }
            2 => caption_glyphs += word.glyphs,
            _ => other_glyphs += word.glyphs,
        }
    }
    let tables = region_feature(
        tables,
        table_glyphs,
        "ruled-or-repeated-alignment-candidate-v1",
        Confidence::Moderate,
        page,
        &mut budget,
    );
    let unruled_tables = region_feature(
        unruled,
        unruled_glyphs,
        "short-cells-repeated-alignment-v1",
        Confidence::Moderate,
        page,
        &mut budget,
    );
    let captions = region_feature(
        captions,
        caption_glyphs,
        "adjacent-short-text-line-v1",
        Confidence::Low,
        page,
        &mut budget,
    );
    let vector_figures = region_feature(
        figures,
        0.0,
        "non-table-vector-footprint-v1-not-semantic-chart",
        Confidence::Low,
        page,
        &mut budget,
    );
    partial |= budget.exhausted;
    Features {
        tables,
        unruled_tables,
        captions,
        vector_figures,
        text: TextOwnership {
            total_glyphs: table_glyphs + caption_glyphs + other_glyphs,
            table_glyphs,
            caption_glyphs,
            other_glyphs,
            complete: !partial,
        },
        words_observed: words.len(),
        partial,
        pair_comparisons: budget.used,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PAGE: [f64; 4] = [0.0, 0.0, 600.0, 800.0];
    fn word(x: f64, y: f64, glyphs: f64) -> Word {
        Word {
            x,
            y,
            width: glyphs * 5.0,
            height: 10.0,
            glyphs,
        }
    }
    fn analyze_words(words: &[Word]) -> Features {
        analyze(words, &[], &[], None, 0, PAGE)
    }

    #[test]
    fn finds_three_aligned_short_cell_rows_without_ruling() {
        let mut words = Vec::new();
        for y in [100.0, 120.0, 140.0] {
            for x in [50.0, 200.0, 350.0] {
                words.push(word(x, y, 6.0));
            }
        }
        let out = analyze_words(&words);
        assert_eq!(out.unruled_tables.regions.len(), 1);
        assert_eq!(out.text.table_glyphs, 54.0);
        assert_eq!(out.text.other_glyphs, 0.0);
        assert!(!out.partial);
    }

    #[test]
    fn prose_and_numbered_lists_are_not_tables() {
        let mut prose = Vec::new();
        let mut list = Vec::new();
        for y in [100.0, 120.0, 140.0, 160.0] {
            prose.push(word(50.0, y, 80.0));
            list.push(word(50.0, y, 2.0));
            list.push(word(100.0, y, 20.0));
        }
        assert!(analyze_words(&prose).unruled_tables.regions.is_empty());
        assert!(analyze_words(&list).unruled_tables.regions.is_empty());
    }

    #[test]
    fn ruled_tables_are_not_counted_again_as_unruled() {
        let words: Vec<_> = [100.0, 120.0, 140.0]
            .into_iter()
            .flat_map(|y| [50.0, 200.0, 350.0].map(|x| word(x, y, 6.0)))
            .collect();
        let out = analyze(&words, &[], &[[40.0, 90.0, 400.0, 160.0]], None, 0, PAGE);
        assert_eq!(out.tables.regions.len(), 1);
        assert!(out.unruled_tables.regions.is_empty());
        assert_eq!(out.text.table_glyphs, 54.0);
    }

    #[test]
    fn short_text_next_to_an_image_is_a_caption_candidate() {
        let words = [
            word(110.0, 310.0, 20.0),
            word(110.0, 330.0, 18.0),
            word(30.0, 600.0, 80.0),
        ];
        let out = analyze(&words, &[[100.0, 100.0, 400.0, 300.0]], &[], None, 0, PAGE);
        assert_eq!(out.captions.regions.len(), 1);
        assert_eq!(out.text.caption_glyphs, 20.0);
        assert_eq!(
            out.text.total_glyphs,
            out.text.table_glyphs + out.text.caption_glyphs + out.text.other_glyphs
        );
        assert_eq!(out.captions.confidence, Confidence::Low);
    }

    #[test]
    fn table_ownership_precedes_caption_and_vector_candidates_are_honest() {
        let words = [word(110.0, 310.0, 20.0)];
        let out = analyze(
            &words,
            &[[100.0, 100.0, 400.0, 300.0]],
            &[[100.0, 300.0, 400.0, 340.0]],
            Some([100.0, 300.0, 400.0, 340.0]),
            100,
            PAGE,
        );
        assert_eq!(out.text.table_glyphs, 20.0);
        assert_eq!(out.text.caption_glyphs, 0.0);
        assert!(out.vector_figures.regions.is_empty());
        let figure = analyze(&[], &[], &[], Some([100.0, 100.0, 400.0, 400.0]), 100, PAGE);
        assert_eq!(figure.vector_figures.regions.len(), 1);
        assert!(figure.vector_figures.method.contains("not-semantic-chart"));
    }

    #[test]
    fn invalid_or_truncated_input_is_explicitly_partial_and_bounded() {
        let words = vec![word(50.0, 100.0, 6.0); MAX_WORDS + 1];
        let out = analyze_words(&words);
        assert_eq!(out.words_observed, MAX_WORDS);
        assert!(out.partial);
        assert!(!out.text.complete);
        assert!(out.pair_comparisons <= MAX_PAIR_COMPARISONS);
        let bad = analyze_words(&[Word {
            x: f64::NAN,
            ..word(0.0, 0.0, 1.0)
        }]);
        assert!(bad.partial);
        assert_eq!(bad.text.total_glyphs, 0.0);
    }

    #[test]
    fn overlapping_regions_use_union_area_and_do_not_duplicate_glyphs() {
        let out = analyze(
            &[word(150.0, 150.0, 6.0)],
            &[],
            &[[100.0, 100.0, 300.0, 300.0], [100.0, 100.0, 300.0, 300.0]],
            None,
            0,
            PAGE,
        );
        assert_eq!(out.text.table_glyphs, 6.0);
        assert!((out.tables.coverage.unwrap() - 40000.0 / 480000.0).abs() < 1e-10);
    }

    #[test]
    fn adversarial_region_word_product_stops_at_comparison_budget() {
        let words = vec![word(1.0, 1.0, 1.0); MAX_WORDS];
        let regions = vec![[300.0, 300.0, 301.0, 301.0]; MAX_REGIONS];
        let out = analyze(&words, &[], &regions, None, 0, PAGE);
        assert!(out.partial);
        assert_eq!(out.pair_comparisons, MAX_PAIR_COMPARISONS);
        assert!(!out.text.complete);
    }
}
