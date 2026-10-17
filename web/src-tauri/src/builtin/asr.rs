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

  // 说话人区分模型（可选）：两个文件都在才启用
  let diar = match (header(&request, "x-diar-seg"), header(&request, "x-diar-emb")) {
    (Ok(seg), Ok(emb)) => {
      let (seg, emb) = (model_path(&app, seg)?, model_path(&app, emb)?);
      (seg.exists() && emb.exists()).then(|| (seg.to_string_lossy().into_owned(), emb.to_string_lossy().into_owned()))
    }
    _ => None,
  };
  tauri::async_runtime::spawn_blocking(move || transcribe(&path.to_string_lossy(), &lang, &pcm, &hotwords, diar.as_ref()))
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn transcribe(
  path: &str,
  lang: &str,
  pcm: &[f32],
  hotwords: &[String],
  diar: Option<&(String, String)>,
) -> Result<Vec<Segment>, String> {
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
  // 静音 / 噪声上少编字：压掉非语音 token
  params.set_suppress_nst(true);
  // 初始提示：zh 拉回简体；热词让人名 / 术语按正确写法出现（「李四」而不是「理事」）
  let prompt = initial_prompt(lang, hotwords);
  if !prompt.is_empty() {
    params.set_initial_prompt(&prompt);
  }

  state.full(params, pcm).map_err(|e| format!("转录失败：{e}"))?;

  let mut segs: Vec<Segment> = state
    .as_iter()
    .filter_map(|seg| {
      let raw = seg.to_str_lossy().ok()?;
      let text = if lang == "zh" { zh_punct(raw.trim()) } else { raw.trim().to_string() };
      let (t0, t1) = (seg.start_timestamp() * 10, seg.end_timestamp() * 10);
      if !keep_segment(&text, seg.no_speech_probability(), rms(pcm, t0, t1)) {
        return None;
      }
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
    .collect();
  drop(state);
  drop(guard); // 先放开 whisper，再跑说话人区分

  // 谁说的：尽力而为，失败只记日志，转录照常返回
  if let Some((seg_model, emb_model)) = diar {
    match super::diarize::diarize(seg_model, emb_model, pcm) {
      Ok(turns) if !turns.is_empty() => {
        let spans: Vec<(i64, i64)> = segs.iter().map(|s| (s.start_ms, s.end_ms)).collect();
        for (s, label) in segs.iter_mut().zip(super::diarize::assign_speakers(&spans, &turns)) {
          s.speaker_label = label;
        }
      }
      Ok(_) => {}
      Err(e) => log::warn!("说话人区分失败，按单人处理：{e}"),
    }
  }
  Ok(segs)
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
  fn drops_silence_hallucinations() {
    assert!(keep_segment("方案B基本确定了。", 0.05, 0.08));
    assert!(!keep_segment("好", 0.9, 0.08), "whisper 自己判为非语音");
    assert!(!keep_segment("滚", 0.1, 0.001), "几乎无声");
    assert!(!keep_segment("请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", 0.1, 0.05));
    assert!(!keep_segment("字幕由Amara.org社区提供", 0.2, 0.05));
  }

  #[test]
  fn rms_of_window() {
    let pcm = vec![0.5f32; 16_000]; // 1 秒、幅度 0.5
    assert!((rms(&pcm, 0, 1000) - 0.5).abs() < 1e-6);
    assert_eq!(rms(&pcm, 2000, 3000), 0.0, "越界窗口为 0");
  }

  #[test]
  fn decodes_percent_encoded_header() {
    assert_eq!(percent_decode("%E6%9D%8E%E5%9B%9B%0APoC"), "李四\nPoC");
  }
}

/// 片段对应音频的均方根能量（16kHz）
pub(crate) fn rms(pcm: &[f32], start_ms: i64, end_ms: i64) -> f32 {
  let a = ((start_ms.max(0) as usize) * 16).min(pcm.len());
  let b = ((end_ms.max(0) as usize) * 16).min(pcm.len()).max(a);
  if b == a {
    return 0.0;
  }
  (pcm[a..b].iter().map(|x| x * x).sum::<f32>() / (b - a) as f32).sqrt()
}

/// whisper 在静音 / 噪声上常见的「幻听」中文字幕套话
const HALLUCINATIONS: &[&str] = &[
  "字幕由", "Amara.org", "请不吝点赞", "订阅 转发", "打赏支持", "明镜与点点", "点点栏目",
  "谢谢观看", "感谢观看", "下集再见", "字幕志愿者", "中文字幕",
];

/// 是否保留这一段：whisper 判为非语音、音频几乎无声、或是常见幻听套话 → 丢弃。
/// 实测：外放声音被回声消除吃掉后，近乎静音的录音被转成「好」「滚」「Goo」「tanto」。
pub(crate) fn keep_segment(text: &str, no_speech_prob: f32, rms: f32) -> bool {
  if text.trim().is_empty() || no_speech_prob > 0.6 {
    return false;
  }
  // ≈ -49 dBFS：正常说话（含远处小声）都远高于这个值
  if rms < 0.0035 {
    return false;
  }
  !HALLUCINATIONS.iter().any(|h| text.contains(h))
}
