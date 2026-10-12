use serde::Serialize;

// ── NotesToGO · Tauri 2 commands ───────────────────────────────────────
//
// Phase-2（详见 docs/FORESIGHT_OKR_REDESIGN.md §4.2 路线图）实装：
//   - `system_audio_status` / `system_audio_start` / `system_audio_stop`
//     macOS 上借 ScreenCaptureKit 拿系统音频 loopback（会议播放声）。
//
// 现状：MVP 占位实现。完整的 screencapturekit 集成（SCStream 配置 +
// CMSampleBuffer → PCM 推回前端 / 落盘）需要引入 `screencapturekit` crate，
// 在 PR 中单独 ship。当前返回的 `supported: false` 是诚实的；前端据此
// 走 mic-only + banner，**绝不**在 UI 假装「系统声音已开」。
//
// 接入计划（后续 PR）：
//   1. Cargo.toml: screencapturekit = "<latest>"   (macos-only, target_os = "macos")
//   2. NSWindow / CGWindowID 通过 tauri::WebviewWindow 取到主窗 handle
//   3. SCStream 流：SCContentFilter + SCStreamConfiguration(capturesAudio = true)
//   4. CMSampleBuffer → f32 PCM → tauri::Emitter 把 chunks 推给前端
//   5. 前端 audio/engine.ts 收到事件后用 AudioContext.decodeAudioData 拼到
//      MediaRecorder stream，详见 src/lib/tauriSystemAudio.ts 顶注。
//
// 权限：macOS 屏幕录制需用户手动在「系统设置 → 隐私与安全性 → 屏幕录制」
// 允许 NotesToGO；第一次 SCStream.start() 会触发 TCC 弹窗（也可能直接
// 拒，需要手动授权）。代码侧如未获批 → permission_granted = false。

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct SystemAudioStatus {
  pub supported: bool,
  /// TCC 屏录权限是否已获批（macOS；其它平台恒为 true）
  pub permission_granted: bool,
  /// 失败/不支持的原因；前端直接展示给用户
  pub note: String,
}

#[tauri::command]
fn system_audio_status() -> SystemAudioStatus {
  // TODO(system-audio): 当 screencapturekit crate 接入后，把 `supported`
  // 翻成 `cfg!(target_os = "macos")` 的真值，并在 SCShareableContent /
  // CGRequestScreenCaptureAccess 失败时返回 supported=false + 真实原因。
  SystemAudioStatus {
    supported: false,
    permission_granted: true, // 浏览器/未实现路径下"无需权限"——前端不会开新窗口
    note: concat!(
      "Tauri 端 system-audio 暂未实装（screencapturekit 集成见 TODO）。",
      "当前构建仅可录制麦克风；",
      "系统声音需 macOS 原生壳 + 在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 NotesToGO。",
    )
    .to_string(),
  }
}

#[tauri::command]
fn system_audio_start() -> serde_json::Value {
  // TODO(system-audio): 启动 SCStream；把 started 翻 true；失败 reason 填具体错。
  serde_json::json!({
    "started": false,
    "reason": "not_implemented",
  })
}

#[tauri::command]
fn system_audio_stop() -> serde_json::Value {
  // TODO(system-audio): 停止 SCStream + 清理 CMSampleBuffer 队列
  serde_json::json!({ "stopped": true })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      system_audio_status,
      system_audio_start,
      system_audio_stop,
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
