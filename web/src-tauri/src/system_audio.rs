//! macOS ScreenCaptureKit system-audio capture (Phase-3 Gap 1).
//!
//! 目标：把会议的「系统声音」（Zoom/Meet 播放声）也录到本地。
//!   - TCC: CGPreflightScreenCaptureAccess / CGRequestScreenCaptureAccess
//!   - capture: `screencapturekit-sys` 0.2 直接做 ObjC FFI（避开
//!     screencapturekit 11 的 apple-cf + swift-bridge —— 后者需要完整 Xcode
//!     的 Swift 工具链，而 CommandLineTools 自带的 swiftc 缺少所需的
//!     PackageDescription init 符号 → 在本机装 Xcode 之前只能用 sys）
//!   - transport: Tauri event "system_audio:chunk" 把 f32 PCM 推给前端；
//!     前端本期只 banner（captureMode='mic+system'），不混音（混音 = 后续 PR）
//!
//! 重要：start 不返回 true 之前必须真的调用 SCStream::start_capture()。
//! 任何失败（无可用 display / TCC 拒 / start_capture 抛错）→ reason 落到
//! 前端 captureModeNote，**绝不**让 UI 假装在录系统声音。
//!
//! 非 macOS 平台：start() 返回 { started:false, reason:'platform_unsupported' }，
//! stop() / status() 都是 no-op。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// ── Session 状态 ──────────────────────────────────────────────────────

/// 当前 capture 会会。Mutex 保护跨 SCStream dispatch queue + main thread。
#[cfg(target_os = "macos")]
pub(crate) struct Session {
    /// screencapsys 的 `init` 返回 `Id<UnsafeSCStream>` —— Id 是 reference-counted
    /// 且 Send/Sync，所以可以安全放进 Mutex<T>。
    pub stream: objc_id::Id<screencapturekit_sys::stream::UnsafeSCStream>,
    /// 48kHz；保留供未来 stop_audio 后处理参考
    pub _sample_rate: u32,
    /// 2；同上
    pub _channels: u32,
}

/// 非 mac 上 Session 只是占位（不构造）；struct 字段都 cfg-out 即可。
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub(crate) struct Session {
    pub sample_rate: u32,
    pub channels: u32,
}

/// 全局 session slot。`None` = 未启动。
pub(crate) struct Sessions(pub std::sync::Mutex<Option<Session>>);

impl Default for Sessions {
    fn default() -> Self {
        Self(std::sync::Mutex::new(None))
    }
}

// ── Event payload ─────────────────────────────────────────────────────

/// Tauri event `system_audio:chunk` 携带的 payload。
///
/// 30ms 一批（@48kHz/2ch ≈ 2880 samples ≈ 11.5KB），前端本期只用来 banner；
/// 后续 PR 用 AudioContext 建 MediaStreamAudioSourceNode 拼到 MediaRecorder。
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct AudioChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u32,
    /// 自 start 起的累计样本数（per channel），前端用它对齐 mic 录音时间轴
    pub cumulative_samples: u64,
}

// ── TCC 探测（CoreImage 框架的 C 入口；非 mac 全部 cfg-out）─────────────────

#[cfg(target_os = "macos")]
#[link(name = "CoreImage", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// 探测 macOS TCC 屏录权限状态。返回 true = 已批；false = 未批 / 未询问。
#[cfg(target_os = "macos")]
pub(crate) fn tcc_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// 主动询问一次（首次启动触发 TCC 弹窗；用户拒/批都立即返回）。
#[cfg(target_os = "macos")]
pub(crate) fn tcc_request() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

// ── 命令实现（跨平台入口）─────────────────────────────────────────────

/// 开始系统音频采集。返回 JSON 字符串。
pub(crate) fn start(app: &AppHandle) -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        start_macos(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        serde_json::json!({
            "supported": false,
            "started": false,
            "reason": "platform_unsupported",
            "note": "系统音频采集仅 NotesToGO 桌面版（macOS）支持",
        })
    }
}

/// 停止系统音频采集。best-effort：session 不在也返回 ok。
pub(crate) fn stop(app: &AppHandle) -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        stop_macos(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        serde_json::json!({ "stopped": true, "note": "platform_unsupported" })
    }
}

// ── macOS 实现 ────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn start_macos(app: &AppHandle) -> serde_json::Value {
    // 1) TCC check（CGRequestScreenCaptureAccess 触发弹窗）
    let _ = tcc_request();
    if !tcc_granted() {
        return serde_json::json!({
            "supported": true,
            "started": false,
            "reason": "tcc_pending_user_approval",
            "note": "未授权屏幕录制权限；请到「系统设置 → 隐私与安全性 → 屏幕录制」中允许 NotesToGO，授权后再次录音即生效。",
        });
    }

    // 2) 真接 SCStream
    match start_stream(app) {
        Ok(note) => serde_json::json!({
            "supported": true,
            "started": true,
            "reason": null,
            "note": note,
            "sample_rate": 48_000u32,
            "channels": 2u32,
        }),
        Err(err) => serde_json::json!({
            "supported": true,
            "started": false,
            "reason": err.code,
            "note": err.note,
        }),
    }
}

#[cfg(target_os = "macos")]
fn stop_macos(app: &AppHandle) -> serde_json::Value {
    let state: tauri::State<Sessions> = app.state();
    let mut slot = state.0.lock().expect("Sessions mutex poisoned");
    match slot.take() {
        Some(session) => match session.stream.stop_capture() {
            Ok(()) => serde_json::json!({ "stopped": true }),
            Err(e) => serde_json::json!({
                "stopped": false,
                "reason": format!("stop_capture 失败：{:?}", e),
            }),
        },
        None => serde_json::json!({ "stopped": true, "note": "no active session" }),
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct StartError {
    code: &'static str,
    note: String,
}

#[cfg(target_os = "macos")]
fn start_stream(app: &AppHandle) -> Result<String, StartError> {
    use objc::msg_send;
    use objc::sel;
    // sel_impl! is the internal helper behind objc::sel!; msg_send! expands to
    // bare sel! → sel_impl!, and on Rust 2024 macro resolution needs an explicit
    // use of both. objc 0.2.x doesn't qualify with $crate::sel_impl!.
    #[allow(unused_imports)]
    use objc::sel_impl;
    use objc_id::Id;
    use screencapturekit_sys::content_filter::{UnsafeContentFilter, UnsafeInitParams};
    use screencapturekit_sys::os_types::base::BOOL;
    use screencapturekit_sys::shareable_content::UnsafeSCShareableContent;
    use screencapturekit_sys::stream::UnsafeSCStream;
    use screencapturekit_sys::stream_configuration::UnsafeStreamConfiguration;
    use screencapturekit_sys::stream_error_handler::UnsafeSCStreamError;
    use screencapturekit_sys::stream_output_handler::UnsafeSCStreamOutput;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    // shareable content
    let content = UnsafeSCShareableContent::get().map_err(|e| StartError {
        code: "sc_shareable_content_failed",
        note: format!(
            "SCShareableContent::get 失败（屏录权限被拒或 ScreenCaptureKit 不可用）：{:?}",
            e
        ),
    })?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| StartError {
            code: "no_display",
            note: "ScreenCaptureKit 找不到可用 display。".to_string(),
        })?;

    // filter: 整屏 + 排除自家进程窗口
    let filter = UnsafeContentFilter::init(UnsafeInitParams::Display(display));

    // config: 极小视频（不浪费 cycles），48kHz/2ch Float32 PCM。
    // screencapsys 的 From<UnsafeStreamConfiguration> for Id<Ref> 不设
    // sample_rate / channel_count —— 我们用 setSampleRate / setChannelCount
    // 手动补上。
    let config = UnsafeStreamConfiguration {
        width: 64,
        height: 64,
        captures_audio: BOOL::from(true),
        excludes_current_process_audio: BOOL::from(true),
        ..Default::default()
    };
    let config_ref: Id<_> = config.into();
    unsafe {
        let _: () = msg_send![config_ref, setSampleRate: 48_000u32];
        let _: () = msg_send![config_ref, setChannelCount: 2u32];
    }

    let app_for_handler = app.clone();
    let counter = Arc::new(AtomicU64::new(0));

    struct Handler {
        app: AppHandle,
        counter: Arc<AtomicU64>,
    }
    impl UnsafeSCStreamOutput for Handler {
        fn did_output_sample_buffer(
            &self,
            sample: objc_id::Id<screencapturekit_sys::cm_sample_buffer_ref::CMSampleBufferRef>,
            of_type: u8,
        ) {
            // 1 = SCStreamOutputType::Audio
            if of_type != 1 {
                return;
            }
            let samples = match extract_f32_samples(&sample) {
                Some(v) if !v.is_empty() => v,
                _ => return,
            };
            // audio_format_description_get_stream_basic_description 返回
            // Option<&'a AudioStreamBasicDescription>，借用期跟 sample —— 提取
            // 立即发生，不要走出 closure。
            let (channels, sample_rate) = sample
                .get_format_description()
                .and_then(|fd| {
                    fd.audio_format_description_get_stream_basic_description()
                        .map(|asbd| (asbd.channels_per_frame, asbd.sample_rate as u32))
                })
                .unwrap_or((2u32, 48_000u32));
            let added = (samples.len() / channels as usize) as u64;
            let cumulative = self.counter.fetch_add(added, Ordering::Relaxed);
            let payload = AudioChunk {
                samples,
                sample_rate,
                channels,
                cumulative_samples: cumulative,
            };
            if let Err(e) = self.app.emit("system_audio:chunk", payload) {
                log::warn!("emit system_audio:chunk 失败：{:?}", e);
            }
        }
    }

    struct ErrorHandler;
    impl UnsafeSCStreamError for ErrorHandler {
        fn handle_error(&self) {
            log::error!("SCStream error callback fired");
        }
    }

    let stream = UnsafeSCStream::init(filter, config_ref, ErrorHandler);
    // 通过 Deref 把 &*stream 借成 &UnsafeSCStream（add_stream_output 是 &self），
    // 然后在 borrow 块结束后把 owned stream 装进 slot。
    let stream_ref: &UnsafeSCStream = &*stream;
    stream_ref.add_stream_output(
        Handler {
            app: app_for_handler,
            counter,
        },
        1, // SCStreamOutputType::Audio
    );
    stream_ref.start_capture().map_err(|e| StartError {
        code: "sc_start_capture_failed",
        note: format!("SCStream::start_capture 失败：{:?}", e),
    })?;

    // 装入 slot
    let state: tauri::State<Sessions> = app.state();
    let mut slot = state.0.lock().expect("Sessions mutex poisoned");
    *slot = Some(Session {
        stream,
        _sample_rate: 48_000,
        _channels: 2,
    });

    Ok("系统音频采集已启动（48kHz/2ch）；Tauri event system_audio:chunk 正在推送 PCM。".to_string())
}

/// 把 CMSampleBuffer 的 audio blocks 拼成 interleaved f32 PCM Vec。
#[cfg(target_os = "macos")]
fn extract_f32_samples(
    sample: &screencapturekit_sys::cm_sample_buffer_ref::CMSampleBufferRef,
) -> Option<Vec<f32>> {
    let buffers = sample.get_av_audio_buffer_list();
    if buffers.is_empty() {
        return None;
    }
    // SCK 默认给 non-interleaved（planar）：一个 buffer 一个声道。
    // 前端按 interleaved 解码，所以多 buffer 时在这里逐帧交错；
    // 单 buffer 视为已 interleaved，原样输出。
    let planes: Vec<Vec<f32>> = buffers
        .iter()
        .filter(|b| b.data.len() % 4 == 0)
        .map(|b| {
            b.data
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect()
        })
        .collect();
    let out: Vec<f32> = if planes.len() == 1 {
        planes.into_iter().next().unwrap_or_default()
    } else {
        let frames = planes.iter().map(Vec::len).min().unwrap_or(0);
        let mut v = Vec::with_capacity(frames * planes.len());
        for i in 0..frames {
            for p in &planes {
                v.push(p[i]);
            }
        }
        v
    };
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
