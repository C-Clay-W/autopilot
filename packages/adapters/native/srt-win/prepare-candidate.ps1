# 中文用途：校验固定上游源码并重放受管执行及 Rust 1.85.1 兼容补丁，只写宿主指定的新隔离候选目录。
param([Parameter(Mandatory=$true)][string]$SourceRoot,[Parameter(Mandatory=$true)][string]$CandidateRoot)
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath $SourceRoot).Path
$candidate=[IO.Path]::GetFullPath($CandidateRoot)
if(Test-Path -LiteralPath $candidate){throw 'Refusing to overwrite an existing candidate'}
$manifest=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'source-manifest.json') | ConvertFrom-Json
if(@(Get-ChildItem -LiteralPath $source -Recurse -File).Count -ne @($manifest.baseFiles).Count){throw 'Unexpected source files; fixed native crate required'}
foreach($entry in $manifest.baseFiles){
  if((Get-FileHash -LiteralPath (Join-Path $source $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256){throw "Source fingerprint mismatch: $($entry.path)"}
}
Copy-Item -LiteralPath $source -Destination $candidate -Recurse
$previousCeiling=$env:GIT_CEILING_DIRECTORIES
try {
  # 中文用途：禁止发现外层仓库，否则 Git 会将候选内 src 补丁静默当作范围外跳过。
  $env:GIT_CEILING_DIRECTORIES=[IO.Path]::GetDirectoryName($candidate)
  foreach($patchName in @('managed-execution-v1.patch','rust-1.85.1-compat.patch')){
    $patchPath=Join-Path $PSScriptRoot $patchName
    & git -C $candidate apply --check -- $patchPath
    if($LASTEXITCODE -ne 0){throw "Patch check failed: $patchName; preserve candidate evidence"}
    & git -C $candidate apply -- $patchPath
    if($LASTEXITCODE -ne 0){throw "Patch replay failed: $patchName; preserve candidate evidence"}
  }
  if(-not (Test-Path -LiteralPath (Join-Path $candidate 'src/job_control.rs'))){throw 'Patch did not create control module'}
  # 中文用途：固定两个补丁涉及源码的 LF 字节，避免宿主 autocrlf 配置改变候选指纹。
  foreach($relative in @('src/cli.rs','src/launch.rs','src/lib.rs','src/logon.rs','src/runner.rs','src/job_control.rs','src/reg.rs','src/sam.rs','src/state_db.rs','src/user.rs','src/wfp.rs')){
    $file=Join-Path $candidate $relative
    [IO.File]::WriteAllText($file,[IO.File]::ReadAllText($file).Replace("`r`n","`n"),[Text.UTF8Encoding]::new($false))
  }
}finally{$env:GIT_CEILING_DIRECTORIES=$previousCeiling}
