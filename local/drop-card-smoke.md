# DropCard 切片冒烟测试计划

真实浏览器（headless Chromium via browser.open）走：

1. 打开 `/`，若被 401 跳到 `/login?next=/`，则登录已有账号（用 todo 仓库任意 admin）。
2. 等 workspace 渲染（看到「Workspace」标题、四列看板）。
3. ⌘/Ctrl 多选：
   - 取 Backlog 列里的 2 张 todo 卡。
   - 按住 Control，依次点其中 2 张。
   - 验证：① 选中卡边框变 accent 实线；② 出现「已选中 N 张 todo 卡」 notice。
4. 拖卡到对话输入框：
   - 使用真实 `mouse.move` + `mouse.down` + `mouse.move` (overshoot target) + `mouse.up`。
   - 落点在 Chief 对话卡片的 composer 内部（target `[data-mention-drop="1"]`）。
5. 验证 drop 落地：
   - composer 出现「待插入引用 · N 个」列表。
   - 「待插入」列表里每项是真实 refId，title 显示。
   - 「已 drop N 张卡」notice 出现。
6. 验证「拖卡到列=改相位」仍然工作（双重重拖语义）：
   - 另起一张 todo 卡，拖到其他列。
   - 看板列响应虚线高亮、composer 不响应实线高亮。

安全起见：开发服务器在 PID 24404 (port 3000)。Next.js 会自动 reload。
