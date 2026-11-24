# Pairs the OnePlus 13R emulator with the laptop TEST copy (npm run start:test) - no camera needed.
# Usage: powershell -File tools\pair-emulator.ps1
$ErrorActionPreference = 'Continue'
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$serial = 'emulator-5554'
$file = "$env:APPDATA\Simple Test\test-pairing.json"

function Read-TestPairing { if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json } }

$info = Read-TestPairing
if (-not $info) { throw 'Start the laptop test copy first: npm.cmd run start:test (in the laptop folder)' }
if ($info.screen -eq 'paired') { 'The test copy is already paired. Unpair it first (S logo > Unpair).'; exit 0 }
if (-not $info.link) { throw "The test copy isn't showing a QR code (screen: $($info.screen))." }

# Open Simple on the emulator, then hand it the pairing link
& $adb -s $serial shell monkey -p com.simpleapp.mobile -c android.intent.category.LAUNCHER 1 2>$null | Out-Null
Start-Sleep -Seconds 3
& $adb -s $serial shell "am start -a android.intent.action.VIEW -d '$($info.link)' com.simpleapp.mobile" 2>$null | Out-Null

# Wait for the OTP to appear on the laptop test copy
$otp = $null
for ($i = 0; $i -lt 30 -and -not $otp; $i++) { Start-Sleep -Milliseconds 500; $otp = (Read-TestPairing).otp }
if (-not $otp) { throw 'No OTP appeared on the laptop test copy. Is the emulator on and Simple installed?' }

# Type the OTP on the emulator and press Enter
Start-Sleep -Seconds 1
& $adb -s $serial shell input text $otp
& $adb -s $serial shell input keyevent 66

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if ((Read-TestPairing).screen -eq 'paired') { 'Emulator paired with the laptop test copy.'; exit 0 }
}
throw 'Pairing did not finish. Check both screens.'
