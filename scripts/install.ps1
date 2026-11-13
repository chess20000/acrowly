$ErrorActionPreference = "Stop"

Write-Host "=== Acrowly 后端安装与启动 ===" -ForegroundColor Cyan

# Check Node.js >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "未检测到 Node.js，尝试通过 winget 安装 Node.js LTS..." -ForegroundColor Yellow
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($wingetCmd) {
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  }
}

if (-not $nodeCmd) {
  throw "请先安装 Node.js 20+ (https://nodejs.org) 后再运行此脚本。"
}

$nodeMajor = [int]((node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
  throw "当前 Node.js 版本过低 ($(node -v))，需要 Node.js 20 或更高版本。"
}

# Determine target directory: use current folder if package.json exists here, else ~/.acrowly
$scriptRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$targetDir = $scriptRoot

if (-not (Test-Path (Join-Path $targetDir "package.json"))) {
  $targetDir = Join-Path $HOME ".acrowly"
  if (-not (Test-Path $targetDir)) {
    $repoUrl = if ($env:ACROWLY_REPO) { $env:ACROWLY_REPO } else { "https://github.com/chess20000/acrowly.git" }
    Write-Host "正在下载 Acrowly 到 $targetDir ..."
    git clone $repoUrl $targetDir
  }
}

Set-Location $targetDir
Write-Host "正在安装后端依赖..."
npm install --no-audit --no-fund
Write-Host "正在构建后端..."
npm run build

try {
  npm link | Out-Null
} catch {
  # ignore if global link lacks permissions
}

Write-Host "安装完成，正在启动模型提供商配置与纯终端对话..." -ForegroundColor Green
node dist/index.js
