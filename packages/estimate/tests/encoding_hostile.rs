//! Hostile inputs for the math and table encoding facts (council review of the encoding facts): fonts re-selected
//! thousands of times, Flate streams of empty blocks, huge shared ActualText and Alt strings, structure trees sharing one
//! associated-file array, dangling structure references. Each profiles in well under a second and is reported as partial
//! or truncated where a fact could not be decided.

use std::io::Write;
use std::time::{Duration, Instant};

use docslurp_estimate::probe::{probe, FileProfile, ProbeInput};
use docslurp_estimate::Rules;
use lopdf::{dictionary, Dictionary, Document, Object, Stream};

const SOURCE: u16 = 1 << 2;
const ACTUAL_TEXT: u16 = 1 << 3;
const PARTIAL: u16 = 1 << 15;
/// The limit each hostile file must profile within: a second in release builds; unoptimized builds (where loading
/// the test document alone takes most of a second) get ten.
const LIMIT: Duration = Duration::from_secs(if cfg!(debug_assertions) { 10 } else { 1 });

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

/// A zlib stream of `blocks` empty stored blocks: megabytes that decode to nothing.
fn empty_blocks(blocks: usize) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    for _ in 0..blocks { out.extend_from_slice(&[0x00, 0x00, 0x00, 0xff, 0xff]); }
    out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff, 0, 0, 0, 1]);
    out
}

fn helvetica() -> Dictionary {
    dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" }
}

/// A document of `pages` pages sharing `content` and the `fonts` and `properties` resources.
fn build(document: &mut Document, fonts: Dictionary, properties: Dictionary, content: &[u8], pages: usize, catalog_extra: Dictionary) -> Vec<u8> {
    let pages_id = document.new_object_id();
    let resources = document.add_object(dictionary! { "Font" => fonts, "Properties" => properties });
    let content = document.add_object(Stream::new(Dictionary::new(), content.to_vec()));
    let kids: Vec<Object> = (0..pages).map(|_| Object::Reference(document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Contents" => content, "Resources" => resources,
    }))).collect();
    let count = kids.len() as i64;
    document.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
    let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages_id };
    for (key, value) in catalog_extra.iter() { catalog.set(key.clone(), value.clone()); }
    let catalog = document.add_object(catalog);
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

fn timed(label: &str, bytes: &[u8]) -> FileProfile {
    let started = Instant::now();
    let result = probe(Rules::bundled(), &ProbeInput::whole("hostile.pdf", None, bytes));
    let elapsed = started.elapsed();
    eprintln!("{label}: {elapsed:?}");
    assert!(elapsed < LIMIT, "{label}: {elapsed:?}");
    result
}

fn mask(result: &FileProfile) -> u16 {
    result.pdf.as_ref().unwrap().page_encodings.as_ref().unwrap().iter().fold(0, |all, (mask, _)| all | mask)
}

/// `/name 1 Tf` repeated `count` times, then one string shown.
fn selections(count: usize, name: &str) -> Vec<u8> {
    let mut content = String::from("BT 72 700 Td ");
    for _ in 0..count { content.push_str(&format!("/{name} 1 Tf ")); }
    content.push_str("(x) Tj ET");
    content.into_bytes()
}

fn type3(procs: Dictionary) -> Dictionary {
    dictionary! { "Type" => "Font", "Subtype" => "Type3", "CharProcs" => procs, "FontBBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
        "FontMatrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()], "Encoding" => dictionary! {}, "FirstChar" => 0, "LastChar" => 0, "Widths" => vec![1.into()] }
}

#[test]
fn a_direct_type3_font_selected_thousands_of_times_is_classified_once() {
    let mut document = Document::with_version("1.7");
    let big = zlib(&vec![b' '; 1 << 20]);
    let mut procs = Dictionary::new();
    for i in 0..8 { procs.set(format!("g{i}"), document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, big.clone()))); }
    let bytes = build(&mut document, dictionary! { "T3" => type3(procs) }, Dictionary::new(), &selections(5_000, "T3"), 2, Dictionary::new());
    timed("type3 font selected 10k times", &bytes);
}

#[test]
fn b_empty_block_glyph_procedures_and_font_programs_read_a_bounded_prefix() {
    let mut document = Document::with_version("1.7");
    let bomb = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, empty_blocks(400_000)));
    let mut procs = Dictionary::new();
    for i in 0..8 { procs.set(format!("g{i}"), bomb); }
    let fonts = dictionary! {
        "T3" => type3(procs),
        "F2" => dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Plain", "FontDescriptor" => dictionary! { "FontFile2" => bomb, "FontFile3" => bomb } },
    };
    let mut content = selections(200, "T3");
    content.extend_from_slice(&selections(200, "F2"));
    timed("empty-block streams", &build(&mut document, fonts, Dictionary::new(), &content, 1, Dictionary::new()));
}

#[test]
fn c_a_font_whose_class_cannot_be_read_makes_the_page_partial() {
    // A Type 3 font whose glyph procedure uses a filter the profiler does not decode.
    let mut document = Document::with_version("1.7");
    let proc_id = document.add_object(Stream::new(dictionary! { "Filter" => "ASCIIHexDecode" }, b"42 49>".to_vec()));
    let bytes = build(&mut document, dictionary! { "T3" => type3(dictionary! { "a" => proc_id }) }, Dictionary::new(), &selections(1, "T3"), 1, Dictionary::new());
    assert_eq!(mask(&timed("hex glyph procedure", &bytes)) & PARTIAL, PARTIAL);

    // More distinct fonts on a page than the profiler classifies.
    let mut document = Document::with_version("1.7");
    let mut fonts = Dictionary::new();
    let mut content = String::new();
    // Fonts that need their own program read to be classified; past the cache only names are read.
    for i in 0..4_200 {
        let program = document.add_object(Stream::new(Dictionary::new(), b"\x00\x01\x00\x00\x00\x00".to_vec()));
        fonts.set(format!("F{i}"), dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Plain", "FontDescriptor" => dictionary! { "FontFile2" => program } });
        content.push_str(&format!("BT /F{i} 1 Tf 72 700 Td (x) Tj ET "));
    }
    let bytes = build(&mut document, fonts, Dictionary::new(), content.as_bytes(), 1, Dictionary::new());
    assert_eq!(mask(&timed("4,200 fonts", &bytes)) & PARTIAL, PARTIAL);
}

#[test]
fn d_huge_shared_actual_text_is_read_by_a_bounded_prefix_and_a_capped_count() {
    // 20,000 marked spans sharing a 1 MB ActualText without TeX: 4 KB of each is checked until 1 MB of prefixes, then
    // the page is partial.
    let mut document = Document::with_version("1.7");
    let text = document.add_object(Object::String(vec![b'a'; 1 << 20], lopdf::StringFormat::Literal));
    let properties = dictionary! { "P0" => dictionary! { "ActualText" => text } };
    let content = "/Span /P0 BDC EMC ".repeat(20_000);
    let bytes = build(&mut document, dictionary! { "F1" => helvetica() }, properties, content.as_bytes(), 1, Dictionary::new());
    let found = mask(&timed("20k ActualText spans", &bytes));
    assert_eq!(found & (ACTUAL_TEXT | SOURCE | PARTIAL), ACTUAL_TEXT | PARTIAL);
}

#[test]
fn e_formulas_sharing_associated_files_read_them_once() {
    // 20,000 formulas sharing one /AF array of 16 references to a 1 MB empty-block stream, and to a 4 KB real one.
    for stream in [empty_blocks(200_000), zlib(&[b'a'; 4096])] {
        let mut document = Document::with_version("1.7");
        let file = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, stream));
        let af = document.add_object(Object::Array((0..16).map(|_| Object::Reference(file)).collect()));
        let kids: Vec<Object> = (0..20_000).map(|_| Object::Dictionary(dictionary! { "S" => "Formula", "AF" => af })).collect();
        let root = document.add_object(dictionary! { "Type" => "StructTreeRoot", "K" => kids });
        let bytes = build(&mut document, dictionary! { "F1" => helvetica() }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (hello) Tj ET", 1, dictionary! { "StructTreeRoot" => root });
        let pdf = timed("shared AF", &bytes).pdf.unwrap();
        assert_eq!((pdf.tagged_formulas, pdf.tagged_math_sources), (Some(20_000), Some(0)));
    }
}

#[test]
fn f_huge_alt_text_spends_the_structure_budget_and_truncates() {
    // 20,000 formulas whose Alt is one shared 1 MB string: 4 KB checked each until the document budget is spent.
    let mut document = Document::with_version("1.7");
    let alt = document.add_object(Object::String(vec![b'a'; 1 << 20], lopdf::StringFormat::Literal));
    let kids: Vec<Object> = (0..20_000).map(|_| Object::Dictionary(dictionary! { "S" => "Formula", "Alt" => alt })).collect();
    let root = document.add_object(dictionary! { "Type" => "StructTreeRoot", "K" => kids });
    let bytes = build(&mut document, dictionary! { "F1" => helvetica() }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (hello) Tj ET", 1, dictionary! { "StructTreeRoot" => root });
    let pdf = timed("shared 1 MB Alt", &bytes).pdf.unwrap();
    assert_eq!((pdf.tagged_formulas, pdf.tagged_math_sources, pdf.tagged_truncated), (Some(20_000), Some(0), Some(true)));
}

#[test]
fn g_dangling_structure_is_unknown_not_untagged() {
    let mut document = Document::with_version("1.7");
    let bytes = build(&mut document, dictionary! { "F1" => helvetica() }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (hello) Tj ET", 1, dictionary! { "StructTreeRoot" => Object::Reference((9_999, 0)) });
    assert_eq!(timed("dangling root", &bytes).pdf.unwrap().tagged_truncated, Some(true));

    let mut document = Document::with_version("1.7");
    let kids: Vec<Object> = (0..1_000).map(|i| Object::Reference((50_000 + i, 0))).collect();
    let root = document.add_object(dictionary! { "Type" => "StructTreeRoot", "K" => kids });
    let bytes = build(&mut document, dictionary! { "F1" => helvetica() }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (hello) Tj ET", 1, dictionary! { "StructTreeRoot" => root });
    assert_eq!(timed("dangling kids", &bytes).pdf.unwrap().tagged_truncated, Some(true));
}

#[test]
fn h_type3_fonts_sharing_a_huge_xobject_dictionary_are_not_copied() {
    // 4,000 Type 3 fonts sharing one resource dictionary of 20,000 XObject entries.
    let mut document = Document::with_version("1.7");
    let form = document.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()] }, b"0 0 1 1 re f".to_vec()));
    let mut xobjects = Dictionary::new();
    for i in 0..20_000 { xobjects.set(format!("X{i}"), form); }
    let shared = document.add_object(dictionary! { "XObject" => xobjects });
    let proc_id = document.add_object(Stream::new(Dictionary::new(), b"1 0 0 0 1 1 d1 /X0 Do".to_vec()));
    let mut fonts = Dictionary::new();
    let mut content = String::new();
    for i in 0..4_000 {
        let mut font = type3(dictionary! { "a" => proc_id });
        font.set("Resources", shared);
        fonts.set(format!("T{i}"), font);
        content.push_str(&format!("BT /T{i} 1 Tf 72 700 Td (x) Tj ET "));
    }
    timed("4,000 Type 3 fonts sharing 20,000 XObjects", &build(&mut document, fonts, Dictionary::new(), content.as_bytes(), 1, Dictionary::new()));
}

#[test]
fn i_embedded_file_cycles_and_chains_are_not_followed() {
    // A file specification whose embedded file is itself, two that point at each other on a formula, and a chain of
    // 30,000: each answered without following /EF /F past one step.
    let mut document = Document::with_version("2.0");
    let spec = document.new_object_id();
    document.objects.insert(spec, Object::Dictionary(dictionary! { "Type" => "Filespec", "F" => Object::string_literal("a.bin"), "EF" => dictionary! { "F" => spec } }));
    let (x, y) = (document.new_object_id(), document.new_object_id());
    document.objects.insert(x, Object::Dictionary(dictionary! { "Type" => "Filespec", "EF" => dictionary! { "F" => y } }));
    document.objects.insert(y, Object::Dictionary(dictionary! { "Type" => "Filespec", "EF" => dictionary! { "F" => x } }));
    let mut next = document.add_object(dictionary! { "Type" => "Filespec" });
    for _ in 0..30_000 { next = document.add_object(dictionary! { "Type" => "Filespec", "EF" => dictionary! { "F" => next } }); }
    let root = document.add_object(dictionary! { "Type" => "StructTreeRoot", "K" => vec![
        Object::Dictionary(dictionary! { "S" => "Formula", "AF" => vec![Object::Reference(x)] }),
        Object::Dictionary(dictionary! { "S" => "Formula", "AF" => vec![Object::Reference(next)] }),
    ] });
    let bytes = build(&mut document, dictionary! { "F1" => helvetica() }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (hello) Tj ET", 1,
        dictionary! { "AF" => vec![Object::Reference(spec)], "StructTreeRoot" => root });
    let pdf = timed("embedded-file cycles and chains", &bytes).pdf.unwrap();
    assert_eq!((pdf.tagged_formulas, pdf.tagged_math_sources), (Some(2), Some(0)));
}

#[test]
fn j_a_math_font_in_a_form_or_a_saved_state_does_not_make_later_text_math() {
    let cmmi = || dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "CMMI10" };
    let body: String = (0..20).map(|i| format!("BT /F1 10 Tf 72 {} Td (The team expanded to London this quarter.) Tj ET ", 700 - 14 * i)).collect();
    // A form selecting a math font, then body text that selects no font of its own.
    let mut document = Document::with_version("1.7");
    let form = document.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        "Resources" => dictionary! { "Font" => dictionary! { "M" => cmmi() } } }, b"BT /M 10 Tf 0 0 Td ET".to_vec()));
    let pages_id = document.new_object_id();
    let content = document.add_object(Stream::new(Dictionary::new(), format!("BT /F1 10 Tf ET q /Fm Do Q BT 72 400 Td (after the form) Tj ET {body}").into_bytes()));
    let page = document.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Contents" => content,
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => helvetica() }, "XObject" => dictionary! { "Fm" => form } } });
    document.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    assert_eq!(mask(&timed("form font", &bytes)) & 0b11, 0);

    // A q/Q block selecting a math font, then text that selects none.
    let mut document = Document::with_version("1.7");
    let content = format!("BT /F1 10 Tf ET q BT /M2 10 Tf ET Q BT 72 400 Td (after the block) Tj ET {body}");
    let bytes = build(&mut document, dictionary! { "F1" => helvetica(), "M2" => cmmi() }, Dictionary::new(), content.as_bytes(), 1, Dictionary::new());
    assert_eq!(mask(&timed("q/Q font", &bytes)) & 0b11, 0);
}

#[test]
fn k_font_heads_do_not_spend_the_page_content_budget() {
    // 24 pages, each with 1.3 MB of content (31 MB in all, inside the 32 MB content budget) and its own embedded
    // TrueType font whose program does not compress: every page is still sampled.
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let mut seed = 0x2545_f491_u32;
    let mut kids = Vec::new();
    for _ in 0..24 {
        let noise: Vec<u8> = (0..96 * 1024).map(|_| { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed as u8 }).collect();
        let program = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, zlib(&noise)));
        let font = dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Plain", "FontDescriptor" => dictionary! { "FontFile2" => program } };
        let mut content = vec![b' '; 1_300_000];
        content.extend_from_slice(b"BT /F1 10 Tf 72 700 Td (A page of the quarterly report) Tj ET");
        let content = document.add_object(Stream::new(Dictionary::new(), content));
        kids.push(Object::Reference(document.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content, "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } } })));
    }
    document.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 24 }));
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let result = probe(Rules::bundled(), &ProbeInput::whole("fonts.pdf", None, &bytes));
    let pdf = result.pdf.unwrap();
    assert_eq!((pdf.sampled_pages, pdf.budget_exhausted), (24, false));
    assert!(pdf.tagged_formulas.is_some());
}

#[test]
fn l_cut_or_corrupt_streams_are_unknown_not_absent() {
    // A font program whose MATH table directory sits behind 70 KB of empty Flate blocks: past the compressed cap.
    let mut document = Document::with_version("1.7");
    let program = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, empty_blocks(14_000)));
    let font = dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Plain", "FontDescriptor" => dictionary! { "FontFile2" => program } };
    let bytes = build(&mut document, dictionary! { "F1" => font }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (x) Tj ET", 1, Dictionary::new());
    assert_eq!(mask(&timed("cut font program", &bytes)) & PARTIAL, PARTIAL);
    // A corrupt Flate stream.
    let mut document = Document::with_version("1.7");
    let program = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, b"\x78\x9c\xff\xff\xff\xff not deflate".to_vec()));
    let font = dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Plain", "FontDescriptor" => dictionary! { "FontFile2" => program } };
    let bytes = build(&mut document, dictionary! { "F1" => font }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (x) Tj ET", 1, Dictionary::new());
    assert_eq!(mask(&timed("corrupt font program", &bytes)) & PARTIAL, PARTIAL);
    // A catalog associated file cut the same way leaves the tree truncated.
    let mut document = Document::with_version("2.0");
    let file = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, empty_blocks(14_000)));
    let bytes = build(&mut document, dictionary! { "F1" => helvetica() }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (x) Tj ET", 1, dictionary! { "AF" => vec![Object::Reference(file)] });
    assert_eq!(timed("cut associated file", &bytes).pdf.unwrap().tagged_truncated, Some(true));
}

/// A document of `pages` pages each showing 130 TrueType fonts that share one 64 KiB empty-block program.
fn shared_program_fonts(pages: usize) -> Vec<u8> {
    let mut document = Document::with_version("1.7");
    let program = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, empty_blocks(13_200)));
    let mut fonts = Dictionary::new();
    let mut content = String::from("BT ");
    for i in 0..130 {
        fonts.set(format!("B{i}"), dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => format!("Body{i}").as_str(),
            "FontDescriptor" => dictionary! { "Type" => "FontDescriptor", "FontFile2" => program } });
        content.push_str(&format!("/B{i} 10 Tf 72 700 Td (a) Tj "));
    }
    content.push_str("ET");
    build(&mut document, fonts, Dictionary::new(), content.as_bytes(), pages, Dictionary::new())
}

#[test]
fn m_detail_and_range_sessions_read_no_font_programs() {
    use docslurp_estimate::probe::{DetailOptions, DetailSession, RangeRequest, RangeSession};
    let bytes = shared_program_fonts(300);
    let started = Instant::now();
    let (mut session, _) = DetailSession::open(&bytes, DetailOptions::default()).unwrap();
    while session.next().is_some() {}
    assert!(started.elapsed() < LIMIT * 3, "detail session: {:?}", started.elapsed());

    let started = Instant::now();
    let mut session = RangeSession::new(bytes.len() as u64, DetailOptions::default(), 1).unwrap();
    loop {
        let step = session.step().unwrap();
        match step["kind"].as_str().unwrap() {
            "read" => {
                let (offset, length) = (step["offset"].as_u64().unwrap() as usize, step["length"].as_u64().unwrap() as usize);
                let request: RangeRequest = serde_json::from_value(serde_json::json!({ "requestId": step["requestId"], "offset": offset, "length": length })).unwrap();
                session.supply(request, &bytes[offset..offset + length]).unwrap();
            }
            "done" => break,
            _ => {}
        }
    }
    assert!(started.elapsed() < LIMIT * 3, "range session: {:?}", started.elapsed());
}

#[test]
fn n_a_shared_font_program_is_read_once_and_leaves_the_budget_for_other_pages() {
    // Page 1: 130 fonts sharing an unreadable program (partial). Pages 2-24: a font known only by its MATH table.
    let mut document = Document::with_version("1.7");
    let bomb = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, empty_blocks(13_200)));
    let mut head = vec![0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    head.extend_from_slice(b"MATH\0\0\0\0\0\0\0\0\0\0\0\0");
    let math = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, zlib(&head)));
    let font = |name: &str, program| dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => name, "FontDescriptor" => dictionary! { "FontFile2" => program } };
    let pages_id = document.new_object_id();
    let mut kids = Vec::new();
    for page in 0..24 {
        let (fonts, content) = if page == 0 {
            let mut fonts = Dictionary::new();
            let mut content = String::from("BT ");
            for i in 0..130 { fonts.set(format!("B{i}"), font(&format!("Body{i}"), bomb)); content.push_str(&format!("/B{i} 10 Tf 72 700 Td (a) Tj ")); }
            (fonts, content + "ET")
        } else {
            (dictionary! { "M" => font("Plain", math) }, "BT /M 10 Tf 72 700 Td (x) Tj ET".to_string())
        };
        let content = document.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
        kids.push(Object::Reference(document.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content, "Resources" => dictionary! { "Font" => fonts } })));
    }
    document.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 24 }));
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let result = timed("shared unreadable program", &bytes);
    let encodings = result.pdf.unwrap().page_encodings.unwrap();
    assert!(encodings.contains(&(1, 23)), "{encodings:?}");
}

#[test]
fn o_predictors_external_data_and_q_overflow_are_unknown() {
    let mut head = vec![0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    head.extend_from_slice(b"MATH\0\0\0\0\0\0\0\0\0\0\0\0");
    for extra in [dictionary! { "DecodeParms" => dictionary! { "Predictor" => 12, "Columns" => 4 } }, dictionary! { "F" => Object::string_literal("font.bin") }] {
        let mut document = Document::with_version("1.7");
        let mut dict = dictionary! { "Filter" => "FlateDecode" };
        for (key, value) in extra.iter() { dict.set(key.clone(), value.clone()); }
        let program = document.add_object(Stream::new(dict, zlib(&head)));
        let font = dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Plain", "FontDescriptor" => dictionary! { "FontFile2" => program } };
        let bytes = build(&mut document, dictionary! { "F1" => font }, Dictionary::new(), b"BT /F1 10 Tf 72 700 Td (x) Tj ET", 1, Dictionary::new());
        assert_eq!(mask(&timed("predictor or external data", &bytes)) & (PARTIAL | 1), PARTIAL);
    }
    // 300 saves (past the 256 the walker keeps): the font in force after the restores is unknown.
    let mut document = Document::with_version("1.7");
    let content = format!("{} BT /M 10 Tf 72 700 Td (x) Tj ET {}", "q ".repeat(300), "Q ".repeat(300));
    let cmmi = dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "CMMI10" };
    let bytes = build(&mut document, dictionary! { "M" => cmmi }, Dictionary::new(), content.as_bytes(), 1, Dictionary::new());
    assert_eq!(mask(&timed("q overflow", &bytes)) & PARTIAL, PARTIAL);
}

#[test]
fn p_a_stream_read_as_a_font_head_does_not_answer_for_a_glyph_procedure() {
    // One stream is both a TrueType font program (its head read for 1,020 bytes) and a Type 3 glyph procedure whose
    // image comes after that: the font drawn first must not make the procedure's answer "no image".
    let mut source = b"0 0 0 0 10 10 d1\n".to_vec();
    for _ in 0..25 { source.extend_from_slice(b"% padding comment line to push the image past the font-head window\n"); }
    source.extend_from_slice(b"q 10 0 0 10 0 0 cm BI /W 1 /H 1 /IM true ID \xff EI Q");
    let mut document = Document::with_version("1.7");
    let shared = document.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, zlib(&source)));
    let fonts = dictionary! {
        "P" => dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "ABCDEF+Body", "FontDescriptor" => dictionary! { "FontFile2" => shared } },
        "T" => type3(dictionary! { "a" => shared }),
    };
    let content = "BT /P 10 Tf 72 720 Td (hi) Tj ET BT /T 10 Tf 72 600 Td (aaaa) Tj ET";
    let bytes = build(&mut document, fonts, Dictionary::new(), content.as_bytes(), 1, Dictionary::new());
    assert_eq!(mask(&timed("shared font head and glyph procedure", &bytes)) & (1 << 6), 1 << 6);
}
