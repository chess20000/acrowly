# Acrowly

极简、无 GUI、全权限自托管个人 AI 协调器系统。

## 核心特点

- **极简使用流程**：一键安装启动 → 首次仅输入「模型提供商 + API Key」→ 自动生成并授权本机 Ed25519 密钥对 → 进入原生纯文本终端与**好为人师的主协调器**对话 → 添加其它设备 Ed25519 公钥、`acrowly.com` 无公网 IP 穿透、新增模型与实时扩展、甚至专属本地 WebUI 全部在聊天里完成。
- **SSH 级纯密钥鉴权（无密码、无静态 Token）**：所有支持 `acl` API 的客户端自带 Ed25519 Keygen，私钥永不出设备，将公钥加入主机即可通过挑战签名登录。
- **极简聊天与全文件传输 API**：消息流通过统一连续时间线传输（`seq` 单调递增、`POST /api/chat/messages` + `GET /api/chat/stream`），支持通过 `POST /api/chat/messages`（`multipart/form-data` 一并发送文本与多个文件）或独立 `POST /api/files` + `GET /api/files/:id/:filename`（支持断点续传 `Range`）传输任意格式文件（图片、文档、代码、压缩包、音频、视频等）。
- **协调器 + 朴素子代理 + 200K/闲时上下文压缩**：主协调器尽量少亲自动手，将代码/网页/扩展编写与长任务全部派发给独立子代理；前缀保持不可变以最大化 Prompt Cache 命中，默认每 200K tokens 或闲置 30 分钟自动压缩一次。
- **无公网 IP 穿透中继（`acrowly.com`）**：本地 Daemon 主动发起出站 WebSocket 长连接至 `acrowly.com`，网页与 iOS App 无需用户懂内网穿透即可随时随地访问。

## 快速启动

Windows PowerShell / CMD：
```powershell
.\scripts\install.ps1
```
或直接手动运行：
```bash
npm install
npm run build
npm start
```

### 常用命令（全局命令 `acl`）
- `acl`（或 `npm start`）：首次启动引导配置协调器模型，启动无头后端并进入原生纯终端对话
- `acl daemon`：仅运行无头后端服务（`http://127.0.0.1:8787`）
- `acl chat`：附着到运行中的服务端（支持 `--url` 经 `acrowly.com` 远端连接，自动走 Ed25519 签名鉴权）
- `acl keygen`：生成或查看本机客户端 Ed25519 公钥（类似 `ssh-keygen`）
- `acl add-key <公钥> [--label 设备名]`：本地快速添加客户端授权公钥
- `acl relay`：启动可部署在 `acrowly.com` 上的无状态中继服务器（默认端口 `8788`）

详细 Pure Chat API 契约见 [`docs/API_SPEC.md`](docs/API_SPEC.md)。
