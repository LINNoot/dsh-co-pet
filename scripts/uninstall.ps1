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
#   4. （可选）删除部署的桌宠目录（含自定义宠物，不可恢复）。
param(
    [string]$Profile = "web",
    [switch]$RemovePlugin,
    [switch]$RemovePetDir,
    [switch]$NoRemoveShortcut
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------- 1. 移除 profile 覆盖 ----------
if ($env:DSH_HOME) { $profileDir = Join-Path $env:DSH_HOME "profiles" $Profile }
else { $profileDir = Join-Path $env:USERPROFILE ".dsh\profiles" $Profile }
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
    Set-Content -Path $patchFile -Value $out -Encoding UTF8
    # 若补丁列表已被清空，恢复为合法的空列表 []（保持注释头）
    $remaining = @($out | Where-Object { $_ -notmatch "^\s*#" -and $_.Trim() -ne "" })
    if ($remaining.Count -eq 0) {
        $out.Add("[]")
        Set-Content -Path $patchFile -Value $out -Encoding UTF8
        Write-Host "    补丁列表已空，已恢复为 []。"
    }
    Write-Host "    已清理。"
}

# ---------- 2. 移除插件（可选） ----------
if ($RemovePlugin) {
    Write-Step "移除 dsh-pet-bridge 插件"
    & dsh plugin --profile $Profile remove dsh-pet-bridge
    if ($LASTEXITCODE -ne 0) { Write-Host "    dsh plugin remove 失败（退出码 $LASTEXITCODE）" -ForegroundColor Yellow }
}

# ---------- 3. 快捷方式 ----------
if (-not $NoRemoveShortcut) {
    Write-Step "删除桌面快捷方式"
    $desktop = [Environment]::GetFolderPath("Desktop")
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
            $item = Get-Item $petsDst -Force
            if ($item.LinkType -eq "Junction") {
                Remove-Item $petsDst -Force
                Write-Host "    已解除 pets 链接（源码 pet/pets/ 保留）"
            }
        }
        Remove-Item $dir -Recurse -Force
    }
}

Write-Host ""
Write-Host "卸载完成。请重启 DSH 使插件移除生效。" -ForegroundColor Green
