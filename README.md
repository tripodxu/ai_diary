# tripodxu 的日记 · TRIPODXU'S DIARY GARDEN

语音交互应答网页 —— 照片化作星尘粒子，和 Gemini 聊出一段记忆日记。

## 启动

```bash
node server.js
# → http://localhost:8765
```

## 功能

- **粒子星尘**：照片溶解为 11 万颗 WebGL 微尘，鼠标 360° 旋转
- **语音对话**：Web Speech API + Gemini 开场引导，演示脚本兜底
- **日记生成**：对话结束保存为日记卡片，支持真 Gemini 模型（配置 GEMINI_API_KEY）
- **记忆回廊**：三联粒子轮播、封面点击重开日记、拖拽换页、自动配乐
- **后端记忆**：REST API 持久化（data/），重启后恢复

## 技术栈

- 前端：单文件 HTML + WebGL 着色器 + Web Audio + Web Speech API
- 后端：Node.js 零依赖 HTTP 服务器
