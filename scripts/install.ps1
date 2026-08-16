# dsh-pet 安装器
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#     [-Profile web] [-PluginDir <插件目录绝对路径>] [-PetDir <桌宠目录>]
#     [-InstallPetTo <目标目录>] [-PetExe <桌宠 exe 路径>] [-NoShortcut] [-NoAutoLaunch]
#     [-Force]（已存在 pet-bridge 覆盖时也强制重写）
#
# 行为：
#   1. 把桌宠应用（pet/）复制到目标目录（默认 $env:LOCALAPPDATA\dsh-pet）；
#   2. 用 `dsh plugin --profile <name> add` 把 dsh-pet-bridge 装进指定 profile；
#   3. 在该 profile 的 cordis.patch.yml 用户层写入 petPath 覆盖（随 DSH 启动）；
#   4. 可选：创建桌面快捷方式（启动桌宠）。
param(
    [string]$Profile = "web",
    [string]$PluginDir = "",
    [string]$PetDir = "",
    [string]$InstallPetTo = "",
    [string]$PetExe = "",
    [switch]$NoShortcut,
    [switch]$NoAutoLaunch,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

# pnpm 可能只装在用户级 npm 全局目录（未入 PATH）
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    $npmBin = Join-Path $env:APPDATA "npm"
    if (Test-Path (Join-Path $npmBin "pnpm.cmd")) {
        $env:PATH = "$npmBin;$env:PATH"
    }
}

if (-not $PluginDir) { $PluginDir = Join-Path $RepoRoot "plugin" }
if (-not $PetDir) { $PetDir = Join-Path $RepoRoot "pet" }
if (-not $InstallPetTo) { $InstallPetTo = Join-Path $env:LOCALAPPDATA "dsh-pet" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------- 1. 部署桌宠 ----------
Write-Step "部署桌宠到 $InstallPetTo"
New-Item -ItemType Directory -Force -Path $InstallPetTo | Out-Null
foreach ($name in @("pet_app.py", "state_listener.py", "pet_loader.py", "pet_style.py", "requirements.txt")) {
    Copy-Item (Join-Path $PetDir $name) $InstallPetTo -Force
}
foreach ($dir in @("pets", "assets", "fonts")) {
    $src = Join-Path $PetDir $dir
    if (Test-Path $src) {
        Copy-Item $src $InstallPetTo -Recurse -Force
    }
}
$petConfig = Join-Path $InstallPetTo "pet_config.json"
if (-not (Test-Path $petConfig)) {
    '{"pet": null, "scale": 1.0, "fps": 10, "port": 47890, "always_on_top": true, "show_status_text": false, "show_bubble": true}' |
        Set-Content -Path $petConfig -Encoding UTF8
}

# 构建产物（dist/DshPet.exe）存在时自动复制到部署目录（优先使用打包版）
$distExe = Join-Path $RepoRoot "dist\DshPet.exe"
if (Test-Path $distExe) {
    Copy-Item $distExe $InstallPetTo -Force
    Write-Host "    已复制构建产物: $(Get-Item (Join-Path $InstallPetTo 'DshPet.exe') | Select-Object -ExpandProperty LastWriteTime)"
}

# 桌宠可执行文件：优先用户指定；其次已构建的 exe；否则自动构建（有 Python）
# 或回退 pythonw 启动；都没有则给出清晰指引。
if (-not $PetExe) {
    $built = Join-Path $InstallPetTo "DshPet.exe"
    if (Test-Path $built) {
        $PetExe = $built
    } else {
        # 尝试自动构建（需要 Python 3.11+）
        $buildScript = Join-Path $RepoRoot "scripts\build.ps1"
        if (Test-Path $buildScript) {
            Write-Host "    dist/DshPet.exe 不存在，尝试自动构建（需要 Python 3.11+）…" -ForegroundColor Yellow
            & powershell -ExecutionPolicy Bypass -File $buildScript
            if ($LASTEXITCODE -eq 0 -and (Test-Path $distExe)) {
                Copy-Item $distExe $InstallPetTo -Force
                $PetExe = $built
            }
        }
        if (-not $PetExe) {
            # pythonw 直启回退：venv → py 启动器 → 系统 pythonw
            $pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
            if (-not $pythonw) {
                $venvPw = Join-Path $RepoRoot ".venv\Scripts\pythonw.exe"
                if (Test-Path $venvPw) { $pythonw = $venvPw }
            }
            if (-not $pythonw) {
                $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
                if ($pyLauncher) {
                    $probe = & py -3 -c "import sys, os; print(os.path.join(os.path.dirname(sys.executable), 'pythonw.exe'))" 2>$null
                    if ($LASTEXITCODE -eq 0 -and $probe -and (Test-Path $probe.Trim())) { $pythonw = $probe.Trim() }
                }
            }
            if ($pythonw) {
                $PetExe = $pythonw
            } else {
                throw "未找到 Python 3.11+，且无预构建 DshPet.exe。请安装 Python（https://www.python.org/downloads/，勾选 Add to PATH）后重试，或使用 GitHub Release 中的预构建 exe（-PetExe 指定）。"
            }
        }
    }
}
Write-Host "    桌宠启动器: $PetExe"

# ---------- 2. 安装 DSH 插件 ----------
Write-Step "安装 dsh-pet-bridge 到 profile '$Profile'"
$pluginAbs = [System.IO.Path]::GetFullPath($PluginDir)
if ($env:DSH_HOME) { $profileDir = Join-Path (Join-Path $env:DSH_HOME "profiles") $Profile }
else { $profileDir = Join-Path (Join-Path $env:USERPROFILE ".dsh\profiles") $Profile }
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
    & dsh plugin --profile $Profile add $pluginAbs
    if ($LASTEXITCODE -ne 0) { Write-Host "    dsh plugin add 失败（退出码 $LASTEXITCODE）——插件可能已安装，可忽略" -ForegroundColor Yellow }
} else {
    # dsh 命令不可用（它只内置在 DSH 运行环境）：手动把插件注册进 profile——
    # 直接编辑 profile 的 package.json（dependencies + bundles 列表），效果与
    # `dsh plugin add` 相同，保证新用户 clone 后也能一键装上。
    Write-Host "    未找到 dsh 命令，改为手动注册到 profile 文件…" -ForegroundColor Yellow
    $profilePkg = Join-Path $profileDir "package.json"
    if (Test-Path $profilePkg) {
        try {
            $pkg = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
            $changed = $false
            if (-not $pkg.dependencies.'dsh-pet-bridge') {
                $pkg.dependencies | Add-Member -NotePropertyName 'dsh-pet-bridge' -NotePropertyValue ("link:" + ($pluginAbs -replace "\\", "/")) -Force
                $changed = $true
            }
            if (-not ($pkg.dsh.profile.bundles -contains "dsh-pet-bridge")) {
                $pkg.dsh.profile.bundles += "dsh-pet-bridge"
                $changed = $true
            }
            if ($changed) {
                $pkg | ConvertTo-Json -Depth 10 | Set-Content $profilePkg -Encoding UTF8
                Write-Host "    已手动注册 dsh-pet-bridge 到 $profilePkg" -ForegroundColor Green
            } else {
                Write-Host "    profile 已包含 dsh-pet-bridge，跳过" -ForegroundColor Green
            }
        } catch {
            Write-Host "    手动注册失败（$($_.Exception.Message)）——请手动执行：dsh plugin --profile $Profile add `"$pluginAbs`"" -ForegroundColor Yellow
        }
    } else {
        Write-Host "    未找到 profile 文件 $profilePkg —— 请手动执行：dsh plugin --profile $Profile add `"$pluginAbs`"" -ForegroundColor Yellow
    }
}

# ---------- 3. 写入 petPath 覆盖 ----------
$patchFile = Join-Path $profileDir "cordis.patch.yml"
Write-Step "写入 profile 用户层覆盖: $patchFile"
$petPathEsc = ($PetExe -replace "\\", "/") -replace "'", "''"

# pythonw 直启 pet_app.py 时需要参数；打包好的 DshPet.exe 不需要
$argsLine = ""
if ($PetExe -match "pythonw") {
    $petArgs = (Join-Path $InstallPetTo "pet_app.py") -replace "\\", "/"
    $argsLine = "    petArgs: ['$petArgs']`n"
}

$override = @"
- id: pet-bridge
  config:
    petPath: '$petPathEsc'
$argsLine    autoLaunch: $(-not $NoAutoLaunch)
"@

# 用户层是个补丁列表：要么是空列表（[]），要么已有其他条目。
# 若当前为 `[]`（含注释），整体替换为覆盖块；否则在列表末尾追加。
if (Test-Path $patchFile) {
    $lines = @(Get-Content $patchFile)
    $nonComment = @($lines | Where-Object { $_ -notmatch "^\s*#" -and $_.Trim() -ne "" })
    $hasBridge = $false
    foreach ($line in $lines) { if ($line -match "^-\s*id:\s*pet-bridge\s*$") { $hasBridge = $true; break } }
    if ($hasBridge -and $Force) {
        # -Force：先移除全部旧 pet-bridge 块，写回文件后再按下方逻辑重写
        $tmp = New-Object System.Collections.Generic.List[string]
        $skip = $false
        foreach ($line in $lines) {
            if ($line -match "^-\s*id:\s*pet-bridge\s*$") { $skip = $true; continue }
            if ($skip) {
                if ($line -match "^-\s|^#") { $skip = $false }
                else { continue }
            }
            if (-not $skip) { $tmp.Add($line) }
        }
        $lines = @($tmp)
        Set-Content -Path $patchFile -Value $lines -Encoding UTF8
        $nonComment = @($lines | Where-Object { $_ -notmatch "^\s*#" -and $_.Trim() -ne "" })
        $hasBridge = $false
        Write-Host "    -Force：已移除旧 pet-bridge 覆盖"
    }
    if ($hasBridge) {
        Write-Host "    cordis.patch.yml 已包含 pet-bridge 覆盖，跳过（使用 -Force 可重写）"
    } elseif ($nonComment.Count -eq 1 -and $nonComment[0].Trim() -eq "[]") {
        # 空列表：保留注释，把 [] 替换为覆盖块
        $out = New-Object System.Collections.Generic.List[string]
        foreach ($line in $lines) {
            if ($line.Trim() -eq "[]") { $out.Add($override.TrimEnd()) }
            else { $out.Add($line) }
        }
        Set-Content -Path $patchFile -Value $out -Encoding UTF8
        Write-Host "    已将空列表替换为 pet-bridge 配置覆盖"
    } else {
        $trimmed = (Get-Content $patchFile -Raw).TrimEnd()
        Add-Content -Path $patchFile -Value "`n$override" -Encoding UTF8
        Write-Host "    已在列表末尾追加 pet-bridge 配置覆盖"
    }
} else {
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    Set-Content -Path $patchFile -Value $override -Encoding UTF8
}

# ---------- 4. 桌面快捷方式 ----------
if (-not $NoShortcut) {
    Write-Step "创建桌面快捷方式（启动桌宠）"
    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnk = Join-Path $desktop "DSH 桌宠.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = $PetExe
    $sc.Arguments = ""
    if ($PetExe -match "pythonw") {
        $sc.Arguments = """$(Join-Path $InstallPetTo 'pet_app.py')"""
        $sc.WorkingDirectory = $InstallPetTo
    } else {
        $sc.WorkingDirectory = Split-Path -Parent $PetExe
    }
    $sc.Save()
}

Write-Host ""
Write-Host "安装完成。请重启 DSH（dsh web）使插件生效；桌宠将随 DSH 启动。" -ForegroundColor Green
Write-Host "桌宠也可通过快捷方式或直接运行 '$PetExe' 手动启动。" -ForegroundColor Green
