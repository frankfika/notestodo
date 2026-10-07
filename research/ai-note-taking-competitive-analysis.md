# AI 会议纪要 / AI 原生笔记产品竞品分析报告

> 研究方法：桌面调研（官方定价页、帮助中心、第三方评测交叉验证）。价格随时变动，以官网为准。标注「≈」表示年付折算价或不同来源略有出入。

---

## 一、单品档案

### 1. Granola（granola.ai）— 品类标杆

1. **定位**：「AI 记事本」（AI Notepad），为连轴转会议的人设计；不加入会议的隐形记录工具。
2. **关键功能**：设备音频采集（系统+麦克风）转写；**会议中随手记要点，会后 AI 把草稿「增强」成结构化笔记**（你的字黑色、AI 补充灰色，可逐条采纳/删除）；29+ 会议纪要模板；Recipes（可保存的重复提示词，如提取 feature request、生成跟进邮件）；说话人标记；跨会议 AI 聊天（带引用溯源）；会前简报（pre-meeting briefs）；共享文件夹；CRM 集成（HubSpot/Attio/Affinity）、Slack/Notion/Zapier、MCP 连接器、API。
3. **UX 范式**：日历感知自动侦测下一场会 → 一键/自动开始 → 会中只记自己关心的 → 会后即得成品笔记。**Bot-free、无录音留存**（转写后即删音频），隐私卖点强。全平台：macOS、Windows、iOS、Android、Apple Watch。
4. **定价**：Basic 免费（无限会议，仅 30 天历史，旧说法 14 天）；Business $14/用户/月（无限历史+集成）；Enterprise $35/用户/月起（SSO、HIPAA、审计）。仅月付，无年付折扣。学生/初创 12 个月免费。
5. **技术**：设备端采集 + 云端 ASR/LLM（Fable 5/Claude 可选）；音频转写后立即删除，仅存文本；SOC 2 Type II；可全员退出模型训练。

来源：[granola.ai/pricing](https://www.granola.ai/pricing)、[granola.ai](https://www.granola.ai/)、[Granola 文档-订阅](https://docs.granola.ai/help-center/managing-your-account/subscriptions-and-billing)

### 2. Otter.ai — 老牌转写+实时协作

1. **定位**：AI 会议助理/实时转写工具，OtterPilot 自动入会记录。
2. **关键功能**：实时转写（自称 99%）；OtterPilot 自动加入 Zoom/Meet/Teams 并可同时入 3 个会；AI 摘要、行动项；「Hey Otter」语音指令；自动幻灯片捕捉；AI Chat 问答；说话人识别；工作区频道协作。语言以英语为主（英法西）。
3. **UX 范式**：Bot 入会、日历驱动全自动；会中多人实时在同一个转写稿上评论/高亮（协作是其差异点）。Web + iOS/Android + Chrome 插件。
4. **定价**：Basic 免费 300 分钟/月（单会 30 分钟上限）；Pro $8.33–16.99/月（1200–1500 分钟）；Business $20–30/月（6000 分钟）；Enterprise 定制。
5. **技术**：自研 ASR（AISense 出身），全云端。

来源：[artificial-intelligence-wiki Otter 定价](https://www.artificial-intelligence-wiki.com/ai-tools/ai-productivity-tools/otter-ai-pricing-plans)、[TechRadar](https://www.techradar.com/pro/what-is-otter-ai-everything-we-know-about-journalists-favourite-ai-transcription-tool)

### 3. Notta — 日系多语言转写

1. **定位**：高精度多语言转写/会议纪要工具（日本团队，日语准确率 98%+ 为强项）。
2. **关键功能**：实时转写 + Notta Bot 入会（Zoom/Meet/Teams/Webex）；上传音视频转写（5 小时文件）；58 种语言转写/42 种翻译；AI 摘要与行动项；AI Chat；说话人识别；过滤口头禅；自定义词库；日历同步；CRM/Zapier/Slack/Notion 集成；离线录音后补传。
3. **UX 范式**：Bot/实时/上传三路采集；Web+iOS/Android+Chrome 插件全平台。
4. **定价**：免费 120 分钟/月（单条 3 分钟）；Pro $8.17/月（年付，1800 分钟）；Business $16.67/席位（无限转写）；Enterprise 定制（51 席起）。
5. **技术**：自研 ASR（日语/亚洲语言优化），云端；SOC 2 Type II、ISO 27001。

来源：[aisaastrends Notta 评测](https://aisaastrends.com/?p=321/)、[Notta App Store](https://apps.apple.com/cl/app/notta-transcribe-voice-to-text/id1480649572?l=en-GB)

### 4. Fireflies.ai — 自动化+对话智能平台

1. **定位**：AI 会议助理「Fred」，从记录走向「会后自动干活」的 agentic 平台（20M 用户、$1B 估值）。
2. **关键功能**：Bot 自动入 10+ 会议平台；转写 100+ 语言（自称 95% 准确）；摘要/行动项/自定义笔记模板；AskFred 问答；200+ 场景化 AI 应用（销售/招聘等）；对话智能（情绪、talk-time、主题追踪）；Soundbites 剪辑；40+ 原生集成（Salesforce/HubSpot/Slack/Notion…）。
3. **UX 范式**：日历连接后全自动、会后推送到下游系统；Web+移动+Chrome 扩展+API。
4. **定价**：免费（800 分钟存储/席位 + 有限 AI 积分）；Pro $10/席位/月（年付）；Business $19（视频录制+对话智能）；Enterprise $39。
5. **技术**：自有 ASR 管线 + LLM 摘要/AskFred；云端。

来源：[EdgeChat Fireflies 档案](https://www.edgechat.ai/fireflies-ai)、[WhoIsGrowing](https://whoisgrowing.com/p/firefliesai-why-it-broke-out-what)、[Fireflies 定价相关评测](https://www.guideofaitool.com/en/ai-tool/fireflies-ai)

### 5. Fathom — 免费个人版最慷慨

1. **定位**：免费 AI 记录员，个人免费无限录制，销售向 CRM 写回。
2. **关键功能**：Bot 入会（Zoom/Meet/Teams）；无限录制/转写（25–38 语言）；即时摘要；15+ 会议模板；AI 行动项与跟进邮件；Ask Fathom 问答；Clips 片段分享；Business 层加 CRM 字段同步、Deal View、AI Scorecards；Mac bot-free 采集（beta）；API+MCP。
3. **UX 范式**：日历接入全自动，会后 30 秒出摘要；Web 为主，无强移动录制。
4. **定价**：免费（无限录制转写，仅 5 个高级摘要/月）；Premium $16–20/月；Team $15–19/用户（2 人起）；Business $25–34；90 天退款保证。
5. **技术**：云端 ASR + LLM。

来源：[Dynalord Fathom 评测](https://dynalord.com/blog/fathom-review)、[fathom.video](https://fathom.video/)、[usagepricing](https://usagepricing.com/blueprint/fathom)

### 6. MeetGeek — 会议自动化+多路采集

1. **定位**：会议智能与自动化平台，强调「AI 直接干活」（Meeting Skills/Agents）。
2. **关键功能**：Bot/移动/桌面/浏览器/上传多路采集；100+ 语言自动检测；AI 纪要+30+ 模板；Meeting Skills（定时或触发式自动生成跟进、打分并推送 CRM/Slack）；每档都含公开 API 与 MCP 服务器；离线移动录制；欧盟/美国数据驻留。
3. **UX 范式**：日历接入，会后自动推送到 10,000+ 应用（Zapier/Make/n8n）；Web 为主+移动端+Chrome。
4. **定价**：Basic 免费 3 小时/月；Pro $9.99–15.99/用户；Business $17–27（无限转写）；Enterprise 定制。非营利/教育 30% off。
5. **技术**：云端 ASR + LLM；SOC 2 Type II、HIPAA、GDPR；零数据训练。

来源：[meetgeek.ai](https://meetgeek.ai/)、[MeetGeek 非营利版](https://meetgeek.ai/company-type/nonprofit)

### 7. Mem.ai — AI 原生第二大脑

1. **定位**：AI 原生个人知识库（非会议工具）：自动组织、语义搜索、对话式回忆；2025 年转向「AI 个人助理」（会跟踪任务、主动跟进）。
2. **关键功能**：Quick Capture（多渠道）；Mem Chat 跨笔记问答；语义+时间检索（Total Recall）；Voice Mode 录音转结构化笔记；自动任务/项目侦测与状态更新；Custom Routines（定时 AI 例行任务）；Gmail/Slack/Todoist 连接；Heads Up 相关笔记推荐；MCP。
3. **UX 范式**：无文件夹/标签，AI 自动聚类；Web+iOS+浏览器扩展。
4. **定价**（2025 用量制）：免费 25 条消息/25 条笔记；Plus $9；Pro $29（100 消息/100 笔记/25h Voice）；更高至 $199；团队定制。
5. **技术**：GPT 系模型 + 自有检索；云端。

来源：[HogoNext Mem 档案](https://hogonext.com/saas/ai-productivity/mem-ai-workspace)、[WikiWalls AI 笔记对比](https://wikiwalls.com/ai/best-ai-note-apps)

### 8. 通义听悟（阿里云）

1. **定位**：大模型音视频内容理解助手：「听会、懂会、记会」，国内首个公测的大模型应用之一。
2. **关键功能**：实时记录（每日 48h 免费额度）；音视频文件转写（每日 2h 免费）；说话人分离；智能纪要（章节速览/全文摘要/发言总结/思维导图/待办/关键词/口语书面化）；「小悟」跨文件问答（单条 6h、100 条）；播客 RSS 一键转写；PPT 提取+分页摘要；中英日韩粤等互译；阿里云盘打通；API/低代码/私有化。
3. **UX 范式**：网页/小程序/客户端，上传或实时两路；转写 1h 音视频 ≈5 分钟。
4. **定价**：免费版（每日 2h 文件+48h 实时，90 天试用政策）；高校公益 500 小时；个人 Pro ≈¥228/年；API：ASR 0.6 元/小时，大模型能力 0.064 元/小时/项，PPT 提取 0.64 元/小时。官方口径「无向 C 端收费计划」，B 端 API 商业化。
5. **技术**：阿里自研工业级 ASR（方言/中英混排优化）+ 通义千问大模型；云端。

来源：[阿里云-通义听悟计费](https://help.aliyun.com/practice_detail/460677)、[NavCN 通义听悟](https://www.navcn.cn/tool/2764.html)、[极客范](https://www.jikefan.com/app/tingwu/t69812299)

### 9. 讯飞听见（iFLYTEK）

1. **定位**：国内语音转写「老大哥」：录音转文字+星火大模型 AI 纪要，中文/方言准确率行业标杆。
2. **关键功能**：实时转写、机器快转（1h 音频 5 分钟出稿）、人工精转；说话人声纹识别（一次录入自动署名）；37 种方言/口音；AI 自适应纪要（可溯源跳转原文、待办提取）；章节速览/思维导图/Chat 问答；悬浮字幕翻译；多端（Web/App/PC）+ 离线录音；API/SDK/私有化。
3. **UX 范式**：App 录音 → 自动转写+纪要；听障用户公益权益。
4. **定价**：实时转写浏览前 5 分钟免费；录音转写包 ¥18/月（30h，仅 App 录音）；畅享包 ¥88/月（50h，含导入）；个人会员 ¥49/月（660 分钟快转）；企业 ¥588–1288/人/年；按量 0.33 元/分钟起；人工精转 2.17 元/分钟起。
5. **技术**：讯飞自研 ASR（普通话 98%、带口音 94.2%，专业术语场景降至 79–88%）+ 星火 LLM；声纹识别。

来源：[讯飞听见-帮助中心](https://m.iflyrec.com/help/help_IOS.html)、[NavCN 讯飞听见](https://www.navcn.cn/tool/2680.html)、[tooolx](https://www.tooolx.com/apps/iflyrec)

### 10. Notion AI（AI Meeting Notes）

1. **定位**：工作空间内置 AI 层；2025 年 5 月起 AI 捆绑进 Business 计划，AI Meeting Notes 抓系统音频无 Bot 入会。
2. **关键功能**：AI 写作/摘要/翻译；**AI Meeting Notes**（Zoom/Meet/Teams 系统音频直采，无 Bot，自动决策点/行动项时间戳，会后可入数据库）；Enterprise Search（跨 Slack/Drive/GitHub 等带引用回答）；Research Mode；数据库 AI 自动填充；Notion Agent 多步任务；模型可选 GPT-4.1/Claude。
3. **UX 范式**：笔记目的地型——会议记录自动落到项目页/数据库，天然连接任务系统；全平台+移动端 2026 起全功能。
4. **定价**：免费/Plus（$10）仅 20 次 AI 试用；Business $20–24/席位含全部 AI；Enterprise 定制。2025 年 9 月起另售单点 AI 应用（AI Meeting Notes $18、AI Search $35 等/席位/月）。
5. **技术**：多模型（GPT-5/Claude Opus/o3）+ Cerebras 实时推理；云端，不拿工作区数据训练。

来源：[The Neuron Notion AI](http://theneuron.ai/tools/notion-ai/)、[Notion AI 完全指南](https://www.artificial-intelligence-wiki.com/ai-tools/ai-productivity-tools/notion-ai)、[aiprotivity 评测](https://www.aiprotivity.com/notion-ai-review)

### 11. Apple Notes / Apple Intelligence

1. **定位**：系统级免费笔记，Apple Intelligence 加持录音转写+摘要。
2. **关键功能**：Notes 内录音并实时转写（iPhone 12+，支持简/繁中、英日韩等）；Apple Intelligence 生成转写摘要；电话/FaceTime 通话录音自动存 Notes 并摘要；语音信箱摘要；Writing Tools 整理「语音备忘录」文稿。
3. **UX 范式**：零安装零成本，系统级入口；但仅限 iPhone 15 Pro/16+，**Apple Intelligence 在中国大陆不可用**；摘要在部分支持语言上不可用。
4. **定价**：免费（设备成本）。
5. **技术**：端侧 AFM + Private Cloud Compute；转写端侧。

来源：[Apple 支持-录音摘要](https://support.apple.com/zh-cn/guide/iphone/iph59143007d/18.0/ios/18.0)、[Apple 支持-录制转写](https://support.apple.com/is-is/guide/iphone/record-and-transcribe-audio-iphbe11247b5/27/ios/27)、[Apple 支持-通话录音](https://apple.co/4wogfdK)

### 12. Google NotebookLM

1. **定位**：源 grounded 的 AI 研究助手（「AI 研究员」），非录音工具但正在吃掉笔记/学习场景。
2. **关键功能**：50–300 个来源/笔记本（PDF/Docs/Word/Sheets/URL/YouTube/音频）；1M token 上下文；带引用问答；**Audio Overviews**（双人 AI 播客，可交互插问，80+ 语言）；视频概览/思维导图/时间线/抽认卡/测验；Deep Research；PPTX 导出；移动端 App；共享与「仅聊天」模式。
3. **UX 范式**：以「来源」为中心的笔记本范式；2025–2026 加入 Deep Research、Slide Decks、Cinematic Video Overviews。
4. **定价**：免费（100 笔记本/50 来源/50 问/日/3 个音频概览）；Plus 随 Google One AI Premium $19.99/月（学生 $9.99）；企业版经 Workspace/Gemini 捆绑。
5. **技术**：Gemini 2.5 Flash（思维模型）；云端，个人数据不用于训练。

来源：[theplanettools.ai](https://theplanettools.ai/tools/notebooklm)、[NotebookLM 指南](https://tyrchen.github.io/geektime-bootcamp-ai/materials/notebooklm-guide)、[Digital Trends](https://www.digitaltrends.com/computing/what-is-notebooklm-everything-you-need-to-know-about-googles-ai-researcher/)

### 13. Voicenotes（voicenotes.com）

1. **定位**：2024–2025 最火的 AI 语音笔记（Product Hunt Bootstrapped 年度产品）：说话而非打字，个人+会议双模式。
2. **关键功能**：语音备忘/会议一键录（无 Bot）；100+ 语言转写（耳语/口音/人名识别）；自动摘要+行动项；**Ask AI** 跨全部笔记自然语言回忆；AI Creations（语音一键变博客/邮件/待办/报告）；Meeting 模式说话人识别；WhatsApp 语音转笔记；MCP（Claude/ChatGPT 直连笔记）；Zapier/Notion/Obsidian/Todoist。
3. **UX 范式**：移动/桌面/手表/Web 全端一键录音 → 自动转写归档 → 对话式检索；极简设计，自筹资金无风投。
4. **定价**：Basic 免费（100 分钟转写/周+30 天历史）；Pro $9/用户/月（无限+MCP）；Enterprise $24；Teams 一口价 $49/月（1 万分钟池，不限人数）。
5. **技术**：云端 ASR + GPT-4o/Claude Opus；SOC 2，不训练用户数据。

来源：[voicenotes.com/pricing](https://voicenotes.com/pricing)、[帮助中心](https://help.voicenotes.com/en/articles/15389129-pricing-and-billing)、[macmenubar](https://macmenubar.app/app/voicenotes)

### 14. Cleft

1. **定位**：「为 verbal thinkers / 神经多样性人群设计」的语音优先笔记本，隐私优先。
2. **关键功能**：一键语音捕获→AI Scribe 整理成结构化笔记（摘要/要点/清单）；Rolling Notes 追加录音；Markdown 编辑；自定义 AI 指令与语气；Spotlight 全局搜索；Apple Watch/小组件；Notion/Obsidian/Apple Notes/Zapier 集成；离线优先。
3. **UX 范式**：3 秒记录，端侧转写（离线可用），只把文本送云端 LLM 排版；Apple 生态（iOS/Mac/Watch/Web）。
4. **定价**：免费（5 分钟/条）；Plus $6.99/月或 $39.99/年（30 分钟/条）。
5. **技术**：**端侧 Whisper（CoreML）**，音频不出设备、1 小时后自动删除。

来源：[Cleft FAQ](https://learn.cleftnotes.com/user-guides/faq#plus-39-99/yr)、[App Store](https://apps.apple.com/cn/app/cleft-for-verbal-thinkers/id6479458038?platform=ipad)

### 15. Flylighter

1. **定位**：**网页剪藏**工具（不是语音笔记）——Thomas Frank 团队出品的高速 Notion 剪藏器，代表「AI 原生采集」的另一支（阅读型捕获）。
2. **关键功能**：Flows 一键入 Notion 数据库并自动填属性；高亮保留格式、追加高亮；Instant Capture 快捷键；网页快照；未来支持 Obsidian/Slack/自定义 HTTP 与自带 API key 的 AI 摘要。
3. **UX 范式**：浏览器扩展、以秒计的快采；免费+Pro（≈$4–8/月）。
4. **技术**：官方 Notion API；即将接入 OpenAI/Anthropic/Ollama。

来源：[flylighter.com/pricing](http://flylighter.com/pricing)、[docs.flylighter.com](http://docs.flylighter.com/)

### 16. flomo 浮墨

1. **定位**：极简卡片笔记（「像发微博一样记录」），中国「卡片盒」笔记代表，近百万用户。
2. **关键功能**：卡片速记+多级标签；**AI 语音输入**（自动转写、纠错、去口癖；PRO 10 分钟/条、500 分钟/月）；AI 洞察（主题/盲点/提问）；「找一找」自然语言搜笔记；相关笔记与随机漫步/认知地图；每日回顾；微信输入（服务号文字/语音）；**flomo Agent**（读过你全部笔记、住在微信里的对话助手，MAX）；MCP 连接；导入微信读书/得到/Kindle。
3. **UX 范式**：刻意不做 TODO/文档/思维导图（官方明示「不擅长」清单）；碎片输入+AI 连接发现。
4. **定价**：免费（基础全功能）；PRO ¥15/月或 ¥99/年；MAX ≈¥40/月档位（美区 $39.99/年）+Agent 点数包；教育优惠。
5. **技术**：云端大模型转写+分析。

来源：[flomo 会员介绍](https://help.flomoapp.com/membership/pro)、[语音输入](http://blog.flomoapp.com/ai/aivoice.html)、[App Store](https://apps.apple.com/cn/app/flomo-浮墨-卡片笔记/id1552314395)

### 17. Cubox

1. **定位**：AI 稍后读/知识管理：收藏→解读→检索（Read-it-later 路线）。
2. **关键功能**：多渠道收藏（浏览器扩展/微信转发/API）；网页快照存档；高亮标注；**AI 自动解读（摘要/要点/幻影高亮）、全库 AI 问答**；语义全文搜索；嵌套文件夹+标签；导出 Obsidian/Notion/Readwise；微信音视频转文字。
3. **UX 范式**：先存后读，AI 清未读、建连接；Web/macOS/iOS/Android/全家桶扩展。
4. **定价**：免费 200 条容量；Pro ¥98/年（约 $29/年）；Pro+AI ¥198/年（约 $49/年，1500 次 AI/月），首购价格终身锁定。
5. **技术**：云端 LLM 解读+语义索引。

来源：[NavCN Cubox](https://www.navcn.cn/tool/410.html)、[itechguides 评测](https://www.itechguides.com/products/cubox)

### 18. 墨问（mowen.cn）

1. **定位**：微信生态内的 AI 创作/笔记工具+私域变现（原「墨问便签」，2025.4 更名）；「记录即创作」。
2. **关键功能**：**AI 语音笔记**（单次 10 分钟实时转写+自动润色）；AI 听读（TTS）；富媒体编辑（图/画廊/音频/PDF/视频号，单篇 2 万字）；付费专栏/付费订阅；微信群权限管理；小红书切图；OpenAPI+MCP（可对接 Obsidian/Cursor 等）。
3. **UX 范式**：微信小程序为主、Web 为辅，内容以小程序卡片在微信内流动；近百万用户。
4. **定价**：免费 1G 存储；Pro（50G、10 分钟语音笔记、无限付费内容）。
5. **技术**：云端 ASR/LLM。

来源：[ailbw 墨问](https://ailbw.com/ai/mowen)、[hello123](https://hello123.com/link/3147)

### 19. 飞书妙记（Feishu Minutes）

1. **定位**：飞书生态的会议记录模块：转写+纪要长在协作流程里。
2. **关键功能**：飞书会议一键 AI 纪要；音视频转文字+说话人区分；智能章节/关键词/时间轴；待办提取（负责人+任务+截止时间，可区分已确认/待确认）一键转飞书任务；文档内评论@同事；上传外部音视频转写；中英日韩等 10 语种+方言。
3. **UX 范式**：开会→纪要自动进飞书文档/群卡片→任务闭环；离开飞书生态价值大减。
4. **定价**：基础版免费（每月 10 小时转写额度，单场 2 小时）；付费随飞书版本（标准版 ≈¥50/人/月）。
5. **技术**：字节自研 ASR（火山引擎系）+大模型。

来源：[AI 工具交换 5 款实测](https://www.aijiaohuan.net/gjtji/51473328.html)、[lpqz 横评](http://www.lpqz.cn/news/58566)、[aizhijian 对比](https://aizhijian.com.cn/nav/vs/feishu-minutes-vs-tencent-meeting)

### 20. 腾讯会议 AI 纪要 / AI 小助手

1. **定位**：腾讯会议内置 AI 秘书：零切换、会中可问。
2. **关键功能**：实时转写+角色分离；每 2 分钟快照；AI 纪要（决策/待办/问题三类标签）；**会中提问**（「刚才那个数字是多少」）；「本周进展」提炼；智能章节（适合 4h+ 长会）；纪要导入腾讯元宝继续问答；多语种翻译。
3. **UX 范式**：会议在哪纪要出在哪；AI 托管（元宝替你会）。
4. **定价**：免费版有限额度（每月数次–10 小时，随版本变化）；会员 ≈¥25–30/月不限次；企业版定制。
5. **技术**：腾讯天籁 inside 音频处理（3A 联合优化）+自研 ASR+混元/元宝大模型。

来源：[donews 腾讯会议 AI](https://www.donews.com/news/detail/4/6125384.html)、[什么值得买横评](https://post.smzdm.com/p/avg6wowp/)、[腾讯会议官方](https://meeting.tencent.com/news/jdcnl20250916.html)

**其他值得注意的 Granola 替代品**：Tactiq（Chrome 扩展抓 Meet/Zoom/Teams 实时字幕，无 Bot，$12–40/月）、Krisp（降噪+端侧转写，$8–16/月）、Jamie、Superpowered（50+ 语言、音频 7 天删除）、Circleback、tl;dv、Supernormal、Flownote、CraftNote。来源：[Fellow 15 个 Jamie 替代品](https://fellow.ai/blog/jamie-ai-note-taker-alternatives)、[anarlog 盘点](https://anarlog.so/blog/bot-free-ai-meeting-assistants)、[Jamie 对比](https://www.meetjamie.ai/blog/granola-vs-superpowered-vs-krisp-vs-jamie-which-bot-free-notetaker-is-best)

---

## 二、综合洞察

### A. 什么算「极致 / AI-native」的 UX 范式（本品类共识清单）

1. **隐形采集（bot-free, device audio）**：Granola 开创的「不派机器人、用设备音频」成为新 premium 标准；跟进者 Krisp/Jamie/Superpowered/Tactiq（浏览器字幕路线）、Notion AI Meeting Notes（系统音频）。会议平台自带（妙记/腾讯会议）则是「生态内隐形」。
2. **Human-in-the-loop 增强**：Granola 的「黑字是你写的、灰字是 AI 补的」是本品类被讨论最多的交互创新——不追求全量转写完美，而让人的判断引导 AI 整理；CraftNote/Flownote 等在抄。
3. **日历感知、零点击开始**：连接 Google/Outlook/飞书日历，自动侦测下一场会、一键乃至全自动开始记录。
4. **自动结构化输出**：按会议类型自动套模板（Granola 29+、Fathom 15+、MeetGeek 30+、Fireflies 自定义），产出的是「纪要」不是「转写稿」。
5. **Chat-with-notes / 跨会议 RAG**：所有头部产品都有（AskFred、Ask Fathom、Granola Chat、Notta Chat、voicenotes Ask AI、腾讯元宝）；高阶形态是**跨会议带引用的综合**（Granola 文件夹查询）和**跨文件问答**（通义听悟小悟、NotebookLM）。
6. **Recipes / Agentic 会后动作**：把「会后处理」做成可保存提示词或定时触发的工作流（Granola Recipes、Fireflies 200+ AI apps、MeetGeek Meeting Skills）；2025 年后从「总结」走向「干活」。
7. **语音优先捕获**：voicenotes/Cleft/flomo/墨问代表的另一极——不是记录会议，而是「说即记」（think out loud），AI 转写+润色+自动归档。
8. **第二大脑式语义检索+主动浮现**：Mem 的语义+时间检索、flomo 相关笔记/每日回顾、NotebookLM 来源 grounded——「让过去的记录增援未来」。
9. **MCP 化**：把笔记库挂到 Claude/ChatGPT 上（Granola、voicenotes、MeetGeek、flomo MAX、墨问、Mem），成为 AI 工作流的数据源。
10. **隐私作为卖点**：音频转写后即删（Granola）、端侧 Whisper（Cleft、Apple）、零数据训练（MeetGeek/voicenotes/通义听悟可退出）。
11. **新的消费形态**：NotebookLM 的 Audio Overview（可交互 AI 播客）把「读笔记」变成「听笔记」。
12. **企业合规回摆**：Granola Enterprise 的「Heads Up」全员告知提示——bot-free 把告知义务转嫁给个人，企业级正在补回可见性。

### B. 共性缺口与机会

1. **层级化待办 / OKR 式追踪（最大空白）**：所有产品的待办提取都是**扁平清单**（负责人+截止时间就到头了）。没有产品把「会议待办 → 项目 → 月度/季度 OKR」串成层级结构并跟踪进度闭环。最接近的是 Mem（任务侦测）和 Notion（纪要入数据库但无 OKR 语义）。**机会：会议纪要自动产出层级化行动项，向上汇总为个人/团队 OKR 视图，跨会议自动追问进展。**
2. **飞书/腾讯会议生态的跨平台聚合**：国际工具（Granola/Otter 等）完全不接腾讯会议/飞书；国内工具（妙记/腾讯会议 AI/钉钉闪记）锁死在自家生态。一个人同时在飞书、腾讯会议、Zoom、线下开会的真实场景没有产品统一承接。**机会：以「个人会议中枢」定位，device-audio 采集天然跨平台，再做飞书文档/腾讯文档/企微的双向同步。**
3. **中文 AI-native 记事本的空档**：Granola 的交互范式（隐形记录+灰字增强+Recipes）没有像样的中文版；通义听悟免费额度惊人但是「工作台」不是「记事本」，无日历驱动、无 in-meeting 伴随体验；讯飞听见 ASR 最强但产品形态传统。Apple Intelligence 大陆不可用、NotebookLM 需魔法上网，进一步留出空间。
4. **中文识别质量的特殊需求**：方言/中英混说/专有名词（OKR、ToB、人名）——讯飞与通义最强；新产品可组合调用（按场景路由 ASR）而非自研。
5. **价格带断层**：国内 C 端心智是 ¥99–198/年（flomo/Cubox），而 Granola 是 $14/月——直接照抄定价在中国走不通，需要免费额度+团队版+API 的组合 monetization。
6. **转写≠理解**：多人抢话/口音场景各家都明显掉准（实测 80% 上下），且通义听悟被实测指出会「用流畅逻辑包装错误」——**人审环节（Granola 灰字模式）反而是质量解**，这是被低估的产品决策。
7. **离线/端侧**：移动+弱网场景体验普遍不稳；Cleft 端侧方案体验好但 Apple-only。
8. **会前-会中-会后全链**：会前简报只有 Granola/部分产品做；「带着上次纪要进会」值得做成标配。
9. **WhatsApp/微信输入管道**：voicenotes 的 WhatsApp bot、flomo/墨问的微信输入证明 IM 即入口；与 IM 深度结合的会议纪要机器人（发链接即记录、会后推群）在国内尚未被好好做。
10. **数据主权**：跨境团队对境内/境外存储分离有需求（MeetGeek 已提供 EU/US residency；国内产品天然合规是优势）。

### C. 功能矩阵

| 产品 | 定位 | 采集方式 | Bot | 说话人区分 | 模板/结构化 | 待办提取 | 日历 | Zoom/Meet/Teams | 腾讯/飞书 | 中文 | 平台 | 免费档 | 付费档（≈） |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Granola** | AI 记事本标杆 | 设备音频 | 无 | ✓ | 29+ 模板+Recipes | ✓ | ✓ | 全（设备音频） | ✗ | 多语言，英优 | Mac/Win/iOS/Android/Watch | 无限会议，30 天历史 | $14/$35 每用户月 |
| **Otter.ai** | 实时转写协作 | Bot 入会 | 有 | ✓ | 摘要+幻灯片捕捉 | ✓ | ✓ | Zoom/Meet/Teams | ✗ | 英/法/西 | Web/iOS/Android | 300 分钟/月 | $8.33–16.99 / $20–30 |
| **Notta** | 多语言转写 | Bot+实时+上传 | 有 | ✓ | 自定义词库/模板 | ✓ | ✓ | +Webex | ✗ | 58 语言含中 | Web/iOS/Android/插件 | 120 分钟/月 | $8.17 / $16.67 |
| **Fireflies.ai** | 自动化+对话智能 | Bot+移动+上传 | 有 | ✓ | 模板+200+ AI apps | ✓ | ✓ | 10+ 平台 | ✗ | 100+ 语言 | Web/移动/插件/API | 800 分钟存储 | $10/$19/$39 |
| **Fathom** | 免费个人记录员 | Bot（Mac beta 无 Bot） | 有 | ✓ | 15+ 模板 | ✓ | ✓ | Zoom/Meet/Teams | ✗ | 25–38 语言 | Web/桌面 | 无限录制+5 摘要 | $16 / $15 团队 / $25 商业 |
| **MeetGeek** | 会议自动化平台 | Bot+移动+桌面+浏览器+上传 | 可选 | ✓ | 30+ 模板+Skills | ✓ | ✓ | +Webex | ✗ | 100+ 语言 | Web/移动/插件 | 3 小时/月 | $9.99 / $17 |
| **Mem.ai** | AI 第二大脑 | 手动+语音模式+IM | — | — | Smart Write/自动组织 | ✓(自动侦测) | ✓ | 集成 | ✗ | 英为主 | Web/iOS | 25 条笔记 | $9 / $29+ |
| **通义听悟** | 音视频理解工作台 | 实时+上传+RSS 播客 | — | ✓ | 章节/思维导图/待办/自定义 prompt | ✓ | ✗ | 文件导入 | ✗ | 中英混合强 | Web/小程序/客户端 | 每日 2h+48h 实时 | Pro ¥228/年；API 0.6 元/h |
| **讯飞听见** | 中文转写标杆 | App 实时+快转+人工精转 | — | 声纹识别 | AI 纪要可溯源 | ✓ | — | — | ✗ | 普通话/方言最强 | Web/App/PC | 5 分钟预览 | ¥18/49/88 月；企业 ¥588+/人年 |
| **Notion AI** | 工作空间 AI 层 | 系统音频（无 Bot） | 无 | 时间戳标记 | 入数据库+Enterprise Search | ✓ | Notion Calendar | Zoom/Meet/Teams | ✗ | 随模型 | 全平台 | 20 次试用 | Business $20–24/席位 |
| **Apple Notes+AI** | 系统级免费 | 端侧录音/通话录音 | — | ✓(通话) | 摘要 | ✗ | — | — | — | 支持但大陆不可用 | iOS/iPadOS/macOS | 全免费 | 设备成本 |
| **NotebookLM** | 来源 grounded 研究 | 来源上传(含音频) | — | — | 导图/时间线/抽认卡/播客 | ✗ | — | — | ✗ | 80+ 语言 | Web/iOS/Android | 50 来源/3 播客日 | Plus $19.99（学生 $9.99） |
| **voicenotes** | 语音优先第二大脑 | 一键语音/会议（无 Bot） | 无 | ✓(会议模式) | AI Creations 自定义 | ✓ | — | 设备音频 | ✗ | 100+ 语言 | 全端+手表+WhatsApp | 100 分钟/周 | $9 / $24；团队 $49 包月 |
| **Cleft** | 语音优先隐私笔记 | 端侧录音 | 无 | ✗ | 结构化输出/自定义指令 | 清单 | — | — | ✗ | 英为主 | iOS/Mac/Watch/Web | 5 分钟/条 | $6.99 月 / $39.99 年 |
| **Flylighter** | 网页剪藏→Notion | 浏览器扩展 | — | — | Flows+属性自动填 | — | — | — | — | 中 | Chrome/Firefox/Edge | 10 条历史 | ≈$4–8/月 |
| **flomo** | 卡片笔记(中) | 手动+微信+AI 语音 | — | — | 标签/相关笔记/Agent | — | — | — | 微信深度 | 原生 | iOS/Android/Win/Mac/Web | 基础全免费 | PRO ¥15/月 ¥99/年；MAX 更高 |
| **Cubox** | AI 稍后读(中) | 扩展/微信/API 收藏 | — | — | AI 解读/幻影高亮 | — | — | — | 微信 | 原生 | 全平台 | 200 条 | ¥98 / ¥198 每年 |
| **墨问** | 微信生态创作(中) | AI 语音笔记 10min | — | — | 富媒体/付费专栏 | — | — | — | 微信深度 | 原生 | 小程序/Web | 1G | Pro 50G |
| **飞书妙记** | 飞书会议记录 | 飞书会议+上传 | 生态内 | ✓ | 章节/时间轴/任务闭环 | ✓(负责人+截止) | 飞书日历 | ✗ | 飞书全家桶 | 中英日韩+方言 | 飞书各端 | 10 小时/月 | 随飞书版本 ≈¥50/人月 |
| **腾讯会议 AI** | 腾讯会议秘书 | 会议内置 | 生态内 | ✓ | 三类标签/章节/快照 | ✓(较粗) | — | ✗ | 腾讯文档/元宝 | 中英翻译 | 腾讯会议全端 | 有限额度 | 会员 ≈¥25–30/月 |

---

## 三、给产品决策者的三条结论

1. **抄 Granola 的「形」容易，抄「神」难**：隐形采集+日历感知已被追平；真正的壁垒是 human-in-the-loop 的灰字增强、跨会议引用级检索和 Recipes 生态——这三点构成「AI-native」的完整定义。
2. **最大差异化机会在「行动闭环」**：品类已 commoditize 的是「转写+摘要」；未被解决的是「层级化待办→OKR→自动追踪」与「飞书/腾讯会议生态的跨平台个人中枢」——两者叠加，就是中国市场的空白卡位。
3. **技术路线建议**：ASR 不要自研（中文接讯飞/通义、英文接 Whisper/AssemblyAI），差异化投在 LLM 结构化、跨会议记忆图谱、与 IM（微信/企微）的深度管道上；隐私上做「音频即焚+可选端侧」的双模。
