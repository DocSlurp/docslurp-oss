//! Local trusted-fixture example. Production customer parsing still requires a VM.
use docslurp_estimate::{local::FileProfileJsonl, probe::DetailOptions};
use std::io::Write;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: profile-jsonl-range <local.pdf>")?;
    let mut stream = FileProfileJsonl::new(std::fs::File::open(path)?, DetailOptions::default())?;
    let mut stdout = std::io::stdout().lock();
    while let Some(chunk) = stream.next_chunk()? {
        stdout.write_all(chunk.as_bytes())?;
    }
    Ok(())
}
