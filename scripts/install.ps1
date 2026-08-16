# dsh-pet 安装器
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#     [-Profile web] [-PluginDir <插件目录绝对路径>] [-PetDir <桌宠目录>]
#     [-InstallPetTo <目标目录>] [-PetExe <桌宠 exe 路径>] [-NoShortcut] [-NoAutoLaunch]
#     [-Force]（已存在 pet-bridge 覆盖时也强制重写）
#
# 行为：
#   0. 前置检查：DSH profile 必须存在（需装过 DSH 并跑过一次 dsh web）、
#      桌宠 exe 必须可用（-PetExe 指定 / 部署目录已有 / 仓库 dist/ / 自动构建），
#      缺任一条件立即明确报错中止（不再装到一半才失败）；
#   1. 把桌宠应用（pet/）复制到目标目录（默认 $env:LOCALAPPDATA\dsh-pet），
#      pets/ 用 junction 链接到源码（放宠物到源码即可用，勿删部署目录 pets）；
#   2. -PetExe 指定的 exe 复制进部署目录（桌宠按 exe 所在目录扫描 pets/，
#      exe 留在下载目录会导致"未找到宠物包"）；
#   3. 用 `dsh plugin --profile <name> add` 把 dsh-pet-bridge 装进指定 profile
#      （dsh 命令不可用时自动改写 profile 文件注册）；
#   4. 在该 profile 的 cordis.patch.yml 用户层写入 petPath 覆盖（随 DSH 启动）；
#   5. 可选：创建桌面快捷方式（启动桌宠）。
#   无现成 exe 时：优先自动构建（Python 3.11+，调 scripts/build.ps1），
#   否则回退 pythonw 直启并自动 pip 安装桌宠依赖（PySide6/Pillow）。
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

# 无 BOM 的 UTF-8 写入：PS 5.1 的 Set-Content -Encoding UTF8 会带 BOM，
# DSH 的 JSON 解析（JSON.parse）不认 BOM，写坏 profile 的 package.json
# 会导致 DSH 启动崩溃（SyntaxError: Unexpected token）。
function Write-Utf8NoBom([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# ---------- 0. 前置检查（preflight）----------
# 明确告知全新用户缺什么、怎么补，避免装到一半才失败。
$profileDir = ""
if ($env:DSH_HOME) { $profileDir = Join-Path (Join-Path $env:DSH_HOME "profiles") $Profile }
else { $profileDir = Join-Path (Join-Path $env:USERPROFILE ".dsh\profiles") $Profile }

Write-Step "前置检查"
$preflightOk = $true

# ① DSH 必须已安装且跑过一次（profile 存在，插件才能注册进去）
if (-not (Test-Path $profileDir)) {
    Write-Host "    [缺] 未找到 DSH profile: $profileDir" -ForegroundColor Red
    Write-Host "         请先安装并启动一次 DeepSeek Harness（dsh web），" -ForegroundColor Yellow
    Write-Host "         确认 ~/.dsh/profiles/$Profile 生成后再运行本脚本。" -ForegroundColor Yellow
    $preflightOk = $false
} else {
    Write-Host "    [OK] DSH profile: $profileDir" -ForegroundColor Green
}

# ② 桌宠可执行文件：-PetExe 指定 或 部署目录已有 或 本机可构建（Python 3.11+）
$hasExe = $false
if ($PetExe -and (Test-Path $PetExe)) {
    $hasExe = $true
    Write-Host "    [OK] 桌宠 exe（-PetExe）: $PetExe" -ForegroundColor Green
} elseif (Test-Path (Join-Path $InstallPetTo "DshPet.exe")) {
    $hasExe = $true
    Write-Host "    [OK] 桌宠 exe（部署目录已有）" -ForegroundColor Green
} elseif (Test-Path (Join-Path $RepoRoot "dist\DshPet.exe")) {
    $hasExe = $true
    Write-Host "    [OK] 桌宠 exe（仓库 dist/）" -ForegroundColor Green
} else {
    # 无 exe：检查能否自动构建（Python 3.11+）或 pythonw 直启
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    $py3 = $false
    if ($pyLauncher) {
        $probe = & py -3 -c "import sys; print(1 if sys.version_info >= (3, 11) else 0)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $probe -match "1") { $py3 = $true }
    }
    $pythonw = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($py3 -or $pythonw) {
        Write-Host "    [OK] 无现成 exe，将自动构建（Python 3.11+）或 pythonw 直启" -ForegroundColor Green
    } else {
        Write-Host "    [缺] 未找到 DshPet.exe，且本机无 Python 3.11+/pythonw 可自动构建" -ForegroundColor Red
        Write-Host "         请从 GitHub Releases 下载 DshPet.exe，用 -PetExe 指定路径后重跑：" -ForegroundColor Yellow
        Write-Host "         powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -PetExe D:\Downloads\DshPet.exe" -ForegroundColor Yellow
        $preflightOk = $false
    }
}

if (-not $preflightOk) {
    Write-Host ""
    Write-Host "前置检查未通过，安装中止。请按上方提示补齐后重试。" -ForegroundColor Red
    exit 1
}
Write-Host "    前置检查通过，继续安装…" -ForegroundColor Green

# ---------- 1. 部署桌宠 ----------
Write-Step "部署桌宠到 $InstallPetTo"
New-Item -ItemType Directory -Force -Path $InstallPetTo | Out-Null
foreach ($name in @("pet_app.py", "state_listener.py", "pet_loader.py", "pet_style.py", "requirements.txt")) {
    Copy-Item (Join-Path $PetDir $name) $InstallPetTo -Force
}
foreach ($dir in @("assets", "fonts")) {
    $src = Join-Path $PetDir $dir
    if (Test-Path $src) {
        Copy-Item $src $InstallPetTo -Recurse -Force
    }
}
# 宠物目录用 junction 链接到源码 pet/pets/：以后直接在源码目录放宠物
# 即可被打包 exe 识别（"放进去就能用"，无需重新安装/复制）。
$petsSrc = Join-Path $PetDir "pets"
$petsDst = Join-Path $InstallPetTo "pets"
if (Test-Path $petsSrc) {
    if (Test-Path $petsDst) {
        $item = Get-Item $petsDst -Force
        if ($item.LinkType -eq "Junction") {
            # PS 5.1 对 junction 的 Remove-Item -Force 仍会弹确认框，显式关闭
            Remove-Item $petsDst -Force -Confirm:$false
        } else {
            Remove-Item $petsDst -Recurse -Force -Confirm:$false
        }
    }
    New-Item -ItemType Junction -Path $petsDst -Value $petsSrc | Out-Null
    Write-Host "    宠物目录已链接到源码: $petsDst → $petsSrc（放宠物到源码 pets/ 即可用）"
}
$petConfig = Join-Path $InstallPetTo "pet_config.json"
if (-not (Test-Path $petConfig)) {
    Write-Utf8NoBom $petConfig '{"pet": null, "scale": 1.0, "fps": 10, "port": 47890, "always_on_top": true, "show_status_text": false, "show_bubble": true}'
}

# 构建产物（dist/DshPet.exe）存在时自动复制到部署目录（优先使用打包版）
$distExe = Join-Path $RepoRoot "dist\DshPet.exe"
if (Test-Path $distExe) {
    Copy-Item $distExe $InstallPetTo -Force
    Write-Host "    已复制构建产物: $(Get-Item (Join-Path $InstallPetTo 'DshPet.exe') | Select-Object -ExpandProperty LastWriteTime)"
}

# 桌宠可执行文件：优先用户指定；其次已构建的 exe；否则自动构建（有 Python）
# 或回退 pythonw 启动；都没有则给出清晰指引。
# -PetExe 指定的 exe 统一复制进部署目录（桌宠按 exe 所在目录扫描 pets/，
# exe 留在下载目录会导致"未找到宠物包"）。
if ($PetExe -and $PetExe -notmatch "pythonw" -and (Test-Path $PetExe)) {
    $deployedExe = Join-Path $InstallPetTo (Split-Path -Leaf $PetExe)
    Copy-Item $PetExe $deployedExe -Force
    $PetExe = $deployedExe
    Write-Host "    已复制桌宠 exe 到部署目录: $deployedExe"
}
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
                # pythonw 直启：自动安装桌宠依赖（PySide6/Pillow），
                # 避免"桌宠闪退/无响应——缺依赖"的问题。
                $pyExe = Join-Path (Split-Path -Parent $pythonw) "python.exe"
                if (Test-Path $pyExe) {
                    $reqFile = Join-Path $PetDir "requirements.txt"
                    if (Test-Path $reqFile) {
                        Write-Host "    安装桌宠依赖（$reqFile）…" -ForegroundColor Yellow
                        & $pyExe -m pip install --quiet -r $reqFile
                        if ($LASTEXITCODE -eq 0) {
                            Write-Host "    依赖安装完成" -ForegroundColor Green
                        } else {
                            Write-Host "    依赖安装失败（退出码 $LASTEXITCODE）——请手动执行: $pyExe -m pip install -r `"$reqFile`"" -ForegroundColor Yellow
                        }
                    }
                }
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
                # 必须无 BOM 写入：DSH 的 JSON.parse 不认 BOM，带 BOM 会启动崩溃
                Write-Utf8NoBom $profilePkg ($pkg | ConvertTo-Json -Depth 10)
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
        Write-Utf8NoBom $patchFile ($lines -join "`n")
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
        Write-Utf8NoBom $patchFile ($out -join "`n")
        Write-Host "    已将空列表替换为 pet-bridge 配置覆盖"
    } else {
        $trimmed = (Get-Content $patchFile -Raw).TrimEnd()
        Write-Utf8NoBom $patchFile ($trimmed + "`n" + $override)
        Write-Host "    已在列表末尾追加 pet-bridge 配置覆盖"
    }
} else {
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    Write-Utf8NoBom $patchFile $override
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
