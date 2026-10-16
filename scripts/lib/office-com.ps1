# Export an Office document to PDF using the application's own rendering engine
# (PowerPoint / Word / Excel COM automation).
#
# Why Windows PowerShell 5.1 and not PowerShell 7:
#   PowerShell 7 runs on .NET Core, where Office COM interop fails with
#   TYPE_E_CANTLOADLIBRARY (0x80029C4A) when querying the _Application interface.
#   Windows PowerShell 5.1 (.NET Framework) works. Run this file with
#   powershell.exe -File, NOT pwsh.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File export-pdf.ps1 `
#     -Kind pptx -Src "input.pptx" -Out "output.pdf"
#
# Prints "OK <path> <bytes>" on success, or "ERR <message>" on failure.

param(
  [Parameter(Mandatory = $true)][ValidateSet('pptx', 'docx', 'xlsx')][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

# Make Office automation quiet and non-interactive.
$app = $null
$doc = $null

try {
  switch ($Kind) {
    'pptx' {
      $app = New-Object -ComObject PowerPoint.Application
      # Open(FileName, ReadOnly=-1, Untitled=0, WithWindow=0)
      $doc = $app.Presentations.Open($Src, -1, 0, 0)
      # 32 = ppSaveAsPDF
      $doc.SaveAs($Out, 32)
    }
    'docx' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      # Open(FileName, ConfirmConversions=$false, ReadOnly=$true, AddToRecentFiles=$false)
      $doc = $app.Documents.Open($Src, $false, $true, $false)
      # 17 = wdExportFormatPDF
      $doc.SaveAs([ref]$Out, [ref]17)
    }
    'xlsx' {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $doc = $app.Workbooks.Open($Src, 0, $true)
      # 0 = xlTypePDF
      $doc.ExportAsFixedFormat(0, $Out)
    }
  }

  if ($doc -ne $null) { $doc.Close($false) }
  if ($app -ne $null) { $app.Quit() }

  if (Test-Path -LiteralPath $Out) {
    $size = (Get-Item -LiteralPath $Out).Length
    Write-Output "OK $Out $size"
    exit 0
  }
  Write-Output 'ERR output file was not created'
  exit 1
}
catch {
  Write-Output "ERR $($_.Exception.Message)"
  try { if ($doc -ne $null) { $doc.Close($false) } } catch { }
  try { if ($app -ne $null) { $app.Quit() } } catch { }
  exit 1
}
