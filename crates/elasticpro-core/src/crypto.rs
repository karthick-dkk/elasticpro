//! Secrets at rest in the config file.
//!
//! A hash (SHA-512 or any other) cannot be used to log in — Elasticsearch needs the
//! actual password on every request — so "hashed in the file" is not an option. What
//! can be done is real encryption with a key nobody stores: the key is derived from a
//! master password with PBKDF2-HMAC-SHA512 (600 000 rounds, random salt) and the
//! password is sealed with AES-256-GCM (random nonce, authenticated). The file then
//! holds `enc:v1:pbkdf2-sha512:<rounds>:<salt>:<nonce>:<ciphertext>` and nothing that
//! helps without the master password. A wrong master password fails authentication
//! cleanly instead of yielding garbage.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use base64::Engine;
use rand::RngCore;
use sha2::Sha512;

pub const PREFIX: &str = "enc:v1:pbkdf2-sha512:";
const ROUNDS: u32 = 600_000;

pub fn is_sealed(v: &str) -> bool {
    v.starts_with("enc:v1:")
}

fn derive(master: &str, salt: &[u8], rounds: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha512>(master.as_bytes(), salt, rounds, &mut key);
    key
}

pub fn seal(plain: &str, master: &str) -> Result<String, String> {
    if master.is_empty() {
        return Err("master password must not be empty".into());
    }
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let key = derive(master, &salt, ROUNDS);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!("{PREFIX}{ROUNDS}:{}:{}:{}", B64.encode(salt), B64.encode(nonce), B64.encode(ct)))
}

#[derive(Debug, PartialEq)]
pub enum OpenError {
    NotSealed,
    Malformed,
    WrongMaster,
}

pub fn open(value: &str, master: &str) -> Result<String, OpenError> {
    let rest = value.strip_prefix(PREFIX).ok_or(OpenError::NotSealed)?;
    let parts: Vec<&str> = rest.split(':').collect();
    if parts.len() != 4 {
        return Err(OpenError::Malformed);
    }
    let rounds: u32 = parts[0].parse().map_err(|_| OpenError::Malformed)?;
    let salt = B64.decode(parts[1]).map_err(|_| OpenError::Malformed)?;
    let nonce = B64.decode(parts[2]).map_err(|_| OpenError::Malformed)?;
    let ct = B64.decode(parts[3]).map_err(|_| OpenError::Malformed)?;
    if nonce.len() != 12 || !(1000..=10_000_000).contains(&rounds) {
        return Err(OpenError::Malformed);
    }
    let key = derive(master, &salt, rounds);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| OpenError::Malformed)?;
    let pt = cipher.decrypt(Nonce::from_slice(&nonce), ct.as_ref()).map_err(|_| OpenError::WrongMaster)?;
    String::from_utf8(pt).map_err(|_| OpenError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_wrong_master() {
        let s = seal("p@ss wörd", "master-1").unwrap();
        assert!(is_sealed(&s));
        assert_eq!(open(&s, "master-1").unwrap(), "p@ss wörd");
        assert_eq!(open(&s, "master-2"), Err(OpenError::WrongMaster));
        assert_eq!(open("plain", "x"), Err(OpenError::NotSealed));
        assert_eq!(open("enc:v1:pbkdf2-sha512:bad", "x"), Err(OpenError::Malformed));
        // two seals of the same value differ (random salt + nonce)
        assert_ne!(s, seal("p@ss wörd", "master-1").unwrap());
    }
}
