//! Native local-file adapter. Customer files on servers still require VM isolation.
use crate::{
    error::Error,
    probe::{DetailOptions, RangeRequest, RangeSession},
};
use serde_json::json;
use std::{
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
};

/// A retained file handle with bounded positional reads and mutation checks.
/// Drop this value to cancel and release the parsed state and file immediately.
pub struct FileProfileJsonl {
    file: File,
    initial: Metadata,
    session: RangeSession,
    done: bool,
}

impl FileProfileJsonl {
    pub fn new(file: File, options: DetailOptions) -> Result<Self, Error> {
        let initial = file
            .metadata()
            .map_err(|_| Error::invalid_request("could not inspect local file"))?;
        if !initial.is_file() {
            return Err(Error::invalid_request("range input must be a regular file"));
        }
        let session = RangeSession::new(initial.len(), options, 1)?;
        Ok(Self {
            file,
            initial,
            session,
            done: false,
        })
    }
    fn verify(&self) -> Result<(), Error> {
        let current = self
            .file
            .metadata()
            .map_err(|_| Error::invalid_request("could not inspect local file"))?;
        let mut same = current.len() == self.initial.len()
            && current.modified().ok() == self.initial.modified().ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            same &= current.dev() == self.initial.dev()
                && current.ino() == self.initial.ino()
                && current.ctime() == self.initial.ctime()
                && current.ctime_nsec() == self.initial.ctime_nsec();
        }
        if !same {
            return Err(Error::invalid_request(
                "local input changed during profiling",
            ));
        }
        Ok(())
    }
    pub fn next_chunk(&mut self) -> Result<Option<String>, Error> {
        if self.done {
            return Ok(None);
        }
        loop {
            self.verify()?;
            let step = self.session.step()?;
            match step["kind"].as_str() {
                Some("read") => {
                    let request:RangeRequest=serde_json::from_value(json!({"requestId":step["requestId"],"offset":step["offset"],"length":step["length"]})).map_err(|_|Error::invalid_request("invalid range request"))?;
                    if request.length > 1024 * 1024 {
                        return Err(Error::invalid_request("range request limit exceeded"));
                    }
                    let mut bytes = vec![0; request.length];
                    self.file
                        .seek(SeekFrom::Start(request.offset))
                        .and_then(|_| self.file.read_exact(&mut bytes))
                        .map_err(|_| Error::invalid_request("local input short read"))?;
                    self.verify()?;
                    self.session.supply(request, &bytes)?;
                }
                Some("output") => {
                    return Ok(Some(
                        step["jsonl"]
                            .as_str()
                            .ok_or_else(|| Error::invalid_request("invalid JSONL frame"))?
                            .to_owned(),
                    ))
                }
                Some("done") => {
                    self.done = true;
                    return Ok(None);
                }
                _ => return Err(Error::invalid_request("invalid range step")),
            }
        }
    }
}
