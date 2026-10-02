# 一键初始化：把 .env.example 复制为 .env（已存在则不覆盖）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$example = Join-Path $root '.env.example'

if (-not (Test-Path $example)) {
    throw "未找到 $example"
}

if (Test-Path $envFile) {
    Write-Host "[skip] .env 已存在：$envFile" -ForegroundColor Yellow
} else {
    Copy-Item $example $envFile
    Write-Host "[ok] 已生成 .env：$envFile" -ForegroundColor Green
}

Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  docker compose up -d --build"
Write-Host "  浏览器打开 http://localhost:8080   （账号 admin / admin123456）"
Write-Host "  端到端验收：docker compose exec api python -m app.verify"
