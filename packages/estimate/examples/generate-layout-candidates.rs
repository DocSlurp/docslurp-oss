//! Generate our own three-page demonstration: unruled table, caption, vector plot.
use lopdf::{dictionary, Document, Object, Stream};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: generate-layout-candidates <output.pdf>")?;
    let mut doc = Document::with_version("1.7");
    let tree = doc.new_object_id();
    let font =
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica"});
    let image=doc.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Image","Width"=>300,"Height"=>200,"ColorSpace"=>"DeviceGray","BitsPerComponent"=>8},(0..60000).map(|i|((i/300+i%300)%256) as u8).collect()));
    let mut table = String::new();
    for (row, y) in [680, 650, 620, 590].into_iter().enumerate() {
        for (column, x) in [72, 230, 390].into_iter().enumerate() {
            table.push_str(&format!(
                "BT /F1 12 Tf 1 0 0 1 {x} {y} Tm (Cell{}{}) Tj ET\n",
                row + 1,
                column + 1
            ));
        }
    }
    let caption="q 300 0 0 200 100 400 cm /Im Do Q\nBT /F1 12 Tf 1 0 0 1 110 385 Tm (Figure: sample image) Tj ET\n".to_string();
    let mut plot = "0.8 w 100 200 m 100 600 l 500 200 m 100 200 l S\n".to_string();
    for i in 1..8 {
        let t = 200 + i * 50;
        plot.push_str(&format!("95 {t} m 105 {t} l S\n"));
        let x = 100 + i * 50;
        plot.push_str(&format!("{x} 195 m {x} 205 l S\n"));
    }
    plot.push_str("100 230 m ");
    for i in 1..21 {
        plot.push_str(&format!("{} {} l ", 100 + i * 18, 230 + (i * 17) % 300));
    }
    plot.push_str("S\nBT /F1 12 Tf 1 0 0 1 250 170 Tm (Time) Tj ET\n");
    let mut kids = Vec::new();
    for content in [table, caption, plot] {
        let content = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>tree,"Contents"=>content,"MediaBox"=>vec![0.into(),0.into(),612.into(),792.into()],"Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>font},"XObject"=>dictionary!{"Im"=>image}}});
        kids.push(Object::Reference(page));
    }
    doc.objects.insert(
        tree,
        dictionary! {"Type"=>"Pages","Kids"=>kids,"Count"=>3}.into(),
    );
    let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>tree});
    doc.trailer.set("Root", root);
    doc.compress();
    doc.save(path)?;
    Ok(())
}
