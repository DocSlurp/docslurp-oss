//! Content-free JSONL on stdout. Use locally trusted fixtures; production parsers require VM isolation.
use docslurp_estimate::probe::{DetailOptions, DetailSession};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: profile-jsonl <local.pdf>")?;
    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > 64 * 1024 * 1024 {
        return Err("PDF exceeds 64 MiB".into());
    }
    use std::io::{Read, Write};
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    let (mut session, header) = DetailSession::open(&bytes, DetailOptions::default())?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(header.as_bytes())?;
    while let Some(batch) = session.next() {
        stdout.write_all(batch.as_bytes())?;
    }
    Ok(())
}
