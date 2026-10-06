//! ElasticPro desktop core.
//!
//! Everything the browser extension delegated to its service worker lives here, plus
//! what a browser could never do: open its own SSH connection to a jump host, decide
//! for itself which certificates to trust, and keep a credential in the OS vault.
//!
//! The UI talks to this crate through one JSON message API (`bridge::Core::handle`),
//! identical in shape to the extension's `chrome.runtime.sendMessage` protocol, so the
//! pages did not have to change.

pub mod auth;
pub mod bridge;
pub mod crypto;
pub mod delay_sink;
pub mod fleet;
pub mod guard;
pub mod hcvault;
pub mod http;
pub mod notify;
pub mod socks;
pub mod ssh;
pub mod tls;
pub mod vault_files;
pub mod zabbix_api;
pub mod zbx_link;
pub mod zbx_sso;
#[cfg(feature = "vault")]
pub mod vault;

pub use bridge::Core;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
