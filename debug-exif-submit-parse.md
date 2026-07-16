# Debug Session: exif-submit-parse
- **Status**: [OPEN]
- **Issue**: `exif-submit-file` 返回 500；EXIF 批量语义不对；文件名解析把 `山东省博物馆藏` 截成了 `山东省博物`
- **Debug Server**: pending
- **Log File**: .dbg/trae-debug-log-exif-submit-parse.ndjson

## Reproduction Steps
1. 打开 `photo-exif` 页面，导入多张指向同一文物的图片。
2. 点击“大模型处理”或“回写 EXIF 并提交”。
3. 观察 `exif-submit-file` 是否返回 500，及表单是否把馆藏错误解析为 `山东省博物`。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | `exif-submit-file` 的 500 来自后端 `multipart/form-data` 解析或字段类型转换失败 | High | Low | Pending |
| B | `exif-submit-file` 的 500 来自 EXIF 回写或 `submit_artifact_to_cloud()` 内部异常 | High | Med | Pending |
| C | “批量处理不正确”是前端逐张独立提交，缺少“同一文物共享基础字段”的批量应用机制 | High | Low | Pending |
| D | 名称解析把 `山东省博物馆藏` 截断为 `山东省博物`，是 `馆藏` 后缀剥离规则过度处理 | High | Low | Pending |
| E | 前端在解析结果落表单时又做了二次裁剪或 museum suggestion 覆盖，导致馆藏被截短 | Med | Med | Pending |

## Log Evidence
- `parse-name` 复现：
  - 请求：`GET /api/artifacts/parse-name?name=隋-夫妇宴享行乐图-1976 年嘉祥英山一号（徐敏行夫妇）隋墓出土-山东省博物馆藏-DSC03961.jpg`
  - 返回：`500 Internal Server Error`
  - 后端日志：`urllib.error.URLError: <urlopen error [Errno 111] Connection refused>`
  - 栈位置：`/app/app/main.py:747`，命中 `parse_artifact_compound_name()` 里的调试埋点
- `exif-submit-file` 复现：
  - 请求：`POST /api/artifacts/exif-submit-file`
  - 返回：`500 Internal Server Error`
  - 后端日志：`urllib.error.URLError: <urlopen error [Errno 111] Connection refused>`
  - 栈位置：`/app/app/main.py:1977`，命中 `submit_artifact_with_exif_file()` 入口调试埋点
- Debug Server 状态：
  - 宿主机 `http://127.0.0.1:7777/health` 返回 `200`
  - Docker Compose 显示 backend 在容器中运行
  - 结论：容器内的 `127.0.0.1:7777` 指向容器自身，无法访问宿主机调试服务
- 名称截断证据：
  - 代码位置：`parse_artifact_compound_name()`
  - 当前规则：`museum_name = segment.removesuffix("馆藏").strip() or segment`
  - 对 `山东省博物馆藏` 会得到 `山东省博物`
- 批量语义证据：
  - 前端 `handleSubmitAll()` 只是 `for ... await submitOne(item.id)`
  - 每张图都有独立 `form`
  - 当前没有“同一文物共享基础字段 / 共享描述 / 一键应用到全部”的机制

## Verification Conclusion
- Hypothesis A：Rejected
  - `exif-submit-file` 500 不是 `multipart/form-data` 解析失败；表单字段已成功进入路由函数，异常发生在入口埋点。
- Hypothesis B：Rejected（针对当前 500）
  - 当前 500 不是 EXIF 回写或 `submit_artifact_to_cloud()` 内部异常，而是埋点网络请求先抛错。
- Hypothesis C：Confirmed
  - 当前实现是多图逐张独立处理，不符合“同一文物多图共享基础信息”的业务语义。
- Hypothesis D：Confirmed
  - `馆藏` 后缀剥离规则过度，直接导致 `山东省博物馆藏 -> 山东省博物`。
- Hypothesis E：Rejected
  - 前端没有发现把 `museum_name` 再次裁剪为 `山东省博物` 的逻辑，错误来源在后端解析。

## Post-fix Verification
- `parse-name`：
  - 修复后返回 `200`
  - `museum_name` 结果为 `山东省博物馆`
- `exif-submit-file`：
  - 修复埋点后，不再在入口直接 500
  - 调试日志已收到：
    - `submit-entry`
    - `submit-after-exif`
    - `submit-error`
  - 新暴露出的真实异常：`submit_artifact_to_cloud() missing 1 required keyword-only argument: 'capture_location'`
- 二次修复后：
  - 本地接口不再因缺少 `capture_location` 抛 `TypeError`
  - 当前返回变为 `{"detail":"提交云端失败：HTTP 404"}`
  - 说明本地 `exif-submit-file` 已经走完 EXIF 回写并尝试推送云端，当前阻塞点转移到 `CLOUD_API_BASE_URL=http://123.57.34.90:8000` 对应的远端入库接口
