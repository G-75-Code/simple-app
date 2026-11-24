# Taps the element on the emulator screen whose text (or description) matches -Text.
# Usage: powershell -File tools\emu-tap.ps1 -Text "Use this folder"
param([Parameter(Mandatory)][string]$Text, [string]$Serial = 'emulator-5554')
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$local = Join-Path $env:TEMP 'emu-ui.xml'
& $adb -s $Serial shell uiautomator dump /sdcard/emu-ui.xml 2>$null | Out-Null
& $adb -s $Serial pull /sdcard/emu-ui.xml $local 2>$null | Out-Null
[xml]$doc = Get-Content $local -Raw
# Case-sensitive; prefer clickable elements (buttons) over plain labels with the same words.
$matches = @($doc.SelectNodes('//node') | Where-Object { $_.text -cmatch $Text -or $_.'content-desc' -cmatch $Text })
$node = ($matches | Where-Object { $_.clickable -eq 'true' } | Select-Object -Last 1)
if (-not $node) { $node = $matches | Select-Object -Last 1 }
if (-not $node) { "NOT FOUND: $Text"; exit 1 }
$b = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
$x = [int](($b[0] + $b[2]) / 2); $y = [int](($b[1] + $b[3]) / 2)
& $adb -s $Serial shell input tap $x $y
"tapped '$($node.text)$($node.'content-desc')' at $x,$y"
