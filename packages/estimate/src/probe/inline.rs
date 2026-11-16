//! Bounded normalization of self-terminating Group 4 inline image masks.
//! PDF objects use the public syntax grammar; fax rows use the public codec.
use fax::{
    maps::{black, mode, white, Mode},
    BitReader,
};
use lopdf::{
    content::{Content, Operation},
    Dictionary, Object, Stream,
};
use otf_pdf_syntax::{lexer::Token, parser::Parser, Limits, Object as Obj, Strictness};

const MAX_INPUT: usize = 256 * 1024;
const MAX_PIXELS: usize = 1024 * 1024;
const MAX_MASKS: usize = 64;

pub(super) struct Budget {
    pixels: usize,
    scanned: usize,
    decoded: usize,
    attempts: usize,
}
pub(super) struct Normalized {
    pub content: Vec<u8>,
    pub stored_lengths: Vec<usize>,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            pixels: MAX_PIXELS,
            scanned: MAX_INPUT * 4,
            decoded: MAX_INPUT * 4,
            attempts: 64,
        }
    }
}

/// Only supported, unambiguous masks are rewritten. Any syntax, work, geometry
/// or codec uncertainty returns None; the caller retains partial evidence.
pub(super) fn normalize_inline_images(
    content: &[u8],
    budget: &mut Budget,
    resolve_color: &impl Fn(&[u8]) -> Option<usize>,
) -> Option<Normalized> {
    if content.len() > MAX_INPUT {
        return None;
    }
    budget.scanned = budget.scanned.checked_sub(content.len())?;
    let limits = Limits {
        max_depth: 16,
        max_object_size: MAX_INPUT as u64,
        ..Limits::default()
    };
    let mut parser = Parser::new(content, 0, &limits, Strictness::Strict);
    let mut output = Vec::new();
    let mut copied = 0;
    let mut stored_lengths = Vec::new();
    let mut masks = 0;
    let mut attempts = 0usize;
    for _ in 0..100_000 {
        let at = parser.lexer().pos();
        match parser.lexer().next_token().ok()? {
            Token::Eof => {
                if masks == 0 {
                    return None;
                }
                output.extend_from_slice(&content[copied..]);

                return (output.len() <= MAX_INPUT).then_some(Normalized {
                    content: output,
                    stored_lengths,
                });
            }
            Token::Keyword(b"BI") => {
                masks += 1;
                if masks > MAX_MASKS {
                    return None;
                }
                let mut entries = std::collections::BTreeMap::new();
                loop {
                    match parser.lexer().next_token().ok()? {
                        Token::Keyword(b"ID") => break,
                        Token::Name(name) => {
                            if entries.len() >= 32 {
                                return None;
                            }
                            let value = parser.parse_object().ok()?;
                            if entries.insert(name.0, value).is_some() {
                                return None;
                            }
                        }
                        _ => return None,
                    }
                }
                for (short, full) in [
                    (b"W".as_slice(), b"Width".as_slice()),
                    (b"H", b"Height"),
                    (b"IM", b"ImageMask"),
                    (b"BPC", b"BitsPerComponent"),
                    (b"F", b"Filter"),
                    (b"DP", b"DecodeParms"),
                    (b"D", b"Decode"),
                    (b"CS", b"ColorSpace"),
                ] {
                    if entries.contains_key(short) && entries.contains_key(full) {
                        return None;
                    }
                }
                let get = |short: &[u8], full: &[u8]| {
                    // Conflicting aliases cannot choose a different parse.
                    if entries.contains_key(short) && entries.contains_key(full) {
                        None
                    } else {
                        entries.get(short).or_else(|| entries.get(full))
                    }
                };
                let integer = |short: &[u8], full: &[u8]| match get(short, full) {
                    Some(Obj::Int(n)) => usize::try_from(*n).ok(),
                    _ => None,
                };
                let width = integer(b"W", b"Width")?;
                let height = integer(b"H", b"Height")?;
                if width == 0 || height == 0 || width > 4096 || height > 4096 {
                    return None;
                }
                budget.pixels = budget.pixels.checked_sub(width.checked_mul(height)?)?;
                let is_mask = match get(b"IM", b"ImageMask") {
                    Some(Obj::Bool(v)) => *v,
                    None => false,
                    _ => return None,
                };
                let bpc = if get(b"BPC", b"BitsPerComponent").is_none() && is_mask {
                    1
                } else {
                    integer(b"BPC", b"BitsPerComponent")?
                };
                if ![1, 2, 4, 8, 16].contains(&bpc)
                    || is_mask && bpc != 1
                    || is_mask && get(b"CS", b"ColorSpace").is_some()
                {
                    return None;
                }
                let components = if is_mask {
                    1
                } else {
                    match get(b"CS", b"ColorSpace") {
                        Some(Obj::Name(n)) => match n.0.as_slice() {
                            b"G" | b"DeviceGray" => 1,
                            b"RGB" | b"DeviceRGB" => 3,
                            b"CMYK" | b"DeviceCMYK" => 4,
                            n => resolve_color(n)?,
                        },
                        _ => return None,
                    }
                };
                let params = match get(b"DP", b"DecodeParms") {
                    Some(Obj::Dict(d)) => Some(d),
                    None => None,
                    _ => return None,
                };
                let mut data = parser.lexer().pos();
                if content.get(data) == Some(&b'\r') && content.get(data + 1) == Some(&b'\n') {
                    data += 2;
                } else if content
                    .get(data)
                    .is_some_and(|b| matches!(b, 0 | 9 | 10 | 12 | 13 | 32))
                {
                    data += 1;
                } else {
                    return None;
                }
                let (encoded_len, raw) = match get(b"F", b"Filter") {
                    Some(Obj::Name(n)) if n.0 == b"CCF" || n.0 == b"CCITTFaxDecode" => {
                        if !is_mask || bpc != 1 {
                            return None;
                        }
                        let params = params?;
                        for (name, value) in params.iter() {
                            match name.0.as_slice() {
                                b"K" | b"Columns" | b"Rows" if matches!(value, Obj::Int(_)) => {}
                                b"BlackIs1" | b"EndOfBlock" | b"EndOfLine"
                                | b"EncodedByteAlign"
                                    if matches!(value, Obj::Bool(_)) => {}
                                _ => return None,
                            }
                        }
                        if params.get_int(b"K") != Some(-1)
                            || params.get_int(b"Columns").unwrap_or(1728) != width as i64
                        {
                            return None;
                        }
                        if params
                            .get_int(b"Rows")
                            .is_some_and(|n| n != height as i64 && n != 0)
                        {
                            return None;
                        }
                        if params
                            .get(b"EndOfBlock")
                            .is_some_and(|v| !matches!(v, Obj::Bool(true)))
                            || params
                                .get(b"EncodedByteAlign")
                                .is_some_and(|v| !matches!(v, Obj::Bool(false)))
                            || params
                                .get(b"EndOfLine")
                                .is_some_and(|v| !matches!(v, Obj::Bool(false)))
                        {
                            return None;
                        }
                        decode_mask(
                            &content[data..],
                            width,
                            height,
                            matches!(params.get(b"BlackIs1"), Some(Obj::Bool(true))),
                            &mut attempts,
                            budget,
                        )?
                    }
                    Some(Obj::Name(n)) if n.0 == b"Fl" || n.0 == b"FlateDecode" => decode_flate(
                        &content[data..],
                        width,
                        height,
                        bpc,
                        components,
                        params,
                        budget,
                    )?,
                    _ => return None,
                };
                stored_lengths.push(encoded_len);
                let whitespace = |b: u8| matches!(b, 0 | 9 | 10 | 12 | 13 | 32);
                let mut end = data + encoded_len;
                if !content.get(end).is_some_and(|b| whitespace(*b)) {
                    return None;
                }
                while content.get(end).is_some_and(|b| whitespace(*b)) {
                    end += 1;
                }
                if content.get(end..end + 2) != Some(b"EI") {
                    return None;
                }
                end += 2;
                if content.get(end).is_some_and(|b| !whitespace(*b)) {
                    return None;
                }
                let mut dict = Dictionary::new();
                dict.set("W", width as i64);
                dict.set("H", height as i64);
                dict.set("BPC", bpc as i64);
                if is_mask {
                    dict.set("IM", true);
                } else {
                    dict.set(
                        "CS",
                        Object::Name(match components {
                            1 => b"G".to_vec(),
                            3 => b"RGB".to_vec(),
                            4 => b"CMYK".to_vec(),
                            _ => return None,
                        }),
                    );
                }
                // Decode maps are semantic image metadata; preserve valid masks.
                if let Some(decode) = get(b"D", b"Decode") {
                    let Obj::Array(values) = decode else {
                        return None;
                    };
                    if values.len() != 2 * components {
                        return None;
                    }
                    let values: Option<Vec<Object>> = values
                        .iter()
                        .map(|v| match v {
                            Obj::Int(n) if *n == 0 || *n == 1 => Some(Object::Integer(*n)),
                            _ => None,
                        })
                        .collect();
                    dict.set("D", Object::Array(values?));
                }
                let encoded = Content {
                    operations: vec![Operation::new(
                        "BI",
                        vec![Object::Stream(Stream::new(dict, raw))],
                    )],
                }
                .encode()
                .ok()?;
                output.extend_from_slice(&content[copied..at]);
                output.push(b'\n');
                output.extend(encoded);
                output.push(b'\n');
                if output.len() > MAX_INPUT {
                    return None;
                }
                copied = end;
                parser.lexer().set_pos(end);
            }
            Token::Keyword(word) if !matches!(word, b"true" | b"false" | b"null") => {}
            _ => {
                parser.lexer().set_pos(at);
                parser.parse_object().ok()?;
            }
        }
    }
    None
}

fn decode_flate(
    input: &[u8],
    width: usize,
    height: usize,
    bpc: usize,
    colors: usize,
    params: Option<&otf_pdf_syntax::Dict>,
    budget: &mut Budget,
) -> Option<(usize, Vec<u8>)> {
    use std::io::Read;
    let stride = width.checked_mul(bpc)?.checked_mul(colors)?.div_ceil(8);
    let expected = stride.checked_mul(height)?;
    if expected > MAX_INPUT {
        return None;
    }
    let mut dp = Dictionary::new();
    let mut predictor = 1;
    if let Some(params) = params {
        for (name, value) in params.iter() {
            let Obj::Int(n) = value else {
                return None;
            };
            match name.0.as_slice() {
                b"Predictor" if *n == 1 || *n == 2 || (10..=15).contains(n) => predictor = *n,
                b"Columns" if *n == width as i64 => {}
                b"Colors" if *n == colors as i64 => {}
                b"BitsPerComponent" if *n == bpc as i64 => {}
                _ => return None,
            }
            dp.set(name.0.clone(), *n);
        }
    }
    // Predictor defaults must match actual samples, not an attacker-supplied
    // Colors hint. Both inflation and predictor inversion are bounded.
    dp.set("Columns", width as i64);
    dp.set("Colors", colors as i64);
    dp.set("BitsPerComponent", bpc as i64);
    let packed = expected.checked_add(if predictor >= 10 { height } else { 0 })?;
    budget.decoded = budget
        .decoded
        .checked_sub(packed.checked_add(input.len().min(MAX_INPUT))?)?;
    budget.attempts = budget.attempts.checked_sub(1)?;
    let mut decoder = flate2::bufread::ZlibDecoder::new(&input[..input.len().min(MAX_INPUT)]);
    let mut inflated = Vec::new();
    (&mut decoder)
        .take(packed as u64 + 1)
        .read_to_end(&mut inflated)
        .ok()?;
    if inflated.len() != packed {
        return None;
    }
    let consumed = usize::try_from(decoder.total_in()).ok()?;
    // Force stream/checksum completion even when output has the exact size.
    let mut extra = [0u8; 1];
    if decoder.read(&mut extra).ok()? != 0 {
        return None;
    }
    let mut dict = Dictionary::new();
    dict.set("Filter", "FlateDecode");
    dict.set("DecodeParms", dp);
    let decoded = Stream::new(dict, input[..consumed].to_vec())
        .decompressed_content_with_limit(MAX_INPUT)
        .ok()?;
    (decoded.len() == expected).then_some((consumed, decoded))
}
#[cfg(test)]
fn normalize_fax_masks(content: &[u8], budget: &mut Budget) -> Option<Normalized> {
    normalize_inline_images(content, budget, &|_| None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flate_predictors_resource_colors_and_encoded_lengths_are_verified() {
        use std::io::Write;
        let raw: Vec<u8> = (0..18).collect();
        let mut predicted = vec![0];
        predicted.extend_from_slice(&raw[..9]);
        predicted.push(0);
        predicted.extend_from_slice(&raw[9..]);
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&predicted).unwrap();
        let data = encoder.finish().unwrap();
        let header=b"q BI /W 3 /H 2 /BPC 8 /CS /CustomRGB /F /Fl /DP << /Predictor 15 /Columns 3 /Colors 3 >> ID ";
        let make = |payload: &[u8]| {
            let mut out = header.to_vec();
            out.extend(payload);
            out.extend(b"\nEI Q");
            out
        };
        let normalized = normalize_inline_images(&make(&data), &mut Budget::default(), &|n| {
            (n == b"CustomRGB").then_some(3)
        })
        .unwrap();
        assert_eq!(normalized.stored_lengths, vec![data.len()]);
        let decoded = Content::decode_strict(&normalized.content).unwrap();
        let Object::Stream(image) = &decoded.operations[1].operands[0] else {
            panic!()
        };
        assert_eq!(image.content, raw);
        assert!(normalize_inline_images(&make(&data), &mut Budget::default(), &|_| None).is_none());
        let mut junk = data.clone();
        junk.extend(b"hidden");
        assert!(
            normalize_inline_images(&make(&junk), &mut Budget::default(), &|_| Some(3)).is_none()
        );
        let mut corrupt = data.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(
            normalize_inline_images(&make(&corrupt), &mut Budget::default(), &|_| Some(3))
                .is_none()
        );
        assert!(
            normalize_inline_images(&make(&data), &mut Budget::default(), &|_| Some(1)).is_none()
        );
    }
    fn mask(width: usize, height: usize) -> Vec<u8> {
        let mut encoder = fax::encoder::Encoder::new(fax::VecWriter::new());
        for y in 0..height {
            encoder
                .encode_line(
                    (0..width).map(|x| {
                        if (x + y) % 3 == 0 {
                            fax::Color::Black
                        } else {
                            fax::Color::White
                        }
                    }),
                    width as u32,
                )
                .unwrap();
        }
        let data = encoder.finish().unwrap().finish();
        let mut content=format!("q BI /IM true /W {width} /H {height} /BPC 1 /F /CCF /DP << /K -1 /Columns {width} >> ID ").into_bytes();
        content.extend(data);
        content.extend(b"\nEI Q");
        content
    }
    #[test]
    fn fax_mask_preserves_dimensions_packed_pixels_and_following_operations() {
        let content = mask(13, 7);
        let normalized = normalize_fax_masks(&content, &mut Budget::default()).unwrap();
        let decoded = Content::decode_strict(&normalized.content).unwrap();
        assert_eq!(decoded.operations.first().unwrap().operator, "q");
        assert_eq!(decoded.operations.last().unwrap().operator, "Q");
        let Object::Stream(image) = &decoded.operations[1].operands[0] else {
            panic!()
        };
        assert_eq!(image.content.len(), 14);
        assert_eq!(image.dict.get(b"W").unwrap().as_i64().unwrap(), 13);
        for y in 0..7 {
            for x in 0..13 {
                assert_eq!(
                    (image.content[y * 2 + x / 8] >> (7 - x % 8)) & 1,
                    u8::from((x + y) % 3 != 0)
                );
            }
        }
    }
    #[test]
    fn truncated_ambiguous_oversized_and_overbudget_masks_stay_unknown() {
        let content = mask(16, 8);
        for n in 0..content.len() {
            assert!(
                normalize_fax_masks(&content[..n], &mut Budget::default()).is_none()
                    || Content::decode_strict(&content[..n]).is_ok()
            );
        }
        let bad = String::from_utf8_lossy(
            &content[..content.windows(3).position(|w| w == b"ID ").unwrap()],
        )
        .replace("/W 16", "/W 99999999");
        assert!(normalize_fax_masks(bad.as_bytes(), &mut Budget::default()).is_none());
        let mut budget = Budget::default();
        budget.pixels = 1;
        assert!(normalize_fax_masks(&content, &mut budget).is_none());
        let mut bad_rows = content.clone();
        let at = bad_rows.windows(4).position(|w| w == b"/H 8").unwrap();
        bad_rows[at + 3] = b'9';
        assert!(normalize_fax_masks(&bad_rows, &mut Budget::default()).is_none());
    }
    fn bits_data(bits: &str) -> Vec<u8> {
        let mut out = vec![0; bits.len().div_ceil(8)];
        for (i, b) in bits.bytes().enumerate() {
            if b == b'1' {
                out[i / 8] |= 1 << (7 - i % 8);
            }
        }
        out
    }
    #[test]
    fn exact_eof_and_row_bounds_reject_recovery_cases() {
        let eof = "000000000001000000000001";
        for bits in [
            format!("1{}11111111{eof}", &eof[..12]),
            format!("00101110000110111{eof}"),
            format!("0000011{eof}"),
        ] {
            assert!(decode_mask(
                &bits_data(&bits),
                1,
                1,
                false,
                &mut 0,
                &mut Budget::default()
            )
            .is_none());
        }
        assert!(decode_mask(
            &bits_data(&format!("1{eof}")),
            1,
            1,
            false,
            &mut 0,
            &mut Budget::default()
        )
        .is_some());
    }
    #[test]
    fn alias_conflicts_and_ei_boundaries_are_not_normalized() {
        let valid = mask(16, 8);
        let id = valid.windows(4).position(|w| w == b" ID ").unwrap();
        for extra in [
            " /BitsPerComponent 8",
            " /D [1 0] /Decode [0 1]",
            " /Width 16",
        ] {
            let mut bad = valid[..id].to_vec();
            bad.extend(extra.as_bytes());
            bad.extend_from_slice(&valid[id..]);
            assert!(normalize_fax_masks(&bad, &mut Budget::default()).is_none());
        }
        let ei = valid.windows(3).rposition(|w| w == b"\nEI").unwrap();
        for separator in [b"".as_slice(), b"%comment\n", b"\n%comment\n"] {
            let mut bad = valid[..ei].to_vec();
            bad.extend(separator);
            bad.extend_from_slice(&valid[ei + 1..]);
            assert!(normalize_fax_masks(&bad, &mut Budget::default()).is_none());
        }
        let mut bad = valid[..ei + 3].to_vec();
        bad.extend(b"/Q");
        assert!(normalize_fax_masks(&bad, &mut Budget::default()).is_none());
        let at = valid.windows(6).position(|w| w == b"/BPC 1").unwrap();
        for replacement in [b"/BPC /Bad".as_slice(), b"/BPC -1", b"/BPC 0", b"/BPC 8"] {
            let mut bad = valid[..at].to_vec();
            bad.extend(replacement);
            bad.extend_from_slice(&valid[at + 6..]);
            assert!(normalize_fax_masks(&bad, &mut Budget::default()).is_none());
        }
    }
}

// Group 4 row traversal uses fax's public prefix-code maps. Based on the
// MIT-licensed pdf-rs/fax decoder (Copyright 2021 pdf-rs contributors), but with
// explicit bit position, exact row bounds and full 24-bit EOFB consumption.
struct Bits<'a> {
    input: &'a [u8],
    at: usize,
}
impl BitReader for Bits<'_> {
    type Error = ();
    fn peek(&self, count: u8) -> Option<u16> {
        if self.at + count as usize > self.input.len() * 8 {
            return None;
        }
        let mut value = 0;
        for bit in self.at..self.at + count as usize {
            value = (value << 1) | u16::from((self.input[bit / 8] >> (7 - bit % 8)) & 1);
        }
        Some(value)
    }
    fn consume(&mut self, count: u8) -> Result<(), ()> {
        self.peek(count).ok_or(())?;
        self.at += count as usize;
        Ok(())
    }
    fn bits_to_byte_boundary(&self) -> u8 {
        ((8 - self.at % 8) % 8) as u8
    }
}
fn run(reader: &mut Bits<'_>, is_white: bool) -> Option<usize> {
    let mut total = 0usize;
    for _ in 0..64 {
        let n = if is_white {
            white::decode(reader)?
        } else {
            black::decode(reader)?
        };
        total = total.checked_add(n as usize)?;
        if n < 64 {
            return Some(total);
        }
    }
    None
}
fn decode_mask(
    input: &[u8],
    width: usize,
    height: usize,
    black_is_one: bool,
    attempts: &mut usize,
    budget: &mut Budget,
) -> Option<(usize, Vec<u8>)> {
    *attempts += 1;
    budget.attempts = budget.attempts.checked_sub(1)?;
    budget.decoded = budget.decoded.checked_sub(input.len().min(MAX_INPUT))?;
    let mut reader = Bits {
        input: &input[..input.len().min(MAX_INPUT)],
        at: 0,
    };
    let stride = width.div_ceil(8);
    let mut raw = vec![0u8; stride * height];
    let mut reference = Vec::<u32>::new();
    for row in 0..height {
        let mut current = Vec::new();
        let mut a0 = 0usize;
        let mut is_white = true;
        let mut start = true;
        while a0 < width {
            let before = reader.at;
            let next = mode::decode(&mut reader)?;
            let mut index = if start {
                0
            } else {
                reference.partition_point(|x| *x as usize <= a0)
            };
            if (index % 2 == 0) != is_white {
                index += 1;
            }
            let index = (index < reference.len()).then_some(index);
            let b1 = index.map(|i| reference[i] as usize).unwrap_or(width);
            match next {
                Mode::Pass => {
                    let b2 = index
                        .and_then(|i| reference.get(i + 1))
                        .map(|x| *x as usize)
                        .unwrap_or(width);
                    if b2 <= a0 || b2 > width {
                        return None;
                    }
                    a0 = b2;
                }
                Mode::Vertical(delta) => {
                    let a1 = usize::try_from(b1 as i64 + i64::from(delta)).ok()?;
                    if a1 < a0 || a1 > width {
                        return None;
                    }
                    if a1 < width {
                        current.push(a1 as u32);
                    }
                    a0 = a1;
                    is_white = !is_white;
                }
                Mode::Horizontal => {
                    let a1 = a0.checked_add(run(&mut reader, is_white)?)?;
                    let a2 = a1.checked_add(run(&mut reader, !is_white)?)?;
                    if a1 > width || a2 > width {
                        return None;
                    }
                    if a1 < width {
                        current.push(a1 as u32);
                    }
                    if a2 < width {
                        current.push(a2 as u32);
                    }
                    a0 = a2;
                }
                Mode::EOF | Mode::Extension => return None,
            }
            if reader.at <= before || current.len() > width * 2 + 2 {
                return None;
            }
            start = false;
        }
        for (x, color) in fax::decoder::pels(&current, width as u32).enumerate() {
            if matches!(color, fax::Color::Black) == black_is_one {
                raw[row * stride + x / 8] |= 1 << (7 - x % 8);
            }
        }
        reference = current;
    }

    // Both EOL halves must immediately follow the exact number of valid rows.
    for _ in 0..2 {
        if reader.peek(12) != Some(1) {
            return None;
        }
        reader.consume(12).ok()?;
    }

    let padding = reader.bits_to_byte_boundary();
    if reader.peek(padding) != Some(0) {
        return None;
    }
    reader.consume(padding).ok()?;
    Some((reader.at / 8, raw))
}
