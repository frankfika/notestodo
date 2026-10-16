// ── 内置笔记模型：Gemma 4（llama.cpp，Metal），进程内推理 ─────────────────
//
// - 提示词用模型自带的 Jinja chat 模板渲染（minijinja），渲染失败再退回 llama.cpp 内置模板。
// - json=true 时用 JSON 语法约束采样，保证整理笔记 / 提取待办拿到合法 JSON。
// - 上下文按「提示词 + 最大输出」动态开，避免默认 2–4K 上下文把长转录静默截断。

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::Deserialize;
use std::num::NonZeroU32;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use super::models::model_path;

static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();
static MODEL: Mutex<Option<(String, LlamaModel)>> = Mutex::new(None);

const N_BATCH: usize = 512;

#[derive(Deserialize, Clone)]
pub struct Msg {
  role: String,
  content: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn builtin_llm_chat(
  app: AppHandle,
  file: String,
  messages: Vec<Msg>,
  max_tokens: u32,
  temperature: f32,
  json: bool,
) -> Result<String, String> {
  let path = model_path(&app, &file)?;
  if !path.exists() {
    return Err("内置模型未下载：笔记模型文件不存在".into());
  }
  tauri::async_runtime::spawn_blocking(move || chat(&path.to_string_lossy(), &messages, max_tokens, temperature, json))
    .await
    .map_err(|e| e.to_string())?
}

fn backend() -> Result<&'static LlamaBackend, String> {
  if let Some(b) = BACKEND.get() {
    return Ok(b);
  }
  let mut b = LlamaBackend::init().map_err(|e| format!("初始化推理后端失败：{e}"))?;
  b.void_logs();
  Ok(BACKEND.get_or_init(|| b))
}

fn chat(path: &str, messages: &[Msg], max_tokens: u32, temperature: f32, json: bool) -> Result<String, String> {
  let backend = backend()?;
  let mut guard = MODEL.lock().map_err(|e| e.to_string())?;
  if guard.as_ref().map(|(p, _)| p.as_str()) != Some(path) {
    *guard = None; // 先释放旧模型
    let params = LlamaModelParams::default().with_n_gpu_layers(999); // 全部层放 GPU（Metal）
    let model = LlamaModel::load_from_file(backend, path, &params).map_err(|e| format!("加载笔记模型失败：{e}"))?;
    *guard = Some((path.to_string(), model));
  }
  let (_, model) = guard.as_ref().expect("just loaded");

  let (prompt, has_bos) = render_prompt(model, messages)?;
  let vocab = model.vocab();
  let tokens = vocab.tokenize(prompt.as_bytes(), !has_bos, true);
  if tokens.is_empty() {
    return Err("提示词为空".into());
  }

  let n_ctx_train = model.n_ctx_train().max(4096);
  let need = tokens.len() as u32 + max_tokens + 64;
  if need > n_ctx_train {
    return Err(format!("内容太长（约 {} tokens），超过模型上下文 {n_ctx_train}", tokens.len()));
  }
  let threads = std::thread::available_parallelism().map(|n| n.get().min(8) as i32).unwrap_or(4);
  let ctx_params = LlamaContextParams::default()
    .with_n_ctx(NonZeroU32::new(need.max(2048)))
    .with_n_batch(N_BATCH as u32)
    .with_n_threads(threads)
    .with_n_threads_batch(threads);
  let mut ctx = model.new_context(backend, ctx_params).map_err(|e| format!("创建推理上下文失败：{e}"))?;

  // 预填提示词：按 N_BATCH 分块解码，只有最后一个 token 需要 logits
  let mut batch = LlamaBatch::new(N_BATCH, 1);
  let last = tokens.len() - 1;
  for (ci, chunk) in tokens.chunks(N_BATCH).enumerate() {
    batch.clear();
    for (j, &t) in chunk.iter().enumerate() {
      let pos = ci * N_BATCH + j;
      batch.add(t, pos as i32, &[0], pos == last).map_err(|e| e.to_string())?;
    }
    ctx.decode(&mut batch).map_err(|e| format!("推理失败：{e}"))?;
  }

  let mut samplers = Vec::new();
  if json {
    samplers.push(LlamaSampler::grammar(model, JSON_GBNF, "root").map_err(|e| format!("JSON 约束初始化失败：{e}"))?);
  }
  if temperature <= 0.01 {
    samplers.push(LlamaSampler::greedy());
  } else {
    samplers.push(LlamaSampler::top_k(40));
    samplers.push(LlamaSampler::top_p(0.95, 1));
    samplers.push(LlamaSampler::temp(temperature));
    samplers.push(LlamaSampler::dist(0x5EED));
  }
  let mut sampler = LlamaSampler::chain_simple(samplers);

  let mut out: Vec<u8> = Vec::new();
  let mut pos = tokens.len() as i32;
  let mut logits_idx = batch.n_tokens() - 1;
  for _ in 0..max_tokens {
    let tok = sampler.sample(&ctx, logits_idx);
    if vocab.is_eog(tok) {
      break;
    }
    out.extend(vocab.token_to_piece(tok, true, None));
    batch.clear();
    batch.add(tok, pos, &[0], true).map_err(|e| e.to_string())?;
    pos += 1;
    ctx.decode(&mut batch).map_err(|e| format!("推理失败：{e}"))?;
    logits_idx = 0;
  }
  Ok(clean_output(&String::from_utf8_lossy(&out)))
}

/// 返回（提示词, 提示词是否已含 BOS）
fn render_prompt(model: &LlamaModel, messages: &[Msg]) -> Result<(String, bool), String> {
  let tmpl = model.chat_template(None).ok();
  let vocab = model.vocab();
  let piece = |t| String::from_utf8_lossy(&vocab.token_to_piece(t, true, None)).into_owned();
  let (bos, eos) = (piece(vocab.bos()), piece(vocab.eos()));

  // 1) 模型自带 Jinja 模板（覆盖 Gemma 4 的 <|turn> 新格式；llama.cpp 内置识别只认旧的 <start_of_turn>）
  if let Some(src) = tmpl.as_ref().and_then(|t| t.to_string().ok()) {
    match render_jinja(&src, messages, &bos, &eos) {
      Ok(p) => {
        let has_bos = !bos.is_empty() && p.starts_with(&bos);
        return Ok((p, has_bos));
      }
      Err(e) => log::warn!("Jinja 模板渲染失败，退回内置模板：{e}"),
    }
  }

  // 2) 退回 llama.cpp 内置模板识别
  let chat: Vec<LlamaChatMessage> = messages
    .iter()
    .filter_map(|m| LlamaChatMessage::new(m.role.clone(), m.content.clone()).ok())
    .collect();
  if let Some(t) = tmpl {
    if let Ok(p) = model.apply_chat_template(&t, &chat, true) {
      return Ok((p, false));
    }
  }
  Err("无法套用模型的对话模板".into())
}

/// 用 minijinja 渲染 HF 风格 chat 模板（关闭思考模式）
pub fn render_jinja(src: &str, messages: &[Msg], bos: &str, eos: &str) -> Result<String, String> {
  let mut env = minijinja::Environment::new();
  minijinja_contrib::add_to_environment(&mut env);
  env.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
  env.add_function("raise_exception", |m: String| -> Result<String, minijinja::Error> {
    Err(minijinja::Error::new(minijinja::ErrorKind::InvalidOperation, m))
  });
  let msgs: Vec<_> = messages
    .iter()
    .map(|m| minijinja::context! { role => m.role.clone(), content => m.content.clone() })
    .collect();
  env
    .render_str(
      src,
      minijinja::context! {
        messages => msgs, add_generation_prompt => true, bos_token => bos, eos_token => eos,
        enable_thinking => false,
      },
    )
    .map_err(|e| format!("{e:#}"))
}

/// 去掉模型可能输出的思考通道（Gemma 4：<|channel>thought…<channel|>）和残留的特殊标记
pub fn clean_output(raw: &str) -> String {
  let mut s = raw.to_string();
  while let Some(a) = s.find("<|channel>") {
    match s[a..].find("<channel|>") {
      Some(b) => s.replace_range(a..a + b + "<channel|>".len(), ""),
      None => s.truncate(a), // 只有开头没有结尾：思考没写完，后面都不要
    }
  }
  for t in ["<turn|>", "<|turn>", "<eos>", "<bos>"] {
    s = s.replace(t, "");
  }
  s.trim().to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn m(role: &str, content: &str) -> Msg {
    Msg { role: role.into(), content: content.into() }
  }

  #[test]
  fn gemma4_template_renders_with_minijinja() {
    let src = include_str!("../../tests/fixtures/gemma4_chat_template.jinja");
    let p = render_jinja(src, &[m("system", "你是会议笔记助手。"), m("user", "整理这段转录")], "<bos>", "<eos>")
      .expect("Gemma 4 模板应能渲染");
    assert!(p.starts_with("<bos><|turn>system\n你是会议笔记助手。"), "{p}");
    assert!(p.contains("<|turn>user\n整理这段转录<turn|>"), "{p}");
    assert!(p.ends_with("<|turn>model\n"), "{p}");
    assert!(!p.contains("<|think|>"), "思考模式应关闭：{p}");
  }

  #[test]
  fn gemma4_template_multi_turn_chat() {
    let src = include_str!("../../tests/fixtures/gemma4_chat_template.jinja");
    let p = render_jinja(src, &[m("user", "问1"), m("assistant", "答1"), m("user", "问2")], "<bos>", "<eos>").unwrap();
    assert!(p.contains("<|turn>model\n答1<turn|>"), "{p}");
    assert!(p.ends_with("<|turn>user\n问2<turn|>\n<|turn>model\n"), "{p}");
  }

  #[test]
  fn clean_output_strips_thinking() {
    assert_eq!(clean_output("<|channel>thought\n先想想<channel|>{\"a\":1}"), "{\"a\":1}");
    assert_eq!(clean_output("正文<|channel>没写完的思考"), "正文");
    assert_eq!(clean_output("你好<turn|>"), "你好");
  }
}

// llama.cpp grammars/json.gbnf
const JSON_GBNF: &str = r#"
root   ::= object
value  ::= object | array | string | number | ("true" | "false" | "null") ws
object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
array  ::= "[" ws ( value ("," ws value)* )? "]" ws
string ::= "\"" ( [^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F]{4}) )* "\"" ws
number ::= ("-"? ([0-9] | [1-9] [0-9]{0,15})) ("." [0-9]+)? ([eE] [-+]? [0-9] [1-9]{0,15})? ws
ws ::= | " " | "\n" [ \t]{0,20}
"#;
