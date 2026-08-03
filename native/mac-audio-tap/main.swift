// sei-audio-tap (260728) — macOS system-audio capture for backseat.
//
// Why this exists: Chromium's `audio: 'loopback'` is Windows-only, and that was
// MEASURED, not read — on macOS 26.4 / Electron 42 it returns a track labelled
// "System audio" carrying digital silence in every request shape (see
// src/renderer/src/lib/backseat/captureController.ts). The OS itself is fine:
// ScreenCaptureKit has carried system audio since macOS 13, which is exactly
// how OBS records desktop audio. This helper is the ~150 lines of Swift that
// bridge the gap. It ships inside the .app (Contents/Resources/audio-tap),
// signed and notarized with everything else, so the user installs nothing.
//
// Permission: SCStream audio rides the SCREEN RECORDING TCC permission, which
// Sei already holds by the time backseat runs (the share picker's thumbnails
// need it). Spawned children inherit the parent's TCC attribution, so this
// prompts for nothing new. If attribution ever fails anyway, the stream errors,
// we exit non-zero, and the renderer degrades to video-only — never a hang.
//
// Protocol (deliberately dumb):
//   stdout   raw interleaved Float32 little-endian PCM, 48 kHz stereo,
//            no framing. The reader may chunk it arbitrarily; the format is
//            fixed so any byte boundary is recoverable (samples are 4 bytes,
//            frames are 8 — main re-aligns on frame boundaries).
//   stderr   one JSON object per line: {"event":"ready"} once audio flows,
//            {"event":"error","message":...} before a non-zero exit.
//   stdin    watched for EOF: when the parent dies or closes the pipe, we
//            exit. This is the orphan guard — a tap that outlives its Electron
//            parent would keep the mic-style capture indicator on forever.
//
// Args: every `--exclude <bundle-id>` names an app whose audio must NOT be
// captured. Main passes Sei's own bundle id (and Electron's dev id), so the
// companion's TTS voice never loops back into its own ears — without this the
// transcript would faithfully contain everything the companion just said.

import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation

let SAMPLE_RATE = 48_000
let CHANNELS = 2

func emit(_ obj: [String: String]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
    }
}

func fail(_ message: String) -> Never {
    emit(["event": "error", "message": message])
    exit(1)
}

// ── Args ──────────────────────────────────────────────────────────────────

var excludedBundleIds: Set<String> = []
var args = ArraySlice(CommandLine.arguments.dropFirst())
while let flag = args.first {
    args = args.dropFirst()
    if flag == "--exclude", let id = args.first {
        excludedBundleIds.insert(id)
        args = args.dropFirst()
    }
}

guard #available(macOS 13.0, *) else {
    fail("macOS 13 or newer is required for system audio capture")
}

// ── Stream output ─────────────────────────────────────────────────────────

@available(macOS 13.0, *)
final class AudioSink: NSObject, SCStreamOutput, SCStreamDelegate {
    private let out = FileHandle.standardOutput
    private var announcedReady = false

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        // CoreAudio hands audio as (usually planar) AudioBufferLists; interleave
        // to the fixed wire format here so the JS side never sees a variant.
        guard let pcm = interleavedFloat32(sampleBuffer) else { return }
        if !announcedReady {
            announcedReady = true
            emit(["event": "ready"])
        }
        pcm.withUnsafeBufferPointer { buf in
            let data = Data(buffer: buf)
            // A broken pipe means the parent is gone; exit rather than spin.
            do { try out.write(contentsOf: data) } catch { exit(0) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("stream stopped: \(error.localizedDescription)")
    }

    private func interleavedFloat32(_ sampleBuffer: CMSampleBuffer) -> [Float]? {
        guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee
        else { return nil }
        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        if frameCount <= 0 { return nil }

        var blockBuffer: CMBlockBuffer?
        let listSize = AudioBufferList.sizeInBytes(maximumBuffers: Int(asbd.mChannelsPerFrame))
        let listPtr = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { listPtr.deallocate() }
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: listPtr.assumingMemoryBound(to: AudioBufferList.self),
            bufferListSize: listSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }
        let ablPtr = UnsafeMutableAudioBufferListPointer(listPtr.assumingMemoryBound(to: AudioBufferList.self))

        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        guard isFloat, asbd.mBitsPerChannel == 32 else { return nil }
        let planar = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0

        var outSamples = [Float](repeating: 0, count: frameCount * CHANNELS)
        if planar {
            // One buffer per channel; upmix mono by duplication, ignore extras.
            let planes: [UnsafeMutablePointer<Float>] = ablPtr.compactMap { b in
                b.mData?.assumingMemoryBound(to: Float.self)
            }
            guard !planes.isEmpty else { return nil }
            for frame in 0..<frameCount {
                let l = planes[0][frame]
                let r = planes.count > 1 ? planes[1][frame] : l
                outSamples[frame * 2] = l
                outSamples[frame * 2 + 1] = r
            }
        } else {
            guard let base = ablPtr.first?.mData?.assumingMemoryBound(to: Float.self) else { return nil }
            let srcChannels = Int(asbd.mChannelsPerFrame)
            if srcChannels == CHANNELS {
                outSamples.withUnsafeMutableBufferPointer { dst in
                    dst.baseAddress!.update(from: base, count: frameCount * CHANNELS)
                }
            } else {
                for frame in 0..<frameCount {
                    let l = base[frame * srcChannels]
                    let r = srcChannels > 1 ? base[frame * srcChannels + 1] : l
                    outSamples[frame * 2] = l
                    outSamples[frame * 2 + 1] = r
                }
            }
        }
        return outSamples
    }
}

// ── Orphan guard ──────────────────────────────────────────────────────────

DispatchQueue.global(qos: .background).async {
    // Blocks until stdin EOF (parent exited or closed the pipe), then exits.
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { exit(0) }
    }
}

// ── Capture ───────────────────────────────────────────────────────────────

@available(macOS 13.0, *)
func run() async {
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        fail("shareable content unavailable (screen recording permission?): \(error.localizedDescription)")
    }
    guard let display = content.displays.first else {
        fail("no display found")
    }
    let excludedApps = content.applications.filter { excludedBundleIds.contains($0.bundleIdentifier) }
    // System audio follows the DISPLAY filter: everything on this display's
    // audio mix except the excluded apps (Sei itself). Per-app narrowing (only
    // the shared window's app) is possible with an including-filter, but whole
    // system minus self matches what the player actually hears.
    let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = SAMPLE_RATE
    config.channelCount = CHANNELS
    config.excludesCurrentProcessAudio = true
    // Video is required plumbing we do not consume: keep it as small and slow
    // as SCK allows, and never attach a video output.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

    let sink = AudioSink()
    let stream = SCStream(filter: filter, configuration: config, delegate: sink)
    do {
        try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: DispatchQueue(label: "sei.audio.tap"))
        try await stream.startCapture()
    } catch {
        fail("could not start audio capture: \(error.localizedDescription)")
    }
    // Runs until the orphan guard or a stream error exits the process.
    while true {
        try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
    }
}

if #available(macOS 13.0, *) {
    Task { await run() }
    RunLoop.main.run()
} else {
    fail("unreachable")
}
