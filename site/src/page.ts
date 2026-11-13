function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const INSTALL_PROMPT =
  "Fetch and execute the appropriate instructions to install and set up Acrowly on my machine from https://acrowly.com/prompt.md";

const MANUAL_COMMANDS = `git clone https://github.com/chess20000/acrowly.git ~/.acrowly
cd ~/.acrowly
npm install --no-audit --no-fund
npm run build
npm link
acl`;

export function renderLandingPage(promptMarkdown: string): string {
  const escapedPrompt = escapeHtml(INSTALL_PROMPT);
  const escapedManual = escapeHtml(MANUAL_COMMANDS);
  const escapedMarkdown = escapeHtml(promptMarkdown);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acrowly — 一行 Prompt 让 Agent 自动装好个人 AI 协调器</title>
  <meta name="description" content="极简、无 GUI、纯 Ed25519 密钥鉴权的自托管个人 AI 协调器系统。复制一行 Prompt 发给你电脑上的 Agent 即可完成安装。" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --surface: #12161c;
      --surface-2: #171c24;
      --border: #262e3a;
      --border-strong: #374355;
      --text: #eef2f6;
      --muted: #9aa5b5;
      --dim: #6f7c8f;
      --accent: #f38020;
      --accent-soft: rgba(243, 128, 32, 0.14);
      --ok: #38c976;
      --ok-soft: rgba(56, 201, 118, 0.14);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); line-height: 1.6; -webkit-font-smoothing: antialiased; }
    a { color: inherit; text-decoration: none; }

    .wrap {
      max-width: 960px;
      margin: 0 auto;
      padding: 28px 20px 72px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 18px;
      letter-spacing: -0.02em;
    }

    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-soft);
    }

    .nav {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 13px;
      color: var(--muted);
      flex-wrap: wrap;
    }

    .nav a {
      padding: 4px 8px;
      border-radius: 6px;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .nav a:hover {
      background: var(--surface-2);
      color: var(--text);
    }

    .hero {
      padding: 48px 0 32px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--accent);
      background: var(--accent-soft);
      border: 1px solid rgba(243, 128, 32, 0.35);
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 18px;
    }

    h1 {
      margin: 0 0 14px;
      font-size: clamp(28px, 4.4vw, 44px);
      line-height: 1.15;
      letter-spacing: -0.03em;
      font-weight: 750;
    }

    .lead {
      margin: 0;
      max-width: 720px;
      font-size: 16px;
      color: var(--muted);
    }

    .prompt-card {
      margin-top: 28px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
    }

    .prompt-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }

    .prompt-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
      font-family: var(--mono);
    }

    .prompt-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    button {
      font-family: inherit;
      cursor: pointer;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 14px;
      transition: transform 0.08s ease, background 0.15s ease, border-color 0.15s ease;
    }

    button:active {
      transform: translateY(1px);
    }

    .btn-primary {
      background: var(--accent);
      color: #140c04;
      border-color: var(--accent);
    }

    .btn-primary:hover {
      background: #ff9238;
      border-color: #ff9238;
    }

    .btn-primary.copied {
      background: var(--ok);
      border-color: var(--ok);
      color: #05160c;
    }

    .btn-ghost {
      background: transparent;
      color: var(--muted);
    }

    .btn-ghost:hover {
      background: var(--surface);
      color: var(--text);
    }

    .prompt-body {
      padding: 18px 18px 16px;
    }

    .prompt-code {
      margin: 0;
      padding: 14px 16px;
      border-radius: 10px;
      background: #080a0d;
      border: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 14px;
      line-height: 1.55;
      color: #f8fafc;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: all;
    }

    .agents-strip {
      margin-top: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--dim);
    }

    .agent-pill {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      background: #0d1015;
      border: 1px solid var(--border);
      padding: 3px 9px;
      border-radius: 999px;
    }

    .preview-drawer {
      display: none;
      margin-top: 14px;
      border-top: 1px solid var(--border);
      padding-top: 14px;
    }

    .preview-drawer.open {
      display: block;
    }

    .preview-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--muted);
      font-family: var(--mono);
    }

    .preview-pre {
      margin: 0;
      max-height: 380px;
      overflow: auto;
      padding: 14px;
      border-radius: 10px;
      background: #080a0d;
      border: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.55;
      color: #c8d3e0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    section {
      margin-top: 40px;
    }

    h2 {
      margin: 0 0 14px;
      font-size: 19px;
      letter-spacing: -0.015em;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    @media (max-width: 760px) {
      .steps, .grid-2 { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
    }

    .step-num {
      display: inline-block;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--accent);
      margin-bottom: 6px;
    }

    .card h3 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 650;
    }

    .card p {
      margin: 0;
      font-size: 13.5px;
      color: var(--muted);
    }

    code.inline {
      font-family: var(--mono);
      font-size: 12.5px;
      background: #090b0f;
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 5px;
      color: #e6edf5;
    }

    .manual-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
    }

    .manual-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .manual-pre {
      margin: 0;
      padding: 12px 14px;
      border-radius: 8px;
      background: #080a0d;
      border: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 12.5px;
      line-height: 1.6;
      color: #d6e0ec;
      overflow-x: auto;
    }

    footer {
      margin-top: 52px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 12.5px;
      color: var(--dim);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <a class="brand" href="/">
        <span class="brand-dot" aria-hidden="true"></span>
        <span>acrowly</span>
      </a>
      <nav class="nav" aria-label="Primary">
        <a href="/prompt.md">/prompt.md</a>
        <a href="https://github.com/chess20000/acrowly" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        <a href="https://github.com/chess20000/acrowly/blob/main/docs/API_SPEC.md" target="_blank" rel="noopener noreferrer">API Spec ↗</a>
      </nav>
    </header>

    <main>
      <section class="hero" style="margin-top:0;">
        <div class="badge">Headless AI Coordinator · Pure Ed25519 Key Auth · acl CLI</div>
        <h1>复制一行 Prompt，让你的 Agent<br />自动把 Acrowly Harness 装到本机</h1>
        <p class="lead">
          不用折腾复杂安装。把下面的 Prompt 复制发送给你电脑上的任意 Coding Agent，它会自动读取
          <a href="/prompt.md" style="text-decoration:underline;color:var(--text);">acrowly.com/prompt.md</a>，
          完成源码拉取、编译、注册全局命令 <code class="inline">acl</code>，并生成本机 Ed25519 客户端私钥与指纹。
        </p>

        <div class="prompt-card">
          <div class="prompt-head">
            <div class="prompt-label">Agent Setup Prompt · https://acrowly.com/prompt.md</div>
            <div class="prompt-actions">
              <button type="button" class="btn-ghost" id="togglePreviewBtn">查看 prompt.md 原文</button>
              <button type="button" class="btn-primary" id="copyPromptBtn">复制安装 Prompt</button>
            </div>
          </div>
          <div class="prompt-body">
            <pre class="prompt-code" id="promptText">${escapedPrompt}</pre>
            <div class="agents-strip">
              <span>适用于：</span>
              <span class="agent-pill">Claude Code</span>
              <span class="agent-pill">Codex</span>
              <span class="agent-pill">Cursor</span>
              <span class="agent-pill">Antigravity</span>
              <span class="agent-pill">OpenCode</span>
              <span class="agent-pill">Gemini CLI</span>
            </div>
            <div class="preview-drawer" id="previewDrawer">
              <div class="preview-head">
                <span>GET https://acrowly.com/prompt.md</span>
                <a href="/prompt.md" target="_blank" rel="noopener noreferrer" style="text-decoration:underline;">在新标签打开 raw Markdown ↗</a>
              </div>
              <pre class="preview-pre">${escapedMarkdown}</pre>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>装完后只需要 3 步开始用</h2>
        <div class="steps">
          <div class="card">
            <span class="step-num">STEP 01</span>
            <h3>发给 Agent 自动部署</h3>
            <p>Agent 会检查 Node.js ≥ 20、克隆代码到 <code class="inline">~/.acrowly</code>、运行测试并执行 <code class="inline">npm link</code> 注册全局 <code class="inline">acl</code> 与 <code class="inline">acl keygen</code>。</p>
          </div>
          <div class="card">
            <span class="step-num">STEP 02</span>
            <h3>终端运行一次 acl</h3>
            <p>在命令行执行 <code class="inline">acl</code>，只需填一次模型提供商和 API Key；系统会自动把本机 Ed25519 公钥写入授权列表并进入纯终端对话。</p>
          </div>
          <div class="card">
            <span class="step-num">STEP 03</span>
            <h3>其他设置全在聊天里说</h3>
            <p>添加手机/网页客户端公钥、开启穿透连接、新增备选模型或让子代理现写一个极简 WebUI，直接在对话里吩咐主协调器即可。</p>
          </div>
        </div>
      </section>

      <section>
        <h2>核心架构设计</h2>
        <div class="grid-2">
          <div class="card">
            <h3>SSH 级纯 Ed25519 密钥鉴权</h3>
            <p>彻底没有密码与静态 Token。支持 <code class="inline">acl</code> API 的任何端（CLI / Web / iOS）自带 keygen，私钥不出设备，将 <code class="inline">ssh-ed25519</code> 公钥加入主机后通过 <code class="inline">/api/auth/challenge</code> → <code class="inline">verify</code> 挑战签名登录。</p>
          </div>
          <div class="card">
            <h3>主协调器 + 朴素子代理</h3>
            <p>主协调器只做架构把关、决策与好为人师的讲解，写代码、造扩展与页面全都委派独立子代理；固定系统前缀配合 200K / 闲置 30m 上下文压缩以最大化 Prompt Cache。</p>
          </div>
          <div class="card">
            <h3>纯文本 Chat API + 热挂载扩展</h3>
            <p>接口层围绕单调递增 <code class="inline">seq</code> 的纯文本消息和 SSE 增量流构建，图片与文件经 <code class="inline">/api/files</code> 独立挂载并严格拒收视频，服务端启动后支持热扩展与热构建 <code class="inline">./webui/</code>。</p>
          </div>
          <div class="card">
            <h3>独立核心，网站只是可选入口</h3>
            <p>就像 Git 永远不依赖 GitHub：Acrowly 核心完全跑在你自己的机器上，打包源码仅 ~178 KB（唯一运行依赖 <code class="inline">ws</code>）。没有本网站也能独立运行、局域网直连或用 <code class="inline">acl relay</code> 自建任意中继节点。</p>
          </div>
        </div>
      </section>

      <section>
        <div class="manual-box">
          <div class="manual-top">
            <div>
              <h3 style="margin:0;font-size:15px;">不想通过 Agent？手动执行等效命令</h3>
            </div>
            <button type="button" class="btn-ghost" id="copyManualBtn">复制命令</button>
          </div>
          <pre class="manual-pre" id="manualCode">${escapedManual}</pre>
        </div>
      </section>
    </main>

    <footer>
      <span>Acrowly · Personal AI Coordinator Harness</span>
      <span><a href="/prompt.md">/prompt.md</a> · <a href="https://github.com/chess20000/acrowly" target="_blank" rel="noopener noreferrer">github.com/chess20000/acrowly</a></span>
    </footer>
  </div>

  <script>
    (function () {
      async function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }

      const promptBtn = document.getElementById("copyPromptBtn");
      const promptEl = document.getElementById("promptText");
      const manualBtn = document.getElementById("copyManualBtn");
      const manualEl = document.getElementById("manualCode");
      const toggleBtn = document.getElementById("togglePreviewBtn");
      const drawer = document.getElementById("previewDrawer");

      let promptTimer = null;
      promptBtn.addEventListener("click", async () => {
        try {
          await copyText(promptEl.textContent || "");
          promptBtn.textContent = "✓ 已复制 Prompt，去发给 Agent";
          promptBtn.classList.add("copied");
          clearTimeout(promptTimer);
          promptTimer = setTimeout(() => {
            promptBtn.textContent = "复制安装 Prompt";
            promptBtn.classList.remove("copied");
          }, 2200);
        } catch {
          promptBtn.textContent = "请手动选中上方代码复制";
        }
      });

      let manualTimer = null;
      manualBtn.addEventListener("click", async () => {
        try {
          await copyText(manualEl.textContent || "");
          manualBtn.textContent = "✓ 已复制";
          clearTimeout(manualTimer);
          manualTimer = setTimeout(() => {
            manualBtn.textContent = "复制命令";
          }, 1800);
        } catch {
          manualBtn.textContent = "请手动选中复制";
        }
      });

      toggleBtn.addEventListener("click", () => {
        const isOpen = drawer.classList.toggle("open");
        toggleBtn.textContent = isOpen ? "收起 prompt.md 原文" : "查看 prompt.md 原文";
      });
    })();
  </script>
</body>
</html>`;
}
