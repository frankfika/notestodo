// ── 开放 API：本机 HTTP 服务（127.0.0.1）──────────────────────────────
//
// 让 Raycast / 快捷指令 / 脚本等外部工具读写拾贝的任务和笔记。
// 数据在 webview 的 IndexedDB 里，Rust 碰不到 —— 所以 Rust 只做：
//   收 HTTP 请求 → 鉴权 → 转成 Tauri 事件发给前端（api-request）→
//   阻塞等前端回包（api_respond 命令写入 pending map）→ 写回 HTTP 响应。
// 前端路由/数据层在 web/src/api/localApi.ts。

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use tiny_http::{Header, Method, Response, Server};

const EVENT_REQUEST: &str = "api-request";
const MAX_BODY_BYTES: u64 = 1024 * 1024;
const RESPOND_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<(u16, String)>>>>;

pub struct ApiServer {
  port: u16,
  /// 停止信号：线程每收一个请求检查一次；自连一下端口把 recv 从阻塞里敲醒
  shutdown: Arc<AtomicBool>,
  pending: Pending,
  #[allow(dead_code)]
  token: String,
  next_id: Arc<AtomicU64>,
}

impl ApiServer {
  fn stop(&self) {
    self.shutdown.store(true, Ordering::SeqCst);
    // incoming_requests 阻塞中：发一个假连接让它醒过来看 shutdown 标志
    let _ = TcpStream::connect(("127.0.0.1", self.port));
  }
}

/// 由 Tauri manage 持有；None = 未启动。
pub type Shared = Arc<Mutex<Option<ApiServer>>>;

pub fn shared() -> Shared {
  Arc::new(Mutex::new(None))
}

fn cors_headers() -> Vec<Header> {
  // 本机服务，放开 CORS 让浏览器里的脚本也能调（数据只在本机）
  vec![
    Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Authorization, Content-Type"[..]).unwrap(),
    Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, PATCH, DELETE, OPTIONS"[..]).unwrap(),
  ]
}

fn json_response(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
  let mut headers = cors_headers();
  headers.push(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
  Response::new(tiny_http::StatusCode(status), headers, std::io::Cursor::new(body.as_bytes().to_vec()), Some(body.len()), None)
}

fn is_authed(request: &tiny_http::Request, token: &str) -> bool {
  request
    .headers()
    .iter()
    .find(|h| h.field.equiv("Authorization"))
    .map(|h| h.value.as_str() == format!("Bearer {token}"))
    .unwrap_or(false)
}

#[tauri::command]
pub fn api_server_start(
  app: AppHandle,
  state: State<'_, Shared>,
  port: u16,
  token: String,
) -> Result<Value, String> {
  if token.is_empty() {
    return Err("api token 不能为空".to_string());
  }
  let mut guard = state.lock().map_err(|e| e.to_string())?;
  if let Some(prev) = guard.take() {
    prev.stop();
  }
  let server = Server::http(("127.0.0.1", port)).map_err(|e| format!("端口 {port} 起不来：{e}"))?;
  let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
  let next_id = Arc::new(AtomicU64::new(1));
  let shutdown = Arc::new(AtomicBool::new(false));
  let shutdown_c = shutdown.clone();
  let pending_c = pending.clone();
  let next_id_c = next_id.clone();

  let token_c = token.clone();
  std::thread::spawn(move || {
    for mut request in server.incoming_requests() {
      if shutdown_c.load(Ordering::SeqCst) {
        break;
      }
      let url = request.url().to_string();
      // CORS 预检直接回，不鉴权
      if request.method() == &Method::Options {
        let _ = request.respond(json_response(204, ""));
        continue;
      }
      // /health 免鉴权（探活用）
      if url == "/health" {
        let _ = request.respond(json_response(200, &json!({"ok": true, "app": "shibei"}).to_string()));
        continue;
      }
      if !is_authed(&request, &token_c) {
        let _ = request.respond(json_response(401, &json!({"error": "unauthorized"}).to_string()));
        continue;
      }
      let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (url.clone(), String::new()),
      };
      let mut body = String::new();
      if request.as_reader().take(MAX_BODY_BYTES).read_to_string(&mut body).is_err() {
        let _ = request.respond(json_response(400, &json!({"error": "body 读取失败"}).to_string()));
        continue;
      }

      let req_id = next_id_c.fetch_add(1, Ordering::SeqCst);
      let (tx, rx) = mpsc::channel::<(u16, String)>();
      {
        let mut p = match pending_c.lock() {
          Ok(p) => p,
          Err(_) => {
            let _ = request.respond(json_response(500, &json!({"error": "server state poisoned"}).to_string()));
            continue;
          }
        };
        p.insert(req_id, tx);
      }
      let payload = json!({
        "req_id": req_id,
        "method": request.method().to_string(),
        "path": path,
        "query": query,
        "body": body,
      });
      if app.emit(EVENT_REQUEST, payload).is_err() {
        pending_c.lock().map(|mut p| p.remove(&req_id)).ok();
        let _ = request.respond(json_response(500, &json!({"error": "前端未就绪"}).to_string()));
        continue;
      }
      match rx.recv_timeout(RESPOND_TIMEOUT) {
        Ok((status, json_body)) => {
          let _ = request.respond(json_response(status, &json_body));
        }
        Err(_) => {
          pending_c.lock().map(|mut p| p.remove(&req_id)).ok();
          let _ = request.respond(json_response(504, &json!({"error": "前端处理超时"}).to_string()));
        }
      }
    }
  });

  *guard = Some(ApiServer {
    port,
    shutdown,
    pending,
    token,
    next_id,
  });
  Ok(json!({"ok": true, "port": port}))
}

#[tauri::command]
pub fn api_server_stop(state: State<'_, Shared>) -> Result<Value, String> {
  let mut guard = state.lock().map_err(|e| e.to_string())?;
  if let Some(prev) = guard.take() {
    prev.stop();
  }
  Ok(json!({"ok": true}))
}

/// 前端处理完 api-request 事件后，用这个命令把响应还给 HTTP 层。
#[tauri::command]
pub fn api_respond(state: State<'_, Shared>, req_id: u64, status: u16, body: String) -> Result<(), String> {
  let guard = state.lock().map_err(|e| e.to_string())?;
  if let Some(server) = guard.as_ref() {
    let sender = server.pending.lock().map_err(|e| e.to_string())?.remove(&req_id);
    if let Some(tx) = sender {
      let _ = tx.send((status, body));
    }
  }
  Ok(())
}
