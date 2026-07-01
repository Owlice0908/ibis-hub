//! End-to-end auto-updater chain verification.
//!
//! This binary runs in CI on macOS (and other platforms) to verify that the
//! auto-updater pipeline is fully functional WITHOUT needing a GUI/WebView.
//! It performs the same fundamental steps the in-app Tauri updater would do:
//!
//! 1. Read the embedded public key from `tauri.conf.json`
//! 2. Fetch `latest.json` from `releases/latest/download/latest.json`
//! 3. Parse the JSON
//! 4. For the current platform (or a target passed via env), download the
//!    referenced bundle (`.app.tar.gz` etc.)
//! 5. Verify the bundle signature against the embedded public key using
//!    `minisign-verify` (the same crate Tauri's updater uses internally)
//!
//! Exit code 0 = updater chain works end-to-end. Non-zero = something is
//! broken (signature mismatch, missing file, parse error, etc.) and the
//! error is printed to stderr so CI logs show exactly what failed.
//!
//! Run via: `cargo run --bin verify-updater` from the `src-tauri` directory.

use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use std::env;
use std::error::Error;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

#[derive(Debug, Deserialize)]
struct LatestJson {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: String,
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[derive(Debug, Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct TauriConfig {
    plugins: TauriPlugins,
}

#[derive(Debug, Deserialize)]
struct TauriPlugins {
    updater: UpdaterPlugin,
}

#[derive(Debug, Deserialize)]
struct UpdaterPlugin {
    pubkey: String,
    endpoints: Vec<String>,
}

fn pick_platform() -> &'static str {
    // Allow override via env (useful for cross-platform testing in CI)
    if let Ok(p) = env::var("VERIFY_UPDATER_PLATFORM") {
        return Box::leak(p.into_boxed_str());
    }
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64"
        } else {
            "darwin-x86_64"
        }
    } else if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else {
        "linux-x86_64"
    }
}

fn fetch(url: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    eprintln!("  GET {}", url);
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(60))
        .call()?;
    let mut buf = Vec::new();
    resp.into_reader().read_to_end(&mut buf)?;
    Ok(buf)
}

fn run() -> Result<(), Box<dyn Error>> {
    println!("=== verify-updater ===");

    // Step 1: Locate and parse tauri.conf.json
    // Try a few candidate paths so this works whether invoked from src-tauri/
    // or the repo root.
    let candidates = [
        "tauri.conf.json",
        "src-tauri/tauri.conf.json",
        "../tauri.conf.json",
    ];
    let conf_path = candidates
        .iter()
        .find(|p| Path::new(p).exists())
        .ok_or("could not locate tauri.conf.json")?;
    println!("Reading config: {}", conf_path);
    let conf_text = fs::read_to_string(conf_path)?;
    let conf: TauriConfig = serde_json::from_str(&conf_text)?;
    let pubkey_raw = &conf.plugins.updater.pubkey;
    println!("  pubkey (raw, first 40 chars): {}...", &pubkey_raw.chars().take(40).collect::<String>());

    // Step 2: Parse the public key. Tauri pubkey may be:
    //   (a) just the inner base64 line (e.g. "RWT...")
    //   (b) the full minisign file content "untrusted comment: ...\n<key>"
    //   (c) the base64-encoded full file
    // minisign-verify's PublicKey::decode wants the inner key string directly.
    let key_str: String = if pubkey_raw.starts_with("untrusted comment:") {
        // Full file content — take the last non-empty line
        pubkey_raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .last()
            .ok_or("empty pubkey file content")?
            .trim()
            .to_string()
    } else {
        // Try to base64-decode in case it's the encoded full file
        match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, pubkey_raw) {
            Ok(bytes) if bytes.starts_with(b"untrusted comment:") => {
                let text = String::from_utf8(bytes)?;
                text.lines()
                    .filter(|l| !l.trim().is_empty())
                    .last()
                    .ok_or("empty pubkey file content")?
                    .trim()
                    .to_string()
            }
            _ => pubkey_raw.trim().to_string(),
        }
    };
    let pubkey = PublicKey::from_base64(&key_str)
        .map_err(|e| format!("failed to decode pubkey '{key_str}': {e}"))?;
    println!("  pubkey decoded successfully (inner key length: {})", key_str.len());

    // Step 3: Fetch latest.json from updater endpoint
    let endpoint = conf
        .plugins
        .updater
        .endpoints
        .first()
        .ok_or("no updater endpoints configured")?;
    println!("Fetching latest.json from: {}", endpoint);
    let latest_bytes = fetch(endpoint)?;
    let latest_text = String::from_utf8(latest_bytes)?;
    let latest: LatestJson = serde_json::from_str(&latest_text)
        .map_err(|e| format!("failed to parse latest.json: {e}\n--- raw ---\n{latest_text}"))?;
    println!(
        "  version: {}, platforms: {}",
        latest.version,
        latest.platforms.len()
    );

    // Step 4: Pick a platform entry to verify
    let plat_key = pick_platform();
    println!("Verifying platform: {}", plat_key);
    let entry = latest
        .platforms
        .get(plat_key)
        .ok_or_else(|| format!("platform {plat_key} not in latest.json"))?;

    // Step 5: Parse the signature. latest.json stores it base64-encoded
    // (the full minisign sig file with comment lines is base64-encoded for
    // safe JSON storage). Decode then parse.
    let sig_text = match base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &entry.signature,
    ) {
        Ok(bytes) => String::from_utf8(bytes)?,
        Err(_) => entry.signature.clone(),
    };
    let signature = Signature::decode(&sig_text)
        .map_err(|e| format!("invalid signature in latest.json: {e}\n--- decoded sig ---\n{sig_text}"))?;
    println!("  signature decoded ({} bytes)", sig_text.len());

    // Step 6: Download the bundle file
    println!("Downloading bundle: {}", entry.url);
    let bundle = fetch(&entry.url)?;
    println!("  downloaded {} bytes", bundle.len());

    // Step 7: Verify signature against the bundle
    pubkey
        .verify(&bundle, &signature, false)
        .map_err(|e| format!("SIGNATURE VERIFICATION FAILED for {plat_key}: {e}"))?;
    println!("  ✓ signature verified");

    println!();
    println!("✅ Updater chain end-to-end OK");
    println!("   pubkey in tauri.conf.json matches the signature in latest.json");
    println!("   which matches the actual bundle file on the release.");
    println!("   Auto-updater will work for {} clients.", plat_key);
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!();
            eprintln!("❌ verify-updater FAILED: {e}");
            let mut source = e.source();
            while let Some(s) = source {
                eprintln!("   caused by: {s}");
                source = s.source();
            }
            ExitCode::FAILURE
        }
    }
}
