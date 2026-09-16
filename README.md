# 古法纸浆发酵记录

运行：

```bash
npm start
```

访问`http://localhost:3039`。数据保存在`data/paper-pulp-fermentation.json`。

测试：

```bash
npm test
```

## 内部质量审核与整改复核

页面顶部切换到「质量审核」页签，走通 计划 → 审核 → 整改 → 复核 → 关闭 → 重开 全流程。

- **审核计划**：绑定标准版本、范围、审核员和起止日期（只接受真实日历日期，结束日期不早于开始日期）；样本批次从台账批次中选取，可追溯。
- **不符合项**：登记条款、严重度（高/中/低）、证据、责任人和整改期限（须为真实日历日期），批次须属于计划样本；只有「审核中」的计划才能登记。
- **整改**：责任人本人提交原因分析与整改证据。
- **复核**：复核人不得与责任人或原审核员相同；驳回退回待整改。
- **关闭**：高等级缺原因、证据、独立确认，或存在逾期关联项时不得关闭。
- **重开与更正**：复发可凭原因重开（上一轮整改复核归档留存）；关闭后记录只读，更正只能追加版本。

升级时保留已有台账，历史批次自动标记「待复核」，不会自动关闭任何记录。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/audits` | 审核计划列表 / 新建 |
| GET/PATCH | `/api/audits/:id` | 详情（含不符合项）/ 状态顺序推进 |
| POST | `/api/audits/:id/nonconformities` | 登记不符合项 |
| GET | `/api/nonconformities` | 列表，支持 `auditId`/`status`/`severity`/`batch` 过滤 |
| GET | `/api/nonconformities/:id` | 详情 |
| POST | `/api/nonconformities/:id/submit` | 提交整改（原因+证据，须责任人） |
| POST | `/api/nonconformities/:id/review` | 复核（复核人与责任人、原审核员互斥） |
| POST | `/api/nonconformities/:id/close` | 关闭（高等级校验四项阻断条件） |
| POST | `/api/nonconformities/:id/reopen` | 复发重开（需原因） |
| POST | `/api/nonconformities/:id/corrections` | 已关闭记录追加更正版本 |

所有写接口支持 `Idempotency-Key` 请求头：幂等键按「方法 + 路径 + 请求内容」隔离——同一操作同一请求的重复（含并发）只执行一次并回放原响应（带 `Idempotent-Replay` 头）；同键但不同接口或不同内容返回 `409 idempotency_conflict`，绝不误回放；失败请求不占用键。并发提交、复核、关闭由状态机保证只有一次成功，失败不留半项或占用。升级保留已有审核、不符合项与幂等数据，旧格式幂等记录标记为 legacy 后不再回放。

存储可靠性：首次启动的初始化与版本迁移只安全成功一次，并发首读不会出现文件重命名冲突，读取结果一致稳定；每次落库使用独立临时文件并原子重命名，任何请求失败都不会损坏、覆盖或残留半写数据。
