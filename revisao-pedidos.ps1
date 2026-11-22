# Revisão de pedidos de conta da Central RTC (usado pela tarefa agendada do Claude Code).
# Só faz três coisas. A chave PAINEL_TOKEN_REVISAO é lida do .env aqui dentro e nunca é mostrada.
#   powershell -NoProfile -ExecutionPolicy Bypass -File revisao-pedidos.ps1 listar
#   powershell -NoProfile -ExecutionPolicy Bypass -File revisao-pedidos.ps1 aprovar <email> '<observação>'
#   powershell -NoProfile -ExecutionPolicy Bypass -File revisao-pedidos.ps1 recusar <email> '<observação>'
# A observação vai entre aspas simples: dentro delas o PowerShell não executa nada (com aspas duplas, $(...) rodaria).
param(
  [Parameter(Mandatory = $true)][ValidateSet('listar', 'aprovar', 'recusar')][string]$Acao,
  [string]$Email = '',
  [string]$Observacao = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$linha = Select-String -Path "$PSScriptRoot\.env" -Pattern '^PAINEL_TOKEN_REVISAO=(.+)$'
if (-not $linha) { throw 'PAINEL_TOKEN_REVISAO não está no .env.' }
$cabecalhos = @{ Authorization = "Bearer $($linha.Matches[0].Groups[1].Value)" }
$base = 'http://localhost:3000/api'

if ($Acao -eq 'listar') {
  $resposta = Invoke-RestMethod -Uri "$base/pedidos" -Headers $cabecalhos
  ConvertTo-Json -InputObject @($resposta.pedidos) -Depth 3
  exit 0
}

$Email = $Email.ToLower()
if ($Email -notmatch '^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$') { throw "E-mail inválido: $Email" }
$corpo = [Text.Encoding]::UTF8.GetBytes((@{ observacao = $Observacao } | ConvertTo-Json))
try {
  $resposta = Invoke-RestMethod -Method Post -Uri "$base/usuarios/$([uri]::EscapeDataString($Email))/$Acao" `
    -Headers $cabecalhos -ContentType 'application/json; charset=utf-8' -Body $corpo
  "OK: $($resposta.usuario) agora está $($resposta.status)."
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) { "Esse pedido já tinha sido decidido antes." }
  else { throw }
}
