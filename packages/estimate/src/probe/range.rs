//! Cooperative random-access PDF loading. Hosts supply only explicitly requested
//! ranges; image/font payloads are never needed for metadata measurements.
use super::detail::{Evidence, Options, Rankings, Session, Summary};
use super::*;
use crate::error::Error;
use otf_pdf_syntax::{self as syntax, Dict, Limits, ObjId, Object as Obj, Strictness};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, BinaryHeap, VecDeque};
use syntax::parser::{ObjectEnd, Parser};
use syntax::xref::{XrefEntry, XrefMap};

const MAX_RANGE: usize = 1024 * 1024;
const CACHE_BYTES: usize = 16 * MAX_RANGE;
const MAX_ENTRIES: usize = 250_000;
const MAX_PAGES: usize = 100_000;
const MAX_READ: u64 = 512 * 1024 * 1024;
const MAX_PARSE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug)]
enum Stop {
    Read(u64, usize),
    Bad(&'static str),
}
type R<T> = Result<T, Stop>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub request_id: u64,
    pub offset: u64,
    pub length: usize,
}

struct Reader {
    size: u64,
    cache: VecDeque<(u64, Vec<u8>)>,
    cached: usize,
    pending: Option<Request>,
    next_id: u64,
    read_bytes: u64,
    parse_bytes: u64,
    limits: Limits,
    index: XrefMap,
    offsets: Vec<u64>,
    objects: HashMap<ObjId, (Header, usize)>,
    object_order: VecDeque<ObjId>,
    object_bytes: usize,
    peak_cache: usize,
    payloads: VecDeque<((u64, u64), Rc<Vec<u8>>)>,
    payload_bytes: usize,
    pin_payloads: bool,
}

#[derive(Clone)]
struct Header {
    value: Rc<Obj>,
    stream: Option<(u64, u64)>,
}

fn object_weight(object: &Obj) -> usize {
    128 + match object {
        Obj::Array(values) => values.iter().map(object_weight).sum(),
        Obj::Dict(dict) => dict
            .iter()
            .map(|(key, value)| 128 + key.as_bytes().len() + object_weight(value))
            .sum(),
        Obj::Name(value) => value.as_bytes().len(),
        Obj::String(value) => value.bytes.len(),
        _ => 0,
    }
}

fn bad<T>(message: &'static str) -> R<T> {
    Err(Stop::Bad(message))
}
fn reference(object: &Obj) -> R<ObjId> {
    object
        .as_ref()
        .ok_or(Stop::Bad("expected an indirect reference"))
}
fn integer(object: &Obj) -> R<u64> {
    object
        .as_int()
        .and_then(|n| u64::try_from(n).ok())
        .ok_or(Stop::Bad("expected a nonnegative integer"))
}
fn convert(object: &Obj) -> Object {
    match object {
        Obj::Null => Object::Null,
        Obj::Bool(v) => Object::Boolean(*v),
        Obj::Int(v) => Object::Integer(*v),
        Obj::Real(v) => Object::Real(*v as f32),
        Obj::Name(v) => Object::Name(v.as_bytes().to_vec()),
        Obj::String(v) => Object::String(v.bytes.clone(), lopdf::StringFormat::Literal),
        Obj::Ref(v) => Object::Reference((v.num, v.generation)),
        Obj::Array(v) => Object::Array(v.iter().map(convert).collect()),
        Obj::Dict(v) => Object::Dictionary(convert_dict(v)),
        Obj::Stream(v) => Object::Dictionary(convert_dict(&v.dict)),
    }
}
fn convert_dict(dict: &Dict) -> Dictionary {
    dict.iter()
        .map(|(key, value)| (key.as_bytes().to_vec(), convert(value)))
        .collect()
}

impl Reader {
    fn read(&mut self, offset: u64, length: usize) -> R<Vec<u8>> {
        let end = offset
            .checked_add(length as u64)
            .ok_or(Stop::Bad("range overflow"))?;
        if end > self.size || length > MAX_RANGE {
            return bad("range outside input or range limit");
        }
        if length == 0 {
            return Ok(Vec::new());
        }
        if let Some(index) = self
            .cache
            .iter()
            .position(|(at, bytes)| offset >= *at && end <= *at + bytes.len() as u64)
        {
            let item = self.cache.remove(index).unwrap();
            let start = (offset - item.0) as usize;
            let output = item.1[start..start + length].to_vec();
            self.cache.push_back(item);
            return Ok(output);
        }
        Err(Stop::Read(offset, length))
    }
    fn charge_parse(&mut self, bytes: usize) -> R<()> {
        self.parse_bytes = self.parse_bytes.saturating_add(bytes as u64);
        if self.parse_bytes > MAX_PARSE {
            return bad("document parsing work budget exceeded");
        }
        Ok(())
    }
    fn supply(&mut self, request: Request, bytes: &[u8]) -> Result<(), Error> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| Error::invalid_request("no pending range"))?;
        if pending.request_id != request.request_id
            || pending.offset != request.offset
            || pending.length != request.length
            || bytes.len() != request.length
        {
            return Err(Error::invalid_request(
                "stale, mismatched or short range response",
            ));
        }
        self.pending = None;
        self.read_bytes += bytes.len() as u64;
        while self.cached + bytes.len() > CACHE_BYTES || self.cache.len() >= 512 {
            if let Some((_, old)) = self.cache.pop_front() {
                self.cached -= old.len();
            } else {
                break;
            }
        }
        self.cached += bytes.len();
        self.peak_cache = self.peak_cache.max(self.cached);
        self.cache.push_back((request.offset, bytes.to_vec()));
        Ok(())
    }
    fn payload(&mut self, header: &Header, cap: usize) -> R<Vec<u8>> {
        let (offset, length) = header.stream.ok_or(Stop::Bad("expected stream"))?;
        if let Some((_, bytes)) = self
            .payloads
            .iter()
            .find(|(key, _)| *key == (offset, length))
        {
            return Ok(bytes.as_ref().clone());
        }
        let length = usize::try_from(length).map_err(|_| Stop::Bad("stream length overflow"))?;
        if length > cap {
            return bad("encoded stream exceeds page work budget");
        }
        if self.pin_payloads && self.payload_bytes + length > 16 * MAX_RANGE {
            return bad("page retained payload budget exceeded");
        }
        let mut output = Vec::with_capacity(length);
        for at in (0..length).step_by(MAX_RANGE) {
            output.extend(self.read(offset + at as u64, (length - at).min(MAX_RANGE))?);
        }
        while self.payload_bytes + length > 16 * MAX_RANGE {
            if let Some((_, old)) = self.payloads.pop_front() {
                self.payload_bytes -= old.len();
            } else {
                break;
            }
        }
        self.payload_bytes += length;
        self.payloads
            .push_back(((offset, length as u64), Rc::new(output.clone())));
        Ok(output)
    }
    fn clear_payloads(&mut self) {
        self.payloads.clear();
        self.payload_bytes = 0;
    }
    fn header(&mut self, offset: u64, expected: Option<ObjId>, depth: usize) -> R<Header> {
        if offset >= self.size || depth > 32 {
            return bad("invalid object offset or reference depth");
        }
        let next = self.offsets.partition_point(|at| *at <= offset);
        let boundary = self.offsets.get(next).copied().unwrap_or(self.size);
        let available = (boundary - offset) as usize;
        let mut length = 512usize.min(available);
        loop {
            let bytes = match self.read(offset, length) {
                Err(Stop::Read(_, requested)) => {
                    // Coalesce only indexed small objects; stop before large streams.
                    let mut at = offset;
                    let mut end = offset;
                    for bound in &self.offsets[next..] {
                        if *bound - at > 4096 || *bound - offset > 65536 { break; }
                        end = *bound;
                        at = *bound;
                    }
                    return Err(Stop::Read(offset, requested.max((end - offset) as usize)));
                }
                other => other?,
            };
            self.charge_parse(length)?;
            let parsed = Parser::new(&bytes, offset, &self.limits, Strictness::Strict)
                .parse_indirect(expected);
            match parsed {
                Ok((_, value, end)) => {
                    let stream = if let ObjectEnd::Stream { data_start } = end {
                        let dict = value
                            .as_dict()
                            .ok_or(Stop::Bad("stream dictionary missing"))?;
                        let size = dict
                            .get(b"Length")
                            .ok_or(Stop::Bad("stream length missing"))?;
                        let size = self.resolve(size, depth + 1)?;
                        let size = integer(&size)?;
                        let start = offset
                            .checked_add(data_start as u64)
                            .ok_or(Stop::Bad("stream offset overflow"))?;
                        let end = start
                            .checked_add(size)
                            .filter(|end| *end < self.size)
                            .ok_or(Stop::Bad("stream exceeds input"))?;
                        let marker = self.read(end, 32.min((self.size - end) as usize))?;
                        let leading = marker.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(marker.len());
                        let marker = marker
                            .iter()
                            .position(|b| !b.is_ascii_whitespace())
                            .map(|i| &marker[i..])
                            .unwrap_or_default();
                        use syntax::lexer::{Lexer, Token};
                        let mut lexer = Lexer::new(marker);
                        if lexer.next_token().ok() != Some(Token::Keyword(b"endstream"))
                            || lexer.next_token().ok() != Some(Token::Keyword(b"endobj"))
                        {
                            return bad(
                                "stream length does not reach exact endstream/endobj tokens",
                            );
                        }
                        if end + leading as u64 + lexer.pos() as u64 > boundary {
                            return bad("stream overlaps another indexed object");
                        }
                        Some((start, size))
                    } else {
                        None
                    };
                    return Ok(Header {
                        value: Rc::new(value),
                        stream,
                    });
                }
                Err(_) if length < MAX_RANGE && length < available => {
                    length = (length * 4)
                        .min(MAX_RANGE)
                        .min(available)
                }
                Err(_) => return bad("invalid or oversized PDF object syntax"),
            }
        }
    }
    fn resolve(&mut self, object: &Obj, depth: usize) -> R<Obj> {
        if depth > 32 {
            return bad("cyclic or deep object reference");
        }
        match object {
            Obj::Ref(id) => {
                let header = self.object(*id, depth + 1)?;
                self.resolve(&header.value, depth + 1)
            }
            other => {
                self.charge_parse(object_weight(other))?;
                Ok(other.clone())
            }
        }
    }
    fn object(&mut self, id: ObjId, depth: usize) -> R<Header> {
        if let Some((header, _)) = self.objects.get(&id) {
            return Ok(header.clone());
        }
        let header = self.object_uncached(id, depth)?;
        let weight = object_weight(&header.value);
        if weight <= CACHE_BYTES {
            while self.object_bytes + weight > CACHE_BYTES {
                if let Some(old) = self.object_order.pop_front() {
                    if let Some((_, weight)) = self.objects.remove(&old) {
                        self.object_bytes -= weight;
                    }
                } else {
                    break;
                }
            }
            self.object_bytes += weight;
            self.object_order.push_back(id);
            self.objects.insert(id, (header.clone(), weight));
        }
        Ok(header)
    }
    fn object_uncached(&mut self, id: ObjId, depth: usize) -> R<Header> {
        if depth > 32 {
            return bad("cyclic or deep object reference");
        }
        match self
            .index
            .get(&id.num)
            .copied()
            .ok_or(Stop::Bad("missing xref object"))?
        {
            XrefEntry::InUse { offset, generation } => {
                if generation != id.generation {
                    return bad("xref generation mismatch");
                }
                self.header(offset, Some(id), depth + 1)
            }
            XrefEntry::Compressed { stream, index } => {
                if id.generation != 0 {
                    return bad("compressed object has nonzero generation");
                }
                let header = self.object(ObjId::new(stream, 0), depth + 1)?;
                let dict = header
                    .value
                    .as_dict()
                    .ok_or(Stop::Bad("object stream dictionary missing"))?;
                if dict.get_name(b"Type") != Some(b"ObjStm") {
                    return bad("compressed object container is not ObjStm");
                }
                let n = dict
                    .get_int(b"N")
                    .and_then(|v| usize::try_from(v).ok())
                    .filter(|v| *v <= 10_000)
                    .ok_or(Stop::Bad("object stream count limit"))?;
                let first = dict
                    .get_int(b"First")
                    .and_then(|v| usize::try_from(v).ok())
                    .ok_or(Stop::Bad("object stream First invalid"))?;
                let payload = self.payload(&header, 8 * MAX_RANGE)?;
                let stream = lopdf::Stream::new(convert_dict(dict), payload);
                let decoded = match stream.decompressed_content_with_limit(16 * MAX_RANGE) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        self.charge_parse(16 * MAX_RANGE)?;
                        return bad("object stream decompression limit");
                    }
                };
                self.charge_parse(decoded.len())?;
                if first > decoded.len() || index as usize >= n {
                    return bad("invalid object stream member bounds");
                }
                let mut lexer = syntax::lexer::Lexer::new(&decoded[..first]);
                let mut entries = Vec::with_capacity(n);
                let mut ids = BTreeSet::new();
                for _ in 0..n {
                    use syntax::lexer::Token;
                    let Token::Int(num) = lexer
                        .next_token()
                        .map_err(|_| Stop::Bad("object stream index syntax"))?
                    else {
                        return bad("object stream id invalid");
                    };
                    let Token::Int(at) = lexer
                        .next_token()
                        .map_err(|_| Stop::Bad("object stream index syntax"))?
                    else {
                        return bad("object stream offset invalid");
                    };
                    if num <= 0 || num > MAX_ENTRIES as i64 || !ids.insert(num) {
                        return bad("duplicate or invalid object stream id");
                    }
                    let at = usize::try_from(at)
                        .ok()
                        .and_then(|at| first.checked_add(at))
                        .filter(|at| *at < decoded.len())
                        .ok_or(Stop::Bad("object stream offset outside body"))?;
                    if entries.last().is_some_and(|(_, previous)| *previous >= at) {
                        return bad("object stream offsets not increasing");
                    }
                    entries.push((num, at));
                }
                if lexer.next_token().ok() != Some(syntax::lexer::Token::Eof) {
                    return bad("object stream index has trailing syntax");
                }
                let (num, at) = entries[index as usize];
                if num != i64::from(id.num) {
                    return bad("object stream index/id mismatch");
                }
                let end = entries
                    .get(index as usize + 1)
                    .map(|entry| entry.1)
                    .unwrap_or(decoded.len());
                if end-at>MAX_RANGE{return bad("compressed member syntax exceeds metadata limit");}
                let mut parser =
                    Parser::new(&decoded[at..end], 0, &self.limits, Strictness::Strict);
                let value = parser
                    .parse_object()
                    .map_err(|_| Stop::Bad("compressed object syntax invalid"))?;
                if parser.lexer().next_token().ok() != Some(syntax::lexer::Token::Eof) {
                    return bad("compressed object contains trailing syntax");
                }
                Ok(Header {
                    value: Rc::new(value),
                    stream: None,
                })
            }
            XrefEntry::Free => bad("reference to a free xref object"),
        }
    }
    fn section(&mut self, offset: u64) -> R<(XrefMap, Dict)> {
        if offset >= self.size {
            return bad("xref offset outside input");
        }
        let bytes = self.read(offset, 16.min((self.size - offset) as usize))?;
        if bytes.starts_with(b"xref") {
            let mut size = 4096usize.min((self.size - offset) as usize);
            loop {
                let bytes = self.read_window(offset, size)?;
                self.charge_parse(bytes.len())?;
                if let Ok(result) = syntax::xref::parse_table(
                    &bytes,
                    offset,
                    &self.limits,
                    Strictness::Strict,
                    &syntax::Diagnostics::default(),
                ) {
                    return Ok(result);
                }
                if size >= 8 * MAX_RANGE || size >= (self.size - offset) as usize {
                    return bad("invalid or oversized xref table");
                }
                size = (size * 4)
                    .min(8 * MAX_RANGE)
                    .min((self.size - offset) as usize);
            }
        }
        let header = self.header(offset, None, 0)?;
        let dict = header
            .value
            .as_dict()
            .ok_or(Stop::Bad("xref stream dictionary missing"))?;
        if !dict.is_type(b"XRef") {
            return bad("startxref does not point to an xref section");
        }
        let data = self.payload(&header, 8 * MAX_RANGE)?;
        let decoded = lopdf::Stream::new(convert_dict(dict), data)
            .decompressed_content_with_limit(16 * MAX_RANGE)
            .map_err(|_| Stop::Bad("xref decompression budget exceeded"))?;
        self.charge_parse(decoded.len())?;
        let widths = dict
            .get_array(b"W")
            .filter(|w| w.len() == 3)
            .ok_or(Stop::Bad("xref widths invalid"))?;
        let mut width = 0usize;
        for part in widths {
            let n = integer(part)?;
            if n > 8 {
                return bad("xref field width exceeds eight bytes");
            }
            width += n as usize;
        }
        if width == 0 {
            return bad("zero-width xref stream");
        }
        let fallback = vec![
            Obj::Int(0),
            Obj::Int(
                dict.get_int(b"Size")
                    .ok_or(Stop::Bad("xref Size missing"))?,
            ),
        ];
        let indices = dict.get_array(b"Index").unwrap_or(&fallback);
        if indices.len() % 2 != 0 {
            return bad("xref Index must contain pairs");
        }
        let mut rows = 0usize;
        for pair in indices.chunks_exact(2) {
            let start = integer(&pair[0])?;
            let count = integer(&pair[1])?;
            if start
                .checked_add(count)
                .is_none_or(|n| n > MAX_ENTRIES as u64)
            {
                return bad("xref entry budget exceeded");
            }
            rows = rows
                .checked_add(count as usize)
                .ok_or(Stop::Bad("xref rows overflow"))?;
        }
        if rows > MAX_ENTRIES || rows.checked_mul(width) != Some(decoded.len()) {
            return bad("truncated or oversized xref stream rows");
        }
        let w: Vec<_> = widths
            .iter()
            .map(|value| value.as_int().unwrap() as usize)
            .collect();
        for row in decoded.chunks_exact(width) {
            let field = |from: usize, to: usize| {
                row[from..to]
                    .iter()
                    .fold(0u64, |value, byte| (value << 8) | u64::from(*byte))
            };
            let kind = if w[0] == 0 { 1 } else { field(0, w[0]) };
            let generation = field(w[0] + w[1], width);
            if matches!(kind, 0 | 1) && generation > 65535 {
                return bad("xref generation exceeds 65535");
            }
        }
        let entries = syntax::xref::parse_stream(dict, &decoded, &self.limits)
            .map_err(|_| Stop::Bad("xref stream invalid"))?;
        Ok((entries, dict.clone()))
    }
    fn read_window(&mut self, offset: u64, size: usize) -> R<Vec<u8>> {
        let mut output = Vec::with_capacity(size);
        for at in (0..size).step_by(MAX_RANGE) {
            output.extend(self.read(offset + at as u64, (size - at).min(MAX_RANGE))?);
        }
        Ok(output)
    }
    fn contents(&mut self, dict: &Dict) -> R<(Vec<ObjId>, u64)> {
        let Some(value) = dict.get(b"Contents") else {
            return Ok((Vec::new(), 0));
        };
        let mut ids = Vec::new();
        let mut total = 0u64;
        let values = if let Obj::Ref(id) = value {
            let header = self.object(*id, 0)?;
            if header.stream.is_some() {
                vec![Obj::Ref(*id)]
            } else {
                match header.value.as_ref() {
                    Obj::Array(values) => values.clone(),
                    _ => return bad("Contents reference is neither stream nor array"),
                }
            }
        } else {
            match value {
                Obj::Array(values) => values.clone(),
                _ => return bad("Contents must reference streams"),
            }
        };
        if values.len() > 256 {
            return bad("page content stream count limit");
        }
        for value in values {
            let id = reference(&value)?;
            let header = self.object(id, 0)?;
            let (_, length) = header
                .stream
                .ok_or(Stop::Bad("Contents member is not a stream"))?;
            if !ids.contains(&id) {
                total = total
                    .checked_add(length)
                    .ok_or(Stop::Bad("content length overflow"))?;
            }
            ids.push(id);
        }
        Ok((ids, total))
    }
    fn attributes(&mut self, page: ObjId, include_resources: bool) -> R<Dict> {
        let mut out = Dict::new();
        let mut current = Some(page);
        let mut seen = BTreeSet::new();
        while let Some(id) = current {
            if !seen.insert(id) || seen.len() > 32 {
                return bad("page inheritance cycle or depth limit");
            }
            let header = self.object(id, 0)?;
            let dict = header
                .value
                .as_dict()
                .ok_or(Stop::Bad("page dictionary missing"))?;
            for key in [b"MediaBox".as_slice(), b"CropBox", b"Rotate", b"Resources"] {
                if key == b"Resources" && !include_resources {
                    continue;
                }
                if !out.contains_key(key) {
                    if let Some(value) = dict.get(key) {
                        out.insert(key, self.resolve(value, 0)?);
                    }
                }
            }
            current = dict.get_ref(b"Parent");
        }
        Ok(out)
    }
    fn document(
        &mut self,
        page: ObjId,
        deep: bool,
    ) -> R<(Document, HashMap<ObjectId, usize>, u64)> {
        let header = self.object(page, 0)?;
        let dict = header
            .value
            .as_dict()
            .ok_or(Stop::Bad("page dictionary missing"))?;
        let (contents, stored) = self.contents(dict)?;
        let attrs = self.attributes(page, deep)?;
        let attrs_weight = attrs
            .iter()
            .map(|(_, value)| object_weight(value))
            .sum::<usize>();
        if attrs_weight > 16 * MAX_RANGE {
            return bad("inherited page attribute budget exceeded");
        }
        self.charge_parse(attrs_weight)?;
        let mut document = Document::with_version("1.7");
        let mut page_dict = convert_dict(&attrs);
        page_dict.set("Type", Object::Name(b"Page".to_vec()));
        page_dict.set(
            "Contents",
            Object::Array(
                contents
                    .iter()
                    .map(|id| Object::Reference((id.num, id.generation)))
                    .collect(),
            ),
        );
        let mut queued: BTreeSet<_> = contents.iter().copied().collect();
        let mut queue: Vec<_> = queued.iter().copied().collect();
        let mut visited_slots = 0usize;
        fn refs(
            object: &Obj,
            queue: &mut Vec<ObjId>,
            queued: &mut BTreeSet<ObjId>,
            slots: &mut usize,
        ) -> R<()> {
            *slots += 1;
            if *slots > 10000 {
                return bad("page reference traversal budget exceeded");
            }
            match object {
                Obj::Ref(id) => {
                    if queued.insert(*id) {
                        if queued.len() > 512 {
                            return bad("page reference queue budget exceeded");
                        }
                        queue.push(*id);
                    }
                }
                Obj::Array(values) => {
                    for value in values {
                        refs(value, queue, queued, slots)?
                    }
                }
                Obj::Dict(dict) => {
                    for (key, value) in dict.iter() {
                        if ![b"Parent".as_slice(), b"Metadata", b"Annots", b"PieceInfo"]
                            .contains(&key.as_bytes())
                        {
                            refs(value, queue, queued, slots)?
                        }
                    }
                }
                _ => {}
            }
            Ok(())
        }
        if deep {
            if let Some(resources) = attrs.get(b"Resources") {
                refs(resources, &mut queue, &mut queued, &mut visited_slots)?;
            }
        }
        let mut seen = BTreeSet::new();
        let mut lengths = HashMap::new();
        let mut encoded = 0usize;
        let mut materialized = attrs_weight;
        while let Some(id) = queue.pop() {
            if !seen.insert(id) {
                continue;
            }
            if seen.len() > 512 {
                return bad("page dependency graph exceeds object budget");
            }
            let header = self.object(id, 0)?;
            let weight = object_weight(&header.value);
            materialized = materialized.saturating_add(weight);
            if materialized > 16 * MAX_RANGE {
                return bad("page materialized metadata budget exceeded");
            }
            self.charge_parse(weight)?;
            let object = if let Some((_, length)) = header.stream {
                let dict = header
                    .value
                    .as_dict()
                    .ok_or(Stop::Bad("stream dictionary missing"))?;
                let needed =
                    deep && (contents.contains(&id) || dict.get_name(b"Subtype") == Some(b"Form"));
                let payload = if needed {
                    let data = self.payload(&header, 8 * MAX_RANGE)?;
                    encoded += data.len();
                    if encoded > 16 * MAX_RANGE {
                        return bad("page encoded dependency budget exceeded");
                    }
                    data
                } else {
                    Vec::new()
                };
                if deep {
                    refs(&header.value, &mut queue, &mut queued, &mut visited_slots)?;
                }
                if dict.get_name(b"Subtype") == Some(b"Image") {
                    lengths.insert(
                        (id.num, id.generation),
                        usize::try_from(length)
                            .map_err(|_| Stop::Bad("image length exceeds host word size"))?,
                    );
                }
                let mut stream = lopdf::Stream::new(convert_dict(dict), payload);
                stream.dict.set("Length", length as i64);
                Object::Stream(stream)
            } else {
                if deep {
                    refs(&header.value, &mut queue, &mut queued, &mut visited_slots)?;
                }
                convert(&header.value)
            };
            document.objects.insert((id.num, id.generation), object);
        }
        document
            .objects
            .insert((page.num, page.generation), Object::Dictionary(page_dict));
        Ok((document, lengths, stored))
    }
}

/// One active range session, with no filesystem or network authority.
pub struct RangeSession {
    reader: Reader,
    options: Options,
    phase: u8,
    xrefs: Vec<u64>,
    seen_xrefs: BTreeSet<u64>,
    root: Option<ObjId>,
    walk: Vec<ObjId>,
    seen_nodes: BTreeSet<ObjId>,
    pages: Vec<ObjId>,
    stored: Vec<u64>,
    selected: BTreeSet<usize>,
    cursor: usize,
    chunk: usize,
    summary: Summary,
    total: Summary,
    decoded: usize,
    operations: usize,
    measured: usize,
    partial: usize,
    attempted: usize,
    rankings: Rankings,
    batch_first: usize,
    batch_inventory: Vec<Value>,
    batch_features: serde_json::Map<String, Value>,
    batch_summaries: Vec<Value>,
    batch_deep: usize,
}

impl RangeSession {
    pub fn new(size: u64, options: Options, epoch: u64) -> Result<Self, Error> {
        options.validate()?;
        if !(16..=2 * 1024 * 1024 * 1024).contains(&size) {
            return Err(Error::invalid_request("PDF size must be 16 bytes..2 GiB"));
        }
        let limits = Limits {
            max_depth: 32,
            max_objects: MAX_ENTRIES as u32,
            max_decoded_size: 16 * MAX_RANGE as u64,
            max_object_size: MAX_RANGE as u64,
            max_pages: MAX_PAGES as u32,
            ..Limits::default()
        };
        Ok(Self {
            reader: Reader {
                size,
                cache: VecDeque::new(),
                cached: 0,
                pending: None,
                next_id: epoch,
                read_bytes: 0,
                parse_bytes: 0,
                limits,
                index: XrefMap::new(),
                offsets: Vec::new(),
                objects: HashMap::new(),
                object_order: VecDeque::new(),
                object_bytes: 0,
                peak_cache: 0,
                payloads: VecDeque::new(),
                payload_bytes: 0,
                pin_payloads: false,
            },
            options,
            phase: 0,
            xrefs: Vec::new(),
            seen_xrefs: BTreeSet::new(),
            root: None,
            walk: Vec::new(),
            seen_nodes: BTreeSet::new(),
            pages: Vec::new(),
            stored: Vec::new(),
            selected: BTreeSet::new(),
            cursor: 0,
            chunk: 1,
            summary: Summary::default(),
            total: Summary::default(),
            decoded: 0,
            operations: 0,
            measured: 0,
            partial: 0,
            attempted: 0,
            rankings: Rankings::default(),
            batch_first: 1,
            batch_inventory: Vec::new(),
            batch_features: serde_json::Map::new(),
            batch_summaries: Vec::new(),
            batch_deep: 0,
        })
    }
    pub fn supply(&mut self, request: Request, bytes: &[u8]) -> Result<(), Error> {
        self.reader.supply(request, bytes)
    }
    pub fn step(&mut self) -> Result<Value, Error> {
        if self.reader.pending.is_some() {
            return Err(Error::invalid_request(
                "supply the pending range before stepping",
            ));
        }
        match self.advance() {
            Ok(value) => Ok(value),
            Err(Stop::Bad(message)) => Err(Error::invalid_request(message)),
            Err(Stop::Read(offset, length)) => {
                if self.reader.read_bytes + length as u64 > MAX_READ {
                    return Err(Error::invalid_request(
                        "document range-read budget exceeded",
                    ));
                }
                self.reader.next_id = self
                    .reader
                    .next_id
                    .checked_add(1)
                    .ok_or_else(|| Error::invalid_request("range request id overflow"))?;
                let request = Request {
                    request_id: self.reader.next_id,
                    offset,
                    length,
                };
                self.reader.pending = Some(request.clone());
                Ok(
                    json!({"kind":"read","requestId":request.request_id,"offset":offset,"length":length}),
                )
            }
        }
    }
    fn advance(&mut self) -> R<Value> {
        loop {
            match self.phase {
                0 => {
                    let prefix = self.reader.read(0, 16)?;
                    if !prefix.starts_with(b"%PDF-") {
                        return bad("PDF header missing");
                    }
                    let size = self.reader.size;
                    let mut length = size.min(65536) as usize;
                    let offset = loop {
                        let tail = self.reader.read_window(size - length as u64, length)?;
                        let eof = tail
                            .windows(5)
                            .rposition(|window| window == b"%%EOF")
                            .unwrap_or(tail.len());
                        if let Some(at) = tail[..eof]
                            .windows(9)
                            .rposition(|window| window == b"startxref")
                        {
                            use syntax::lexer::{Lexer, Token};
                            let mut lexer = Lexer::new(&tail[at + 9..]);
                            let Token::Int(offset) = lexer
                                .next_token()
                                .map_err(|_| Stop::Bad("invalid startxref integer"))?
                            else {
                                return bad("invalid startxref integer");
                            };
                            break u64::try_from(offset)
                                .map_err(|_| Stop::Bad("negative startxref offset"))?;
                        }
                        if length >= MAX_RANGE || length as u64 == size {
                            return bad("PDF startxref missing in bounded tail; range mode refuses full-file recovery");
                        }
                        length = (length * 4).min(MAX_RANGE).min(size as usize);
                    };
                    self.xrefs.push(offset);
                    self.phase = 1;
                }
                1 => {
                    if let Some(offset) = self.xrefs.last().copied() {
                        if self.seen_xrefs.contains(&offset) || self.seen_xrefs.len() >= 64 {
                            return bad("xref chain cycle or section limit");
                        }
                        let (mut entries, dict) = self.reader.section(offset)?;
                        if dict.contains_key(b"Encrypt") {
                            return bad("encrypted PDF cannot be profiled");
                        }
                        let hybrid = if let Some(hybrid) = dict.get(b"XRefStm") {
                            let hybrid = integer(hybrid)?;
                            if hybrid == offset || self.seen_xrefs.contains(&hybrid) {
                                return bad("hybrid xref cycle");
                            }
                            let (extra, extra_dict) = self.reader.section(hybrid)?;
                            if extra_dict.contains_key(b"Encrypt")
                                || extra_dict.get(b"Prev") != dict.get(b"Prev")
                            {
                                return bad("inconsistent hybrid xref revision");
                            }
                            entries.extend(extra);
                            Some(hybrid)
                        } else {
                            None
                        };
                        for entry in entries.values() {
                            match entry {
                                XrefEntry::InUse { offset, .. } if *offset >= self.reader.size => {
                                    return bad("xref object outside source")
                                }
                                XrefEntry::Compressed { stream, index }
                                    if *stream > MAX_ENTRIES as u32 || *index > 10000 =>
                                {
                                    return bad("compressed object index exceeds limits")
                                }
                                _ => {}
                            }
                        }
                        if self.reader.index.len() + entries.len() > MAX_ENTRIES * 2 {
                            return bad("xref entry count limit");
                        }
                        for (num, entry) in entries {
                            self.reader.index.entry(num).or_insert(entry);
                        }
                        if self.reader.index.len() > MAX_ENTRIES {
                            return bad("xref entry count limit");
                        }
                        if self.root.is_none() {
                            self.root = dict.get_ref(b"Root");
                        }
                        self.xrefs.pop();
                        self.seen_xrefs.insert(offset);
                        if let Some(hybrid) = hybrid {
                            self.seen_xrefs.insert(hybrid);
                        }
                        if let Some(prev) = dict.get(b"Prev") {
                            self.xrefs.push(integer(prev)?);
                        }
                    } else {
                        let root = self.root.ok_or(Stop::Bad("PDF catalog root missing"))?;
                        self.reader.offsets = self.reader.index.values().filter_map(|entry| match entry {
                            XrefEntry::InUse { offset, .. } => Some(*offset), _ => None,
                        }).chain(self.seen_xrefs.iter().copied()).chain(std::iter::once(self.reader.size)).collect();
                        self.reader.offsets.sort_unstable();
                        self.reader.offsets.dedup();
                        let header = self.reader.object(root, 0)?;
                        let pages = header
                            .value
                            .as_dict()
                            .filter(|dict| dict.is_type(b"Catalog"))
                            .and_then(|dict| dict.get_ref(b"Pages"))
                            .ok_or(Stop::Bad("catalog page tree missing"))?;
                        self.walk.push(pages);
                        self.phase = 2;
                    }
                }
                2 => {
                    if let Some(id) = self.walk.last().copied() {
                        if self.seen_nodes.contains(&id) || self.seen_nodes.len() >= MAX_ENTRIES {
                            return bad("page tree cycle or node limit");
                        }
                        let header = self.reader.object(id, 0)?;
                        let dict = header
                            .value
                            .as_dict()
                            .ok_or(Stop::Bad("page tree dictionary missing"))?;
                        if dict.is_type(b"Page") {
                            let (_, stored) = self.reader.contents(dict)?;
                            self.walk.pop();
                            self.pages.push(id);
                            self.stored.push(stored);
                            if self.pages.len() > MAX_PAGES {
                                return bad("PDF page count exceeds inventory limit");
                            }
                        } else if dict.is_type(b"Pages") {
                            let kids = dict
                                .get_array(b"Kids")
                                .ok_or(Stop::Bad("page tree Kids missing"))?;
                            if kids.len() + self.walk.len() > MAX_ENTRIES {
                                return bad("page tree fanout limit");
                            }
                            let kids = kids.iter().map(reference).collect::<R<Vec<_>>>()?;
                            self.walk.pop();
                            self.walk.extend(kids.into_iter().rev());
                        } else {
                            return bad("unexpected page tree node type");
                        }
                        self.seen_nodes.insert(id);
                    } else {
                        if self.pages.is_empty() {
                            return bad("PDF has no pages");
                        }
                        let cap = self.options.max_deep_pages.min(self.pages.len());
                        let baseline = if cap == self.pages.len() {
                            cap
                        } else {
                            cap * 3 / 4
                        };
                        let mut seed = 0x9e3779b9u64;
                        for index in 0..baseline {
                            let start = index * self.pages.len() / baseline;
                            let end = (index + 1) * self.pages.len() / baseline;
                            seed ^= seed << 13;
                            seed ^= seed >> 7;
                            seed ^= seed << 17;
                            self.selected
                                .insert(start + (seed % (end - start) as u64) as usize);
                        }
                        let remaining = cap - self.selected.len();
                        let mut heap = BinaryHeap::new();
                        if remaining > 0 {
                            for (index, bytes) in self.stored.iter().enumerate() {
                                if !self.selected.contains(&index) {
                                    heap.push(std::cmp::Reverse((*bytes, index)));
                                    if heap.len() > remaining {
                                        heap.pop();
                                    }
                                }
                            }
                            self.selected
                                .extend(heap.into_iter().map(|entry| entry.0 .1));
                        }
                        self.chunk = self.pages.len().div_ceil(100).clamp(1, 10);
                        self.phase = 3;
                        self.reader.clear_payloads();
                        self.reader.pin_payloads = true;
                        let header = detail::header(
                            self.reader.size,
                            self.pages.len(),
                            self.selected.len(),
                            self.chunk,
                            &self.options,
                        );
                        let mut header: Value = serde_json::from_str(header.trim_end())
                            .map_err(|_| Stop::Bad("internal header serialization"))?;
                        header["input"] = json!({"mode":"ranges","maxRangeBytes":MAX_RANGE,"cacheBytes":CACHE_BYTES,"maxReadBytes":MAX_READ,"maxFileBytes":2u64*1024*1024*1024,"parser":"otf-pdf-syntax@0.2.0"});
                        header["limits"]["fileBytes"] = json!(2u64 * 1024 * 1024 * 1024);
                        return Ok(json!({"kind":"output","jsonl":format!("{header}\n")}));
                    }
                }
                3 => {
                    if self.cursor == self.pages.len() {
                        self.phase = 4;
                        continue;
                    }
                    let index = self.cursor;
                    let id = self.pages[index];
                    let deep = self.selected.contains(&index);
                    let (document, lengths, stored, refused) = match self.reader.document(id, deep)
                    {
                        Ok((document, lengths, stored)) => (document, lengths, stored, false),
                        Err(Stop::Bad(_)) if deep => {
                            self.reader.clear_payloads();
                            let (document, lengths, stored) = self.reader.document(id, false)?;
                            (document, lengths, stored, true)
                        }
                        Err(error) => return Err(error),
                    };
                    let visible = visible_box(&document, (id.num, id.generation));
                    let rotate = page_rotate(&document, (id.num, id.generation));
                    let display = visible.map(|b| {
                        layout::DisplaySpace::new(
                            page_box(&document, (id.num, id.generation), b"MediaBox").unwrap_or(b),
                            b,
                            rotate,
                        )
                        .visible
                    });
                    let width = display.map(|b| ((b[2] - b[0]) * 10.0).round() as u64);
                    let height = display.map(|b| ((b[3] - b[1]) * 10.0).round() as u64);
                    let row = if refused {
                        let mut row = Evidence::inventory(Some(stored));
                        row.status = 3;
                        self.attempted += 1;
                        row
                    } else if deep {
                        let (row, decoded, operations) = Session::measure(
                            document,
                            (id.num, id.generation),
                            &self.options,
                            self.decoded,
                            self.operations,
                            lengths,
                        );
                        self.decoded = decoded;
                        self.operations = operations;
                        self.attempted += usize::from(row.status != 4);
                        row
                    } else {
                        Evidence::inventory(Some(stored))
                    };
                    self.measured += usize::from(row.status == 1);
                    self.partial += usize::from(row.status == 2);
                    let features = row.features(index + 1);
                    self.rankings
                        .add(index + 1, &row, self.options.ranked_pages);
                    self.batch_inventory.push(json!([
                        index + 1,
                        width,
                        height,
                        stored,
                        row.status,
                        rotate
                    ]));
                    self.batch_deep += usize::from(deep);
                    if let Value::Object(groups) = features {
                        for (name, values) in groups {
                            self.batch_features
                                .entry(name)
                                .or_insert_with(|| json!([]))
                                .as_array_mut()
                                .unwrap()
                                .extend(values.as_array().unwrap().iter().cloned());
                        }
                    }
                    self.total.add(&row);
                    self.summary.add(&row);
                    self.cursor += 1;
                    self.reader.clear_payloads();
                    if self.cursor % self.chunk == 0 || self.cursor == self.pages.len() {
                        self.batch_summaries.push(
                            self.summary
                                .record("summary", self.cursor + 1 - self.summary.pages),
                        );
                        self.summary = Summary::default();
                    }
                    if self.batch_inventory.len() >= self.options.batch_pages
                        || self.batch_deep >= 8
                        || self.cursor == self.pages.len()
                    {
                        let mut output = format!(
                            "{}\n",
                            json!({"t":"pages","first":self.batch_first,"inventory":std::mem::take(&mut self.batch_inventory),"features":std::mem::take(&mut self.batch_features)})
                        );
                        for summary in self.batch_summaries.drain(..) {
                            output.push_str(&format!("{summary}\n"));
                        }
                        self.batch_first = self.cursor + 1;
                        self.batch_deep = 0;
                        return Ok(json!({"kind":"output","jsonl":output}));
                    }
                }
                4 => {
                    self.phase = 5;
                    let ranks = if self.options.ranked_pages > 0 {
                        format!("{}\n", self.rankings.record())
                    } else {
                        String::new()
                    };
                    return Ok(
                        json!({"kind":"output","jsonl":format!("{ranks}{}\n",json!({"t":"end","complete":true,"inventoryPages":self.pages.len(),"deepSelected":self.selected.len(),"deepAttempted":self.attempted,"deepMeasured":self.measured,"deepPartial":self.partial,"deepComplete":self.measured==self.selected.len(),"decodedBytes":self.decoded,"operations":self.operations,"readBytes":self.reader.read_bytes,"parseBytes":self.reader.parse_bytes,"peakRangeCacheBytes":self.reader.peak_cache,"totals":self.total.record("totals",1)}))}),
                    );
                }
                _ => return Ok(json!({"kind":"done"})),
            }
        }
    }
}
