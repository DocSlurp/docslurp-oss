use docslurp_estimate::probe::{DetailOptions, RangeRequest, RangeSession};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};

fn run(bytes: &[u8]) -> Vec<Value> {
    let mut session = RangeSession::new(bytes.len() as u64, DetailOptions::default(), 1).unwrap();
    let mut records = Vec::new();
    loop {
        let step = session.step().unwrap();
        match step["kind"].as_str().unwrap() {
            "read" => {
                let offset = step["offset"].as_u64().unwrap() as usize;
                let len = step["length"].as_u64().unwrap() as usize;
                session
                    .supply(
                        serde_json::from_value(
                            json!({"requestId":step["requestId"],"offset":offset,"length":len}),
                        )
                        .unwrap(),
                        &bytes[offset..offset + len],
                    )
                    .unwrap();
            }
            "output" => records.extend(
                step["jsonl"]
                    .as_str()
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).unwrap()),
            ),
            "done" => break,
            _ => panic!("unknown step"),
        }
    }
    records
}

#[test]
fn ranged_small_fixture_matches_existing_feature_evidence() {
    let bytes =
        include_bytes!("../../../worker/testdata/pdf-fixtures/routing-table-clean-financial.pdf");
    let records = run(bytes);
    let page = records.iter().find(|r| r["t"] == "pages").unwrap();
    assert_eq!(page["features"]["text"][0][1], json!([89, 494, 12, 988]));
    assert_eq!(page["features"]["tables"][0][1], json!([1, 9, 1810, 510]));
    assert_eq!(records.last().unwrap()["deepComplete"], true);
}

#[test]
fn rich_candidates_separate_unruled_cells_caption_and_plot_ticks() {
    let all = run(include_bytes!("../examples/layout-candidates.pdf"));
    let feature = |page: usize, name: &str| {
        all.iter()
            .filter(|r| r["t"] == "pages")
            .flat_map(|r| r["features"][name].as_array().unwrap())
            .find(|row| row[0] == page)
            .unwrap()[1]
            .clone()
    };
    assert_eq!(feature(1, "unruledTables")[0], 1);
    assert_eq!(feature(2, "captions")[0], 1);
    assert_eq!(feature(3, "tableCandidates")[0], 0);
    assert_eq!(feature(3, "captions")[0], 0);
    assert_eq!(feature(3, "charts")[0], 1);
    assert_eq!(feature(3, "charts")[2], 1);
    for page in 1..=3 {
        let value = feature(page, "composition");
        let composition = value.as_array().unwrap();
        assert_eq!(
            composition[0].as_u64().unwrap(),
            composition[1..5]
                .iter()
                .map(|value| value.as_u64().unwrap())
                .sum::<u64>()
        );
    }
}

#[test]
fn repeated_contents_execute_twice_but_stored_bytes_are_deduplicated() {
    let bytes =
        include_bytes!("../../../worker/testdata/pdf-fixtures/routing-table-clean-financial.pdf");
    let original = run(bytes);
    let mut doc = lopdf::Document::load_mem(bytes).unwrap();
    let page = doc.get_pages()[&1];
    let content = doc
        .get_dictionary(page)
        .unwrap()
        .get(b"Contents")
        .unwrap()
        .clone();
    doc.get_object_mut(page)
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set(
            "Contents",
            lopdf::Object::Array(vec![content.clone(), content]),
        );
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    let repeated = run(&bytes);
    let a = original.iter().find(|r| r["t"] == "pages").unwrap();
    let b = repeated.iter().find(|r| r["t"] == "pages").unwrap();
    assert_eq!(
        b["features"]["text"][0][1][1].as_u64().unwrap(),
        2 * a["features"]["text"][0][1][1].as_u64().unwrap()
    );
    assert_eq!(a["inventory"][0][3], b["inventory"][0][3]);
}

fn hybrid_pdf() -> Vec<u8> {
    hybrid_pdf_with_supplemental_prev(false)
}
fn hybrid_pdf_with_supplemental_prev(with_prev: bool) -> Vec<u8> {
    let mut bytes = b"%PDF-1.7\n".to_vec();
    let mut offsets = [0usize; 7];
    fn object(bytes: &mut Vec<u8>, offsets: &mut [usize], id: usize, body: &[u8]) {
        offsets[id] = bytes.len();
        write!(bytes, "{id} 0 obj\n").unwrap();
        bytes.extend(body);
        bytes.extend(b"\nendobj\n");
    }
    object(
        &mut bytes,
        &mut offsets,
        1,
        b"<< /Type /Catalog /Pages 2 0 R >>",
    );
    object(
        &mut bytes,
        &mut offsets,
        2,
        b"<< /Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    );
    let text = b"BT (hybrid text) Tj ET";
    let mut content = format!("<< /Length {} >> stream\n", text.len()).into_bytes();
    content.extend(text);
    content.extend(b"\nendstream");
    object(&mut bytes, &mut offsets, 3, &content);
    let member = b"4 0 << /Type /Page /Parent 2 0 R /Contents 3 0 R >>";
    let mut stream = format!(
        "<< /Type /ObjStm /N 1 /First 4 /Length {} >> stream\n",
        member.len()
    )
    .into_bytes();
    stream.extend(member);
    stream.extend(b"\nendstream");
    object(&mut bytes, &mut offsets, 5, &stream);
    let row = [2u8, 0, 0, 0, 5, 0, 0];
    let supplemental_prev = if with_prev { "/Prev 1" } else { "" };
    let mut hybrid = format!(
        "<< /Type /XRef /Size 7 {supplemental_prev} /Index [4 1] /W [1 4 2] /Length {} >> stream\n",
        row.len()
    )
    .into_bytes();
    hybrid.extend(row);
    hybrid.extend(b"\nendstream");
    object(&mut bytes, &mut offsets, 6, &hybrid);
    let xref = bytes.len();
    bytes.extend(b"xref\n0 7\n0000000000 65535 f \n");
    for id in 1..7 {
        if id == 4 {
            bytes.extend(b"0000000000 00000 f \n");
        } else {
            write!(bytes, "{:010} 00000 n \n", offsets[id]).unwrap();
        }
    }
    write!(
        bytes,
        "trailer << /Size 7 /Root 1 0 R /XRefStm {} >>\nstartxref\n{xref}\n%%EOF\n",
        offsets[6]
    )
    .unwrap();
    bytes
}

#[test]
fn hybrid_xref_stream_overrides_same_revision_free_placeholders() {
    let records = run(&hybrid_pdf());
    assert_eq!(records.last().unwrap()["deepMeasured"], 1);
    assert_eq!(records.last().unwrap()["deepComplete"], true);
}

#[test]
fn hybrid_ignores_supplemental_prev_but_follows_owning_revision_chain() {
    let mut bytes = hybrid_pdf_with_supplemental_prev(true);
    let tail = String::from_utf8_lossy(&bytes);
    let previous: usize = tail.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
    let updated = bytes.len();
    bytes.extend(b"2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 700 792] >>\nendobj\n");
    let xref = bytes.len();
    write!(bytes, "xref\n2 1\n{updated:010} 00000 n \ntrailer << /Size 7 /Root 1 0 R /Prev {previous} >>\nstartxref\n{xref}\n%%EOF\n").unwrap();
    let records = run(&bytes);
    let page = records.iter().find(|r| r["t"] == "pages").unwrap();
    assert_eq!(page["inventory"][0][1], 7000);
    assert_eq!(records.last().unwrap()["deepMeasured"], 1);
    let mut cycle = hybrid_pdf();
    let cyclic = cycle.len();
    write!(cycle, "xref\n0 1\n0000000000 65535 f \ntrailer << /Size 7 /Root 1 0 R /Prev {cyclic} >>\nstartxref\n{cyclic}\n%%EOF\n").unwrap();
    assert!(rejects(&cycle));
}

fn rejects(bytes: &[u8]) -> bool {
    let mut session = RangeSession::new(bytes.len() as u64, DetailOptions::default(), 1).unwrap();
    for _ in 0..1000 {
        let step = match session.step() {
            Ok(step) => step,
            Err(_) => return true,
        };
        match step["kind"].as_str().unwrap() {
            "read" => {
                let at = step["offset"].as_u64().unwrap() as usize;
                let len = step["length"].as_u64().unwrap() as usize;
                session
                    .supply(
                        serde_json::from_value(
                            json!({"requestId":step["requestId"],"offset":at,"length":len}),
                        )
                        .unwrap(),
                        &bytes[at..at + len],
                    )
                    .unwrap();
            }
            "output" => {
                if step["jsonl"]
                    .as_str()
                    .unwrap()
                    .lines()
                    .any(|line| serde_json::from_str::<Value>(line).unwrap()["t"] == "end")
                {
                    return false;
                }
            }
            _ => return false,
        }
    }
    false
}

#[test]
fn truncated_xref_rows_and_prefix_only_stream_terminators_refuse() {
    let bytes = hybrid_pdf();
    let text = String::from_utf8(bytes.clone()).unwrap();
    let truncated = text.replace("/Index [4 1]", "/Index [4 2]").into_bytes();
    assert!(rejects(&truncated));
    let mut invalid = bytes;
    let at = invalid
        .windows(9)
        .position(|part| part == b"endstream")
        .unwrap();
    invalid[at + 9] = b'X';
    assert!(rejects(&invalid));
}

#[test]
fn abi_epoch_rejects_supplies_from_a_closed_session() {
    use docslurp_estimate::abi::{
        range_close_json, range_open_json, range_step_json, range_supply_json,
    };
    assert!(range_open_json(b"{}", br#"{"size":1024}"#).contains("\"ok\":true"));
    let old: Value = serde_json::from_str(&range_step_json()).unwrap();
    range_close_json();
    range_open_json(b"{}", br#"{"size":1024}"#);
    let new: Value = serde_json::from_str(&range_step_json()).unwrap();
    let request = |step: &Value| {
        serde_json::to_vec(&json!({"requestId":step["value"]["requestId"],"offset":step["value"]["offset"],"length":step["value"]["length"]})).unwrap()
    };
    assert!(range_supply_json(&request(&old), &[0; 16]).contains("\"ok\":false"));
    assert!(range_supply_json(&request(&new), &[0; 16]).contains("\"ok\":true"));
    range_close_json();
}

#[test]
fn bounded_tail_search_accepts_long_trailing_comments() {
    let mut bytes =
        include_bytes!("../../../worker/testdata/pdf-fixtures/routing-table-clean-financial.pdf")
            .to_vec();
    bytes.extend(b"\n% ");
    bytes.extend(vec![b'x'; 128 * 1024]);
    bytes.extend(b"\n");
    assert_eq!(run(&bytes).last().unwrap()["deepComplete"], true);
}

#[test]
fn inventory_skips_distributed_image_payloads_instead_of_prefetching_them() {
    use lopdf::{dictionary,Document,Object,Stream};
    let mut doc=Document::with_version("1.7");let tree=doc.new_object_id();let content=doc.add_object(Stream::new(dictionary!{},b"q 612 0 0 792 0 0 cm /Im Do Q".to_vec()));let mut kids=Vec::new();
    for _ in 0..20 {
        let image=doc.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Image","Width"=>256,"Height"=>256,"ColorSpace"=>"DeviceGray","BitsPerComponent"=>8},vec![0;65536]));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>tree,"MediaBox"=>vec![0.into(),0.into(),612.into(),792.into()],"Contents"=>content,"Resources"=>dictionary!{"XObject"=>dictionary!{"Im"=>image}}});kids.push(Object::Reference(page));
    }
    doc.objects.insert(tree,dictionary!{"Type"=>"Pages","Kids"=>kids,"Count"=>20}.into());let root=doc.add_object(dictionary!{"Type"=>"Catalog","Pages"=>tree});doc.trailer.set("Root",root);
    let mut bytes=Vec::new();doc.save_to(&mut bytes).unwrap();let all=run(&bytes);let end=all.last().unwrap();
    assert_eq!(end["deepMeasured"],20);assert!(end["readBytes"].as_u64().unwrap()<200000);
}

#[test]
fn native_handle_adapter_refuses_input_mutation() {
    let path = std::env::temp_dir().join(format!(
        "docslurp-native-mutation-{}-{}.pdf",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _cleanup = Scratch(path.clone());
    std::fs::write(
        &path,
        include_bytes!("../../../worker/testdata/pdf-fixtures/routing-table-clean-financial.pdf"),
    )
    .unwrap();
    let file = std::fs::File::open(&path).unwrap();
    let mut stream =
        docslurp_estimate::local::FileProfileJsonl::new(file, DetailOptions::default()).unwrap();
    assert!(stream.next_chunk().unwrap().unwrap().contains("header"));
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(0)
        .unwrap();
    assert!(stream.next_chunk().unwrap_err().message.contains("changed"));
}

#[test]
fn retained_page_payloads_do_not_thrash_the_raw_range_cache() {
    use lopdf::{dictionary, Document, Object, Stream};
    let mut doc = Document::with_version("1.7");
    let tree = doc.new_object_id();
    let mut resources = lopdf::Dictionary::new();
    for name in ["A", "B"] {
        let mut data = vec![b' '; 8 * 1024 * 1024 - 1024];
        data.extend(b"q Q");
        let id=doc.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),100.into(),100.into()]},data));
        resources.set(name, Object::Reference(id));
    }
    let content = doc.add_object(Stream::new(
        dictionary! {},
        b"BT (cache boundary) Tj ET".to_vec(),
    ));
    let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>tree,"MediaBox"=>vec![0.into(),0.into(),612.into(),792.into()],"Contents"=>content,"Resources"=>dictionary!{"XObject"=>resources}});
    doc.objects.insert(
        tree,
        dictionary! {"Type"=>"Pages","Kids"=>vec![Object::Reference(page)],"Count"=>1}.into(),
    );
    let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>tree});
    doc.trailer.set("Root", root);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    let records = run(&bytes);
    let end = records.last().unwrap();
    assert_eq!(end["deepComplete"], true);
    assert!(end["readBytes"].as_u64().unwrap() < 32 * 1024 * 1024);
}

#[test]
fn repeated_resource_references_are_bounded_and_not_materialized_for_inventory() {
    use lopdf::{dictionary, Document, Object, Stream};
    let mut doc = Document::with_version("1.7");
    let tree = doc.new_object_id();
    let font =
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica"});
    let resources = doc
        .add_object(dictionary! {"Repeated"=>Object::Array(vec![Object::Reference(font);30000])});
    let content = doc.add_object(Stream::new(dictionary! {}, b"BT (bounded) Tj ET".to_vec()));
    let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>tree,"Contents"=>content,"MediaBox"=>vec![0.into(),0.into(),612.into(),792.into()],"Resources"=>resources});
    doc.objects.insert(
        tree,
        dictionary! {"Type"=>"Pages","Kids"=>vec![Object::Reference(page)],"Count"=>1}.into(),
    );
    let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>tree});
    doc.trailer.set("Root", root);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    let all = run(&bytes);
    assert_eq!(all.last().unwrap()["deepComplete"], false);
    assert_eq!(all.last().unwrap()["inventoryPages"], 1);
    let mut session = RangeSession::new(
        bytes.len() as u64,
        DetailOptions {
            max_deep_pages: 0,
            ..DetailOptions::default()
        },
        1,
    )
    .unwrap();
    let end = loop {
        let step = session.step().unwrap();
        match step["kind"].as_str().unwrap() {
            "read" => {
                let at = step["offset"].as_u64().unwrap() as usize;
                let len = step["length"].as_u64().unwrap() as usize;
                session
                    .supply(
                        serde_json::from_value(
                            json!({"requestId":step["requestId"],"offset":at,"length":len}),
                        )
                        .unwrap(),
                        &bytes[at..at + len],
                    )
                    .unwrap();
            }
            "output" => {
                let end = step["jsonl"]
                    .as_str()
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).unwrap())
                    .find(|row| row["t"] == "end");
                if let Some(end) = end {
                    break end;
                }
            }
            _ => panic!("terminal missing"),
        }
    };
    assert_eq!(end["deepSelected"], 0);
    assert!(end["readBytes"].as_u64().unwrap() < bytes.len() as u64);
}

#[test]
fn supply_rejects_stale_short_and_out_of_bounds_responses() {
    let mut session = RangeSession::new(1024, DetailOptions::default(), 1000).unwrap();
    let step = session.step().unwrap();
    let request: RangeRequest = serde_json::from_value(
        json!({"requestId":step["requestId"],"offset":step["offset"],"length":step["length"]}),
    )
    .unwrap();
    let mut wrong = request.clone();
    wrong.request_id += 1;
    assert!(session.supply(wrong, &vec![0; request.length]).is_err());
    assert!(session.supply(request.clone(), &[0]).is_err());
    assert!(session.step().is_err());
    session
        .supply(request.clone(), &vec![0; request.length])
        .unwrap();
    assert!(session.supply(request, &[0; 16]).is_err());
    assert!(session.step().is_err());
}

#[test]
fn malformed_and_encrypted_sources_do_not_emit_complete() {
    let mut session = RangeSession::new(128, DetailOptions::default(), 1).unwrap();
    let read = session.step().unwrap();
    session.supply(serde_json::from_value(json!({"requestId":read["requestId"],"offset":read["offset"],"length":read["length"]})).unwrap(),&[0;16]).unwrap();
    assert!(session.step().is_err());
}

struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A real >1GiB PDF: 20,000 pages share a 32,768² 8-bit gray image. Its
/// zero-valued pixel payload is a sparse file hole, not a fake byte source.
#[test]
fn inventories_twenty_thousand_pages_without_loading_a_one_gib_image() {
    let path = std::env::temp_dir().join(format!(
        "docslurp-range-{}-{}.pdf",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _cleanup = Scratch(path.clone());
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.write_all(b"%PDF-1.7\n").unwrap();
    let pages = 20_000;
    let count = pages + 4;
    let mut offsets = vec![0u64; count + 1];
    offsets[1] = file.stream_position().unwrap();
    write!(file, "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n").unwrap();
    offsets[2] = file.stream_position().unwrap();
    write!(file, "2 0 obj << /Type /Pages /Count {pages} /Kids [").unwrap();
    for id in 5..=count {
        write!(file, "{id} 0 R ").unwrap();
    }
    write!(
        file,
        "] /MediaBox [0 0 612 792] /Resources << /XObject << /Im 4 0 R >> >> >> endobj\n"
    )
    .unwrap();
    offsets[3] = file.stream_position().unwrap();
    let content = b"q 612 0 0 792 0 0 cm /Im Do Q BT (hello world) Tj ET";
    write!(file, "3 0 obj << /Length {} >> stream\n", content.len()).unwrap();
    file.write_all(content).unwrap();
    file.write_all(b"\nendstream endobj\n").unwrap();
    offsets[4] = file.stream_position().unwrap();
    let image_bytes = 1024u64 * 1024 * 1024;
    write!(file,"4 0 obj << /Type /XObject /Subtype /Image /Width 32768 /Height 32768 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length {image_bytes} >> stream\n").unwrap();
    let image_start = file.stream_position().unwrap();
    file.seek(SeekFrom::Start(image_start + image_bytes))
        .unwrap();
    file.write_all(b"\nendstream endobj\n").unwrap();
    for id in 5..=count {
        offsets[id] = file.stream_position().unwrap();
        write!(
            file,
            "{id} 0 obj << /Type /Page /Parent 2 0 R /Contents 3 0 R >> endobj\n"
        )
        .unwrap();
    }
    let xref = file.stream_position().unwrap();
    write!(file, "xref\n0 {}\n0000000000 65535 f \n", count + 1).unwrap();
    for offset in &offsets[1..] {
        write!(file, "{offset:010} 00000 n \n").unwrap();
    }
    write!(
        file,
        "trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        count + 1
    )
    .unwrap();
    file.flush().unwrap();
    let size = file.metadata().unwrap().len();
    assert!(size > image_bytes);
    let mut session = RangeSession::new(size, DetailOptions::default(), 1).unwrap();
    let started = std::time::Instant::now();
    let mut inventoried = 0usize;
    let mut read_bytes = 0usize;
    let mut largest = 0;
    let mut calls = 0;
    let end = loop {
        let step = session.step().unwrap();
        match step["kind"].as_str().unwrap() {
            "read" => {
                let offset = step["offset"].as_u64().unwrap();
                let len = step["length"].as_u64().unwrap() as usize;
                assert!(len <= 1024 * 1024);
                largest = largest.max(len);
                calls += 1;
                read_bytes += len;
                // Small header windows may include the first image bytes; no interior
                // image pixel range is ever requested.
                assert!(offset < image_start + 1024 * 1024 || offset >= image_start + image_bytes);
                let mut bytes = vec![0; len];
                file.seek(SeekFrom::Start(offset)).unwrap();
                file.read_exact(&mut bytes).unwrap();
                session
                    .supply(
                        serde_json::from_value(
                            json!({"requestId":step["requestId"],"offset":offset,"length":len}),
                        )
                        .unwrap(),
                        &bytes,
                    )
                    .unwrap();
            }
            "output" => {
                let mut terminal = None;
                for line in step["jsonl"].as_str().unwrap().lines() {
                    let record: Value = serde_json::from_str(line).unwrap();
                    if record["t"] == "pages" {
                        inventoried += record["inventory"].as_array().unwrap().len();
                    }
                    if record["t"] == "end" {
                        terminal = Some(record);
                    }
                }
                if let Some(end) = terminal {
                    break end;
                }
            }
            _ => panic!("missing terminal"),
        }
    };
    assert_eq!(inventoried, pages);
    assert_eq!(end["deepMeasured"], 1000);
    assert!(read_bytes < 32 * 1024 * 1024);
    println!(
        "{}",
        json!({"inputBytes":size,"inventoryPages":inventoried,"readBytes":read_bytes,"readCalls":calls,"largestReadBytes":largest,"elapsedMs":started.elapsed().as_millis(),"end":end})
    );
}
