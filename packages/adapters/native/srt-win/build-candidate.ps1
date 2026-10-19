# 中文用途：用已有固定离线工具链构建一次隔离候选，不安装、不更新现役 runner。
param([Parameter(Mandatory=$true)][string]$CandidateRoot,[Parameter(Mandatory=$true)][string]$ToolchainRoot,[Parameter(Mandatory=$true)][string]$EvidenceRoot,[string]$ReusableTargetRoot)
$ErrorActionPreference='Stop'
$candidate=(Resolve-Path -LiteralPath $CandidateRoot).Path
$toolchain=(Resolve-Path -LiteralPath $ToolchainRoot).Path
$evidence=[IO.Path]::GetFullPath($EvidenceRoot)
if(Test-Path -LiteralPath $evidence){throw 'Refusing to overwrite build evidence'}
New-Item -ItemType Directory -Path $evidence | Out-Null
if([string]::IsNullOrWhiteSpace($ReusableTargetRoot)){
  $targetDir=Join-Path $evidence 'target'
  $targetCacheMode='new'
}else{
  $targetDir=(Resolve-Path -LiteralPath $ReusableTargetRoot).Path
  if(-not (Test-Path -LiteralPath $targetDir -PathType Container)){throw 'Reusable target directory must already exist'}
  $targetCacheMode='reused-existing-mutable'
}
$rustRoot=Join-Path $toolchain 'portable-1.85.1'
$llvmBin=Join-Path $toolchain 'llvm-mingw/llvm-mingw-20261006-msvcrt-x86_64/bin'
$llvmLib=Join-Path (Split-Path -Parent $llvmBin) 'x86_64-w64-mingw32/lib'
$runtimeLib=Join-Path $rustRoot 'lib/rustlib/x86_64-pc-windows-gnu/lib/self-contained'
$cargo=Join-Path $rustRoot 'bin/cargo.exe'
$rustc=Join-Path $rustRoot 'bin/rustc.exe'
$clang=Join-Path $llvmBin 'x86_64-w64-mingw32-clang.exe'
$ar=Join-Path $llvmBin 'x86_64-w64-mingw32-llvm-ar.exe'
$dlltool=Join-Path $llvmBin 'x86_64-w64-mingw32-dlltool.exe'
$llvmMsvcrt=Join-Path $llvmLib 'libmsvcrt.a'
$inputs=@($cargo,$rustc,$clang,$ar,$dlltool,(Join-Path $candidate 'Cargo.lock'),$llvmMsvcrt,(Join-Path $runtimeLib 'libgcc_eh.a'),(Join-Path $runtimeLib 'libgcc.a'),(Join-Path $runtimeLib 'libpthread.a'))
$fingerprints=@($inputs | ForEach-Object { [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash} })
[IO.File]::WriteAllText((Join-Path $evidence 'build-inputs.json'),(ConvertTo-Json -InputObject $fingerprints -Depth 4))
$version=& $rustc -vV
if($LASTEXITCODE -ne 0 -or -not (($version -join "`n").Contains('rustc 1.85.1 ')) -or -not (($version -join "`n").Contains('host: x86_64-pc-windows-gnu'))){throw 'Unexpected Rust host toolchain'}
$temp=Join-Path $evidence 'tmp'
New-Item -ItemType Directory -Path $temp | Out-Null
$info=[Diagnostics.ProcessStartInfo]::new()
$info.FileName=$cargo
$info.WorkingDirectory=$candidate
$info.UseShellExecute=$false
$info.CreateNoWindow=$true
$info.RedirectStandardOutput=$true
$info.RedirectStandardError=$true
foreach($key in @('RUSTFLAGS','CARGO_BUILD_TARGET','CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS')){[void]$info.Environment.Remove($key)}
$flags=@('-C',"dlltool=$dlltool",'-L',"native=$llvmLib",'-L',"native=$runtimeLib") -join [char]31
$environment=@{RUSTC=$rustc;CARGO_HOME=(Join-Path $toolchain 'cargo-cache');CARGO_TARGET_DIR=$targetDir;CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=$clang;CC_x86_64_pc_windows_gnu=$clang;AR_x86_64_pc_windows_gnu=$ar;CARGO_ENCODED_RUSTFLAGS=$flags;TEMP=$temp;TMP=$temp}
foreach($entry in $environment.GetEnumerator()){$info.Environment[$entry.Key]=[string]$entry.Value}
foreach($argument in @('build','--locked','--offline','--verbose','--bin','srt-win','--jobs','1')){[void]$info.ArgumentList.Add($argument)}
$process=[Diagnostics.Process]::new()
$process.StartInfo=$info
[void]$process.Start()
$out=$process.StandardOutput.ReadToEndAsync()
$err=$process.StandardError.ReadToEndAsync()
if(-not $process.WaitForExit(180000)){
  $process.Kill($true)
  $process.WaitForExit()
  $timedOut=$true
}else{$timedOut=$false}
[IO.File]::WriteAllText((Join-Path $evidence 'stdout.log'),$out.GetAwaiter().GetResult())
[IO.File]::WriteAllText((Join-Path $evidence 'stderr.log'),$err.GetAwaiter().GetResult())
$result=[ordered]@{exitCode=$process.ExitCode;timedOut=$timedOut;command='cargo build --locked --offline --verbose --bin srt-win --jobs 1';explicitTarget=$false;targetDir=$targetDir;targetCacheMode=$targetCacheMode;librarySearchOrder=@($llvmLib,$runtimeLib);linkerTrace='disabled: PE/MinGW linker rejected --trace and -t before archive resolution';encodedFlags=@('-C',"dlltool=$dlltool",'-L',"native=$llvmLib",'-L',"native=$runtimeLib")}
$builtExe=Join-Path $targetDir 'debug/srt-win.exe'
if($process.ExitCode -eq 0 -and (Test-Path -LiteralPath $builtExe)){$exe=Join-Path $evidence 'srt-win.exe';Copy-Item -LiteralPath $builtExe -Destination $exe;$result.builtExe=$builtExe;$result.exe=$exe;$result.sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash}
[IO.File]::WriteAllText((Join-Path $evidence 'result.json'),(ConvertTo-Json -InputObject $result -Depth 4))
$result | ConvertTo-Json -Depth 4
if($timedOut -or $process.ExitCode -ne 0){throw 'Native candidate build failed; preserve logs and use a new evidence directory for any concrete source-directed follow-up'}
