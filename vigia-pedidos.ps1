# Vigia de pedidos de conta: a cada minuto confere, sem IA, se há pedido pendente na Central RTC.
# Só quando a fila muda (chegou pedido novo) chama o Claude para analisar com revisao-pedidos.md.
# O Claude roda só com a ferramenta Bash e só pode rodar revisao-pedidos.ps1 (a ferramenta PowerShell recusa abrir outro PowerShell).
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File vigia-pedidos.ps1
$ErrorActionPreference = 'Continue'
$pasta = $PSScriptRoot
$script = Join-Path $pasta 'revisao-pedidos.ps1'
$permissao = "Bash(powershell.exe -NoProfile -ExecutionPolicy Bypass -File $($script.Replace('\', '/')) *)"

# Um vigia por vez.
$trava = New-Object System.Threading.Mutex($false, 'Global\central-rtc-vigia-pedidos')
if (-not $trava.WaitOne(0)) { exit 0 }

# Um registro por mês; ficam só os 3 mais recentes, porque eles guardam nome e e-mail de quem pediu conta (LGPD).
function Registrar($texto) {
  Add-Content -Path (Join-Path $pasta "revisao-pedidos-$(Get-Date -Format 'yyyy-MM').log") -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $texto" -Encoding UTF8
}
function LimparRegistros {
  Get-ChildItem $pasta -Filter 'revisao-pedidos*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item
}
function Fila { (& powershell -NoProfile -ExecutionPolicy Bypass -File $script listar 2>$null | Out-String).Trim() }

# No máximo 10 análises por hora: um robô mandando pedidos sem parar não vira uma chamada do Claude a cada minuto.
# Os pedidos não se perdem: a próxima análise olha a fila inteira de uma vez.
$MAX_POR_HORA = 10
function PodeAnalisar([datetime[]]$anteriores, [datetime]$agora) {
  @($anteriores | Where-Object { $_ -gt $agora.AddHours(-1) }).Count -lt $MAX_POR_HORA
}

# Confere a regra acima toda vez que o vigia sobe.
$t0 = Get-Date '2026-01-01 12:00'
if (-not (PodeAnalisar @() $t0) -or (PodeAnalisar @(1..10 | ForEach-Object { $t0.AddMinutes(-$_) }) $t0) -or
    -not (PodeAnalisar @(1..10 | ForEach-Object { $t0.AddMinutes(-60 - $_) }) $t0)) { throw 'PodeAnalisar está errada' }

# Cópia diária das contas para outra pasta: se painel\dados se perder, as contas voltam daqui (ficam as 30 últimas).
$copias = Join-Path $pasta 'copias-contas'
function CopiarContas {
  New-Item -ItemType Directory -Force $copias | Out-Null
  try { Copy-Item (Join-Path $pasta 'painel\dados\usuarios.json') (Join-Path $copias "usuarios-$(Get-Date -Format 'yyyy-MM-dd').json") -ErrorAction Stop }
  catch { return $false }
  Get-ChildItem $copias -Filter 'usuarios-*.json' | Sort-Object Name -Descending | Select-Object -Skip 30 | Remove-Item
  $true
}

# Painel e serviços rodam direto no Windows: se algum cair (ou o computador acabou de ligar), o vigia sobe de novo.
# Espera 5 minutos entre tentativas, porque os Java levam uns 30 s para abrir a porta.
$PORTAS = 3000, 8080, 8081, 8082
function NoAr([int]$porta) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $porta); $true } catch { $false } finally { $c.Dispose() }
}
function ReligarServicos {
  $fora = @($PORTAS | Where-Object { -not (NoAr $_) })
  if (-not $fora.Count) { return $false }
  Registrar "fora do ar: $($fora -join ', '); subindo de novo"
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $pasta 'servicos-windows.ps1')`"", '-Oculto'
  $true
}

Set-Location $pasta
[Console]::OutputEncoding = [Text.Encoding]::UTF8  # a saída do claude é UTF-8; sem isso os acentos quebram no log
$versao = (Get-Item $PSCommandPath).LastWriteTime
Registrar 'vigia iniciado'
$jaAnalisada = '[]'
$analises = @()
$avisouLimite = $false
$copiaFeita = $null
$avisouCopia = $null
while ($true) {
  # Este arquivo mudou: sobe a versão nova e esta cópia sai, sem ninguém precisar reiniciar o vigia à mão.
  if ((Get-Item $PSCommandPath).LastWriteTime -ne $versao) {
    Registrar 'vigia-pedidos.ps1 mudou; reiniciando com a versão nova'
    $trava.ReleaseMutex()
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    exit 0
  }
  $hoje = (Get-Date).Date
  if ($copiaFeita -ne $hoje) {
    if (CopiarContas) { $copiaFeita = $hoje; LimparRegistros; Registrar 'cópia das contas salva' }
    elseif ($avisouCopia -ne $hoje) { Registrar 'não consegui copiar as contas; tento de novo no próximo minuto'; $avisouCopia = $hoje }
  }
  if ((-not $religadoEm -or (Get-Date) -gt $religadoEm.AddMinutes(5)) -and (ReligarServicos)) {
    $religadoEm = Get-Date
    Start-Sleep -Seconds 60
    continue
  }
  $fila = Fila
  if ($LASTEXITCODE -ne 0) {
    Start-Sleep -Seconds 600  # painel fora do ar: tenta de novo em 10 minutos
    continue
  }
  # Só chama o Claude se a fila mudou desde a última análise: pedidos deixados em dúvida não geram nova chamada a cada minuto.
  if ($fila -and $fila -ne '[]' -and $fila -ne $jaAnalisada) {
    $agora = Get-Date
    if (-not (PodeAnalisar $analises $agora)) {
      if (-not $avisouLimite) { Registrar "limite de $MAX_POR_HORA análises por hora atingido; a fila espera"; $avisouLimite = $true }
      Start-Sleep -Seconds 60
      continue
    }
    $avisouLimite = $false
    $analises = @($analises | Where-Object { $_ -gt $agora.AddHours(-1) }) + $agora
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
