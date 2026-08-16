# dsh-pet 桌宠打包脚本（PyInstaller）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1
#
# 产出：dist/DshPet.exe（含 pets/assets/fonts 的目录需在 pet/ 下）
# 前置：Python 3.11+（自动检测：仓库 .venv → py 启动器 → 系统 python）
param(
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PetDir = Join-Path $RepoRoot "pet"
$DistDir = Join-Path $RepoRoot "dist"

if (-not $Python) {
    $venvPy = Join-Path $RepoRoot ".venv\Scripts\python.exe"
    if (Test-Path $venvPy) {
        $Python = $venvPy
    } else {
        $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
        if ($pyLauncher) {
            # py 启动器：取实际解释器路径（避免 3.x 选择歧义）
            $probe = & py -3 -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $probe) { $Python = $probe.Trim() }
        }
        if (-not $Python) {
            $sysPy = Get-Command python.exe -ErrorAction SilentlyContinue
            if ($sysPy) { $Python = $sysPy.Source }
        }
    }
}
if (-not $Python -or -not (Test-Path $Python)) {
    throw "未找到 Python 3.11+。请安装 Python（https://www.python.org/downloads/，安装时勾选 Add to PATH），或使用 GitHub Release 中的预构建 DshPet.exe（install.ps1 -PetExe 指定）。"
}

function Invoke-Native {
    # 在 $ErrorActionPreference=Stop 下安全调用外部命令：
    # stderr 输出（如 pip 提示）不应被当作终止错误。
    param([scriptblock]$Command)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $Command
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    return $code
}

Write-Host "==> 安装构建依赖（PyInstaller）"
$code = Invoke-Native { & $Python -m pip install --quiet pyinstaller 2>$null }
if ($code -ne 0) { throw "pip install pyinstaller 失败（退出码 $code）" }

Write-Host "==> PyInstaller 打包 DshPet.exe"
Push-Location $PetDir
try {
    # 数据目录按存在与否动态拼接（fonts/ 缺省时回退系统字体，属正常）
    $dataArgs = @()
    foreach ($dir in @("pets", "assets", "fonts")) {
        if (Test-Path (Join-Path $PetDir $dir)) {
            $dataArgs += "--add-data"
            $dataArgs += "$dir;$dir"
        }
    }
    $code = Invoke-Native { & $Python -m PyInstaller --noconfirm --clean --onefile --windowed --name "DshPet" @dataArgs pet_app.py }
    if ($code -ne 0) { throw "PyInstaller 失败（退出码 $code）" }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Copy-Item (Join-Path $PetDir "dist\DshPet.exe") $DistDir -Force

Write-Host ""
Write-Host "打包完成：$DistDir\DshPet.exe" -ForegroundColor Green
Write-Host "绿色使用：把 DshPet.exe 与 pets/、assets/、fonts/ 放同一目录即可运行。" -ForegroundColor Green
