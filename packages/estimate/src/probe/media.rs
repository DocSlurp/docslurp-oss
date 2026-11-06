//! Media duration from container headers: MP4/MOV/M4A, WAV, MP3, WebM/Matroska, FLAC and Ogg.
//!
//! Only headers are parsed, never audio or video data, so large files need just their first and last megabytes.

use super::{find, u16_le, u32_be, u32_le, u64_be, u64_le, ProbeInput, ProbeKind, ProbeResult};

/// Durations above this are treated as corrupt headers (the server caps durations at 24 hours).
const MAX_DURATION_SECONDS: f64 = 24.0 * 3600.0;

pub(super) fn probe(input: &ProbeInput<'_>) -> Option<ProbeResult> {
    let head = input.head;
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        let brand = &head[8..12];
        let audio_only = matches!(brand, b"M4A " | b"M4B " | b"M4P ");
        let kind = if audio_only || input.mime().starts_with("audio/") { ProbeKind::Audio } else { ProbeKind::Video };
        let (format, mime) = match (kind, brand) {
            (ProbeKind::Audio, _) => ("m4a", "audio/mp4"),
            (_, b"qt  ") => ("mov", "video/quicktime"),
            _ => ("mp4", "video/mp4"),
        };
        return Some(finish(ProbeResult::new(kind, format, Some(mime)), mp4_duration(input)));
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "wav", Some("audio/wav")), wav_duration(input)));
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        let kind = if input.mime().starts_with("audio/") || input.extension() == "weba" { ProbeKind::Audio } else { ProbeKind::Video };
        let webm = find(head, b"webm", 64).is_some();
        let (format, mime) = match (webm, kind) {
            (true, ProbeKind::Audio) => ("webm", "audio/webm"),
            (true, _) => ("webm", "video/webm"),
            (false, ProbeKind::Audio) => ("mka", "audio/x-matroska"),
            (false, _) => ("mkv", "video/x-matroska"),
        };
        return Some(finish(ProbeResult::new(kind, format, Some(mime)), ebml_duration(head)));
    }
    if head.starts_with(b"fLaC") {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "flac", Some("audio/flac")), flac_duration(head)));
    }
    if head.starts_with(b"OggS") {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "ogg", Some("audio/ogg")), ogg_duration(input)));
    }
    if head.starts_with(b"ID3") || mp3_frame_at(head, 0).is_some() {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "mp3", Some("audio/mpeg")), mp3_duration(input)));
    }
    None
}

fn finish(mut result: ProbeResult, duration: Option<f64>) -> ProbeResult {
    match duration.filter(|seconds| seconds.is_finite() && *seconds > 0.0 && *seconds <= MAX_DURATION_SECONDS) {
        Some(seconds) => result.duration_seconds = Some(seconds),
        None => result.notes.push("duration not found in the headers".into()),
    }
    result
}

// ---- MP4 / QuickTime ---------------------------------------------------------------------------------------------

/// Walk top-level boxes to `moov`, then read `mvhd` (timescale and duration).
fn mp4_duration(input: &ProbeInput<'_>) -> Option<f64> {
    let mut offset = 0u64;
    for _ in 0..4096 {
        let header = input.range(offset, 16).or_else(|| input.range(offset, 8))?;
        let mut size = u64::from(u32_be(header, 0)?);
        let kind = &header[4..8];
        let mut header_len = 8u64;
        if size == 1 {
            size = u64_be(header, 8)?;
            header_len = 16;
        } else if size == 0 {
            size = input.size.checked_sub(offset)?;
        }
        if size < header_len {
            return None;
        }
        if kind == b"moov" {
            // mvhd is the first child of moov, so a moov longer than the bytes read (a faststart file with a large
            // sample table) still yields it from whatever part was read.
            let body = input.available(offset.checked_add(header_len)?, size - header_len)?;
            return mvhd_duration(body);
        }
        offset = offset.checked_add(size)?;
        if offset >= input.size {
            return None;
        }
    }
    None
}

fn mvhd_duration(moov: &[u8]) -> Option<f64> {
    let mut at = 0usize;
    while at.checked_add(8)? <= moov.len() {
        let size = usize::try_from(u32_be(moov, at)?).ok()?;
        if moov.get(at + 4..at + 8)? == b"mvhd" {
            let body = moov.get(at + 8..)?;
            let version = *body.first()?;
            let (timescale, duration) = if version == 1 {
                (u32_be(body, 20)?, u64_be(body, 24)?)
            } else {
                (u32_be(body, 12)?, u64::from(u32_be(body, 16)?))
            };
            if timescale == 0 || duration == u64::MAX || (version == 0 && duration == u64::from(u32::MAX)) {
                return None;
            }
            return Some(duration as f64 / f64::from(timescale));
        }
        if size < 8 {
            return None;
        }
        at = at.checked_add(size)?;
    }
    None
}

// ---- WAV --------------------------------------------------------------------------------------------------------

fn wav_duration(input: &ProbeInput<'_>) -> Option<f64> {
    // Offsets are u64: chunk sizes are attacker-chosen u32s that overflow a 32-bit usize (wasm32).
    let mut at = 12u64;
    let mut byte_rate = None;
    for _ in 0..64 {
        let header = input.range(at, 8)?;
        let size = u32_le(header, 4)?;
        if &header[0..4] == b"fmt " {
            byte_rate = input.range(at + 8, 12).and_then(|fmt| u32_le(fmt, 8)).filter(|rate| *rate > 0);
        } else if &header[0..4] == b"data" {
            let rate = f64::from(byte_rate?);
            // Streams written before their length is known leave the size at 0 or u32::MAX; use the file size.
            let data = if size == 0 || size == u32::MAX { input.size.saturating_sub(at + 8) as f64 } else { f64::from(size) };
            return Some(data / rate);
        }
        at = at.checked_add(8)?.checked_add(u64::from(size))?.checked_add(u64::from(size & 1))?;
    }
    None
}

// ---- MP3 --------------------------------------------------------------------------------------------------------

struct Mp3Frame {
    bitrate_kbps: u32,
    sample_rate: u32,
    samples_per_frame: u32,
    mpeg1: bool,
    mono: bool,
}

fn mp3_frame_at(bytes: &[u8], at: usize) -> Option<Mp3Frame> {
    let header = u32_be(bytes, at)?;
    if header >> 21 != 0x7FF {
        return None;
    }
    let version = (header >> 19) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    let layer = (header >> 17) & 3; // 1 = Layer III
    let bitrate_index = ((header >> 12) & 0xF) as usize;
    let rate_index = ((header >> 10) & 3) as usize;
    if version == 1 || layer != 1 || bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
        return None;
    }
    const MPEG1_BITRATES: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const MPEG2_BITRATES: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let mpeg1 = version == 3;
    let base_rate = [44_100, 48_000, 32_000][rate_index];
    let sample_rate = match version {
        3 => base_rate,
        2 => base_rate / 2,
        _ => base_rate / 4,
    };
    Some(Mp3Frame {
        bitrate_kbps: if mpeg1 { MPEG1_BITRATES[bitrate_index] } else { MPEG2_BITRATES[bitrate_index] },
        sample_rate,
        samples_per_frame: if mpeg1 { 1152 } else { 576 },
        mpeg1,
        mono: (header >> 6) & 3 == 3,
    })
}

fn mp3_duration(input: &ProbeInput<'_>) -> Option<f64> {
    let head = input.head;
    let mut start = 0usize;
    if head.starts_with(b"ID3") {
        let size = head.get(6..10)?.iter().fold(0usize, |acc, byte| (acc << 7) | usize::from(byte & 0x7F));
        start = size.checked_add(10 + if head.get(5)? & 0x10 != 0 { 10 } else { 0 })?;
    }
    // Find the first frame within 64 KB of the tag.
    let limit = head.len().min(start.saturating_add(64 * 1024));
    let at = (start..limit.saturating_sub(4)).find(|at| mp3_frame_at(head, *at).is_some())?;
    let frame = mp3_frame_at(head, at)?;
    // A Xing/Info or VBRI header carries the frame count of a variable bitrate file.
    let side_info = match (frame.mpeg1, frame.mono) {
        (true, false) => 32,
        (true, true) => 17,
        (false, false) => 17,
        (false, true) => 9,
    };
    let xing_at = at + 4 + side_info;
    let frames = match head.get(xing_at..xing_at + 4) {
        Some(b"Xing") | Some(b"Info") if u32_be(head, xing_at + 4)? & 1 == 1 => u32_be(head, xing_at + 8),
        _ if head.get(at + 36..at + 40) == Some(b"VBRI") => u32_be(head, at + 50),
        _ => None,
    };
    if let Some(frames) = frames.filter(|frames| *frames > 0) {
        return Some(f64::from(frames) * f64::from(frame.samples_per_frame) / f64::from(frame.sample_rate));
    }
    // Constant bitrate: audio bytes over the byte rate.
    let audio_bytes = input.size.saturating_sub(at as u64) as f64;
    Some(audio_bytes * 8.0 / (f64::from(frame.bitrate_kbps) * 1000.0))
}

// ---- WebM / Matroska --------------------------------------------------------------------------------------------

fn ebml_vint(bytes: &[u8], at: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *bytes.get(at)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 {
        return None;
    }
    let mut value = if keep_marker { u64::from(first) } else { u64::from(first) & ((1u64 << (8 - len)) - 1) };
    for i in 1..len {
        value = (value << 8) | u64::from(*bytes.get(at.checked_add(i)?)?);
    }
    Some((value, len))
}

/// Segment → Info → Duration (float, in TimecodeScale units; default scale 1 ms).
fn ebml_duration(head: &[u8]) -> Option<f64> {
    const SEGMENT: u64 = 0x1853_8067;
    const INFO: u64 = 0x1549_A966;
    const TIMECODE_SCALE: u64 = 0x2A_D7B1;
    const DURATION: u64 = 0x4489;
    let mut at = 0usize;
    let mut end = head.len();
    for _ in 0..4096 {
        if at >= end {
            return None;
        }
        let (id, id_len) = ebml_vint(head, at, true)?;
        let (size, size_len) = ebml_vint(head, at.checked_add(id_len)?, false)?;
        let body = at.checked_add(id_len)?.checked_add(size_len)?;
        let unknown_size = size == (1u64 << (7 * size_len)) - 1;
        match id {
            SEGMENT => {
                at = body;
                if !unknown_size {
                    end = end.min(body.saturating_add(usize::try_from(size).unwrap_or(usize::MAX)));
                }
            }
            INFO => {
                let info_end = head.len().min(body.saturating_add(usize::try_from(size).unwrap_or(usize::MAX)));
                let mut scale = 1_000_000f64;
                let mut duration = None;
                let mut cursor = body;
                while cursor < info_end {
                    let (child, child_len) = ebml_vint(head, cursor, true)?;
                    let (child_size, child_size_len) = ebml_vint(head, cursor.checked_add(child_len)?, false)?;
                    let value_at = cursor.checked_add(child_len)?.checked_add(child_size_len)?;
                    let value_end = value_at.checked_add(usize::try_from(child_size).ok()?)?;
                    let value = head.get(value_at..value_end)?;
                    match child {
                        TIMECODE_SCALE => scale = value.iter().fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte)) as f64,
                        DURATION => {
                            duration = match value.len() {
                                4 => Some(f64::from(f32::from_be_bytes(value.try_into().ok()?))),
                                8 => Some(f64::from_be_bytes(value.try_into().ok()?)),
                                _ => None,
                            }
                        }
                        _ => {}
                    }
                    cursor = value_end;
                }
                return duration.map(|ticks| ticks * scale / 1e9);
            }
            _ => {
                if unknown_size {
                    return None;
                }
                at = body.checked_add(usize::try_from(size).ok()?)?;
            }
        }
    }
    None
}

// ---- FLAC -------------------------------------------------------------------------------------------------------

fn flac_duration(head: &[u8]) -> Option<f64> {
    // STREAMINFO is the first metadata block: sample rate (20 bits) and total samples (36 bits) at bytes 18-25.
    if head.get(4)? & 0x7F != 0 {
        return None;
    }
    let info = head.get(8..8 + 34)?;
    let packed = u64_be(info, 10)?;
    let sample_rate = (packed >> 44) as f64;
    let total_samples = (packed & 0xF_FFFF_FFFF) as f64;
    if sample_rate == 0.0 || total_samples == 0.0 {
        return None;
    }
    Some(total_samples / sample_rate)
}

// ---- Ogg (Vorbis, Opus) -----------------------------------------------------------------------------------------

fn ogg_duration(input: &ProbeInput<'_>) -> Option<f64> {
    let head = input.head;
    // First page's packet: the codec identification header.
    let segments = usize::from(*head.get(26)?);
    let packet = head.get(27 + segments..)?;
    let rate = if packet.starts_with(b"\x01vorbis") {
        f64::from(u32_le(packet, 12)?)
    } else if packet.starts_with(b"OpusHead") {
        48_000.0 // Opus granule positions always count 48 kHz samples.
    } else {
        return None;
    };
    let pre_skip = if packet.starts_with(b"OpusHead") { f64::from(u16_le(packet, 10)?) } else { 0.0 };
    // The last page's granule position is the stream's final sample.
    let tail = match input.tail {
        Some(tail) => tail,
        None if input.is_whole() => head,
        None => return None,
    };
    let last = tail.windows(4).rposition(|window| window == b"OggS")?;
    let granule = u64_le(tail, last + 6)?;
    if rate == 0.0 || granule == u64::MAX {
        return None;
    }
    Some((granule as f64 - pre_skip).max(0.0) / rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(seconds: u32) -> Vec<u8> {
        let rate = 8_000u32;
        let data = rate * 2 * seconds;
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(36 + data).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data.to_le_bytes());
        bytes.resize(bytes.len() + data as usize, 0);
        bytes
    }

    #[test]
    fn reads_wav_duration() {
        let bytes = wav(3);
        let result = probe(&ProbeInput::whole("a.wav", None, &bytes)).unwrap();
        assert_eq!(result.mime_type.as_deref(), Some("audio/wav"));
        assert_eq!(result.kind, ProbeKind::Audio);
        assert_eq!(result.duration_seconds, Some(3.0));
    }

    #[test]
    fn reads_mp4_moov_from_the_tail() {
        // ftyp, a large mdat the caller did not read, then moov/mvhd (timescale 1000, duration 90.5 s).
        let mut start = Vec::new();
        start.extend_from_slice(&16u32.to_be_bytes());
        start.extend_from_slice(b"ftypisom\0\0\0\0");
        let mdat_len = 50_000_000u64;
        start.extend_from_slice(&(mdat_len as u32).to_be_bytes());
        start.extend_from_slice(b"mdat");
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&90_500u32.to_be_bytes());
        let mut moov = Vec::new();
        moov.extend_from_slice(&(8 + 8 + mvhd.len() as u32).to_be_bytes());
        moov.extend_from_slice(b"moov");
        moov.extend_from_slice(&(8 + mvhd.len() as u32).to_be_bytes());
        moov.extend_from_slice(b"mvhd");
        moov.extend_from_slice(&mvhd);
        let size = 16 + mdat_len + moov.len() as u64;
        let input = ProbeInput { name: "clip.mp4", mime_type: None, size, head: &start, tail: Some(&moov) };
        let result = probe(&input).unwrap();
        assert_eq!(result.kind, ProbeKind::Video);
        assert_eq!(result.duration_seconds, Some(90.5));
    }

    #[test]
    fn survives_chunk_sizes_that_overflow_32_bit_offsets() {
        let mut bytes = wav(1);
        bytes[16..20].copy_from_slice(&0xFFFF_FFF9u32.to_le_bytes()); // fmt chunk size
        let result = probe(&ProbeInput::whole("a.wav", None, &bytes)).unwrap();
        assert_eq!(result.duration_seconds, None);
    }

    #[test]
    fn reads_mvhd_from_a_faststart_moov_longer_than_the_head() {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&600u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&36_000u32.to_be_bytes());
        let moov_len = 5_000_000u32;
        let mut head = Vec::new();
        head.extend_from_slice(&16u32.to_be_bytes());
        head.extend_from_slice(b"ftypisom\0\0\0\0");
        head.extend_from_slice(&moov_len.to_be_bytes());
        head.extend_from_slice(b"moov");
        head.extend_from_slice(&(8 + mvhd.len() as u32).to_be_bytes());
        head.extend_from_slice(b"mvhd");
        head.extend_from_slice(&mvhd);
        let input = ProbeInput { name: "a.mp4", mime_type: None, size: 900_000_000, head: &head, tail: Some(&[0u8; 64]) };
        assert_eq!(probe(&input).unwrap().duration_seconds, Some(60.0));
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        for bytes in [&b"ID3\x04\0\0\xff\xff\xff\xff"[..], b"OggS", b"fLaC\0", b"\x1a\x45\xdf\xa3\x8f", b"\0\0\0\x01ftypmp42"] {
            let _ = probe(&ProbeInput::whole("x", None, bytes));
        }
    }
}
