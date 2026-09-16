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

- **审核计划**：绑定标准版本、范围、审核员和起止日期；样本批次从台账批次中选取，可追溯。
- **不符合项**：登记条款、严重度（高/中/低）、证据、责任人和整改期限，批次须属于计划样本。
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

所有写接口支持 `Idempotency-Key` 请求头：相同键的重复请求只执行一次并回放原响应；并发提交、复核、关闭由状态机保证只有一次成功，失败不留半项或占用。
