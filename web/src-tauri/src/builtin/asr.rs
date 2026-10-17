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

/// 退出前释放（否则 ggml Metal 在进程退出析构时断言崩溃）
pub fn unload() {
  if let Ok(mut g) = CTX.lock() {
    *g = None;
  }
}

#[derive(Serialize)]
pub struct Segment {
  pub start_ms: i64,
  pub end_ms: i64,
  pub speaker_label: String,
  pub text: String,
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
  // 热词（人名 / 术语）：前端 encodeURIComponent 后以换行分隔，放进请求头
  let hotwords: Vec<String> = header(&request, "x-hotwords")
    .map(percent_decode)
    .unwrap_or_default()
    .lines()
    .map(|w| w.trim().to_string())
    .filter(|w| !w.is_empty())
    .collect();
  // i16 LE → f32 [-1, 1]
  let pcm: Vec<f32> = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();

  tauri::async_runtime::spawn_blocking(move || transcribe(&path.to_string_lossy(), &lang, &pcm, &hotwords))
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn transcribe(path: &str, lang: &str, pcm: &[f32], hotwords: &[String]) -> Result<Vec<Segment>, String> {
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
  // 初始提示：zh 拉回简体；热词让人名 / 术语按正确写法出现（「李四」而不是「理事」）
  let prompt = initial_prompt(lang, hotwords);
  if !prompt.is_empty() {
    params.set_initial_prompt(&prompt);
  }

  state.full(params, pcm).map_err(|e| format!("转录失败：{e}"))?;

  Ok(state
    .as_iter()
    .filter_map(|seg| {
      let raw = seg.to_str_lossy().ok()?;
      let text = if lang == "zh" { zh_punct(raw.trim()) } else { raw.trim().to_string() };
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

/// 初始提示 = 语言提示 + 热词。whisper 的 prompt 上限约 224 token，热词按字数截断。
pub(crate) fn initial_prompt(lang: &str, hotwords: &[String]) -> String {
  let mut p = if lang == "zh" { "以下是普通话会议录音的转写，使用简体中文，带标点。".to_string() } else { String::new() };
  let mut words = String::new();
  for w in hotwords {
    if words.chars().count() + w.chars().count() > 120 {
      break;
    }
    if !words.is_empty() {
      words.push('、');
    }
    words.push_str(w);
  }
  if !words.is_empty() {
    p.push_str(if lang == "zh" { "可能出现的人名和术语：" } else { "Names and terms: " });
    p.push_str(&words);
    p.push_str(if lang == "zh" { "。" } else { "." });
  }
  p
}

fn is_cjk(c: char) -> bool {
  matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{3000}'..='\u{303F}' | '\u{FF00}'..='\u{FFEF}')
}

/// 中文语境下把半角标点换成全角（紧邻中文才换，英文 / 数字里的「3,000」「v1.2」不动）
pub(crate) fn zh_punct(s: &str) -> String {
  let cs: Vec<char> = s.chars().collect();
  cs.iter()
    .enumerate()
    .map(|(i, &c)| {
      let full = match c { ',' => '，', '?' => '？', '!' => '！', ':' => '：', ';' => '；', _ => return c };
      let prev_cjk = i > 0 && is_cjk(cs[i - 1]);
      let next_cjk = cs.get(i + 1).is_some_and(|&n| is_cjk(n));
      if prev_cjk || next_cjk { full } else { c }
    })
    .collect()
}

fn percent_decode(s: &str) -> String {
  let b = s.as_bytes();
  let mut out = Vec::with_capacity(b.len());
  let mut i = 0;
  while i < b.len() {
    if b[i] == b'%' && i + 2 < b.len() {
      if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
        out.push(v);
        i += 3;
        continue;
      }
    }
    out.push(b[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn zh_punct_only_near_chinese() {
    assert_eq!(zh_punct("好,我们开始。预算3,000元?"), "好，我们开始。预算3,000元？");
    assert_eq!(zh_punct("version v1.2, ok"), "version v1.2, ok");
  }

  #[test]
  fn prompt_includes_hotwords_within_budget() {
    let p = initial_prompt("zh", &["李四".into(), "PoC".into(), "方案B".into()]);
    assert!(p.ends_with("可能出现的人名和术语：李四、PoC、方案B。"), "{p}");
    let many: Vec<String> = (0..200).map(|i| format!("术语{i}")).collect();
    assert!(initial_prompt("zh", &many).chars().count() < 200);
  }

  #[test]
  fn decodes_percent_encoded_header() {
    assert_eq!(percent_decode("%E6%9D%8E%E5%9B%9B%0APoC"), "李四\nPoC");
  }
}
