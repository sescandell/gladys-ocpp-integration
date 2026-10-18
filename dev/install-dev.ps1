<#
.SYNOPSIS
  Construit les images de l'intégration en local et les installe (ou met à jour)
  sur l'instance Gladys de test, en mode "dev" : rien n'est publié.

.DESCRIPTION
  1. construit gladys-ocpp-gateway:dev et gladys-ocpp:dev (cette dernière porte le
     manifest dans le label io.gladysassistant.manifest, que Gladys relit à chaque
     mise à jour) ;
  2. se connecte à Gladys ;
  3. installe l'intégration, ou la met à jour si elle est déjà installée
     (-Reinstall : désinstalle d'abord, ce qui SUPPRIME ses appareils et sa config).

  À lancer depuis n'importe où ; cible l'instance de test (par défaut localhost:8080).
#>
param(
  [string]$GladysUrl = 'http://localhost:8080',
  [string]$Email,
  [switch]$Reinstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
# Les guillemets du JSON passé à `docker build --label` doivent arriver intacts.
$PSNativeCommandArgumentPassing = 'Standard'

$root = Split-Path -Parent $PSScriptRoot
$mainImage = 'gladys-ocpp:dev'
$gatewayImage = 'gladys-ocpp-gateway:dev'

# --- Manifest de dev : les images pointent vers les tags locaux ---------------
$manifest = Get-Content (Join-Path $root 'gladys-assistant-integration.json') -Raw | ConvertFrom-Json
$manifest.docker_image = $mainImage
$manifest.containers[0].docker_image = $gatewayImage
$manifestJson = $manifest | ConvertTo-Json -Depth 20 -Compress

# --- Images --------------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host "Construction de $gatewayImage..." -ForegroundColor Cyan
  docker build -t $gatewayImage (Join-Path $root 'gateway')
  if ($LASTEXITCODE -ne 0) { throw 'docker build (gateway) a échoué' }

  Write-Host "Construction de $mainImage..." -ForegroundColor Cyan
  docker build -t $mainImage --label "io.gladysassistant.manifest=$manifestJson" $root
  if ($LASTEXITCODE -ne 0) { throw 'docker build (intégration) a échoué' }
}

# --- Connexion -----------------------------------------------------------------
if (-not $Email) { $Email = Read-Host 'Email du compte Gladys de test' }
# GLADYS_PASSWORD (variable d'environnement) évite la saisie, pour un lancement sans console.
$password = $env:GLADYS_PASSWORD
if (-not $password) {
  $secure = Read-Host 'Mot de passe' -AsSecureString
  $password = [System.Net.NetworkCredential]::new('', $secure).Password
}

$login = Invoke-RestMethod -Method Post -Uri "$GladysUrl/api/v1/login" -ContentType 'application/json' `
  -Body (@{ email = $Email; password = $password } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.access_token)" }

function Invoke-Gladys([string]$Method, [string]$Path, $Body) {
  $params = @{ Method = $Method; Uri = "$GladysUrl$Path"; Headers = $headers; ContentType = 'application/json' }
  if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
  Invoke-RestMethod @params
}

# --- Installation ou mise à jour -----------------------------------------------
$installed = @(Invoke-Gladys 'Get' '/api/v1/external_integration' $null) |
  Where-Object { $_.docker_image -eq $mainImage }

if ($installed -and $Reinstall) {
  Write-Host "Désinstallation de $($installed.selector) (appareils et config supprimés)..." -ForegroundColor Yellow
  Invoke-Gladys 'Delete' "/api/v1/external_integration/$($installed.selector)" $null | Out-Null
  $installed = $null
}

if ($installed) {
  Write-Host "Mise à jour de $($installed.selector) avec les images locales..." -ForegroundColor Cyan
  $result = Invoke-Gladys 'Post' "/api/v1/external_integration/$($installed.selector)/update" $null
} else {
  Write-Host 'Installation de l''intégration (mode dev)...' -ForegroundColor Cyan
  $result = Invoke-Gladys 'Post' '/api/v1/external_integration' @{ docker_image = $mainImage; manifest = $manifest }
}

Write-Host "OK : $($result.selector) (statut $($result.status))" -ForegroundColor Green
Write-Host "Ouvrez $GladysUrl : la supervision de l'intégration donne l'URL OCPP de la gateway."
