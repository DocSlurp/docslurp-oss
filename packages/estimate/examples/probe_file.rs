//! Diagnostic: profile one file natively the way the WASM `ds_probe` does (read plan, head, tail), printing the
//! envelope and the process's peak memory, so a file that traps the module can be told apart (a panic prints its
//! message and location; a file that needs more than the module's 256 MiB shows a large peak). Run it only inside the
//! sandbox VM on untrusted files: `probe_file <path> [mime type]`.
use std::io::{Read, Seek, SeekFrom};

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let mime = std::env::args().nth(2).unwrap_or_default();
    let mut file = std::fs::File::open(&path).expect("open");
    let size = file.metadata().expect("stat").len();
    let meta = serde_json::json!({ "name": "file", "size": size, "type": mime }).to_string();
    let plan: serde_json::Value = serde_json::from_str(&docslurp_estimate::abi::read_plan_json(meta.as_bytes())).unwrap();
    let head_len = plan["value"]["head"].as_u64().unwrap_or(0).min(size) as usize;
    let tail_len = plan["value"]["tail"].as_u64().unwrap_or(0).min(size) as usize;
    let mut head = vec![0; head_len];
    file.read_exact(&mut head).expect("head");
    let tail = (tail_len > 0).then(|| {
        let mut tail = vec![0; tail_len];
        file.seek(SeekFrom::Start(size - tail_len as u64)).expect("seek");
        file.read_exact(&mut tail).expect("tail");
        tail
    });
    let out = docslurp_estimate::abi::probe_json(meta.as_bytes(), &head, tail.as_deref());
    let hwm = std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(str::to_owned));
    println!("{} | head {} | {:?}", &out[..out.len().min(200)], head_len, hwm);
}
