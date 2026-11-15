//! The layout walker's geometry (`pdf-layout-facts@1`, core `docs/page-layout-facts.md`, computed on the worker by
//! `worker/scripts/pdf_layout_facts.py`), reproduced from the page's own content stream: the displayed page space, image
//! placement and coverage, ruling lines and the ruled grids and table coverage built from them. Structure only.
//! `tests/layout_walker.rs` cross-checks these against the walker's output on the routing fixtures.

use crate::rules::LayoutRules;

pub type Matrix = [f64; 6];

/// The visible page box (crop box ∩ media box) and the map from default user space to displayed page space (points,
/// origin top-left, y down, the page's /Rotate applied): the walker's `display_matrix`.
#[derive(Debug, Clone, Copy)]
pub struct DisplaySpace {
    pub matrix: Matrix,
    /// The visible box in displayed coordinates.
    pub visible: [f64; 4],
}

impl DisplaySpace {
    pub fn new(media: [f64; 4], visible_user: [f64; 4], rotate: i64) -> Self {
        let [x0, y0, x1, y1] = media;
        let (w, h) = (x1 - x0, y1 - y0);
        let base: Matrix = [1.0, 0.0, 0.0, -1.0, -x0, y1];
        let rotation: Option<Matrix> = match rotate.rem_euclid(360) {
            90 => Some([0.0, 1.0, -1.0, 0.0, h, 0.0]),
            180 => Some([-1.0, 0.0, 0.0, -1.0, w, h]),
            270 => Some([0.0, -1.0, 1.0, 0.0, 0.0, w]),
            _ => None,
        };
        let matrix = rotation.map_or(base, |rotation| multiply(&base, &rotation));
        let mut space = Self { matrix, visible: [0.0; 4] };
        space.visible = space.bounds(&[
            (visible_user[0], visible_user[1]),
            (visible_user[2], visible_user[1]),
            (visible_user[0], visible_user[3]),
            (visible_user[2], visible_user[3]),
        ]);
        space
    }

    pub fn point(&self, x: f64, y: f64) -> (f64, f64) {
        let m = &self.matrix;
        (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
    }

    /// The displayed bounding box of user-space points.
    pub fn bounds(&self, points: &[(f64, f64)]) -> [f64; 4] {
        let mut out = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for (x, y) in points {
            let (dx, dy) = self.point(*x, *y);
            out = [out[0].min(dx), out[1].min(dy), out[2].max(dx), out[3].max(dy)];
        }
        out
    }

    pub fn visible_area(&self) -> f64 {
        ((self.visible[2] - self.visible[0]) * (self.visible[3] - self.visible[1])).max(1e-9)
    }

    /// `placement_from_draw`: an image drawn with `ctm` (the unit square in user space) as a displayed box and its share
    /// of the visible page, clipped to it; a rotated or skewed draw counts its own area, capped by the clipped box. None
    /// when the draw is not finite.
    pub fn placement(&self, ctm: &Matrix) -> Option<([f64; 4], f64)> {
        let shown = multiply(ctm, &self.matrix);
        let [a, b, c, d, e, f] = shown;
        let corners = [(e, f), (a + e, b + f), (c + e, d + f), (a + c + e, b + d + f)];
        if !corners.iter().all(|(x, y)| x.is_finite() && y.is_finite() && x.abs() < 1e7 && y.abs() < 1e7) {
            return None;
        }
        let bbox = [
            corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min),
            corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min),
            corners.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max),
            corners.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max),
        ];
        let v = self.visible;
        let ix = (bbox[2].min(v[2]) - bbox[0].max(v[0])).max(0.0);
        let iy = (bbox[3].min(v[3]) - bbox[1].max(v[1])).max(0.0);
        let own = (a * d - b * c).abs();
        let box_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
        let covered = if own < box_area - 1e-6 { own.min(ix * iy) } else { ix * iy };
        Some((bbox, (covered / self.visible_area()).clamp(0.0, 1.0)))
    }
}

pub fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

/// A path under construction, in displayed coordinates: straight segments and rectangles (curves are never rules).
#[derive(Debug, Default)]
pub struct PathBuilder {
    segments: Vec<((f64, f64), (f64, f64))>,
    rectangles: Vec<[f64; 4]>,
    current: Option<(f64, f64)>,
    start: Option<(f64, f64)>,
    overflow: bool,
    pub detailed_min_length: Option<f64>,
}

/// Segments and rectangles kept per path; a path larger than this is drawing, not ruling.
const MAX_PATH_PARTS: usize = 4_096;

impl PathBuilder {
    pub fn move_to(&mut self, point: (f64, f64)) {
        self.current = Some(point);
        self.start = Some(point);
    }

    pub fn line_to(&mut self, point: (f64, f64)) {
        if let Some(from) = self.current {
            let eligible = self.detailed_min_length.is_none_or(|min| {
                (from.1-point.1).abs()<0.01 && (from.0-point.0).abs()>=min
                || (from.0-point.0).abs()<0.01 && (from.1-point.1).abs()>=min
            });
            if eligible && self.segments.len() < MAX_PATH_PARTS {
                self.segments.push((from, point));
            } else if eligible { self.overflow = true;
            }
        }
        self.current = Some(point);
    }

    /// A curve ends where it ends; it is never a rule.
    pub fn curve_to(&mut self, end: (f64, f64)) {
        self.current = Some(end);
    }

    pub fn close(&mut self) {
        if let (Some(from), Some(start)) = (self.current, self.start) {
            if from != start { self.line_to(start); }
            self.current = Some(start);
        }
    }

    /// A rectangle given by its four displayed corners.
    pub fn rectangle(&mut self, corners: [(f64, f64); 4]) {
        let axis_aligned = (corners[0].1 - corners[1].1).abs() < 0.01 && (corners[0].0 - corners[3].0).abs() < 0.01
            || (corners[0].0 - corners[1].0).abs() < 0.01 && (corners[0].1 - corners[3].1).abs() < 0.01;
        let eligible = self.detailed_min_length.is_none_or(|min| {
            let xs=corners.map(|p|p.0);let ys=corners.map(|p|p.1);
            xs.iter().copied().fold(f64::NEG_INFINITY,f64::max)-xs.iter().copied().fold(f64::INFINITY,f64::min)>=min
            || ys.iter().copied().fold(f64::NEG_INFINITY,f64::max)-ys.iter().copied().fold(f64::INFINITY,f64::min)>=min
        });
        if axis_aligned && eligible && self.rectangles.len() < MAX_PATH_PARTS {
            let xs = corners.map(|p| p.0);
            let ys = corners.map(|p| p.1);
            self.rectangles.push([
                xs.iter().copied().fold(f64::INFINITY, f64::min),
                ys.iter().copied().fold(f64::INFINITY, f64::min),
                xs.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                ys.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            ]);
        } else if axis_aligned && eligible { self.overflow = true; }
        self.move_to(corners[0]);
    }

    /// Paint the path: a stroke turns each horizontal or vertical segment and each rectangle edge into a rule as thick as
    /// the line; a fill turns each thin rectangle into a rule. Rules are clipped to the visible box. The path is consumed.
    pub fn paint(&mut self, stroke: bool, fill: bool, line_width: f64, visible: [f64; 4], rules: &mut RuleSet, limits: &LayoutRules) {
        if self.overflow && (stroke || fill) && rules.eligible_only { rules.overflow = true; }
        let half = (line_width.abs().max(0.0)) / 2.0;
        let mut add = |rule: [f64; 4]| {
            let clipped = [rule[0].max(visible[0]), rule[1].max(visible[1]), rule[2].min(visible[2]), rule[3].min(visible[3])];
            if clipped[2] >= clipped[0] && clipped[3] >= clipped[1] {
                rules.push(clipped, limits.max_rules_per_page as usize, limits);
            }
        };
        if stroke {
            let mut edges = std::mem::take(&mut self.segments);
            for r in &self.rectangles {
                edges.push(((r[0], r[1]), (r[2], r[1])));
                edges.push(((r[2], r[1]), (r[2], r[3])));
                edges.push(((r[0], r[3]), (r[2], r[3])));
                edges.push(((r[0], r[1]), (r[0], r[3])));
            }
            for ((x0, y0), (x1, y1)) in edges {
                if (y0 - y1).abs() < 0.01 && (x0 - x1).abs() >= 0.01 {
                    add([x0.min(x1), y0 - half, x0.max(x1), y0 + half]);
                } else if (x0 - x1).abs() < 0.01 && (y0 - y1).abs() >= 0.01 {
                    add([x0 - half, y0.min(y1), x0 + half, y0.max(y1)]);
                }
            }
        } else if fill {
            for r in &self.rectangles {
                if r[2] - r[0] <= limits.rule_thickness_pt || r[3] - r[1] <= limits.rule_thickness_pt {
                    add(*r);
                }
            }
        }
        let detailed_min_length = self.detailed_min_length;
        *self = PathBuilder::default();
        self.detailed_min_length = detailed_min_length;
    }
}

/// A page's ruling lines in displayed coordinates; `overflow` when there were more than the walker keeps.
#[derive(Debug, Default, Clone)]
pub struct RuleSet {
    pub rules: Vec<[f64; 4]>,
    pub overflow: bool,
    pub eligible_only: bool,
    seen: std::collections::HashSet<[u64; 4]>,
}

impl RuleSet {
    fn push(&mut self, rule: [f64; 4], cap: usize, limits: &LayoutRules) {
        if self.eligible_only {
            let w = rule[2] - rule[0];
            let h = rule[3] - rule[1];
            if !(h <= limits.rule_thickness_pt && w >= limits.rule_min_length_pt
                || w <= limits.rule_thickness_pt && h >= limits.rule_min_length_pt) { return; }
            let key = rule.map(|v| if v == 0.0 { 0 } else { v.to_bits() });
            if self.seen.contains(&key) { return; }
            if self.rules.len() < cap { self.seen.insert(key); }
        }
        if self.rules.len() < cap {
            self.rules.push(rule);
        } else {
            self.overflow = true;
        }
    }
}

/// One ruled grid: rows and columns between its distinct lines, and its box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    pub rows: u32,
    pub columns: u32,
    pub bbox: [f64; 4],
}

/// `ruled_grids`: connected sets of horizontal and vertical rules (at most `rule_thickness_pt` thick, at least
/// `rule_min_length_pt` long, meeting within `rule_touch_pt`) with at least two distinct horizontals and three distinct
/// verticals.
pub fn ruled_grids(rules: &[[f64; 4]], limits: &LayoutRules) -> Vec<Grid> {
    // Preserve the existing unrestricted geometry contract for legacy callers.
    ruled_grids_checked(rules, limits, usize::MAX).unwrap_or_default()
}

/// The same grid detection with a bounded orthogonal intersection sweep.
/// `None` is unknown evidence, not an empty table list. The allowance counts
/// spatial candidates visited; parallel and distant pairs consume no visits.
/// Grouping preserves legacy first-seen order and uses a lookup map so it does
/// not introduce a second, uncharged quadratic scan.
pub fn ruled_grids_checked(rules: &[[f64; 4]], limits: &LayoutRules, max_comparisons: usize) -> Option<Vec<Grid>> {
    let thin = limits.rule_thickness_pt;
    let long = limits.rule_min_length_pt;
    let mut lines: Vec<(bool, [f64; 4])> = Vec::new();
    for r in rules {
        if r[3] - r[1] <= thin && r[2] - r[0] >= long {
            lines.push((true, *r));
        }
    }
    for r in rules {
        if r[2] - r[0] <= thin && r[3] - r[1] >= long {
            lines.push((false, *r));
        }
    }
    let mut parent: Vec<usize> = (0..lines.len()).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let t = limits.rule_touch_pt;
    let meet = |a: &[f64; 4], b: &[f64; 4]| a[0] - t <= b[2] && b[0] - t <= a[2] && a[1] - t <= b[3] && b[1] - t <= a[3];
    // Query at the horizontal's top. Start verticals early by the maximum
    // horizontal thickness; query x uses the maximum vertical thickness.
    // These conservative windows cannot miss a legacy meet; the exact predicate
    // below removes broad-phase false positives. Event ties include endpoints.
    fn key(v: f64) -> u64 {
        let bits = if v == 0.0 { 0 } else { v.to_bits() };
        if bits >> 63 == 1 { !bits } else { bits ^ (1 << 63) }
    }
    let mut events = Vec::with_capacity(lines.len() * 2);
    for (i, (horizontal, r)) in lines.iter().enumerate() {
        if !r.iter().all(|v| v.is_finite()) { return None; }
        if *horizontal { events.push((r[1], 1u8, i)); }
        else { events.push((r[1] - t - thin, 0, i)); events.push((r[3] + t, 2, i)); }
    }
    events.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut active = std::collections::BTreeMap::new();
    let mut compared = 0usize;
    for (_, kind, i) in events {
        let r = lines[i].1;
        let position = (key(r[0]), i);
        match kind {
            0 => { active.insert(position, i); }
            2 => { active.remove(&position); }
            _ => {
                for (_, &j) in active.range((key(r[0] - t - thin), 0)..=(key(r[2] + t), usize::MAX)) {
                    if compared == max_comparisons { return None; }
                    compared += 1;
                    if meet(&r, &lines[j].1) {
                        let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                        parent[a] = b;
                    }
                }
            }
        }
    }
    let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut group_indices = std::collections::HashMap::new();
    for i in 0..lines.len() {
        let root = find(&mut parent, i);
        let index = *group_indices.entry(root).or_insert_with(|| {
            let index = groups.len();
            groups.push((root, Vec::new()));
            index
        });
        groups[index].1.push(i);
    }
    let mut grids = Vec::new();
    for (_, members) in groups {
        let ys = distinct(members.iter().filter(|i| lines[**i].0).map(|i| (lines[*i].1[1] + lines[*i].1[3]) / 2.0).collect(), t);
        let xs = distinct(members.iter().filter(|i| !lines[**i].0).map(|i| (lines[*i].1[0] + lines[*i].1[2]) / 2.0).collect(), t);
        if ys < 2 || xs < 3 {
            continue;
        }
        let boxes = members.iter().map(|i| lines[*i].1);
        let bbox = boxes.fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, r| {
            [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[2]), b[3].max(r[3])]
        });
        grids.push(Grid { rows: ys as u32 - 1, columns: xs as u32 - 1, bbox });
    }
    Some(grids)
}

fn distinct(mut values: Vec<f64>, tolerance: f64) -> usize {
    values.sort_by(f64::total_cmp);
    let mut count = 0;
    let mut last: Option<f64> = None;
    for value in values {
        if last.is_none_or(|previous| value - previous > tolerance) {
            count += 1;
            last = Some(value);
        }
    }
    count
}

/// `union_coverage`: the share of the visible box the union of `boxes` covers, on a raster × raster grid.
pub fn union_coverage(boxes: &[[f64; 4]], visible: [f64; 4], raster: u32) -> f64 {
    let n = raster.max(1) as usize;
    let width = (visible[2] - visible[0]).max(1e-9);
    let height = (visible[3] - visible[1]).max(1e-9);
    let mut covered = vec![false; n * n];
    for b in boxes {
        let c0 = (((b[0] - visible[0]) / width * n as f64) as i64).max(0) as usize;
        let c1 = (((b[2] - visible[0]) / width * n as f64).ceil() as i64).clamp(0, n as i64) as usize;
        let r0 = (((b[1] - visible[1]) / height * n as f64) as i64).max(0) as usize;
        let r1 = (((b[3] - visible[1]) / height * n as f64).ceil() as i64).clamp(0, n as i64) as usize;
        for r in r0..r1 {
            for c in c0..c1 {
                covered[r * n + c] = true;
            }
        }
    }
    let count = covered.iter().filter(|cell| **cell).count();
    (count as f64 / (n * n) as f64 * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> LayoutRules {
        crate::rules::Rules::bundled().layout.clone()
    }

    #[test]
    fn rotation_maps_user_space_to_the_displayed_page() {
        let media = [0.0, 0.0, 612.0, 792.0];
        let upright = DisplaySpace::new(media, media, 0);
        assert_eq!(upright.point(0.0, 792.0), (0.0, 0.0));
        assert_eq!(upright.visible, [0.0, 0.0, 612.0, 792.0]);
        let turned = DisplaySpace::new(media, media, 90);
        assert_eq!(turned.visible, [0.0, 0.0, 792.0, 612.0]);
    }

    #[test]
    fn a_stroked_rectangle_is_four_rules_and_three_columns_make_a_grid() {
        let visible = [0.0, 0.0, 612.0, 792.0];
        let mut rules = RuleSet::default();
        for x in [72.0, 182.0, 292.0, 402.0] {
            let mut path = PathBuilder::default();
            path.rectangle([(x, 100.0), (x + 100.0, 100.0), (x + 100.0, 120.0), (x, 120.0)]);
            path.paint(true, false, 0.5, visible, &mut rules, &limits());
        }
        assert_eq!(rules.rules.len(), 16);
        let mut grid_rules = RuleSet::default();
        let mut path = PathBuilder::default();
        for y in [100.0, 120.0, 140.0] {
            path.move_to((72.0, y));
            path.line_to((372.0, y));
        }
        for x in [72.0, 172.0, 272.0, 372.0] {
            path.move_to((x, 100.0));
            path.line_to((x, 140.0));
        }
        path.paint(true, false, 0.5, visible, &mut grid_rules, &limits());
        let grids = ruled_grids(&grid_rules.rules, &limits());
        assert_eq!(grids.len(), 1);
        assert_eq!((grids[0].rows, grids[0].columns), (2, 3));
        assert!(union_coverage(&[grids[0].bbox], visible, 200) > 0.0);
    }

    #[test]
    fn checked_grid_parallel_rules_need_no_candidate_visits() {
        let rules: Vec<[f64; 4]> = (0..4096)
            .map(|y| [0.0, y as f64, 600.0, y as f64])
            .collect();
        assert_eq!(ruled_grids_checked(&rules, &limits(), 0), Some(Vec::new()));
        assert_eq!(ruled_grids_checked(&[], &limits(), 0), Some(Vec::new()));
        assert_eq!(ruled_grids_checked(&rules[..1], &limits(), 0), Some(Vec::new()));
    }

    #[test]
    fn checked_grid_boundary_preserves_normal_and_legacy_results() {
        let rules = [
            [72.0, 100.0, 372.0, 100.0],
            [72.0, 120.0, 372.0, 120.0],
            [72.0, 140.0, 372.0, 140.0],
            [72.0, 100.0, 72.0, 140.0],
            [172.0, 100.0, 172.0, 140.0],
            [272.0, 100.0, 272.0, 140.0],
            [372.0, 100.0, 372.0, 140.0],
        ];
        assert_eq!(ruled_grids_checked(&rules, &limits(), 11), None);
        let checked = ruled_grids_checked(&rules, &limits(), 12).unwrap();
        assert_eq!(checked, ruled_grids(&rules, &limits()));
        assert_eq!(checked.len(), 1);
        assert_eq!((checked[0].rows, checked[0].columns), (2, 3));
    }

    #[test]
    fn a_large_filled_panel_is_not_a_rule() {
        let mut rules = RuleSet::default();
        let mut path = PathBuilder::default();
        path.rectangle([(48.0, 300.0), (564.0, 300.0), (564.0, 382.0), (48.0, 382.0)]);
        path.paint(false, true, 1.0, [0.0, 0.0, 612.0, 792.0], &mut rules, &limits());
        assert!(rules.rules.is_empty());
    }
}

#[cfg(test)]
mod sweep_regressions {
    use super::*;
    fn limits() -> LayoutRules { crate::rules::Rules::bundled().layout.clone() }
    #[test]
    fn detailed_path_discards_short_fragments_but_reports_relevant_truncation() {
        let limits=limits();let visible=[0.0,0.0,600.0,800.0];
        let mut path=PathBuilder::default();path.detailed_min_length=Some(limits.rule_min_length_pt);
        let mut rules=RuleSet::default();rules.eligible_only=true;
        for _ in 0..5000 {path.move_to((0.0,0.0));path.line_to((1.0,0.0));}
        path.move_to((0.0,10.0));path.line_to((500.0,10.0));
        path.paint(true,false,0.5,visible,&mut rules,&limits);
        assert_eq!(rules.rules.len(),1);assert!(!rules.overflow);
        for y in 0..5000 {path.move_to((0.0,y as f64/10.0));path.line_to((500.0,y as f64/10.0));}
        path.paint(true,false,0.5,visible,&mut rules,&limits);
        assert!(rules.overflow);
    }
    #[test]
    fn sweep_matches_exhaustive_touch_geometry_and_component_order() {
        let mut seed=17u64;
        for _ in 0..500 {
            let mut next=||{seed=seed.wrapping_mul(6364136223846793005).wrapping_add(1);(seed>>32) as u32};
            let mut rules=Vec::new();
            for _ in 0..40 {
                let x=(next()%40) as f64-20.0; let y=(next()%40) as f64-20.0;
                let length=10.0+(next()%40) as f64; let thickness=(next()%30) as f64/10.0;
                rules.push(if next()%2==0 {[x,y,x+length,y+thickness]} else {[x,y,x+thickness,y+length]});
            }
            assert_eq!(ruled_grids_checked(&rules,&limits(),65536),reference_grids_checked(&rules,&limits(),usize::MAX));
        }
    }
    #[test]
    fn long_tables_and_disconnected_groups_use_only_local_contacts() {
        let mut rules:Vec<_>=(0..400).map(|y|[0.0,y as f64*5.0,500.0,y as f64*5.0]).collect();
        rules.extend((0..5).map(|x|[x as f64*100.0,0.0,x as f64*100.0,1995.0]));
        let grids=ruled_grids_checked(&rules,&limits(),65536).unwrap();
        assert_eq!((grids[0].rows,grids[0].columns),(399,4));
        let mut sparse=Vec::new();
        for n in 0..500 { let b=n as f64*1000.0;
            for y in [0.0,20.0,40.0] {sparse.push([b,b+y,b+100.0,b+y]);}
            for x in [0.0,50.0,100.0] {sparse.push([b+x,b,b+x,b+40.0]);}
        }
        assert_eq!(ruled_grids_checked(&sparse,&limits(),65536).unwrap().len(),500);
        let mut dense:Vec<_>=(0..300).map(|y|[0.0,y as f64,500.0,y as f64]).collect();
        dense.extend((0..300).map(|x|[x as f64,0.0,x as f64,500.0]));
        assert_eq!(ruled_grids_checked(&dense,&limits(),65536),None);
    }
    #[test]
    fn detailed_retention_drops_only_ineligible_and_exact_duplicate_rules() {
        let limits=limits();let mut detailed=RuleSet::default();detailed.eligible_only=true;
        let mut legacy=RuleSet::default();
        for _ in 0..6000 {for set in [&mut detailed,&mut legacy] {
            let mut path=PathBuilder::default();path.move_to((0.0,10.0));path.line_to((1.0,10.0));
            path.paint(true,false,0.5,[0.0,0.0,600.0,800.0],set,&limits);
        }}
        assert!(legacy.overflow);assert!(!detailed.overflow);assert!(detailed.rules.is_empty());
        for _ in 0..10000 {
            let mut path=PathBuilder::default();path.move_to((0.0,10.0));path.line_to((500.0,10.0));
            path.paint(true,false,0.5,[0.0,0.0,600.0,800.0],&mut detailed,&limits);
        }
        assert_eq!(detailed.rules.len(),1);assert!(!detailed.overflow);
    }
fn reference_grids_checked(rules: &[[f64; 4]], limits: &LayoutRules, max_comparisons: usize) -> Option<Vec<Grid>> {
    let thin = limits.rule_thickness_pt;
    let long = limits.rule_min_length_pt;
    let mut lines: Vec<(bool, [f64; 4])> = Vec::new();
    for r in rules {
        if r[3] - r[1] <= thin && r[2] - r[0] >= long {
            lines.push((true, *r));
        }
    }
    for r in rules {
        if r[2] - r[0] <= thin && r[3] - r[1] >= long {
            lines.push((false, *r));
        }
    }
    // Reject large inputs in O(n), before allocating union-find state or
    // spending the allowance on a prefix whose result must be discarded.
    let comparisons = lines.len().checked_mul(lines.len().saturating_sub(1))? / 2;
    if comparisons > max_comparisons {
        return None;
    }
    let mut parent: Vec<usize> = (0..lines.len()).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let t = limits.rule_touch_pt;
    let meet = |a: &[f64; 4], b: &[f64; 4]| a[0] - t <= b[2] && b[0] - t <= a[2] && a[1] - t <= b[3] && b[1] - t <= a[3];
    for i in 0..lines.len() {
        for j in (i + 1)..lines.len() {
            if lines[i].0 != lines[j].0 && meet(&lines[i].1, &lines[j].1) {
                let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                parent[a] = b;
            }
        }
    }
    let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut group_indices = std::collections::HashMap::new();
    for i in 0..lines.len() {
        let root = find(&mut parent, i);
        let index = *group_indices.entry(root).or_insert_with(|| {
            let index = groups.len();
            groups.push((root, Vec::new()));
            index
        });
        groups[index].1.push(i);
    }
    let mut grids = Vec::new();
    for (_, members) in groups {
        let ys = distinct(members.iter().filter(|i| lines[**i].0).map(|i| (lines[*i].1[1] + lines[*i].1[3]) / 2.0).collect(), t);
        let xs = distinct(members.iter().filter(|i| !lines[**i].0).map(|i| (lines[*i].1[0] + lines[*i].1[2]) / 2.0).collect(), t);
        if ys < 2 || xs < 3 {
            continue;
        }
        let boxes = members.iter().map(|i| lines[*i].1);
        let bbox = boxes.fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, r| {
            [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[2]), b[3].max(r[3])]
        });
        grids.push(Grid { rows: ys as u32 - 1, columns: xs as u32 - 1, bbox });
    }
    Some(grids)
}

}
