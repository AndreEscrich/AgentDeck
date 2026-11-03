// Voice input on macOS (see src/voice.js): listens to the microphone and
// writes what Apple's speech recognition hears, as JSON lines on stdout:
//   {"ready":true}                  listening
//   {"text":"...","final":false}    everything heard so far (it can change)
//   {"level":0.42}                  how loud it is, 0 to 1, about 12 times a second
//   {"text":"...","final":true}     the last text, then it exits
//   {"error":"speech-denied"|"mic-denied"|"no-recognizer"|"..."}
// "stop" on stdin (or stdin closing) ends it. The first argument is a locale
// such as en-US; without one, the system's language.
//
// scripts/build-voice-mac.sh builds the binary next to this file (it is in
// the repository, so nobody needs Xcode), with an Info.plist inside it that
// has the usage descriptions macOS asks for.

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

// macOS asks for the microphone and speech recognition on behalf of the app
// that started a program, and Agent Hub gets a new signature each time it is
// rebuilt, which makes macOS forget what you allowed. So this program first
// replaces itself with a copy of itself that answers for itself
// (responsibility_spawnattrs_setdisclaim; POSIX_SPAWN_SETEXEC keeps the
// process and its stdin and stdout). You allow "Agent Hub Voice" once.
if ProcessInfo.processInfo.environment["AGENT_HUB_VOICE_OWN"] == nil,
   let path = Bundle.main.executablePath,
   let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") {
  typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  _ = unsafeBitCast(sym, to: Disclaim.self)(&attr, 1)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
  setenv("AGENT_HUB_VOICE_OWN", "1", 1)
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var pid: pid_t = 0
  posix_spawn(&pid, path, nil, &attr, &argv, environ)
  // Only reached when that failed: carry on as we are.
}

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

func fail(_ code: String) -> Never {
  emit(["error": code])
  exit(1)
}

let args = CommandLine.arguments
let locale = args.count > 1 && !args[1].isEmpty ? Locale(identifier: args[1]) : Locale.current
guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else { fail("no-recognizer") }

let wait = DispatchSemaphore(value: 0)
var speechOK = false
SFSpeechRecognizer.requestAuthorization { status in
  speechOK = status == .authorized
  wait.signal()
}
wait.wait()
if !speechOK { fail("speech-denied") }

var micOK = false
AVCaptureDevice.requestAccess(for: .audio) { ok in
  micOK = ok
  wait.signal()
}
wait.wait()
if !micOK { fail("mic-denied") }
if !recognizer.isAvailable { fail("not-available") }

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
if #available(macOS 13, *) { request.addsPunctuation = true }

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
var lastLevel = Date.distantPast
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
  request.append(buffer)
  let now = Date()
  guard now.timeIntervalSince(lastLevel) > 0.08, let data = buffer.floatChannelData?[0] else { return }
  lastLevel = now
  var sum: Float = 0
  let n = Int(buffer.frameLength)
  for i in 0..<n { sum += data[i] * data[i] }
  let rms = n > 0 ? sqrt(sum / Float(n)) : 0
  // About -50 dB is silence and -10 dB loud speech.
  let db = 20 * log10(max(rms, 0.000_01))
  emit(["level": Double(max(0, min(1, (db + 50) / 40)))])
}

var lastText = ""
var finished = false
var stopping = false
func finish() {
  if finished { return }
  finished = true
  emit(["text": lastText, "final": true])
  exit(0)
}

let task = recognizer.recognitionTask(with: request) { result, error in
  DispatchQueue.main.async {
    if let result = result {
      lastText = result.bestTranscription.formattedString
      if result.isFinal { finish() }
      emit(["text": lastText, "final": false])
    }
    // An error after you stopped (nothing more to hear) ends it with the
    // text so far; before, it says what went wrong.
    if let error = error, !finished {
      if stopping { finish() }
      let code = (error as NSError).code
      // 1110: nothing was said.
      if code == 1110 { finish() }
      emit(["error": error.localizedDescription])
      exit(1)
    }
  }
}

do {
  engine.prepare()
  try engine.start()
} catch {
  fail("mic: \(error.localizedDescription)")
}
emit(["ready": true])

func stop() {
  DispatchQueue.main.async {
    if stopping { return }
    stopping = true
    engine.stop()
    input.removeTap(onBus: 0)
    request.endAudio()
    // The last words take a moment; after 3 seconds it ends with what it has.
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }
  }
}

DispatchQueue.global().async {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
  }
  stop()
}

_ = task
dispatchMain()
