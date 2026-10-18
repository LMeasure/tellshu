## 一、当前阶段目标


Phase 1 已完成：

音视频输入

↓

ASR接口层

↓

Transcript模型

↓

字幕展示与导出


当前进入：

真实 ASR 服务接入阶段。


目标：

让现有：

src/services/asr/

能够连接真实语音识别服务。


完成：

真实音频/视频文件

↓

ASR Provider

↓

Transcript

↓

字幕展示



---

# 二、严格范围控制


本阶段只允许：


实现：

- ASR Provider
- Provider Adapter
- 真实转录任务
- Provider响应转换
- 端到端验证



禁止：


不要实现：

- AI学习稿
- 双语解释
- 思维导图
- XMind
- 学习卡片
- AI测试
- 掌握度模型


不要修改：

- Reader逻辑
- OCR逻辑
- 词典逻辑
- 现有知识库逻辑



---

# 三、开发前必须执行


开始编码前：

重新读取：

1. 产品前提卡

2. AI学习工作台产品设计约束

3. Phase1实施方案

4. Phase1交付说明


重新确认：

当前架构：


UI

↓

domain/transcript

↓

services/asr

↓

server/api/asr

↓

Provider




输出：

《ASR Provider实施方案》


包含：


1. Provider选择理由

2. 接入流程

3. 文件修改列表

4. 风险分析

5. 测试方案


未经方案确认：

禁止编码。



---

# 四、Provider架构要求


必须采用 Adapter 模式。


禁止：

业务代码直接调用第三方SDK。



结构：


server/src/asr/

├── provider.ts

├── types.ts

├── adapter.ts

├── providers/

│
├── aliyun.ts

├── tencent.ts

└── openai.ts



具体目录根据现有代码调整。


要求：

上层只依赖：

AsrProvider接口。



例如：


```ts
interface AsrProvider {


submit(
 file:Buffer,
 metadata:MediaInfo
):Promise<Job>


query(
 jobId:string
):Promise<Transcript>


}
五、Provider选择原则

必须比较：

至少：

OpenAI Whisper API
阿里云录音文件识别
腾讯云ASR

比较：

中文识别
英文识别
时间轴能力
长音频支持
成本
网络稳定性
接入复杂度

不要凭感觉选择。

输出选择依据。

六、配置要求

禁止：

前端保存：

API Key
Secret
Token

所有密钥：

只能：

server/.env

例如：

ASR_PROVIDER=

ASR_API_KEY=

ASR_SECRET=


必须加入：

.env.example

七、错误处理

必须覆盖：

Provider不可用：

503

认证失败：

401

文件错误：

400

超过限制：

413

Provider超时：

504

禁止：

吞掉错误。

错误必须转换为统一格式。

八、任务状态

保持已有状态：

queued

running

done

failed

expired

禁止新增无必要状态。

状态变化：

submit:

queued

provider开始：

running

完成：

done

失败：

failed

九、Transcript转换

第三方返回结果：

必须转换：

统一：

Transcript

禁止：

Provider格式进入domain。

例如：

Provider:

segments
words
items

转换：

Transcript

segments[
 start

 end

 text
]

十、测试要求

必须新增：

单元测试

测试：

Provider响应转换

异常转换

状态变化

失败恢复

集成测试

真实Provider：

至少一次：

真实音频

↓

真实转录

↓

生成SRT

记录：

文件大小
时长
识别时间
字符数量
错误情况
十一、成本控制

禁止：

无限调用真实API。

测试：

使用：

短音频

小文件

记录：

预计单次成本。

十二、验证要求

完成后执行：

前端：

npm run typecheck

npm test

npm run build

python scripts/check_pwa.py

服务端：

npm run typecheck

npm test

npm run build

额外：

真实音频验证。

十三、交付报告

完成后输出：

《Phase1.5-ASR Provider交付说明》

包含：

选择的Provider

为什么选择

修改文件列表

新增文件列表

接口变化

真实测试结果

成本估算

已知风险

下一阶段建议