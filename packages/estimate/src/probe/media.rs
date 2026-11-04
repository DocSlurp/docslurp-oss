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
        let format = if audio_only { "m4a" } else if brand == b"qt  " { "mov" } else { "mp4" };
        return Some(finish(ProbeResult::new(kind, format), mp4_duration(input)));
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "wav"), wav_duration(input)));
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        let kind = if input.mime().starts_with("audio/") || input.extension() == "weba" { ProbeKind::Audio } else { ProbeKind::Video };
        let format = if find(head, b"webm", 64).is_some() { "webm" } else { "mkv" };
        return Some(finish(ProbeResult::new(kind, format), ebml_duration(head)));
    }
    if head.starts_with(b"fLaC") {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "flac"), flac_duration(head)));
    }
    if head.starts_with(b"OggS") {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "ogg"), ogg_duration(input)));
    }
    if head.starts_with(b"ID3") || mp3_frame_at(head, 0).is_some() {
        return Some(finish(ProbeResult::new(ProbeKind::Audio, "mp3"), mp3_duration(input)));
    }
    None
}

fn finish(mut result: ProbeResult, duration: Option<f64>) -> ProbeResult {
    match duration.filter(|seconds| seconds.is_finite() && *seconds > 0.0 && *seconds <= MAX_DURATION_SECONDS) {
        Some(seconds) => result.duration_seconds = Some(seconds),
        None => result.notes.push("duration not found in the headers; priced from size".into()),
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
            size = input.size - offset;
        }
        if size < header_len {
            return None;
        }
        if kind == b"moov" {
            let body_len = (size - header_len).min(64 * 1024 * 1024);
            let body = input.range(offset + header_len, body_len)?;
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
    while at + 8 <= moov.len() {
        let size = u32_be(moov, at)? as usize;
        if &moov[at + 4..at + 8] == b"mvhd" {
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
    let head = input.head;
    let mut at = 12usize;
    let mut byte_rate = None;
    for _ in 0..64 {
        let id = head.get(at..at + 4)?;
        let size = u32_le(head, at + 4)?;
        if id == b"fmt " {
            byte_rate = u32_le(head, at + 16).filter(|rate| *rate > 0);
        } else if id == b"data" {
            let rate = f64::from(byte_rate?);
            // Streams written before their length is known leave the size at 0 or u32::MAX; use the file size.
            let data = if size == 0 || size == u32::MAX { input.size.saturating_sub(at as u64 + 8) as f64 } else { f64::from(size) };
            return Some(data / rate);
        }
        at = at.checked_add(8 + size as usize + (size as usize & 1))?;
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
        start = 10 + size + if head.get(5)? & 0x10 != 0 { 10 } else { 0 };
    }
    // Find the first frame within 64 KB of the tag.
    let limit = head.len().min(start + 64 * 1024);
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
        value = (value << 8) | u64::from(*bytes.get(at + i)?);
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
        let (size, size_len) = ebml_vint(head, at + id_len, false)?;
        let body = at + id_len + size_len;
        let unknown_size = size == (1u64 << (7 * size_len)) - 1;
        match id {
            SEGMENT => {
                at = body;
                if !unknown_size {
                    end = end.min(body.saturating_add(size as usize));
                }
            }
            INFO => {
                let info_end = head.len().min(body.saturating_add(size as usize));
                let mut scale = 1_000_000f64;
                let mut duration = None;
                let mut cursor = body;
                while cursor < info_end {
                    let (child, child_len) = ebml_vint(head, cursor, true)?;
                    let (child_size, child_size_len) = ebml_vint(head, cursor + child_len, false)?;
                    let value_at = cursor + child_len + child_size_len;
                    let value = head.get(value_at..value_at + child_size as usize)?;
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
                    cursor = value_at + child_size as usize;
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
    fn rejects_garbage_without_panicking() {
        for bytes in [&b"ID3\x04\0\0\xff\xff\xff\xff"[..], b"OggS", b"fLaC\0", b"\x1a\x45\xdf\xa3\x8f", b"\0\0\0\x01ftypmp42"] {
            let _ = probe(&ProbeInput::whole("x", None, bytes));
        }
    }
}
