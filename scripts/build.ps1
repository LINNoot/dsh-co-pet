# dsh-pet 桌宠打包脚本（PyInstaller）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1
#
# 产出：dist/DshPet.exe（含 pets/assets/fonts 的目录需在 pet/ 下）
param(
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PetDir = Join-Path $RepoRoot "pet"
$DistDir = Join-Path $RepoRoot "dist"

if (-not $Python) {
    $venvPy = Join-Path $RepoRoot ".venv\Scripts\python.exe"
    if (Test-Path $venvPy) { $Python = $venvPy }
    else { $Python = (Get-Command python.exe).Source }
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
