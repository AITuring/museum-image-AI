# Debug Session: cloud-upload-502
- **Status**: [OPEN]
- **Issue**: `exif-submit-file` 上传到云端返回 `502 Bad Gateway`
- **Debug Server**: pending
- **Log File**: .dbg/trae-debug-log-cloud-upload-502.ndjson

## Reproduction Steps
1. 在 `photo-exif` 页面选择图片并完成 EXIF 处理。
2. 调用 `POST /api/artifacts/exif-submit-file` 提交到云端。
3. 观察后端日志中的 `cloud ingest connection failed ... retrying once`，随后接口返回 `502 Bad Gateway`。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 云端 API 基址或路径配置错误，导致后端重试后仍拿到上游非 2xx/连接失败 | High | Low | Pending |
| B | 发往云端的 multipart 字段与远端接口契约不匹配，导致远端拒绝请求 | High | Med | Pending |
| C | 云端鉴权头或 token 缺失/失效，导致上游请求失败 | Med | Low | Pending |
| D | 本地 `exif-submit-file` 已完成 EXIF 回写，但 `submit_artifact_to_cloud()` 捕获上游异常后统一转成 `502` | High | Low | Pending |

## Log Evidence
- Pending

## Verification Conclusion
- Pending

## Post-fix Verification
- Pending
