export const ID_PREFIXES = {
  memory: "mem_",
  task: "tsk_",
  confirmation: "cnf_",
  usage: "use_",
  chat: "cht_",
  message: "msg_",
  patch: "pat_",
  activity: "act_",
  event: "evt_",
  audit: "aud_",
  provider: "prv_",
  brief: "brf_",
  recording: "rec_",
  notification: "ntf_",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
