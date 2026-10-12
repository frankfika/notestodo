// ── NotesToGO · Tauri 2 commands ───────────────────────────────────────
//
// Phase-3（详见 docs/CODEX_TASK_PHASE3.md Gap 1）实装：
//   - system_audio_status / system_audio_start / system_audio_stop
//     macOS 上**真正**接入 ScreenCaptureKit：TCC 权限探测 + SCStream 启停 +
//     把 audio CMSampleBuffer 转 f32 PCM + 通过 Tauri event 推回前端。
//
// 实现细节都在 `system_audio` 模块（同样 cfg-gate 到 macOS）；本文件只做
// 命令注册 + state 注册 + plugin 初始化。客户端 UI（audio/engine.ts →
// probeSystemAudio + captureModeNote）按返回 JSON 自动渲染 banner，
// **永不**让 captureMode='mic+system' 在 start 实际成功之前出现。

use serde::Serialize;

mod system_audio;

// ── Status 命令 ─────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct SystemAudioStatus {
  /// 平台是否真的提供 system-audio 路径：macOS 为 true；其余平台 false
  /// （前端据此降级到 mic-only，UI 不假装）。
  pub supported: bool,
  /// TCC 屏录权限是否已获批。macOS 上是 `CGPreflight*` 的实时值；
  /// 其它平台恒为 true（前端永远不会调到这里）。
  pub permission_granted: bool,
  /// 给用户的短句：未获批时是去系统设置的提示；其余空。
  pub note: String,
}

#[tauri::command]
fn system_audio_status() -> SystemAudioStatus {
  #[cfg(target_os = "macos")]
  {
    let granted = system_audio::tcc_granted();
    let note = if granted {
      "屏录权限已获批；SCStream 已在 start/stop 时实装。".to_string()
    } else {
      "未授权屏幕录制权限；请到「系统设置 → 隐私与安全性 → 屏幕录制」中允许 NotesToGO，授权后再次录音即生效。".to_string()
    };
    SystemAudioStatus {
      supported: true,
      permission_granted: granted,
      note,
    }
  }
  #[cfg(not(target_os = "macos"))]
  {
    SystemAudioStatus {
      supported: false,
      permission_granted: true, // 非 mac 不需要，逻辑流程不会触达 start
      note: "系统音频采集仅 NotesToGO 桌面版（macOS）支持".to_string(),
    }
  }
}

#[tauri::command]
fn system_audio_start(app: tauri::AppHandle) -> serde_json::Value {
  system_audio::start(&app)
}

#[tauri::command]
fn system_audio_stop(app: tauri::AppHandle) -> serde_json::Value {
  system_audio::stop(&app)
}

// ── 屏录授权引导命令 ────────────────────────────────────────────────
//
// 让前端 PermissionGuide 一键完成：弹系统授权框 → 直达「屏幕录制」设置页 →
// 重启生效（macOS TCC 不会即时刷新已运行进程）。

/// 触发 macOS 屏录授权弹窗（首次调用会把本 App 自动加进「屏幕录制」列表）。
/// 返回调用当下的授权状态；用户在弹窗里点允许后需重启才会翻 true。
#[tauri::command]
fn system_audio_request_permission() -> bool {
  #[cfg(target_os = "macos")]
  {
    system_audio::tcc_request()
  }
  #[cfg(not(target_os = "macos"))]
  {
    true
  }
}

/// 直接打开「系统设置 → 隐私与安全性 → 屏幕录制」。
#[tauri::command]
fn open_screen_recording_settings() -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
      .spawn()
      .map(|_| ())
      .map_err(|e| e.to_string())
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("仅 macOS 需要屏幕录制授权".to_string())
  }
}

/// 重启 App（授权后让 TCC 生效）。
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
  app.restart();
}

// ── 入口 ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(system_audio::Sessions::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Phase-3: knowledge folder reindex. FS plugin gives read_text_file /
      // read_dir; dialog plugin gives an Open dialog (folder/file picker)
      // from the frontend. Both are no-op unless the desktop capability scope
      // grants them — see capabilities/default.json for "fs:scope" / "fs:default".
      app.handle().plugin(tauri_plugin_fs::init())?;
      app.handle().plugin(tauri_plugin_dialog::init())?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      system_audio_status,
      system_audio_start,
      system_audio_stop,
      system_audio_request_permission,
      open_screen_recording_settings,
      restart_app,
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
