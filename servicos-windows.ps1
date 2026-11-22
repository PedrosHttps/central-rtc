# Sobe os três serviços da Receita direto no Windows, sem Docker. Precisa do Java 25, do Go 1.27 e do Git.
# Na primeira vez clona e compila (demora: o Maven baixa muita coisa). Nas próximas só sobe.
# Cada serviço abre numa janela própria; fechar a janela para o serviço.
#   powershell -ExecutionPolicy Bypass -File servicos-windows.ps1
param([string]$Pasta = "$HOME\Documents\rfb-servicos")
$ErrorActionPreference = 'Stop'

$rg = "$Pasta\calculadora-rtc-regime-regular"
$sn = "$Pasta\calculadora-rtc-simples-nacional"
$df = "$Pasta\calculadora-rtc-gerador-danfse"

function Rodar($dir, [scriptblock]$comando) {
  Push-Location $dir
  try { & $comando; if ($LASTEXITCODE) { throw "Falhou em $dir (código $LASTEXITCODE)." } } finally { Pop-Location }
}

foreach ($r in $rg, $sn, $df) {
  if (-not (Test-Path $r)) { git clone --depth 1 "https://github.com/ReceitaFederal/$(Split-Path $r -Leaf).git" $r }
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

Start-Process java -WorkingDirectory $rg -ArgumentList '-Dspring.profiles.active=offline', '-jar', 'target\api-regime-geral.jar'
Start-Process java -WorkingDirectory $sn -ArgumentList '-Dspring.profiles.active=offline', '-jar', 'target\api-simples-nacional.jar'
# SERVER_PORT só para o DANFSe: o Spring também lê essa variável e mudaria a porta dos serviços Java.
$env:SERVER_PORT = '8081'
Start-Process "$df\danfse.exe" -WorkingDirectory $df
Remove-Item Env:SERVER_PORT

Write-Host 'Serviços subindo: regime geral 8080, Simples Nacional 8082, DANFSe 8081.'
Write-Host 'Os Java levam uns 30 s. Confira com: node painel\cli.js status'
