// ── 内置模型文件管理：列出 / 下载（断点续传 + 进度事件）/ 取消 / 删除 ───────────
//
// 模型存放在 app_data_dir/models/<file>；下载中写 <file>.part，完成后原子改名。
// 多下载源依次尝试（Hugging Face / hf-mirror.com / OpenCSG，国内用户可优先国内源）；
// 只允许这几个域名（命令不能被拿来下任意文件）；只下载、不上传。
// 不同源的同名文件不一定逐字节相同（OpenCSG 可能是较早版本）→ .part 旁记下来源族，换族就从头下，绝不拼接。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

const ALLOWED_PREFIXES: &[&str] = &["https://huggingface.co/", "https://hf-mirror.com/", "https://hub.opencsg.com/"];

#[derive(Deserialize, Clone)]
pub struct Source {
  url: String,
  /// 字节一致的源属于同一族（huggingface.co 与 hf-mirror.com 同族；opencsg 单独一族）
  family: String,
}

fn allowed(url: &str) -> bool {
  // 调试构建额外放行本机地址，方便用本地假文件测下载流程；发布构建只认白名单
  ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p)) || (cfg!(debug_assertions) && url.starts_with("http://127.0.0.1:"))
}
const EVENT: &str = "builtin_model:progress";

/// 进行中的下载：id → 取消标记
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Deserialize)]
pub struct CatalogEntry {
  id: String,
  file: String,
}

#[derive(Serialize)]
pub struct ModelRow {
  id: String,
  /// ready = 文件完整；partial = 有未完成的 .part（下次下载会续传）；absent
  state: &'static str,
  received: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
  id: String,
  received: u64,
  total: u64,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  done: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<String>,
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
  std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败：{e}"))?;
  Ok(dir)
}

/// 文件名只允许纯名字（防 ../ 路径穿越）
fn safe_name(file: &str) -> Result<&str, String> {
  if file.is_empty() || file.contains('/') || file.contains('\\') || file.starts_with('.') {
    return Err(format!("非法模型文件名：{file}"));
  }
  Ok(file)
}

pub fn model_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
  Ok(models_dir(app)?.join(safe_name(file)?))
}

#[tauri::command]
pub fn builtin_models_list(app: AppHandle, catalog: Vec<CatalogEntry>) -> Result<Vec<ModelRow>, String> {
  let dir = models_dir(&app)?;
  Ok(catalog
    .into_iter()
    .map(|c| {
      let Ok(name) = safe_name(&c.file) else {
        return ModelRow { id: c.id, state: "absent", received: 0 };
      };
      let done = dir.join(name);
      let part = dir.join(format!("{name}.part"));
      if done.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        ModelRow { id: c.id, state: "ready", received: 0 }
      } else if let Ok(m) = part.metadata() {
        ModelRow { id: c.id, state: "partial", received: m.len() }
      } else {
        ModelRow { id: c.id, state: "absent", received: 0 }
      }
    })
    .collect())
}

#[tauri::command]
pub fn builtin_model_download(
  app: AppHandle,
  downloads: tauri::State<'_, Downloads>,
  id: String,
  sources: Vec<Source>,
  file: String,
  bytes: u64,
) -> Result<(), String> {
  if sources.is_empty() || !sources.iter().all(|s| allowed(&s.url)) {
    return Err("只允许从 Hugging Face / hf-mirror.com / OpenCSG 下载模型".into());
  }
  let dest = model_path(&app, &file)?;
  let cancel = Arc::new(AtomicBool::new(false));
  {
    let mut map = downloads.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&id) {
      return Ok(()); // 已在下载
    }
    map.insert(id.clone(), cancel.clone());
  }
  let app2 = app.clone();
  tauri::async_runtime::spawn(async move {
    let emit_app = app2.clone();
    let result = download_any(&move |p| emit(&emit_app, p), &id, &sources, &dest, bytes, &cancel).await;
    if let Some(d) = app2.try_state::<Downloads>() {
      if let Ok(mut map) = d.0.lock() {
        map.remove(&id);
      }
    }
    match result {
      Ok(total) => emit(&app2, Progress { id, received: total, total, done: true, error: None }),
      Err(e) => emit(&app2, Progress { id, received: 0, total: bytes, done: false, error: Some(e) }),
    }
  });
  Ok(())
}

#[tauri::command]
pub fn builtin_model_cancel(downloads: tauri::State<'_, Downloads>, id: String) -> Result<(), String> {
  if let Some(flag) = downloads.0.lock().map_err(|e| e.to_string())?.get(&id) {
    flag.store(true, Ordering::Relaxed);
  }
  Ok(())
}

#[tauri::command]
pub fn builtin_model_delete(app: AppHandle, file: String) -> Result<(), String> {
  let path = model_path(&app, &file)?;
  let name = safe_name(&file)?;
  for p in [path.clone(), path.with_file_name(format!("{name}.part")), path.with_file_name(format!("{name}.part.src"))] {
    if p.exists() {
      std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))?;
    }
  }
  Ok(())
}

/// 依次尝试各下载源；取消立即停止，其它失败换下一个源。全部失败返回最后的错误。
async fn download_any(
  emit: &(dyn Fn(Progress) + Send + Sync),
  id: &str,
  sources: &[Source],
  dest: &std::path::Path,
  expected: u64,
  cancel: &AtomicBool,
) -> Result<u64, String> {
  let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("model");
  let part = dest.with_file_name(format!("{name}.part"));
  let tag = dest.with_file_name(format!("{name}.part.src"));
  let mut last_err = String::new();
  for (i, src) in sources.iter().enumerate() {
    // .part 来自别的源族 → 不能续传，从头下
    let prev = std::fs::read_to_string(&tag).unwrap_or_default();
    if prev.trim() != src.family {
      let _ = std::fs::remove_file(&part);
    }
    let _ = std::fs::write(&tag, &src.family);
    match download(emit, id, &src.url, dest, expected, cancel).await {
      Ok(n) => {
        let _ = std::fs::remove_file(&tag);
        return Ok(n);
      }
      Err(e) if e == "cancelled" => return Err(e),
      Err(e) => {
        log::warn!("下载源 {} 失败：{e}", src.family);
        last_err = if i + 1 < sources.len() { e } else { format!("所有下载源都失败了，最后一个：{e}") };
      }
    }
  }
  Err(last_err)
}

/// 代理地址：环境变量优先，其次 macOS 系统设置里的 HTTPS 代理（打包后的 GUI 应用拿不到 shell 环境变量）。
/// 不用 reqwest 的 system-proxy 自动探测：实测会选中 SOCKS 条目导致连接超时。
fn proxy_url() -> Option<String> {
  for k in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
    if let Ok(v) = std::env::var(k) {
      if v.starts_with("http://") || v.starts_with("https://") {
        return Some(v);
      }
    }
  }
  #[cfg(target_os = "macos")]
  {
    let out = std::process::Command::new("scutil").arg("--proxy").output().ok()?;
    return parse_scutil_https_proxy(&String::from_utf8_lossy(&out.stdout));
  }
  #[allow(unreachable_code)]
  None
}

/// 解析 `scutil --proxy` 输出里的 HTTPS 代理
fn parse_scutil_https_proxy(text: &str) -> Option<String> {
  let get = |k: &str| {
    text.lines().find_map(|l| {
      let (key, val) = l.split_once(':')?;
      (key.trim() == k).then(|| val.trim().to_string())
    })
  };
  if get("HTTPSEnable").as_deref() != Some("1") {
    return None;
  }
  Some(format!("http://{}:{}", get("HTTPSProxy")?, get("HTTPSPort")?))
}

/// NO_PROXY 命中（本机地址、局域网后缀等）→ 不走代理
fn bypass_proxy(url: &str) -> bool {
  let host = url.split("://").nth(1).and_then(|r| r.split(['/', ':', '?']).next()).unwrap_or("");
  let list = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
  host == "localhost" || host.starts_with("127.") || host == "[::1]"
    || list.split(',').map(str::trim).filter(|p| !p.is_empty()).any(|p| {
      p == "*" || host == p.trim_start_matches('.') || host.ends_with(&format!(".{}", p.trim_start_matches('.')))
    })
}

/// 依次尝试的客户端：有代理先代理、再直连；没代理（或 NO_PROXY 命中）就直连
fn clients(url: &str) -> Result<Vec<(&'static str, reqwest::Client)>, String> {
  let base = || reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).no_proxy();
  let mut v = Vec::new();
  if let Some(p) = proxy_url().filter(|_| !bypass_proxy(url)) {
    let proxy = reqwest::Proxy::all(&p).map_err(|e| e.to_string())?;
    v.push(("代理", base().proxy(proxy).build().map_err(|e| e.to_string())?));
  }
  v.push(("直连", base().build().map_err(|e| e.to_string())?));
  Ok(v)
}

/// reqwest 的错误只说「error sending request」，把底层原因（证书 / 代理 / DNS / 超时）一并带上
fn error_chain(e: &dyn std::error::Error) -> String {
  let mut s = e.to_string();
  let mut cur = e.source();
  while let Some(c) = cur {
    s.push_str(" ← ");
    s.push_str(&c.to_string());
    cur = c.source();
  }
  s
}

fn emit(app: &AppHandle, p: Progress) {
  let _ = app.emit(EVENT, p);
}

async fn download(
  emit: &(dyn Fn(Progress) + Send + Sync),
  id: &str,
  url: &str,
  dest: &std::path::Path,
  expected: u64,
  cancel: &AtomicBool,
) -> Result<u64, String> {
  let part = dest.with_file_name(format!("{}.part", dest.file_name().and_then(|n| n.to_str()).unwrap_or("model")));
  let mut offset = part.metadata().map(|m| m.len()).unwrap_or(0);

  // 先走配置的 HTTP(S) 代理（国内常见 Clash 等），连不上再直连
  let mut resp = None;
  let mut errs = Vec::new();
  for (via, client) in clients(url)? {
    let mut req = client.get(url);
    if offset > 0 {
      req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    match req.send().await {
      // 代理自己报网关错误（上游连不上 / 要认证）→ 当作代理不可用，改直连
      Ok(r) if via == "代理" && matches!(r.status().as_u16(), 407 | 502 | 503 | 504) => {
        errs.push(format!("{via}：HTTP {}", r.status().as_u16()));
      }
      Ok(r) => {
        resp = Some(r);
        break;
      }
      Err(e) => errs.push(format!("{via}：{}", error_chain(&e))),
    }
  }
  let resp = resp.ok_or_else(|| format!("网络错误：{}", errs.join("；")))?;
  let status = resp.status();
  if !status.is_success() {
    return Err(format!("下载失败（HTTP {}）", status.as_u16()));
  }
  // 服务器不支持续传（返回 200 而不是 206）→ 从头写
  if offset > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
    offset = 0;
  }
  let total = resp.content_length().map(|n| n + offset).unwrap_or(expected);

  let mut f = tokio::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .append(offset > 0)
    .truncate(offset == 0)
    .open(&part)
    .await
    .map_err(|e| format!("写入失败：{e}"))?;

  let mut received = offset;
  let mut last = Instant::now();
  let mut stream = resp.bytes_stream();
  while let Some(chunk) = stream.next().await {
    if cancel.load(Ordering::Relaxed) {
      let _ = f.flush().await;
      return Err("cancelled".into()); // 保留 .part，下次续传
    }
    let chunk = chunk.map_err(|e| format!("网络中断：{e}"))?;
    f.write_all(&chunk).await.map_err(|e| format!("写入失败（磁盘满？）：{e}"))?;
    received += chunk.len() as u64;
    if last.elapsed() >= Duration::from_millis(250) {
      last = Instant::now();
      emit(Progress { id: id.into(), received, total, done: false, error: None });
    }
  }
  f.flush().await.map_err(|e| e.to_string())?;
  drop(f);
  if total > 0 && received != total {
    return Err(format!("下载不完整（{received}/{total} 字节），请重试"));
  }
  tokio::fs::rename(&part, dest).await.map_err(|e| format!("保存失败：{e}"))?;
  Ok(received)
}

/// 给真实下载测试用：只关心进度数字
#[cfg(test)]
pub(crate) async fn test_download_any(
  on: &(dyn Fn(u64, u64) + Send + Sync),
  url: &str,
  family: &str,
  dest: &std::path::Path,
  cancel: &AtomicBool,
) -> Result<u64, String> {
  let src = [Source { url: url.into(), family: family.into() }];
  download_any(&|p: Progress| on(p.received, p.total), "e2e", &src, dest, 0, cancel).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader, Write};
  use std::net::TcpListener;

  /// 极简 HTTP 文件服务：honor_range=false 时忽略 Range，总是 200 全量返回
  fn serve(body: Vec<u8>, honor_range: bool) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
      for stream in l.incoming().flatten() {
        let mut r = BufReader::new(stream.try_clone().unwrap());
        let mut start = 0usize;
        loop {
          let mut line = String::new();
          if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" { break; }
          let lower = line.to_ascii_lowercase();
          if honor_range && lower.starts_with("range: bytes=") {
            start = lower["range: bytes=".len()..].trim().trim_end_matches('-').parse().unwrap_or(0);
          }
        }
        let part = &body[start..];
        let status = if start > 0 { "206 Partial Content" } else { "200 OK" };
        let mut w = stream;
        let _ = write!(w, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", part.len());
        let _ = w.write_all(part);
      }
    });
    format!("http://127.0.0.1:{port}/m.bin")
  }

  fn body() -> Vec<u8> { (0..200_000u32).map(|i| (i % 251) as u8).collect() }

  fn run(url: &str, dest: &std::path::Path, cancel: bool) -> Result<u64, String> {
    let flag = AtomicBool::new(cancel);
    tauri::async_runtime::block_on(download(&|_| {}, "m", url, dest, 200_000, &flag))
  }

  fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("notestogo-dl-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.join("m.bin")
  }

  #[test]
  fn full_download_then_rename() {
    let dest = tmp("full");
    assert_eq!(run(&serve(body(), true), &dest, false), Ok(200_000));
    assert_eq!(std::fs::read(&dest).unwrap(), body());
    assert!(!dest.with_file_name("m.bin.part").exists());
  }

  #[test]
  fn resumes_from_part_with_range() {
    let dest = tmp("resume");
    std::fs::write(dest.with_file_name("m.bin.part"), &body()[..80_000]).unwrap();
    assert_eq!(run(&serve(body(), true), &dest, false), Ok(200_000));
    assert_eq!(std::fs::read(&dest).unwrap(), body());
  }

  #[test]
  fn restarts_when_server_ignores_range() {
    let dest = tmp("norange");
    std::fs::write(dest.with_file_name("m.bin.part"), b"garbage-from-old-run").unwrap();
    assert_eq!(run(&serve(body(), false), &dest, false), Ok(200_000));
    assert_eq!(std::fs::read(&dest).unwrap(), body());
  }

  #[test]
  fn cancel_keeps_part_and_reports_cancelled() {
    let dest = tmp("cancel");
    assert_eq!(run(&serve(body(), true), &dest, true), Err("cancelled".into()));
    assert!(!dest.exists());
  }

  fn src(url: &str, family: &str) -> Source {
    Source { url: url.into(), family: family.into() }
  }

  #[test]
  fn falls_back_to_next_source() {
    let dest = tmp("fallback");
    let dead = "http://127.0.0.1:9/m.bin".to_string(); // 端口 9 无服务
    let flag = AtomicBool::new(false);
    let r = tauri::async_runtime::block_on(download_any(&|_| {}, "m", &[src(&dead, "hf"), src(&serve(body(), true), "opencsg")], &dest, 200_000, &flag));
    assert_eq!(r, Ok(200_000));
    assert_eq!(std::fs::read(&dest).unwrap(), body());
  }

  #[test]
  fn never_splices_part_across_source_families() {
    let dest = tmp("family");
    // 上次从 hf 族下了一半（内容故意是错的），这次换 opencsg 族 → 必须从头下
    std::fs::write(dest.with_file_name("m.bin.part"), vec![0xAB; 80_000]).unwrap();
    std::fs::write(dest.with_file_name("m.bin.part.src"), "hf").unwrap();
    let flag = AtomicBool::new(false);
    let r = tauri::async_runtime::block_on(download_any(&|_| {}, "m", &[src(&serve(body(), true), "opencsg")], &dest, 200_000, &flag));
    assert_eq!(r, Ok(200_000));
    assert_eq!(std::fs::read(&dest).unwrap(), body(), "不得拼接不同源的字节");
  }

  #[test]
  fn parses_macos_system_proxy() {
    let out = "<dictionary> {\n  HTTPEnable : 1\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n}";
    assert_eq!(parse_scutil_https_proxy(out), Some("http://127.0.0.1:7897".into()));
    assert_eq!(parse_scutil_https_proxy("<dictionary> {\n  HTTPSEnable : 0\n}"), None);
  }

  #[test]
  fn no_proxy_rules() {
    assert!(bypass_proxy("http://127.0.0.1:8080/x"));
    assert!(bypass_proxy("http://localhost/x"));
    assert!(!bypass_proxy("https://hf-mirror.com/x"));
  }

  #[test]
  fn falls_back_to_direct_when_proxy_is_dead() {
    // 代理指向一个没人监听的端口：应自动改直连成功
    unsafe { std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9") };
    let dest = tmp("deadproxy");
    let r = run(&serve(body(), true), &dest, false);
    unsafe { std::env::remove_var("HTTPS_PROXY") };
    assert_eq!(r, Ok(200_000));
  }

  #[test]
  fn allowlist() {
    assert!(allowed("https://hf-mirror.com/x/y/resolve/main/a.gguf"));
    assert!(allowed("https://hub.opencsg.com/api/v1/models/x/y/resolve/a.gguf?ref=main"));
    assert!(!allowed("https://evil.example.com/a.gguf"));
    assert!(!allowed("https://huggingface.co.evil.com/a.gguf"));
  }

  #[test]
  fn rejects_path_traversal_names() {
    assert!(safe_name("../evil").is_err());
    assert!(safe_name(".hidden").is_err());
    assert!(safe_name("a/b.gguf").is_err());
    assert_eq!(safe_name("gemma-4-E4B_q4_0-it.gguf"), Ok("gemma-4-E4B_q4_0-it.gguf"));
  }
}

