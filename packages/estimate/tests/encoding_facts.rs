//! Math and table encoding facts (`pageEncodings`, the tagged counts and the per-page stat stream) on small PDFs built
//! here with lopdf: one positive and the negatives each fact must reject.

use std::time::{Duration, Instant};

use docslurp_estimate::probe::{probe, FileProfile, ProbeInput};
use docslurp_estimate::Rules;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

const MATH_FONT: u16 = 1 << 0;
const STACKED: u16 = 1 << 1;
const SOURCE: u16 = 1 << 2;
const ACTUAL_TEXT: u16 = 1 << 3;
const STRIP: u16 = 1 << 4;
const OUTLINES: u16 = 1 << 5;
const TYPE3_BITMAP: u16 = 1 << 6;
const RULE_GRID: u16 = 1 << 8;
const RULE_TABLE: u16 = 1 << 9;
const TAGGED_TABLE: u16 = 1 << 10;
const TAGGED_FORMULA: u16 = 1 << 11;
const TABLE_IMAGE: u16 = 1 << 12;
const MATH_GRID: u16 = 1 << 13;
const PARTIAL: u16 = 1 << 15;

/// A PDF under construction: fonts and images as page resources, pages of raw content, catalog extras.
struct Builder {
    document: Document,
    fonts: Dictionary,
    images: Dictionary,
    pages: Vec<(String, Dictionary)>,
}

impl Builder {
    fn new() -> Self {
        let mut builder = Self { document: Document::with_version("1.7"), fonts: Dictionary::new(), images: Dictionary::new(), pages: Vec::new() };
        builder.font("F1", dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
        builder
    }

    fn font(&mut self, name: &str, font: Dictionary) -> ObjectId {
        let id = self.document.add_object(font);
        self.fonts.set(name, id);
        id
    }

    fn image(&mut self, name: &str, width: i64, height: i64, filter: Option<&str>) -> ObjectId {
        let mut dict = dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => width, "Height" => height, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 };
        if let Some(filter) = filter { dict.set("Filter", Object::Name(filter.as_bytes().to_vec())); }
        let id = self.document.add_object(Stream::new(dict, vec![0x80; (width * height).clamp(1, 1 << 20) as usize]));
        self.images.set(name, id);
        id
    }

    fn page(&mut self, content: impl Into<String>) -> &mut Self {
        self.pages.push((content.into(), Dictionary::new()));
        self
    }

    fn build(mut self, catalog_extra: impl FnOnce(&mut Document, &[ObjectId]) -> Dictionary) -> Vec<u8> {
        let pages_id = self.document.new_object_id();
        let resources = self.document.add_object(dictionary! { "Font" => self.fonts.clone(), "XObject" => self.images.clone() });
        let mut kids = Vec::new();
        let mut page_ids = Vec::new();
        for (content, extra) in std::mem::take(&mut self.pages) {
            let content = self.document.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
            let mut page = dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Contents" => content, "Resources" => resources };
            for (key, value) in extra.iter() { page.set(key.clone(), value.clone()); }
            let id = self.document.add_object(page);
            kids.push(Object::Reference(id));
            page_ids.push(id);
        }
        let count = kids.len() as i64;
        self.document.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
        let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages_id };
        for (key, value) in catalog_extra(&mut self.document, &page_ids).iter() { catalog.set(key.clone(), value.clone()); }
        let catalog = self.document.add_object(catalog);
        self.document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        self.document.save_to(&mut bytes).unwrap();
        bytes
    }

    fn bytes(self) -> Vec<u8> { self.build(|_, _| Dictionary::new()) }
}

fn profile(bytes: &[u8]) -> FileProfile {
    let result = probe(Rules::bundled(), &ProbeInput::whole("test.pdf", None, bytes));
    assert!(serde_json::to_string(&result).unwrap().len() <= 4096);
    result
}

/// The masks of the sampled pages, one entry a page (from the histogram).
fn masks(bytes: &[u8]) -> Vec<u16> {
    let result = profile(bytes);
    let pdf = result.pdf.unwrap_or_else(|| panic!("no page facts: {:?}", result.notes));
    pdf.page_encodings.unwrap().iter().flat_map(|(mask, pages)| std::iter::repeat_n(*mask, *pages as usize)).collect()
}

fn mask(bytes: &[u8]) -> u16 {
    masks(bytes).into_iter().fold(0, |all, mask| all | mask)
}

/// A paragraph of plain text lines in Helvetica (about 12 words a line).
fn prose(lines: usize, top: f64) -> String {
    (0..lines).map(|i| format!("BT /F1 10 Tf 72 {:.1} Td (Quarterly results improved across every region and the team expanded to London.) Tj ET\n", top - 14.0 * i as f64)).collect()
}

fn math_font() -> Dictionary {
    dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "ABCDEF+CMMI10" }
}

#[test]
fn math_fonts_are_seen_by_name_and_symbol_heavy_prose_is_not() {
    let mut pdf = Builder::new();
    pdf.font("M1", math_font());
    pdf.page(format!("{}BT /F1 10 Tf 72 600 Td (Let ) Tj /M1 10 Tf (x) Tj /F1 10 Tf ( be given.) Tj ET\n", prose(3, 700.0)));
    assert_eq!(mask(&pdf.bytes()) & MATH_FONT, MATH_FONT);

    // Plus-minus, degree, euro and arrows in an ordinary text font, and a STIX Two Text page: no math font.
    let mut pdf = Builder::new();
    pdf.font("T2", dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "STIXTwoText-Regular" });
    pdf.page(format!("{}BT /F1 10 Tf 72 600 Td (Total 5 \\200 \\261 2 at 20\\260C) Tj ET BT /T2 10 Tf 72 580 Td (Plain words) Tj ET\n", prose(3, 700.0)));
    assert_eq!(mask(&pdf.bytes()) & (MATH_FONT | STACKED | MATH_GRID), 0);
}

#[test]
fn symbol_fonts_count_inside_a_line_and_not_as_bullets() {
    let symbol = || dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Symbol" };
    let mut bullets = Builder::new();
    bullets.font("S1", symbol());
    let list: String = (0..6).map(|i| format!("BT /S1 10 Tf 72 {y} Td (\\267) Tj ET BT /F1 10 Tf 84 {y} Td (An item of the list) Tj ET\n", y = 700 - 14 * i)).collect();
    bullets.page(list);
    assert_eq!(mask(&bullets.bytes()) & MATH_FONT, 0, "bullets start their lines");

    let mut inline = Builder::new();
    inline.font("S1", symbol());
    inline.page("BT /F1 10 Tf 72 700 Td (so that) Tj ET BT /S1 10 Tf 110 700 Td (a) Tj ET BT /F1 10 Tf 118 700 Td (plus) Tj ET BT /S1 10 Tf 140 700 Td (b) Tj ET\n");
    assert_eq!(mask(&inline.bytes()) & MATH_FONT, MATH_FONT);
}

#[test]
fn stacked_math_needs_runs_over_each_other_or_a_fraction_bar() {
    let mut pdf = Builder::new();
    pdf.font("M1", math_font());
    // A numerator over a denominator, with a fraction bar between them.
    pdf.page("BT /M1 10 Tf 200 610 Td (ab) Tj ET BT /M1 10 Tf 202 594 Td (c) Tj ET 198 604 14 0.5 re f\n");
    assert_eq!(mask(&pdf.bytes()) & STACKED, STACKED);
    // The same glyphs on one baseline.
    let mut flat = Builder::new();
    flat.font("M1", math_font());
    flat.page("BT /M1 10 Tf 200 600 Td (ab) Tj ET BT /M1 10 Tf 230 600 Td (c) Tj ET\n");
    assert_eq!(mask(&flat.bytes()) & STACKED, 0);
}

#[test]
fn type3_fonts_painting_images_are_bitmap_fonts_and_vector_ones_are_not() {
    let type3 = |pdf: &mut Builder, proc_content: &[u8], resources: Option<Dictionary>| {
        let proc_id = pdf.document.add_object(Stream::new(Dictionary::new(), proc_content.to_vec()));
        let mut font = dictionary! { "Type" => "Font", "Subtype" => "Type3", "FontBBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "FontMatrix" => vec![0.1.into(), 0.into(), 0.into(), 0.1.into(), 0.into(), 0.into()], "CharProcs" => dictionary! { "a" => proc_id },
            "Encoding" => dictionary! { "Type" => "Encoding", "Differences" => vec![97.into(), Object::Name(b"a".to_vec())] }, "FirstChar" => 97, "LastChar" => 97, "Widths" => vec![10.into()] };
        if let Some(resources) = resources { font.set("Resources", resources); }
        pdf.font("T3", font);
        pdf.page(format!("{}BT /T3 10 Tf 72 600 Td (aaaa) Tj ET\n", prose(2, 700.0)));
    };
    let mut bitmap = Builder::new();
    type3(&mut bitmap, b"10 0 0 0 8 8 d1 8 0 0 8 0 0 cm BI /IM true /W 8 /H 8 /BPC 1 ID \xff\x00\xff\x00\xff\x00\xff\x00 EI", None);
    assert_eq!(mask(&bitmap.bytes()) & TYPE3_BITMAP, TYPE3_BITMAP);

    let mut vector = Builder::new();
    type3(&mut vector, b"10 0 0 0 8 8 d1 0 0 m 8 0 l 8 8 l h f", None);
    assert_eq!(mask(&vector.bytes()) & TYPE3_BITMAP, 0);

    // A procedure drawing a form (not an image) is vector drawing too.
    let mut form = Builder::new();
    let glyph = form.document.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 8.into(), 8.into()] }, b"0 0 8 8 re f".to_vec()));
    type3(&mut form, b"10 0 0 0 8 8 d1 /G1 Do", Some(dictionary! { "XObject" => dictionary! { "G1" => glyph } }));
    assert_eq!(mask(&form.bytes()) & TYPE3_BITMAP, 0);
}

#[test]
fn formula_strips_are_short_wide_images_in_text_and_photos_logos_and_charts_are_not() {
    let mut strip = Builder::new();
    strip.image("I1", 600, 80, Some("FlateDecode"));
    strip.page(format!("{}q 200 0 0 26 150 560 cm /I1 Do Q\n", prose(4, 700.0)));
    let found = mask(&strip.bytes());
    assert_eq!(found & STRIP, STRIP);
    assert_eq!(found & TABLE_IMAGE, 0, "a strip is no table");

    // A photo (tall), a square logo and a vector chart.
    let mut others = Builder::new();
    others.image("P1", 400, 500, Some("DCTDecode"));
    others.image("L1", 120, 120, None);
    let chart: String = (0..12).map(|i| format!("{} 400 20 {} re f ", 100 + 30 * i, 20 + 10 * i)).collect();
    others.page(format!("{}q 200 0 0 250 72 300 cm /P1 Do Q q 40 0 0 40 400 600 cm /L1 Do Q {chart} 100 400 m 460 400 l S\n", prose(4, 740.0)));
    assert_eq!(mask(&others.bytes()) & (STRIP | TABLE_IMAGE | OUTLINES), 0);

    // A wide banner repeated on every page is furniture, not a strip.
    let mut banner = Builder::new();
    banner.image("B1", 600, 80, None);
    for _ in 0..5 { banner.page(format!("{}q 200 0 0 26 150 760 cm /B1 Do Q\n", prose(4, 700.0))); }
    assert_eq!(mask(&banner.bytes()) & STRIP, 0);
}

#[test]
fn table_images_are_lossless_wide_images_in_text() {
    let mut png = Builder::new();
    png.image("T1", 1200, 450, Some("FlateDecode"));
    png.page(format!("{}q 400 0 0 150 100 300 cm /T1 Do Q\n", prose(5, 700.0)));
    assert_eq!(mask(&png.bytes()) & TABLE_IMAGE, TABLE_IMAGE);
    let mut jpeg = Builder::new();
    jpeg.image("T1", 1200, 450, Some("DCTDecode"));
    jpeg.page(format!("{}q 400 0 0 150 100 300 cm /T1 Do Q\n", prose(5, 700.0)));
    assert_eq!(mask(&jpeg.bytes()) & TABLE_IMAGE, 0, "a JPEG is a photo");
}

#[test]
fn glyph_outlines_are_small_curve_dense_clusters() {
    // Five "formulas", each two filled glyph paths of four curves.
    let glyph = |x: f64, y: f64| format!("{x} {y} m {a} {b} {c} {d} {e} {y} c {a} {f} {c} {f} {x} {y} c {a} {b} {c} {d} {e} {y} c {a} {f} {c} {f} {x} {y} c f\n",
        a = x + 2.0, b = y + 6.0, c = x + 4.0, d = y + 6.0, e = x + 6.0, f = y - 2.0);
    let mut outlined = Builder::new();
    let content: String = (0..5).map(|i| { let y = 650.0 - 40.0 * i as f64; glyph(100.0, y) + &glyph(106.5, y) }).collect();
    outlined.page(format!("{}{content}", prose(2, 740.0)));
    assert_eq!(mask(&outlined.bytes()) & OUTLINES, OUTLINES);
}

/// A table body: `rows` rows of three cells (separate text objects a column gap apart) from `top` down.
fn cells(rows: usize, top: f64) -> String {
    (0..rows).map(|r| {
        let y = top - 14.0 * r as f64;
        format!("BT /F1 9 Tf 110 {y} Td (Region) Tj ET BT /F1 9 Tf 230 {y} Td (1,250) Tj ET BT /F1 9 Tf 350 {y} Td (+12%) Tj ET\n")
    }).collect()
}

#[test]
fn booktabs_tables_are_horizontal_rule_tables_and_forms_and_underlines_are_not() {
    let rule = |y: f64| format!("100 {y} m 420 {y} l S\n");
    let mut booktabs = Builder::new();
    booktabs.page(format!("{}{}{}{}{}{}", prose(3, 740.0), rule(600.0), cells(1, 590.0), rule(584.0), cells(4, 572.0), rule(512.0)));
    let found = mask(&booktabs.bytes());
    assert_eq!(found & RULE_TABLE, RULE_TABLE);
    assert_eq!(found & RULE_GRID, 0);

    // A lined form: a label over each of eight equal rules.
    let mut form = Builder::new();
    let lines: String = (0..8).map(|i| { let y = 650.0 - 30.0 * i as f64; format!("BT /F1 9 Tf 100 {} Td (Name of the applicant) Tj ET {}", y + 4.0, rule(y)) }).collect();
    form.page(format!("{}{lines}", prose(2, 740.0)));
    assert_eq!(mask(&form.bytes()) & RULE_TABLE, 0, "a lined form");

    // A single rule under a heading, and a footnote rule.
    let mut underline = Builder::new();
    underline.page(format!("BT /F1 14 Tf 100 700 Td (Results) Tj ET {}{}100 120 m 200 120 l S BT /F1 8 Tf 100 110 Td (1 A footnote.) Tj ET\n", rule(696.0), prose(10, 680.0)));
    assert_eq!(mask(&underline.bytes()) & RULE_TABLE, 0, "a heading underline");

    // The same rows in a full grid: a rule grid, not a horizontal-rule table.
    let mut grid = Builder::new();
    let verticals: String = [100.0, 220.0, 340.0, 420.0].iter().map(|x| format!("{x} 512 m {x} 600 l S ")).collect();
    grid.page(format!("{}{}{}{}{}{}{verticals}\n", prose(3, 740.0), rule(600.0), cells(1, 590.0), rule(584.0), cells(4, 572.0), rule(512.0)));
    let found = mask(&grid.bytes());
    assert_eq!(found & (RULE_GRID | RULE_TABLE), RULE_GRID);
}

#[test]
fn math_grids_need_aligned_rows_and_a_delimiter() {
    let entries = |pdf: &mut Builder, delimiters: bool| {
        pdf.font("M1", math_font());
        let cells: String = [(0, 0), (1, 0), (0, 1), (1, 1)].iter()
            .map(|(c, r)| format!("BT /M1 10 Tf {} {} Td (a) Tj ET ", 220 + 30 * c, 600 - 14 * r)).collect();
        let bars = if delimiters { "210 580 m 210 612 l S 268 580 m 268 612 l S" } else { "" };
        pdf.page(format!("{}{cells}{bars}\n", prose(2, 740.0)));
    };
    let mut matrix = Builder::new();
    entries(&mut matrix, true);
    assert_eq!(mask(&matrix.bytes()) & MATH_GRID, MATH_GRID);
    let mut aligned = Builder::new();
    entries(&mut aligned, false);
    assert_eq!(mask(&aligned.bytes()) & MATH_GRID, 0, "aligned equations have no delimiter");
}

#[test]
fn actual_text_is_seen_and_tex_like_text_is_a_source() {
    let mut tex = Builder::new();
    tex.page(format!("{}/Span << /ActualText (\\\\frac{{a}}{{b}}) >> BDC BT /F1 10 Tf 72 600 Td (a/b) Tj ET EMC\n", prose(2, 700.0)));
    assert_eq!(mask(&tex.bytes()) & (ACTUAL_TEXT | SOURCE), ACTUAL_TEXT | SOURCE);
    let mut ligature = Builder::new();
    ligature.page(format!("{}/Span << /ActualText (fi) >> BDC BT /F1 10 Tf 72 600 Td (\\001) Tj ET EMC\n", prose(2, 700.0)));
    assert_eq!(mask(&ligature.bytes()) & (ACTUAL_TEXT | SOURCE), ACTUAL_TEXT);
}

/// A structure tree under the catalog: `kids` built by the caller from the page ids.
fn tagged(build: impl FnOnce(&mut Document, &[ObjectId]) -> Object) -> FileProfile {
    let mut pdf = Builder::new();
    pdf.page(prose(3, 700.0));
    pdf.page(prose(3, 700.0));
    let bytes = pdf.build(|document, pages| {
        let kids = build(document, pages);
        let root = document.add_object(dictionary! { "Type" => "StructTreeRoot", "K" => kids, "RoleMap" => dictionary! { "Equation" => "Formula", "Grid" => "Table" } });
        dictionary! { "StructTreeRoot" => root, "MarkInfo" => dictionary! { "Marked" => true } }
    });
    profile(&bytes)
}

#[test]
fn tagged_formulas_and_tables_are_counted_through_the_role_map_and_marked_on_their_pages() {
    let result = tagged(|document, pages| {
        let formula = document.add_object(dictionary! { "S" => "Equation", "Pg" => pages[1], "Alt" => Object::string_literal("x^{2}"), "K" => 0 });
        let cell = document.add_object(dictionary! { "S" => "TD", "Pg" => pages[0], "K" => 1 });
        let table = document.add_object(dictionary! { "S" => "Grid", "K" => vec![cell.into()] });
        let figure = document.add_object(dictionary! { "S" => "Figure", "Pg" => pages[0], "K" => 2 });
        Object::Array(vec![formula.into(), table.into(), figure.into()])
    });
    let pdf = result.pdf.unwrap();
    assert_eq!((pdf.tagged_formulas, pdf.tagged_tables, pdf.tagged_math_sources, pdf.tagged_truncated), (Some(1), Some(1), Some(1), None));
    let mut seen: Vec<u16> = pdf.page_encodings.unwrap().iter().map(|(mask, _)| *mask & (TAGGED_FORMULA | TAGGED_TABLE | SOURCE)).collect();
    seen.sort();
    assert_eq!(seen, vec![TAGGED_TABLE, TAGGED_FORMULA | SOURCE], "the table's cell names its page");
}

#[test]
fn hostile_structure_trees_stay_bounded() {
    // A cycle: an element whose kid is itself and its parent.
    let started = Instant::now();
    let cycle = tagged(|document, _| {
        let a = document.new_object_id();
        let b = document.add_object(dictionary! { "S" => "Formula", "K" => vec![Object::Reference(a), Object::Reference(a)] });
        document.objects.insert(a, Object::Dictionary(dictionary! { "S" => "Table", "K" => vec![Object::Reference(b), Object::Reference(a)] }));
        Object::Reference(a)
    });
    let pdf = cycle.pdf.unwrap();
    assert_eq!((pdf.tagged_formulas, pdf.tagged_tables), (Some(1), Some(1)), "each object is visited once");

    // Nesting deeper than the walk follows.
    let deep = tagged(|document, _| {
        let mut kid = Object::Integer(0);
        for _ in 0..200 { kid = Object::Reference(document.add_object(dictionary! { "S" => "Formula", "K" => kid })); }
        kid
    });
    let pdf = deep.pdf.unwrap();
    assert_eq!(pdf.tagged_truncated, Some(true));
    assert!(pdf.tagged_formulas.unwrap() <= 66);

    // A huge kids array of elements (and marked-content ids) past the element cap.
    let huge = tagged(|document, _| {
        let table = document.add_object(dictionary! { "S" => "Table" });
        let mut kids: Vec<Object> = (0..60_000).map(|_| Object::Reference(table)).collect();
        kids.extend((0..60_000).map(|_| Object::Dictionary(dictionary! { "S" => "Formula" })));
        kids.extend((0..100_000).map(Object::Integer));
        Object::Array(kids)
    });
    let pdf = huge.pdf.unwrap();
    assert_eq!(pdf.tagged_truncated, Some(true));
    assert!(pdf.tagged_formulas.unwrap() <= 50_000 && pdf.tagged_tables == Some(1), "{:?} {:?}", pdf.tagged_formulas, pdf.tagged_tables);
    assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
}

#[test]
fn untagged_documents_report_zero_and_masks_partition_the_sampled_pages() {
    let mut pdf = Builder::new();
    for _ in 0..30 { pdf.page(prose(3, 700.0)); }
    let result = profile(&pdf.bytes());
    let pdf = result.pdf.unwrap();
    assert_eq!((pdf.tagged_formulas, pdf.tagged_tables, pdf.tagged_math_sources, pdf.tagged_truncated), (Some(0), Some(0), Some(0), None));
    let encodings = pdf.page_encodings.unwrap();
    assert_eq!(encodings.iter().map(|(_, pages)| pages).sum::<u32>(), pdf.sampled_pages);
    assert!(encodings.iter().all(|(mask, _)| mask & PARTIAL == 0));
}

#[test]
fn the_page_stat_stream_has_one_line_per_sampled_page_beside_the_same_profile() {
    let mut pdf = Builder::new();
    pdf.font("M1", math_font());
    for i in 0..30 { pdf.page(format!("{}BT /M1 10 Tf 72 500 Td ({}) Tj ET\n", prose(3, 700.0), "x".repeat(i + 1))); }
    let bytes = pdf.bytes();
    let meta = format!(r#"{{"name":"test.pdf","size":{}}}"#, bytes.len());
    let envelope: serde_json::Value = serde_json::from_str(&docslurp_estimate::abi::probe_pages_json(meta.as_bytes(), &bytes, None)).unwrap();
    assert_eq!(envelope["ok"], true);
    let plain: serde_json::Value = serde_json::from_str(&docslurp_estimate::abi::probe_json(meta.as_bytes(), &bytes, None)).unwrap();
    assert_eq!(envelope["value"]["profile"], plain["value"], "the same profile as ds_probe");
    let lines: Vec<serde_json::Value> = envelope["value"]["pageStats"].as_str().unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(lines.len(), 24);
    assert_eq!(lines[0]["page"], 1);
    assert_eq!(lines[23]["page"], 30);
    for line in &lines {
        let keys: Vec<&String> = line.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["counts", "mask", "page"]);
        assert_eq!(line["mask"].as_u64().unwrap() & u64::from(MATH_FONT), u64::from(MATH_FONT));
        // words (bucket of ~40 words: 6) in the lowest nibble, math glyphs in the third.
        let counts = line["counts"].as_u64().unwrap();
        assert_eq!(counts & 0xf, 6);
        assert!((counts >> 8) & 0xf >= 1);
    }
    // Other files: the same profile and no lines.
    let text = b"plain text";
    let meta = r#"{"name":"notes.txt","size":10}"#;
    let envelope: serde_json::Value = serde_json::from_str(&docslurp_estimate::abi::probe_pages_json(meta.as_bytes(), text, None)).unwrap();
    assert_eq!(envelope["value"]["pageStats"], "");
}
