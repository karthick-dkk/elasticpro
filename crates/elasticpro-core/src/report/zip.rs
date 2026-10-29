//! A ZIP archive, written here: the .xlsx and the CSV bundle are both one.
//!
//! The same small subset `ui/js/lib/xlsx.js` writes — local headers, a central directory,
//! the end record — with one difference: entries are deflated, since the core has flate2
//! anyway and a year of daily rows compresses tenfold. No ZIP64 (a report is kilobytes to a
//! few megabytes), no encryption, no extra fields. Times are fixed at 1980-01-01, the
//! format's epoch, so the same data gives the same bytes.

use std::io::Write as _;

/// One entry before it is written.
pub struct Entry {
    pub name: String,
    pub data: Vec<u8>,
}

impl Entry {
    pub fn new(name: impl Into<String>, data: impl Into<Vec<u8>>) -> Entry {
        Entry { name: name.into(), data: data.into() }
    }
}

const DOS_DATE_1980_01_01: u16 = 0x21;

fn deflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

/// The archive's bytes. An entry that would not get smaller is stored instead.
pub fn write(entries: &[Entry]) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    if entries.len() > u16::MAX as usize {
        return Err("too many entries for a ZIP without ZIP64".into());
    }
    for e in entries {
        let name = e.name.as_bytes();
        let mut crc = flate2::Crc::new();
        crc.update(&e.data);
        let sum = crc.sum();
        let packed = deflate(&e.data)?;
        let (method, body): (u16, &[u8]) = if packed.len() < e.data.len() { (8, &packed) } else { (0, &e.data) };
        let fits = |n: usize| u32::try_from(n).map_err(|_| format!("{}: too large for a ZIP without ZIP64", e.name));
        let (csize, size, offset) = (fits(body.len())?, fits(e.data.len())?, fits(out.len())?);
        // Bit 11: the name is UTF-8 (a cluster name need not be ASCII).
        let flags: u16 = 1 << 11;

        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&DOS_DATE_1980_01_01.to_le_bytes());
        out.extend_from_slice(&sum.to_le_bytes());
        out.extend_from_slice(&csize.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(name);
        out.extend_from_slice(body);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        central.extend_from_slice(&20u16.to_le_bytes()); // needed
        central.extend_from_slice(&flags.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&DOS_DATE_1980_01_01.to_le_bytes());
        central.extend_from_slice(&sum.to_le_bytes());
        central.extend_from_slice(&csize.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        central.extend_from_slice(&0u32.to_le_bytes()); // external attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let cd_offset = u32::try_from(out.len()).map_err(|_| "archive too large for a ZIP without ZIP64".to_string())?;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk
    out.extend_from_slice(&0u16.to_le_bytes()); // disk with the directory
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment
    Ok(out)
}

/// Read an archive back through its central directory, checking every CRC and size. The
/// proof that what was written opens is a reader that trusts nothing but the directory;
/// public (hidden) so the integration tests can open what `REPORT_DOWNLOAD` hands back.
#[doc(hidden)]
pub fn read(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    use std::io::Read as _;
    let u16_at = |i: usize| -> Result<u16, String> {
        bytes.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]])).ok_or_else(|| format!("short read at {i}"))
    };
    let u32_at = |i: usize| -> Result<u32, String> {
        bytes.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok_or_else(|| format!("short read at {i}"))
    };
    let eocd = (0..bytes.len().saturating_sub(21)).rev().find(|&i| u32_at(i).ok() == Some(0x0605_4b50)).ok_or("no end record")?;
    let count = u16_at(eocd + 10)? as usize;
    let mut at = u32_at(eocd + 16)? as usize;
    let mut out = vec![];
    for _ in 0..count {
        if u32_at(at)? != 0x0201_4b50 {
            return Err(format!("no central header at {at}"));
        }
        let method = u16_at(at + 10)?;
        let crc = u32_at(at + 16)?;
        let csize = u32_at(at + 20)? as usize;
        let size = u32_at(at + 24)? as usize;
        let nlen = u16_at(at + 28)? as usize;
        let (xlen, clen) = (u16_at(at + 30)? as usize, u16_at(at + 32)? as usize);
        let local = u32_at(at + 42)? as usize;
        let name = bytes.get(at + 46..at + 46 + nlen).ok_or("name past the end")?;
        let name = String::from_utf8(name.to_vec()).map_err(|e| e.to_string())?;
        if u32_at(local)? != 0x0403_4b50 {
            return Err(format!("{name}: no local header"));
        }
        let start = local + 30 + u16_at(local + 26)? as usize + u16_at(local + 28)? as usize;
        let raw = bytes.get(start..start + csize).ok_or("entry past the end")?;
        let data = match method {
            0 => raw.to_vec(),
            8 => {
                let mut v = vec![];
                flate2::read::DeflateDecoder::new(raw).read_to_end(&mut v).map_err(|e| e.to_string())?;
                v
            }
            m => return Err(format!("{name}: method {m}")),
        };
        let mut c = flate2::Crc::new();
        c.update(&data);
        if c.sum() != crc || data.len() != size {
            return Err(format!("{name}: CRC or size mismatch"));
        }
        out.push((name, data));
        at += 46 + nlen + xlen + clen;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_written_reads_back_through_the_central_directory() {
        let big = "row,of,text\n".repeat(500);
        let entries = || vec![Entry::new("a.txt", "hello"), Entry::new("dir/b.csv", big.clone()), Entry::new("é.txt", vec![])];
        let z = write(&entries()).unwrap();
        let back = read(&z).unwrap();
        assert_eq!(back.len(), 3);
        assert_eq!(back[0], ("a.txt".to_string(), b"hello".to_vec()));
        assert_eq!(back[1].1, big.as_bytes());
        assert_eq!(back[2].0, "é.txt", "UTF-8 names");
        assert!(z.len() < big.len() / 4, "the repetitive entry was deflated: {} bytes", z.len());
        assert_eq!(z, write(&entries()).unwrap(), "the same input, the same bytes");
    }

    #[test]
    fn a_corrupted_archive_is_noticed() {
        let mut z = write(&[Entry::new("a.txt", "hello")]).unwrap();
        z[30 + 5 + 1] ^= 0xff; // inside the stored data of the first entry
        assert!(read(&z).is_err());
    }
}
