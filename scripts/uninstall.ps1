# dsh-pet 卸载器
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1
#     [-Profile web] [-RemovePlugin] [-RemovePetDir] [-NoRemoveShortcut]
#
# 行为：
#   1. 从 profile 的 cordis.patch.yml 移除 pet-bridge 覆盖；
#   2. （可选）`dsh plugin --profile <name> remove dsh-pet-bridge`；
#   3. 删除桌面快捷方式；
#   4. （可选）删除部署的桌宠目录。先解除 pets junction 链接（PS 5.1 的
#      Remove-Item -Recurse 对 junction 会递归删其指向的源码宠物目录），
#      源码 pet/pets/ 始终保留。
# 注意：-RemovePlugin 需要 dsh 命令可用；仅装过插件（未用安装脚本部署
# 桌宠）时不要用 -RemovePetDir（它删的是 %LOCALAPPDATA%\dsh-pet）。
param(
    [string]$Profile = "web",
    [switch]$RemovePlugin,
    [switch]$RemovePetDir,
    [switch]$NoRemoveShortcut
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# 无 BOM 的 UTF-8 写入：PS 5.1 的 Set-Content -Encoding UTF8 会带 BOM，
# DSH 的 JSON 解析（JSON.parse）不认 BOM，写坏 profile 的 package.json
# 会导致 DSH 启动崩溃（SyntaxError: Unexpected token）。
function Write-Utf8NoBom([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# ---------- 1. 移除 profile 覆盖 ----------
if ($env:DSH_HOME) { $profileDir = Join-Path (Join-Path $env:DSH_HOME "profiles") $Profile }
else { $profileDir = Join-Path (Join-Path $env:USERPROFILE ".dsh\profiles") $Profile }
$patchFile = Join-Path $profileDir "cordis.patch.yml"
if (Test-Path $patchFile) {
    Write-Step "从 $patchFile 移除 pet-bridge 覆盖"
    $lines = Get-Content $patchFile
    $out = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($line in $lines) {
        if ($line -match "^-\s*id:\s*pet-bridge\s*$") { $skip = $true; continue }
        if ($skip) {
            if ($line -match "^-\s|^#") { $skip = $false }
            else { continue }
        }
        if (-not $skip) { $out.Add($line) }
    }
    Write-Utf8NoBom $patchFile ($out -join "`n")
    # 若补丁列表已被清空，恢复为合法的空列表 []（保持注释头）
    $remaining = @($out | Where-Object { $_ -notmatch "^\s*#" -and $_.Trim() -ne "" })
    if ($remaining.Count -eq 0) {
        $out.Add("[]")
        Write-Utf8NoBom $patchFile ($out -join "`n")
        Write-Host "    补丁列表已空，已恢复为 []。"
    }
    Write-Host "    已清理。"
}

# ---------- 2. 移除插件（可选） ----------
if ($RemovePlugin) {
    Write-Step "移除 dsh-pet-bridge 插件"
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($dshCmd) {
        & dsh plugin --profile $Profile remove dsh-pet-bridge
        if ($LASTEXITCODE -ne 0) { Write-Host "    dsh plugin remove 失败（退出码 $LASTEXITCODE）" -ForegroundColor Yellow }
    } else {
        # dsh 命令不可用：手动从 profile 的 package.json 移除注册
        # （与 install.ps1 的手动注册互为对称，保证新用户也能卸载）
        Write-Host "    未找到 dsh 命令，改为手动从 profile 文件移除…" -ForegroundColor Yellow
        $profilePkg = Join-Path $profileDir "package.json"
        if (Test-Path $profilePkg) {
            try {
                $pkg = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
                $changed = $false
                if ($pkg.dependencies.'dsh-pet-bridge') {
                    $pkg.dependencies.PSObject.Properties.Remove('dsh-pet-bridge')
                    $changed = $true
                }
                $oldBundles = @($pkg.dsh.profile.bundles)
                $newBundles = @($oldBundles | Where-Object { $_ -ne "dsh-pet-bridge" })
                if ($newBundles.Count -ne $oldBundles.Count) {
                    $pkg.dsh.profile.bundles = $newBundles
                    $changed = $true
                }
                if ($changed) {
                    # 必须无 BOM 写入：DSH 的 JSON.parse 不认 BOM，带 BOM 会启动崩溃
                    Write-Utf8NoBom $profilePkg ($pkg | ConvertTo-Json -Depth 10)
                    Write-Host "    已手动移除 dsh-pet-bridge 注册" -ForegroundColor Green
                } else {
                    Write-Host "    profile 无 dsh-pet-bridge 注册，跳过" -ForegroundColor Green
                }
            } catch {
                Write-Host "    手动移除失败（$($_.Exception.Message)）——请手动编辑 $profilePkg 删除 dsh-pet-bridge 后重试" -ForegroundColor Yellow
            }
        } else {
            Write-Host "    未找到 profile 文件 $profilePkg —— 请手动执行：dsh plugin --profile $Profile remove dsh-pet-bridge" -ForegroundColor Yellow
        }
    }
}

# ---------- 3. 快捷方式 ----------
if (-not $NoRemoveShortcut) {
    Write-Step "删除桌面快捷方式"
    $desktop = [Environment]::GetFolderPath("Desktop")
    if ([string]::IsNullOrEmpty($desktop)) { $desktop = Join-Path $env:USERPROFILE "Desktop" }
    $lnk = Join-Path $desktop "DSH 桌宠.lnk"
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
}

# ---------- 4. 删除部署目录（可选） ----------
if ($RemovePetDir) {
    $dir = Join-Path $env:LOCALAPPDATA "dsh-pet"
    if (Test-Path $dir) {
        Write-Step "删除桌宠目录 $dir"
        # 先解除 pets junction（PS 5.1 的 Remove-Item -Recurse 对 junction
        # 会递归删除其指向的目标目录——即源码 pet/pets/，宠物素材会连带被删）。
        $petsDst = Join-Path $dir "pets"
        if (Test-Path $petsDst) {
            $item = Get-Item $petsDst -Force -ErrorAction SilentlyContinue
            if ($null -ne $item -and $item.LinkType -eq "Junction") {
                # PS 5.1 对 junction 的 Remove-Item -Force 仍会弹确认框，显式关闭
                Remove-Item $petsDst -Force -Confirm:$false
                Write-Host "    已解除 pets 链接（源码 pet/pets/ 保留）"
            }
        }
        Remove-Item $dir -Recurse -Force
    }
}

Write-Host ""
Write-Host "卸载完成。请重启 DSH 使插件移除生效。" -ForegroundColor Green
