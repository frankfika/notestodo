// ── 内置转录：whisper.cpp（Metal），音频不出本机 ─────────────────────────
//
// 前端把录音解码成 16kHz 单声道 i16 PCM，走 Tauri raw IPC（请求体就是字节，免 JSON 膨胀），
// 模型路径 / 语言放在请求头里。加载好的模型缓存复用，换模型才重新加载。

use serde::Serialize;
use std::sync::Mutex;
use tauri::AppHandle;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::models::model_path;

static CTX: Mutex<Option<(String, WhisperContext)>> = Mutex::new(None);

#[derive(Serialize)]
pub struct Segment {
  start_ms: i64,
  end_ms: i64,
  speaker_label: String,
  text: String,
}

fn header<'a>(req: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
  req
    .headers()
    .get(name)
    .and_then(|v| v.to_str().ok())
    .ok_or_else(|| format!("缺少请求头 {name}"))
}

#[tauri::command]
pub async fn builtin_asr_transcribe(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Vec<Segment>, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("音频需以原始字节发送".into());
  };
  let path = model_path(&app, header(&request, "x-model-file")?)?;
  if !path.exists() {
    return Err("内置模型未下载：转录模型文件不存在".into());
  }
  let lang = header(&request, "x-language").unwrap_or("zh").to_string();
  // i16 LE → f32 [-1, 1]
  let pcm: Vec<f32> = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();

  tauri::async_runtime::spawn_blocking(move || transcribe(&path.to_string_lossy(), &lang, &pcm))
    .await
    .map_err(|e| e.to_string())?
}

fn transcribe(path: &str, lang: &str, pcm: &[f32]) -> Result<Vec<Segment>, String> {
  let mut guard = CTX.lock().map_err(|e| e.to_string())?;
  if guard.as_ref().map(|(p, _)| p.as_str()) != Some(path) {
    *guard = None; // 先释放旧模型的显存
    let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
      .map_err(|e| format!("加载转录模型失败：{e}"))?;
    *guard = Some((path.to_string(), ctx));
  }
  let (_, ctx) = guard.as_ref().expect("just loaded");
  let mut state = ctx.create_state().map_err(|e| e.to_string())?;

  let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
  params.set_language(Some(lang));
  params.set_n_threads(std::thread::available_parallelism().map(|n| n.get().min(8) as i32).unwrap_or(4));
  params.set_print_special(false);
  params.set_print_progress(false);
  params.set_print_realtime(false);
  params.set_print_timestamps(false);
  // Whisper 对 zh 常输出繁体；用简体提示把输出拉回简体
  if lang == "zh" {
    params.set_initial_prompt("以下是普通话会议录音的转写，使用简体中文，带标点。");
  }

  state.full(params, pcm).map_err(|e| format!("转录失败：{e}"))?;

  Ok(state
    .as_iter()
    .filter_map(|seg| {
      let text = seg.to_str_lossy().ok()?.trim().to_string();
      if text.is_empty() {
        return None;
      }
      // whisper 时间戳单位是厘秒
      Some(Segment {
        start_ms: seg.start_timestamp() * 10,
        end_ms: seg.end_timestamp() * 10,
        speaker_label: "说话人 1".into(),
        text,
      })
    })
    .collect())
}
