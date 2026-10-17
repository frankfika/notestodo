// ── 说话人区分（谁说的）：sherpa-onnx = pyannote 分段 + 3D-Speaker CAM++（阿里达摩院，中文训练）声纹聚类 ──
//
// 借鉴 VibeVoice-ASR「谁 / 何时 / 说了什么」的结构化转录：whisper 负责「说了什么」（支持热词、中文更准），
// 这里负责「谁」，按时间重叠把说话人贴到 whisper 的每一段上。模型合计约 30MB，缺失时转录照常（不区分说话人）。

use sherpa_onnx::{
  FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig, OfflineSpeakerSegmentationModelConfig,
  OfflineSpeakerSegmentationPyannoteModelConfig, SpeakerEmbeddingExtractorConfig,
};
use std::sync::Mutex;

static SD: Mutex<Option<(String, OfflineSpeakerDiarization)>> = Mutex::new(None);

pub fn unload() {
  if let Ok(mut g) = SD.lock() {
    *g = None;
  }
}

/// 说话人时间段（秒）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Turn {
  pub start: f32,
  pub end: f32,
  pub speaker: i32,
}

pub fn diarize(seg_model: &str, emb_model: &str, pcm: &[f32]) -> Result<Vec<Turn>, String> {
  let key = format!("{seg_model}|{emb_model}");
  let mut guard = SD.lock().map_err(|e| e.to_string())?;
  if guard.as_ref().map(|(k, _)| k.as_str()) != Some(key.as_str()) {
    *guard = None;
    let threads = std::thread::available_parallelism().map(|n| n.get().min(4) as i32).unwrap_or(2);
    let config = OfflineSpeakerDiarizationConfig {
      segmentation: OfflineSpeakerSegmentationModelConfig {
        pyannote: OfflineSpeakerSegmentationPyannoteModelConfig { model: Some(seg_model.into()), ..Default::default() },
        num_threads: threads,
        ..Default::default()
      },
      embedding: SpeakerEmbeddingExtractorConfig { model: Some(emb_model.into()), num_threads: threads, ..Default::default() },
      // 说话人数未知：按相似度阈值自动聚类
      clustering: FastClusteringConfig { num_clusters: -1, threshold: 0.5, ..Default::default() },
      min_duration_on: 0.3,
      min_duration_off: 0.5,
    };
    let sd = OfflineSpeakerDiarization::create(&config).ok_or("加载说话人区分模型失败")?;
    *guard = Some((key, sd));
  }
  let (_, sd) = guard.as_ref().expect("just loaded");
  let result = sd.process(pcm).ok_or("说话人区分失败")?;
  Ok(result
    .sort_by_start_time()
    .into_iter()
    .map(|s| Turn { start: s.start, end: s.end, speaker: s.speaker })
    .collect())
}

/// 给每段转录（毫秒）分配说话人：取时间重叠最多的那位；
/// 编号按首次出现排为 说话人 1 / 2 / …；完全没重叠的段沿用上一段的说话人。
pub fn assign_speakers(segments: &[(i64, i64)], turns: &[Turn]) -> Vec<String> {
  let mut order: Vec<i32> = Vec::new();
  let mut last: Option<i32> = None;
  segments
    .iter()
    .map(|&(s, e)| {
      let (s, e) = (s as f32 / 1000.0, e as f32 / 1000.0);
      let mut best: Option<(i32, f32)> = None;
      for t in turns {
        let overlap = (e.min(t.end) - s.max(t.start)).max(0.0);
        if overlap > 0.0 && best.is_none_or(|(_, b)| overlap > b) {
          best = Some((t.speaker, overlap));
        }
      }
      let spk = best.map(|(k, _)| k).or(last).unwrap_or(0);
      last = Some(spk);
      let idx = order.iter().position(|&x| x == spk).unwrap_or_else(|| {
        order.push(spk);
        order.len() - 1
      });
      format!("说话人 {}", idx + 1)
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn t(start: f32, end: f32, speaker: i32) -> Turn {
    Turn { start, end, speaker }
  }

  #[test]
  fn assigns_by_max_overlap_and_numbers_by_first_appearance() {
    // 聚类编号是任意的（先出现的可能是 7）：展示时按首次出现重排为 1、2
    let turns = [t(0.0, 7.5, 7), t(7.5, 15.0, 3), t(15.0, 20.0, 7)];
    let segs = [(0, 7000), (8000, 14000), (15500, 19000), (6500, 9500)];
    assert_eq!(assign_speakers(&segs, &turns), ["说话人 1", "说话人 2", "说话人 1", "说话人 2"]);
  }

  #[test]
  fn gap_inherits_previous_speaker() {
    let turns = [t(0.0, 5.0, 0)];
    assert_eq!(assign_speakers(&[(0, 4000), (30_000, 31_000)], &turns), ["说话人 1", "说话人 1"]);
    assert_eq!(assign_speakers(&[(0, 1000)], &[]), ["说话人 1"]);
  }
}
