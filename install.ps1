param(
    [string]$SillyTavernPath,
    [string]$StatePath,
    [string]$Profile,
    [string]$RuntimePath,
    [string]$RepositoryPath
)
$ErrorActionPreference = 'Stop'
try {
    if (-not $SillyTavernPath) { $SillyTavernPath = Read-Host '请输入已安装并完成首次启动的 SillyTavern 目录（先关闭酒馆）' }
    if (-not $SillyTavernPath) { throw '未指定酒馆目录。' }
    $SillyTavernPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SillyTavernPath.Trim('"')).Path)
    $standardRepository = [IO.Path]::GetFullPath((Join-Path $SillyTavernPath 'plugins\tavernsyn'))
    if (-not $RepositoryPath) { $RepositoryPath = $standardRepository }
    $RepositoryPath = [IO.Path]::GetFullPath($RepositoryPath)
    if (-not $RepositoryPath.TrimEnd('\').Equals($standardRepository, [StringComparison]::OrdinalIgnoreCase)) { throw '代码统一安装到酒馆的 plugins\tavernsyn，请省略 RepositoryPath 参数。' }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path -LiteralPath $node)) { throw '请先安装 Node.js 20 或以上版本，并完成酒馆首次启动。' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '请先安装 Git for Windows，再重新运行安装脚本。' }
    $source = $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $source 'bin\setup-device.mjs'))) {
        $source = $RepositoryPath
        if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath (Join-Path $source 'bin\setup-device.mjs'))) {
            $source = Join-Path $SillyTavernPath ('.tavernsyn-download-' + [Guid]::NewGuid().ToString())
        }
        if (-not (Test-Path -LiteralPath $source)) {
            & git clone --depth 1 --branch main 'https://github.com/anyKami/tavernSyn.git' $source
            if ($LASTEXITCODE -ne 0) { throw '下载 TavernSyn 失败，请检查 GitHub 连接。' }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $source 'bin\setup-device.mjs'))) { throw '仓库缺少安装器，请先更新酒馆 plugins\tavernsyn 中的代码。' }
        Write-Host "使用仓库：$source（已有仓库请先自行 git pull 更新）"
    }
    $arguments = @((Join-Path $source 'bin\setup-device.mjs'), '--st', $SillyTavernPath, '--repository', $RepositoryPath)
    if ($StatePath) { $arguments += @('--state', [IO.Path]::GetFullPath($StatePath)) }
    if ($Profile) { $arguments += @('--profile', $Profile) }
    if ($RuntimePath) { $arguments += @('--runtime', [IO.Path]::GetFullPath($RuntimePath)) }
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw '安装没有完成，请处理上面的错误后重新运行；已有配置和账号密码会保留。' }
} catch {
    Write-Error $_
    exit 1
}
