# Vigia de pedidos de conta: a cada minuto confere, sem IA, se há pedido pendente na Central RTC.
# Só quando a fila muda (chegou pedido novo) chama o Claude para analisar com revisao-pedidos.md.
# O Claude roda só com a ferramenta Bash e só pode rodar revisao-pedidos.ps1 (a ferramenta PowerShell recusa abrir outro PowerShell).
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File vigia-pedidos.ps1
$ErrorActionPreference = 'Continue'
$pasta = $PSScriptRoot
$script = Join-Path $pasta 'revisao-pedidos.ps1'
$log = Join-Path $pasta 'revisao-pedidos.log'
$permissao = "Bash(powershell.exe -NoProfile -ExecutionPolicy Bypass -File $($script.Replace('\', '/')) *)"

# Um vigia por vez.
$trava = New-Object System.Threading.Mutex($false, 'Global\central-rtc-vigia-pedidos')
if (-not $trava.WaitOne(0)) { exit 0 }

function Registrar($texto) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $texto" -Encoding UTF8 }
function Fila { (& powershell -NoProfile -ExecutionPolicy Bypass -File $script listar 2>$null | Out-String).Trim() }

Set-Location $pasta
Registrar 'vigia iniciado'
$jaAnalisada = '[]'
while ($true) {
  $fila = Fila
  if ($LASTEXITCODE -ne 0) {
    Start-Sleep -Seconds 600  # painel fora do ar: tenta de novo em 10 minutos
    continue
  }
  # Só chama o Claude se a fila mudou desde a última análise: pedidos deixados em dúvida não geram nova chamada a cada minuto.
  if ($fila -and $fila -ne '[]' -and $fila -ne $jaAnalisada) {
    Registrar 'pedido novo na fila, chamando o Claude'
    $resposta = Get-Content (Join-Path $pasta 'revisao-pedidos.md') -Raw -Encoding UTF8 |
      & claude -p --tools Bash --allowedTools $permissao 2>&1 | Out-String
    $ok = $LASTEXITCODE -eq 0
    Registrar $resposta.Trim()
    if ($ok) { $jaAnalisada = Fila }
    else { Registrar 'a análise falhou; nova tentativa em 10 minutos'; Start-Sleep -Seconds 600 }
  }
  Start-Sleep -Seconds 60
}
