#Requires -Version 5.1
<#
.SYNOPSIS
  把本仓库 checkout 以 link: 依赖装进 dsh profile，并修复 pnpm 在 Windows 上
  对跨盘符 link: 目标创建的坏 junction，以及由此被 dsh plugin reconcile
  误删的 dsh.profile.bundles 条目。

.DESCRIPTION
  dsh plugin --profile <name> add <path> 只是把参数转发给 profile 目录下的
  pnpm。pnpm 会把本地目录记录成 link: 依赖；当 checkout 与 profile 不在同一
  盘符时（如 E:\Workspace vs C:\Users\...\.dsh），pnpm 创建的 junction 目标
  会被错误地按相对路径拼接而失效。

  坏 junction 还有连锁反应：dsh plugin 在 pnpm 之后会运行 reconcile —— 用
  包的 dsh.bundle 声明来维护 dsh.profile.bundles。若彼时 junction 是坏的，
  reconcile 读不到包的声明，就会把包名从 bundles 中删除，导致该插件（含
  其 Web 按钮）从 dsh web 中消失。本脚本因此做了三件事：
    1. pnpm add 安装 link: 依赖
    2. 检查 lib\index.js 是否可达，不可达则重建坏 junction 为绝对目标
    3. 检查 dsh.profile.bundles 是否仍包含本包，缺失则重新加入

  日常开发循环：
    pnpm build                     # 重建 lib/
    .\scripts\install-profile.ps1  # 本脚本（首次或 pnpm 重建坏 junction 后）
    重启 dsh web + 刷新页面

.PARAMETER Profile
  profile 名，默认 web
#>
param(
    [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = (Get-Item $repoRoot).FullName.TrimEnd('\')

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile 目录不存在: $profileDir"
}

Write-Host "[安装] pnpm add $target -> $profileDir"
pnpm --dir $profileDir add "$target"
if ($LASTEXITCODE -ne 0) { throw 'pnpm add 失败' }

$link = Join-Path $profileDir 'node_modules\dsh-win-docker-workspace'
$entry = Get-Item $link -Force -ErrorAction SilentlyContinue
if ($null -eq $entry) { throw "安装后找不到 $link" }

$probe = Join-Path $link 'lib\index.js'
if (-not (Test-Path -LiteralPath $probe)) {
    Write-Warning 'pnpm 创建的 junction 目标无效（跨盘符 link: 已知问题），重建为绝对目标'
    cmd /c rmdir "$link"
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    $entry = Get-Item $link -Force
    if (-not (Test-Path -LiteralPath $probe)) { throw 'junction 修复失败' }
}

# --- 修复 dsh.profile.bundles 中被 reconcile 误删的条目 ---
# 判定依据与 dsh 的 reconcile 一致：包的 package.json 声明了 dsh.bundle.patch
# 才应出现在 bundles 里。只读检查，缺条目时才用 node 改写（保持 2 空格缩进）。
$pluginManifestPath = Join-Path $target 'package.json'
$pluginManifest = Get-Content $pluginManifestPath -Raw | ConvertFrom-Json
$pluginName = $pluginManifest.name
if (-not $pluginName) { throw 'checkout package.json 缺少 name 字段' }

$profilePkgPath = Join-Path $profileDir 'package.json'
$profilePkg = Get-Content $profilePkgPath -Raw | ConvertFrom-Json
$bundles = @($profilePkg.dsh.profile.bundles)
$declaresBundle = ($null -ne $pluginManifest.dsh.bundle.patch)

if ($declaresBundle -and ($bundles -notcontains $pluginName)) {
    Write-Warning "$pluginName 不在 dsh.profile.bundles 中（dsh plugin 的 reconcile 曾在坏 junction 期间删除了它），重新加入"
    $repairScript = @'
const fs = require('fs')
const file = process.argv[1]
const pluginName = process.argv[2]
const j = JSON.parse(fs.readFileSync(file, 'utf8'))
j.dsh = j.dsh || {}
j.dsh.profile = j.dsh.profile || {}
if (!Array.isArray(j.dsh.profile.bundles)) j.dsh.profile.bundles = []
if (!j.dsh.profile.bundles.includes(pluginName)) {
  j.dsh.profile.bundles.push(pluginName)
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
  console.log('bundles repaired: added ' + pluginName)
} else {
  console.log('bundles ok: ' + pluginName + ' already present')
}
'@
    & node -e $repairScript $profilePkgPath $pluginName
    if ($LASTEXITCODE -ne 0) { throw 'bundles 修复失败（node 改写 package.json 出错）' }
} elseif (-not $declaresBundle -and ($bundles -contains $pluginName)) {
    Write-Warning "$pluginName 在 bundles 中，但 checkout 未声明 dsh.bundle，保留现状（如需要可手动移除）"
} else {
    Write-Host "[检查] dsh.profile.bundles 已包含 $pluginName"
}

Write-Host "[完成] $($entry.Target) 已可用，重启 dsh web 后生效"
