use docslurp_estimate::probe::{DetailOptions, DetailSession};
use lopdf::{dictionary, Document, Object, Stream};
use serde_json::Value;

fn pdf(pages: usize) -> Vec<u8> {
    let mut document = Document::with_version("1.5");
    let tree = document.new_object_id();
    let content = document.add_object(Stream::new(
        dictionary! {},
        b"BT (hello world) Tj ET".to_vec(),
    ));
    let kids: Vec<Object> = (0..pages)
        .map(|_| {
            document
                .add_object(dictionary! {
                    "Type" => "Page", "Parent" => tree, "Contents" => content,
                    "MediaBox" => vec![0.into(),0.into(),612.into(),792.into()]
                })
                .into()
        })
        .collect();
    document.objects.insert(
        tree,
        dictionary! {"Type"=>"Pages","Kids"=>kids,"Count"=>pages as i64}.into(),
    );
    let root = document.add_object(dictionary! {"Type"=>"Catalog","Pages"=>tree});
    document.trailer.set("Root", root);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

fn records(bytes: &[u8], options: DetailOptions) -> Vec<Value> {
    let (mut session, header) = DetailSession::open(bytes, options).unwrap();
    let mut output = header;
    while let Some(batch) = session.next() {
        assert!(batch.len() < 65536, "output frame exceeded 64KiB");
        output.push_str(&batch);
    }
    output
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn rewrite_content(pages: usize, content: Vec<u8>, extra: Option<(String, Object)>) -> Vec<u8> {
    let mut doc = Document::load_mem(&pdf(pages)).unwrap();
    let page = doc.get_pages()[&1];
    let id = doc
        .get_dictionary(page)
        .unwrap()
        .get(b"Contents")
        .unwrap()
        .as_reference()
        .unwrap();
    let stream = doc.get_object_mut(id).unwrap().as_stream_mut().unwrap();
    stream.content = content;
    if let Some((key, value)) = extra {
        stream.dict.set(key, value);
    }
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn malformed_content_and_truncated_images_are_partial() {
    let malformed = rewrite_content(1, b"BT (valid) Tj ET (unterminated".to_vec(), None);
    assert_eq!(
        records(&malformed, DetailOptions::default())
            .last()
            .unwrap()["deepComplete"],
        false
    );
    let mut doc = Document::load_mem(&pdf(1)).unwrap();
    let page = doc.get_pages()[&1];
    let image=doc.add_object(Stream::new(dictionary! {"Type"=>"XObject","Subtype"=>"Image","Width"=>1000,"Height"=>1000,"BitsPerComponent"=>8,"ColorSpace"=>"DeviceGray"},vec![0]));
    let id = doc
        .get_dictionary(page)
        .unwrap()
        .get(b"Contents")
        .unwrap()
        .as_reference()
        .unwrap();
    doc.get_object_mut(id)
        .unwrap()
        .as_stream_mut()
        .unwrap()
        .content = b"q 612 0 0 792 0 0 cm /Im Do Q\n".repeat(65);
    doc.get_object_mut(page)
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set(
            "Resources",
            dictionary! {"XObject"=>dictionary! {"Im"=>image}},
        );
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    let all = records(&bytes, DetailOptions::default());
    assert_eq!(all.last().unwrap()["deepPartial"], 1);
    assert_eq!(all.last().unwrap()["totals"]["imageKnownPages"], 0);
}

#[test]
fn failed_decompression_is_charged_and_cannot_repeat_for_every_page() {
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&vec![b' '; 9 * 1024 * 1024], 6);
    let bytes = rewrite_content(
        100,
        compressed,
        Some(("Filter".into(), Object::Name(b"FlateDecode".to_vec()))),
    );
    let all = records(&bytes, DetailOptions::default());
    let end = all.last().unwrap();
    assert!(end["decodedBytes"].as_u64().unwrap() >= 8 * 1024 * 1024);
    assert!(end["deepAttempted"].as_u64().unwrap() < 100);
    assert_eq!(end["deepComplete"], false);
    assert_eq!(end["inventoryPages"], 100);
}

#[test]
fn inventory_dimensions_are_displayed_and_rotation_is_explicit() {
    let mut doc = Document::load_mem(&pdf(1)).unwrap();
    let page = doc.get_pages()[&1];
    doc.get_object_mut(page)
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set("Rotate", 90);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    let all = records(&bytes, DetailOptions::default());
    let row = &all.iter().find(|r| r["t"] == "pages").unwrap()["inventory"][0];
    assert_eq!(row[1], 7920);
    assert_eq!(row[2], 6120);
    assert_eq!(row[5], 90);
}

#[test]
fn inventories_every_page_but_caps_deep_work_at_one_thousand() {
    let all = records(&pdf(1200), DetailOptions::default());
    let inventory: Vec<_> = all
        .iter()
        .filter(|r| r["t"] == "pages")
        .flat_map(|r| r["inventory"].as_array().unwrap())
        .collect();
    assert_eq!(inventory.len(), 1200);
    for (index, row) in inventory.iter().enumerate() {
        assert_eq!(row[0], index + 1);
    }
    assert_eq!(inventory.iter().filter(|r| r[4] == 1).count(), 1000);
    assert_eq!(inventory.iter().filter(|r| r[4] == 0).count(), 200);
    let end = all.last().unwrap();
    println!("{end}");
    assert_eq!(end["deepMeasured"], 1000);
    assert_eq!(end["totals"]["unknown"], 200);
    assert_eq!(end["complete"], true);
    assert_eq!(end["totals"]["populationExtrapolated"], false);
}

#[test]
fn batches_do_not_change_page_facts_or_summaries() {
    let bytes = pdf(105);
    let a = records(&bytes, DetailOptions::default());
    let b = records(
        &bytes,
        DetailOptions {
            batch_pages: 7,
            ..DetailOptions::default()
        },
    );
    let summaries = |all: Vec<Value>| {
        all.into_iter()
            .filter(|r| r["t"] == "summary" || r["t"] == "end")
            .collect::<Vec<_>>()
    };
    assert_eq!(summaries(a), summaries(b));
}

#[test]
fn optional_groups_and_inventory_only_are_explicit() {
    let all = records(
        &pdf(3),
        DetailOptions {
            max_deep_pages: 0,
            groups: vec![],
            ..DetailOptions::default()
        },
    );
    assert_eq!(all.last().unwrap()["deepSelected"], 0);
    assert_eq!(all.last().unwrap()["totals"]["textKnownPages"], 0);
    assert_eq!(all.last().unwrap()["totals"]["unknown"], 3);
    assert!(all.iter().find(|r| r["t"] == "pages").unwrap()["features"]
        .as_object()
        .unwrap()
        .is_empty());
}

#[test]
fn malicious_and_oversized_requests_fail_closed() {
    let bytes = pdf(1);
    assert!(DetailSession::open(
        &bytes,
        DetailOptions {
            max_deep_pages: 1001,
            ..DetailOptions::default()
        }
    )
    .is_err());
    assert!(DetailSession::open(
        &bytes,
        DetailOptions {
            batch_pages: 0,
            ..DetailOptions::default()
        }
    )
    .is_err());
    assert!(DetailSession::open(b"%PDF-1.5\nmalformed", DetailOptions::default()).is_err());
    let mut oversized = vec![0; 64 * 1024 * 1024 + 1];
    oversized[..5].copy_from_slice(b"%PDF-");
    assert!(DetailSession::open(&oversized, DetailOptions::default()).is_err());
    let hostile = include_bytes!("fixtures/form_amplification.pdf");
    let all = records(hostile, DetailOptions::default());
    assert_eq!(all.last().unwrap()["complete"], true);
    assert_eq!(all.last().unwrap()["deepComplete"], false);
}

#[test]
fn abi_rejects_session_replacement_and_releases_explicitly() {
    use docslurp_estimate::abi::{detail_close_json, detail_next_json, detail_open_json};
    let bytes = pdf(1);
    assert!(detail_open_json(b"{}", &bytes).contains("\"ok\":true"));
    assert!(detail_open_json(b"{}", &bytes).contains("\"ok\":false"));
    assert!(detail_next_json().contains("pages"));
    detail_close_json();
    assert!(detail_next_json().contains("\"ok\":false"));
    assert!(detail_open_json(b"{}", &bytes).contains("\"ok\":true"));
    detail_close_json();
}
