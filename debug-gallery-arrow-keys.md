# Debug Session: gallery-arrow-keys [OPEN]

## Symptoms
- 画廊弹窗打开后，按左右方向键没有切换图片。
- 用户在 `Gallery.tsx` 的键盘监听里加入了 `console.log`，但没有任何打印。

## Expected
- 弹窗打开且未处于编辑输入状态时，`ArrowLeft` / `ArrowRight` 能切换当前图片。

## Reproduction
1. 打开画廊列表。
2. 打开一个包含多张图片的文物详情弹窗。
3. 按键盘左右方向键。

## Hypotheses
1. 弹窗打开时，`Gallery.tsx` 里的 `useEffect` 没有实际注册键盘监听。
2. 键盘事件被更上层元素、iframe 或其他监听吞掉，导致 `window`/`document` 都收不到。
3. 事件收到了，但 `event.target` 被识别成可编辑元素，提前 `return` 了。
4. 事件收到了，但切图状态更新被其他 effect 或渲染流程立即重置。
5. 当前实际获得焦点的并不是这个页面上下文，导致监听加在错误的宿主上。

## Evidence Plan
- 给弹窗生命周期和键盘监听注册/触发加运行时日志。
- 在图片切换状态更新点补日志，确认是否真的进入了切图分支。
- 运行页面并通过调试日志比对假设。
