const INSTALL_PROMPT =
  "Fetch and execute the appropriate instructions to install and set up Acrowly on my machine from https://acrowly.com/prompt.md";

export function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acrowly</title>
  <style>
    body {
      max-width: 640px;
      margin: 64px auto;
      padding: 0 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
      color: #111;
      background: #fff;
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { margin: 0 0 16px; color: #555; font-size: 14px; }
    pre {
      padding: 12px;
      border: 1px solid #ddd;
      background: #f7f7f7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0 0 12px;
      user-select: all;
    }
    button {
      padding: 6px 14px;
      border: 1px solid #ccc;
      background: #fff;
      color: #111;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .links { margin-top: 24px; font-size: 13px; }
    .links a { color: inherit; margin-right: 16px; }
    @media (prefers-color-scheme: dark) {
      body { color: #eaeaea; background: #111; }
      p { color: #999; }
      pre { background: #1a1a1a; border-color: #333; }
      button { color: #eaeaea; background: #1a1a1a; border-color: #444; }
    }
  </style>
</head>
<body>
  <h1>Acrowly</h1>
  <p>无头个人 AI 协调器。复制发给你电脑上的 Agent 即可安装（本页仅作入口，非核心依赖）：</p>
  <pre id="p">${INSTALL_PROMPT}</pre>
  <button id="b" type="button">复制 Prompt</button>
  <div class="links">
    <a href="/prompt.md">prompt.md</a>
    <a href="https://github.com/chess20000/acrowly" target="_blank" rel="noopener noreferrer">GitHub</a>
  </div>
  <script>
    (function () {
      var btn = document.getElementById("b");
      var text = document.getElementById("p").textContent || "";
      var timer;
      btn.addEventListener("click", function () {
        function done() {
          btn.textContent = "已复制";
          clearTimeout(timer);
          timer = setTimeout(function () { btn.textContent = "复制 Prompt"; }, 1800);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
          fallback();
        }
        function fallback() {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          done();
        }
      });
    })();
  </script>
</body>
</html>`;
}
