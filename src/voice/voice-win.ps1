# Voice input on Windows (see src/voice.js): listens to the microphone with
# the speech recognizer that comes with Windows (System.Speech, dictation) and
# writes the same JSON lines as voice-mac.swift:
#   {"ready":true}  {"text":"...","final":false}  {"level":0.42}
#   {"text":"...","final":true}  {"error":"..."}
# "stop" on stdin (or stdin closing) ends it. The first argument is a culture
# such as en-US; without one (or one Windows has no recognizer for), the
# recognizer of the system's language.
param([string]$Culture = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Speech
  $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if (-not $installed -or $installed.Count -eq 0) { Emit @{ error = 'no-recognizer' }; exit 1 }
  $info = $null
  if ($Culture) { $info = $installed | Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1 }
  if (-not $info) { $info = $installed | Where-Object { $_.Culture.Name -eq [Globalization.CultureInfo]::CurrentUICulture.Name } | Select-Object -First 1 }
  if (-not $info) { $info = $installed[0] }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToDefaultAudioDevice()
} catch {
  Emit @{ error = "mic: $($_.Exception.Message)" }
  exit 1
}

# The recognizer hears one phrase at a time: the finished phrases, plus the
# guess for the one you are saying.
$done = New-Object System.Collections.Generic.List[string]
$Global:lastLevel = [DateTime]::MinValue
Register-ObjectEvent $engine SpeechRecognized -SourceIdentifier recognized | Out-Null
Register-ObjectEvent $engine SpeechHypothesized -SourceIdentifier hypothesized | Out-Null
Register-ObjectEvent $engine AudioLevelUpdated -SourceIdentifier level | Out-Null
Register-ObjectEvent $engine RecognizeCompleted -SourceIdentifier completed | Out-Null

function Joined($extra) {
  $parts = @($done) + @($extra) | Where-Object { $_ }
  return ($parts -join ' ')
}

$engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Emit @{ ready = $true }

$stdin = [Console]::In.ReadLineAsync()
$stopping = $false
$stopAt = $null
while ($true) {
  $e = Wait-Event -Timeout 0.05
  if ($e) {
    Remove-Event -EventIdentifier $e.EventIdentifier
    switch ($e.SourceIdentifier) {
      'recognized' { $done.Add($e.SourceEventArgs.Result.Text); Emit @{ text = (Joined $null); final = $false } }
      'hypothesized' { if (-not $stopping) { Emit @{ text = (Joined $e.SourceEventArgs.Result.Text); final = $false } } }
      'level' {
        $now = [DateTime]::Now
        if (($now - $Global:lastLevel).TotalMilliseconds -gt 80) {
          $Global:lastLevel = $now
          Emit @{ level = [Math]::Min(1, $e.SourceEventArgs.AudioLevel / 60) }
        }
      }
      'completed' { break }
    }
    if ($e.SourceIdentifier -eq 'completed') { break }
  }
  if (-not $stopping -and $stdin.IsCompleted) {
    $line = $stdin.Result
    if ($line -eq $null -or $line.Trim() -eq 'stop') {
      $stopping = $true
      $stopAt = [DateTime]::Now
      # Stops after the phrase it is hearing, so the last words count.
      $engine.RecognizeAsyncStop()
    } else {
      $stdin = [Console]::In.ReadLineAsync()
    }
  }
  if ($stopping -and ([DateTime]::Now - $stopAt).TotalSeconds -gt 3) { break }
}
Emit @{ text = (Joined $null); final = $true }
$engine.Dispose()
