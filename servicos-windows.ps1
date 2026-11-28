# Sobe os três serviços da Receita e o painel direto no Windows, sem Docker nem WSL. Precisa do Java 25, do Go 1.27, do Git e do Node 22.
# Na primeira vez clona e compila (demora: o Maven baixa muita coisa). Nas próximas só sobe o que não estiver no ar.
# O painel lê o login e o e-mail do arquivo .env e guarda as contas em painel\dados.
#   powershell -ExecutionPolicy Bypass -File servicos-windows.ps1           (cada serviço numa janela; fechar a janela para o serviço)
#   powershell -ExecutionPolicy Bypass -File servicos-windows.ps1 -Oculto   (sem janelas, saída em <Pasta>\logs; é assim que o vigia religa)
param([string]$Pasta = "$HOME\Documents\rfb-servicos", [switch]$Oculto)
$ErrorActionPreference = 'Stop'

$rg = "$Pasta\calculadora-rtc-regime-regular"
$sn = "$Pasta\calculadora-rtc-simples-nacional"
$df = "$Pasta\calculadora-rtc-gerador-danfse"
# Mesmo commit do docker-compose.yml (DANFSe 1.0.0): mudança no repositório da Receita só entra quando alguém trocar aqui.
$DANFSE_COMMIT = '8d79e6b2f7fad6375340afcb51c85ed370c64a14'

function Rodar($dir, [scriptblock]$comando) {
  Push-Location $dir
  try { & $comando; if ($LASTEXITCODE) { throw "Falhou em $dir (código $LASTEXITCODE)." } } finally { Pop-Location }
}

function NoAr([int]$porta) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $porta); $true } catch { $false } finally { $c.Dispose() }
}

# Sem janela, a saída vai para um arquivo por serviço, recriado a cada vez que ele sobe.
function Subir($nome, $porta, $programa, $dir, $argumentos) {
  if (NoAr $porta) { Write-Host "$nome já está no ar ($porta)."; return }
  $opcoes = @{ FilePath = $programa; WorkingDirectory = $dir }
  if ($argumentos) { $opcoes.ArgumentList = $argumentos }
  if ($Oculto) {
    New-Item -ItemType Directory -Force "$Pasta\logs" | Out-Null
    $opcoes += @{ WindowStyle = 'Hidden'; RedirectStandardOutput = "$Pasta\logs\$nome.log"; RedirectStandardError = "$Pasta\logs\$nome-erros.log" }
  }
  Start-Process @opcoes
  Write-Host "$nome subindo ($porta)."
}

foreach ($r in $rg, $sn, $df) {
  if (-not (Test-Path $r)) { git clone --depth 1 "https://github.com/ReceitaFederal/$(Split-Path $r -Leaf).git" $r }
}
if ((git -C $df rev-parse HEAD) -ne $DANFSE_COMMIT) {
  git -C $df fetch --depth 1 origin $DANFSE_COMMIT
  git -C $df checkout --quiet $DANFSE_COMMIT
  if (Test-Path "$df\danfse.exe") { Remove-Item "$df\danfse.exe" }
}

# O banco é gerado uma vez com as migrações do regime regular; o Simples Nacional usa uma cópia.
$banco = "$rg\calculadora\db\calculadora-pro.db"
if (-not (Test-Path $banco)) {
  Write-Host 'Gerando o banco de dados...'
  New-Item -ItemType Directory -Force (Split-Path $banco) | Out-Null
  Rodar $rg { .\mvnw.cmd -B --no-transfer-progress flyway:migrate '-Dflyway.configFiles=flyway\flyway-pro.conf' }
}
if (-not (Test-Path "$sn\calculadora\db\calculadora-pro.db")) {
  New-Item -ItemType Directory -Force "$sn\calculadora\db" | Out-Null
  Copy-Item $banco "$sn\calculadora\db\"
}

# Um build por vez para caber em 8 GB de RAM.
if (-not (Test-Path "$rg\target\api-regime-geral.jar")) { Write-Host 'Compilando o regime geral...'; Rodar $rg { .\mvnw.cmd -B --no-transfer-progress -DskipTests package } }
if (-not (Test-Path "$sn\target\api-simples-nacional.jar")) { Write-Host 'Compilando o Simples Nacional...'; Rodar $sn { .\mvnw.cmd -B --no-transfer-progress -DskipTests package } }
if (-not (Test-Path "$df\danfse.exe")) { Write-Host 'Compilando o DANFSe...'; Rodar $df { go build -o danfse.exe ./cmd/danfse } }

# Sem limite, cada Java reserva até 1/4 da memória do computador.
$java = '-Xmx384m', '-Dspring.profiles.active=offline', '-jar'
Subir 'regime-geral' 8080 'java' $rg ($java + 'target\api-regime-geral.jar')
Subir 'simples-nacional' 8082 'java' $sn ($java + 'target\api-simples-nacional.jar')
# SERVER_PORT só para o DANFSe: o Spring também lê essa variável e mudaria a porta dos serviços Java.
$env:SERVER_PORT = '8081'
Subir 'danfse' 8081 "$df\danfse.exe" $df $null
Remove-Item Env:SERVER_PORT

# Painel: as variáveis do .env valem só para o processo dele (KEY=valor por linha; # começa comentário).
$envArquivo = Join-Path $PSScriptRoot '.env'
$definidas = @()
if (Test-Path $envArquivo) {
  foreach ($linha in Get-Content $envArquivo -Encoding UTF8) {
    if ($linha -match '^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$') {
      $valor = $Matches[2].Trim()
      if ($valor -match '^"(.*)"$' -or $valor -match "^'(.*)'$") { $valor = $Matches[1] }
      Set-Item "Env:$($Matches[1])" $valor
      $definidas += $Matches[1]
    }
  }
}
# Sem janela é o painel publicado na internet (o vigia religa assim): sem senha ele abriria sem login para qualquer um.
if ($Oculto -and -not $env:PAINEL_SENHA) { throw 'Sem PAINEL_SENHA no .env: o painel subiria sem login.' }
Subir 'painel' 3000 'node' (Join-Path $PSScriptRoot 'painel') 'server.js'
foreach ($nome in $definidas) { Remove-Item "Env:$nome" }

Write-Host 'Painel em http://localhost:3000. Os Java levam uns 30 s. Confira com: node painel\cli.js status'
