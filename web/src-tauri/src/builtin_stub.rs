//! 非 macOS 平台的内置模型桩。
//!
//! `src/builtin/` 依赖 whisper-rs / llama-cpp-2 / sherpa-onnx（Cargo.toml 里是
//! `cfg(target_os = "macos")` 专属依赖），Windows / Linux 上编译不出来。这里保留
//! **完全一致的命令签名与返回类型**，运行时报「仅支持 macOS 桌面版」，让桌面壳在
//! 其它平台照常可用（云端 API / 自建本地服务不受影响）。lib.rs 用 `#[path]`
//! 按平台切换实现，命令注册代码不需要任何条件编译。

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const UNSUPPORTED: &str = "本机内置模型仅支持 macOS 桌面版；请改用云端 API 或自建本地服务";

pub mod models {
  use super::*;
  use std::collections::HashMap;
  use std::sync::atomic::AtomicBool;
  use std::sync::{Arc, Mutex};

  /// 进行中的下载：id → 取消标记（与 macOS 版同名同形，供 State 注册）
  #[derive(Default)]
  pub struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

  #[derive(Deserialize)]
  pub struct CatalogEntry {
    id: String,
    file: String,
  }

  #[derive(Deserialize, Clone)]
  pub struct Source {
    url: String,
    family: String,
  }

  #[derive(Serialize)]
  pub struct ModelRow {
    id: String,
    state: &'static str,
    received: u64,
  }

  #[tauri::command]
  pub fn builtin_models_list(_app: AppHandle, catalog: Vec<CatalogEntry>) -> Result<Vec<ModelRow>, String> {
    Ok(catalog.into_iter().map(|c| ModelRow { id: c.id, state: "absent", received: 0 }).collect())
  }

  #[tauri::command]
  pub fn builtin_model_download(
    _app: AppHandle,
    _downloads: tauri::State<'_, Downloads>,
    _id: String,
    _sources: Vec<Source>,
    _file: String,
    _bytes: u64,
  ) -> Result<(), String> {
    Err(UNSUPPORTED.into())
  }

  #[tauri::command]
  pub fn builtin_model_cancel(_downloads: tauri::State<'_, Downloads>, _id: String) -> Result<(), String> {
    Ok(())
  }

  #[tauri::command]
  pub fn builtin_model_delete(_app: AppHandle, _file: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
  }
}

pub mod asr {
  use super::*;

  #[derive(Serialize)]
  pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_label: String,
    pub text: String,
  }

  #[tauri::command]
  pub async fn builtin_asr_transcribe(
    _app: AppHandle,
    _request: tauri::ipc::Request<'_>,
  ) -> Result<Vec<Segment>, String> {
    Err(UNSUPPORTED.into())
  }
}

pub mod llm {
  use super::*;

  #[derive(Deserialize, Clone)]
  pub struct Msg {
    role: String,
    content: String,
  }

  #[tauri::command]
  pub async fn builtin_llm_chat(
    _app: AppHandle,
    _file: String,
    _messages: Vec<Msg>,
    _max_tokens: u32,
    _temperature: f32,
    _json: bool,
  ) -> Result<String, String> {
    Err(UNSUPPORTED.into())
  }
}

pub fn unload_all() {}
