// Sei screen-text helper (260803) — macOS Vision OCR for backseat.
//
// Reads what is WRITTEN on the shared screen so the companion can follow the
// parts a downscaled grid cell cannot show: a subtitle, a quest log, a kill
// feed, a headline, a menu, a price.
//
// Why a native helper rather than the tesseract.js path this replaces on macOS,
// measured on four frames of the Valorant test clip (Tesseract at 2x upscale,
// which it needs, against Vision at native 1280x720, which it does not):
//
//   0:14  tesseract  "Orange 50 NG IN"
//         vision     "B Orange 5 SPIKE PLANTED 50 100 1,550"
//   0:40  tesseract  "A Site ne i 410 (OPERATOR 100 1"
//         vision     "A Site 1:17 SIGNATURE ABILITY CHARGED 410 100 2,150"
//   1:28  tesseract  "KILLED BY vio COMBAT 46 55 Team Clin In Deteader Side Spawn"
//         vision     "Sova KILLED BY Sova OUTGOING 105 COMBAT REPORT INCOMING 46
//                     Karasu ... Defender Side Spawn Team (Eliminated) 190 KILLED 146"
//
//   ~1000 ms/frame                        ~100 ms/frame
//
// Whole phrases instead of fragments, an order of magnitude faster, and no
// upscale pass. Tesseract stays as the fallback on every other platform.
//
// Protocol, over stdio, one frame at a time:
//
//   stdout, once at startup   "ready\n"  (or "error <reason>\n" and exit 1)
//   stdin,  per request       4-byte big-endian length, then that many JPEG bytes
//   stdout, per request       one JSON line: {"lines":[{"t":"...","c":93}],"ms":91}
//
// Sequential by construction: the caller sends the next frame only after
// reading a reply. A queue would only ever hold pictures of a screen that has
// already moved on.
//
//   swiftc -O -target arm64-apple-macos13.0 -o sei-mac-ocr main.swift

import Foundation
import Vision
import CoreGraphics
import ImageIO

// ── Options ────────────────────────────────────────────────────────────────
// --lang is best-effort: an unsupported tag falls back to en-US rather than
// failing the session, because a companion reading English off a Japanese game
// is still better than a companion reading nothing.
var requested = ["en-US"]
var args = Array(CommandLine.arguments.dropFirst())
while let i = args.firstIndex(of: "--lang"), i + 1 < args.count {
    requested = [args[i + 1]]
    args.removeSubrange(i...(i + 1))
}

let supported: [String] = {
    let probe = VNRecognizeTextRequest()
    probe.recognitionLevel = .accurate
    return (try? probe.supportedRecognitionLanguages()) ?? ["en-US"]
}()
// Match on the language subtag so "en" finds "en-US" and "pt" finds "pt-BR".
let languages: [String] = {
    for want in requested {
        if supported.contains(want) { return [want] }
        let base = want.split(separator: "-").first.map(String.init) ?? want
        if let hit = supported.first(where: { $0.hasPrefix(base) }) { return [hit] }
    }
    return supported.contains("en-US") ? ["en-US"] : Array(supported.prefix(1))
}()

// ── stdio plumbing ─────────────────────────────────────────────────────────

let stdinFd = FileHandle.standardInput
let stdoutFd = FileHandle.standardOutput

func emit(_ line: String) {
    if let d = (line + "\n").data(using: .utf8) { stdoutFd.write(d) }
}

/// Read exactly `n` bytes, or nil at EOF. readData(ofLength:) is documented to
/// return UP TO n bytes, so a single call cannot be trusted with a framed
/// protocol: a 90 KB JPEG regularly arrives across several pipe reads.
func readExactly(_ n: Int) -> Data? {
    var out = Data()
    out.reserveCapacity(n)
    while out.count < n {
        let chunk = stdinFd.readData(ofLength: n - out.count)
        if chunk.isEmpty { return nil }
        out.append(chunk)
    }
    return out
}

func decode(_ jpeg: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(jpeg as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

// ── Recognition ────────────────────────────────────────────────────────────

/// One observation per LINE, which is why the line structure survives to the
/// prompt: "SPIKE PLANTED" and a score that happen to sit at the same height
/// are different lines on screen and different lines in the reading.
func recognize(_ image: CGImage) -> [(String, Int)] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    // Off deliberately. Correction is tuned for prose and this is not prose: it
    // is proper nouns, callouts, ability names and scoreboard tokens, which are
    // exactly what a companion needs verbatim to talk about them. Measured, it
    // changed almost nothing on real text and rewrote names.
    req.usesLanguageCorrection = false
    // The default floor is 1/32 of image height, which discards most of a HUD.
    req.minimumTextHeight = 0.008
    req.recognitionLanguages = languages
    if #available(macOS 13.0, *) { req.revision = VNRecognizeTextRequestRevision3 }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([req]) } catch { return [] }

    var out: [(String, Int)] = []
    for obs in (req.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let text = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        out.append((text, Int((top.confidence * 100).rounded())))
    }
    return out
}

func json(_ lines: [(String, Int)], ms: Int) -> String {
    let payload: [String: Any] = [
        "lines": lines.map { ["t": $0.0, "c": $0.1] },
        "ms": ms,
    ]
    guard let d = try? JSONSerialization.data(withJSONObject: payload),
          let s = String(data: d, encoding: .utf8) else { return "{\"lines\":[],\"ms\":0}" }
    return s
}

// ── Main loop ──────────────────────────────────────────────────────────────

// Warm the engine before declaring ready: the first recognition loads models
// and takes several times as long as the rest, and paying that here means the
// first real frame of a session is as fast as the hundredth.
if let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                       space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
   let blank = ctx.makeImage() {
    _ = recognize(blank)
}

emit("ready \(languages.joined(separator: ","))")

while true {
    guard let header = readExactly(4) else { break }
    let n = header.withUnsafeBytes { UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self)) }
    // A length this size means the stream desynchronised; there is no way to
    // resynchronise a framed protocol, so stop rather than allocate on garbage.
    if n == 0 || n > 64_000_000 { break }
    guard let jpeg = readExactly(Int(n)) else { break }

    let started = Date()
    guard let image = decode(jpeg) else {
        emit(json([], ms: 0))
        continue
    }
    let lines = recognize(image)
    emit(json(lines, ms: Int(Date().timeIntervalSince(started) * 1000)))
}
