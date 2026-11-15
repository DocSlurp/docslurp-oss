//! A valid sparse PDF: many pages share an enormous raw grayscale image.
use std::io::{Seek, SeekFrom, Write};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let path = args
        .get(1)
        .ok_or("usage: generate-range-scale <output.pdf> [pages] [imageMiB]")?;
    let pages: usize = args.get(2).map(|n| n.parse()).transpose()?.unwrap_or(20000);
    let mib: u64 = args.get(3).map(|n| n.parse()).transpose()?.unwrap_or(1024);
    if args.get(4).is_some_and(|mode|mode=="distributed"){return distributed(path,pages,mib);}
    if pages == 0 || pages > 100000 || mib == 0 || mib > 1500 {
        return Err("pages 1..100000, imageMiB 1..1500".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(b"%PDF-1.7\n")?;
    let count = pages + 4;
    let mut offsets = vec![0u64; count + 1];
    offsets[1] = file.stream_position()?;
    writeln!(file, "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj")?;
    offsets[2] = file.stream_position()?;
    write!(file, "2 0 obj << /Type /Pages /Count {pages} /Kids [")?;
    for id in 5..=count {
        write!(file, "{id} 0 R ")?;
    }
    writeln!(
        file,
        "] /MediaBox [0 0 612 792] /Resources << /XObject << /Im 4 0 R >> >> >> endobj"
    )?;
    offsets[3] = file.stream_position()?;
    let content = b"q 612 0 0 792 0 0 cm /Im Do Q BT (hello world) Tj ET";
    writeln!(file, "3 0 obj << /Length {} >> stream", content.len())?;
    file.write_all(content)?;
    file.write_all(b"\nendstream endobj\n")?;
    offsets[4] = file.stream_position()?;
    let length = mib * 1024 * 1024;
    writeln!(file,"4 0 obj << /Type /XObject /Subtype /Image /Width 32768 /Height {} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length {length} >> stream",length/32768)?;
    let start = file.stream_position()?;
    file.seek(SeekFrom::Start(start + length))?;
    file.write_all(b"\nendstream endobj\n")?;
    for id in 5..=count {
        offsets[id] = file.stream_position()?;
        writeln!(
            file,
            "{id} 0 obj << /Type /Page /Parent 2 0 R /Contents 3 0 R >> endobj"
        )?;
    }
    let xref = file.stream_position()?;
    writeln!(file, "xref\n0 {}\n0000000000 65535 f ", count + 1)?;
    for offset in &offsets[1..] {
        writeln!(file, "{offset:010} 00000 n ")?;
    }
    writeln!(
        file,
        "trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF",
        count + 1
    )?;
    file.flush()?;
    println!(
        "{{\"pages\":{pages},\"fileBytes\":{},\"imageBytes\":{length}}}",
        file.metadata()?.len()
    );
    Ok(())
}

fn distributed(path:&str,pages:usize,mib:u64)->Result<(),Box<dyn std::error::Error>> {
    if pages==0 || pages>100000 || mib==0 || mib>1500{return Err("pages 1..100000, imageMiB 1..1500".into());}
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    let count=pages*2+3;let mut offsets=vec![0u64;count+1];file.write_all(b"%PDF-1.7\n")?;
    offsets[1]=file.stream_position()?;writeln!(file,"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj")?;
    offsets[2]=file.stream_position()?;write!(file,"2 0 obj << /Type /Pages /Count {pages} /Kids [")?;
    for i in 0..pages{write!(file,"{} 0 R ",5+i*2)?;}writeln!(file,"] /MediaBox [0 0 612 792] >> endobj")?;
    offsets[3]=file.stream_position()?;let content=b"q 612 0 0 792 0 0 cm /Im Do Q";
    writeln!(file,"3 0 obj << /Length {} >> stream",content.len())?;file.write_all(content)?;file.write_all(b"\nendstream endobj\n")?;
    let height=(mib*1024*1024/pages as u64/100).max(1);let image_bytes=height*100;
    for i in 0..pages {
        let image=4+i*2;let page=image+1;
        offsets[image]=file.stream_position()?;
        writeln!(file,"{image} 0 obj << /Type /XObject /Subtype /Image /Width 800 /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Length {image_bytes} >> stream")?;
        let start=file.stream_position()?;file.seek(SeekFrom::Start(start+image_bytes))?;file.write_all(b"\nendstream endobj\n")?;
        offsets[page]=file.stream_position()?;writeln!(file,"{page} 0 obj << /Type /Page /Parent 2 0 R /Contents 3 0 R /Resources << /XObject << /Im {image} 0 R >> >> >> endobj")?;
    }
    let xref=file.stream_position()?;writeln!(file,"xref\n0 {}\n0000000000 65535 f ",count+1)?;
    for offset in &offsets[1..]{writeln!(file,"{offset:010} 00000 n ")?;}
    writeln!(file,"trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF",count+1)?;file.flush()?;
    println!("{{\"pages\":{pages},\"fileBytes\":{},\"imageBytes\":{},\"mode\":\"distributed\"}}",file.metadata()?.len(),image_bytes*pages as u64);Ok(())
}
