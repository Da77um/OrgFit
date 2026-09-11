param([ValidateSet('start','stop')][string]$Action='start')
$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$binaryRoot=Join-Path $repoRoot 'work/package/native/bin'
$clusterPath=Join-Path $repoRoot 'work/pg-foundation'
if ($Action -eq 'stop') {
  & (Join-Path $binaryRoot 'pg_ctl.exe') -D $clusterPath -m fast -w stop
  exit $LASTEXITCODE
}
if (!(Test-Path -LiteralPath $clusterPath)) {
  $passwordPath=Join-Path $repoRoot 'work/pg-password.txt'
  & (Join-Path $binaryRoot 'initdb.exe') -D $clusterPath -U postgres -A scram-sha-256 --pwfile $passwordPath --encoding=UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
}
& (Join-Path $binaryRoot 'pg_ctl.exe') -D $clusterPath -l (Join-Path $repoRoot 'work/postgres.log') -o '-h 127.0.0.1 -p 55432' -w start
exit $LASTEXITCODE
