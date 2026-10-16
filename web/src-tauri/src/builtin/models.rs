// ── 内置模型文件管理：列出 / 下载（断点续传 + 进度事件）/ 取消 / 删除 ───────────
//
// 模型存放在 app_data_dir/models/<file>；下载中写 <file>.part，完成后原子改名。
// 只允许从 https://huggingface.co/ 下载（命令不能被拿来下任意文件）；只下载、不上传。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

const ALLOWED_PREFIX: &str = "https://huggingface.co/";
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
  url: String,
  file: String,
  bytes: u64,
) -> Result<(), String> {
  // 调试构建额外放行本机地址，方便用本地假文件测下载流程；发布构建只认 huggingface.co
  let dev_local = cfg!(debug_assertions) && url.starts_with("http://127.0.0.1:");
  if !url.starts_with(ALLOWED_PREFIX) && !dev_local {
    return Err("只允许从 huggingface.co 下载模型".into());
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
    let result = download(&move |p| emit(&emit_app, p), &id, &url, &dest, bytes, &cancel).await;
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
  for p in [path.clone(), path.with_file_name(format!("{}.part", safe_name(&file)?))] {
    if p.exists() {
      std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))?;
    }
  }
  Ok(())
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

  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(20))
    .build()
    .map_err(|e| e.to_string())?;
  let mut req = client.get(url);
  if offset > 0 {
    req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
  }
  let resp = req.send().await.map_err(|e| format!("网络错误：{e}"))?;
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

  #[test]
  fn rejects_path_traversal_names() {
    assert!(safe_name("../evil").is_err());
    assert!(safe_name(".hidden").is_err());
    assert!(safe_name("a/b.gguf").is_err());
    assert_eq!(safe_name("gemma-4-E4B_q4_0-it.gguf"), Ok("gemma-4-E4B_q4_0-it.gguf"));
  }
}
