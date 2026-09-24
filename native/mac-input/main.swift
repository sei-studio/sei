// sei-mac-input (260925, backseat act M0 spike): mouse + keyboard injection,
// window/display queries, full-resolution screenshots and a user-input
// watcher, for the backseat "act" loop in main (src/main/computerUse/).
//
// Modeled on native/mac-audio-tap: a tiny Swift binary shipped in
// Contents/Resources/mac-input, signed and notarized with the app, spawned by
// main with stdio pipes. No entitlement is needed under the hardened runtime.
//
// Permissions. Posting events needs the Accessibility (PostEvent) TCC grant.
// Screenshots need Screen Recording, which backseat already requires. A child
// spawned by Sei.app should be attributed to Sei.app as the "responsible
// process" (that is how the audio tap's Screen Recording works), but whether
// macOS 26 does the same for PostEvent is the open question this spike
// answers: `ping` reports AXIsProcessTrusted, CGPreflightPostEventAccess and
// CGPreflightScreenCaptureAccess as the helper sees them.
//
// Protocol (JSON lines):
//   stdin    one request per line: {"id":N,"cmd":"...", ...args}
//   stdout   one line per response: {"id":N,"ok":true, ...} or
//            {"id":N,"ok":false,"error":"..."}; and unsolicited events:
//            {"event":"ready",...} once at start, {"event":"user_input",...}
//            when the armed watcher sees the player's own input (once per
//            arming; the in-flight action is already cancelled by then, and
//            every later action is refused until `watch` re-arms).
//   stderr   free-form diagnostics.
//   EOF on stdin releases every held key and button, then exits (orphan
//   guard). A helper that outlives its parent with a key held down would be
//   the computer-use version of the stop-button lag.
//
// Commands. Actions (serial, cancellable): move, click, drag, scroll, key,
// key_down, key_up, hold, type, wait. Queries: ping, permissions, frontmost,
// app, windows, window, displays, cursor, keys, screenshot (+ optional
// `thumb` and `ocr` on the same frame), ax_dump (the Accessibility tree of a
// pid), ax_focused (the focused element, used to refuse typing into secure
// fields), watch. Control: cancel, release_all. Test only (needs
// SEI_MAC_INPUT_TEST=1 in the helper's environment, which Sei never sets):
// test_user_event, an UNTAGGED event standing in for the player;
// test_secure_input, secure event input on/off as a password field sets it.
//
// Coordinates are GLOBAL POINTS in the Quartz space: origin at the top-left
// of the main display, y down. That is the space CGEvent, CGWindowList and
// CGDisplayBounds use, and on macOS it is also Electron's screen DIP space.
//
// Concurrency. Queries (and cancel/release_all) are answered from the stdin
// reader thread. Actions run one at a time on a serial queue. `cancel` bumps a
// generation counter that every long action polls between steps, then
// releases everything held, so a stop never waits behind a drag or a held key.
//
// Our events vs the player's. Every event we post is TAGGED with SEI_EVENT_TAG
// in kCGEventSourceUserData. The watcher is an active CGEventTap (it passes
// every event through untouched) that treats any UNTAGGED key or mouse event
// as the player taking over: it cancels the in-flight action on the spot and
// tells main. An active tap needs the Accessibility grant that posting already
// needs; a listen-only tap would need Input Monitoring for key events, which
// Sei deliberately never asks for.

import Foundation
import Carbon.HIToolbox // IsSecureEventInputEnabled
import AppKit
import CoreGraphics
import ApplicationServices
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

let HELPER_VERSION = "0.3.0"

signal(SIGPIPE, SIG_IGN)

// ── Globals ─────────────────────────────────────────────────────────────────
// Declared before any function that uses them: main.swift runs top to bottom.

let outLock = NSLock()

let state = HelperState()
/// Marks every event we post (kCGEventSourceUserData). Hardware events and
/// other processes' events carry 0 there unless they set it themselves.
let SEI_EVENT_TAG: Int64 = 0x5E1AC7
let eventSource: CGEventSource? = {
    let s = CGEventSource(stateID: .privateState)
    s?.userData = SEI_EVENT_TAG
    return s
}()
/// Test-only commands (test_user_event). Main never sets this.
let TEST_COMMANDS = ProcessInfo.processInfo.environment["SEI_MAC_INPUT_TEST"] == "1"
/// Per-action caps, matching src/main/computerUse/actions.ts. Short on
/// purpose: an action is one burst, and a long one is a long time for the
/// player to wait for the next check.
let TYPE_MAX_CHARS = 200
let HOLD_MAX_MS = 3000.0
let actionQueue = DispatchQueue(label: "sei.mac-input.actions")
/// Slow queries (AX walks) run here so the reader thread stays free for cancel.
let queryQueue = DispatchQueue(label: "sei.mac-input.queries", attributes: .concurrent)

/// Canonical key names (lowercase) to macOS virtual key codes (kVK_*, US
/// layout). src/main/computerUse/keys.ts normalizes model-side names to these
/// and must stay in sync (the CI smoke test prints `keys` for comparison).
let KEY_CODES: [String: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06,
    "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E,
    "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C,
    "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23,
    "return": 0x24, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F,
    "tab": 0x30, "space": 0x31, "`": 0x32, "backspace": 0x33, "escape": 0x35,
    "cmd": 0x37, "shift": 0x38, "capslock": 0x39, "alt": 0x3A, "ctrl": 0x3B,
    "fn": 0x3F, "kp_enter": 0x4C,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
    "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "f13": 0x69, "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40, "f18": 0x4F,
    "f19": 0x50, "f20": 0x5A,
    "home": 0x73, "pageup": 0x74, "delete": 0x75, "end": 0x77, "pagedown": 0x79,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
]

let MODIFIER_FLAGS: [String: CGEventFlags] = [
    "cmd": .maskCommand, "shift": .maskShift, "alt": .maskAlternate,
    "ctrl": .maskControl, "fn": .maskSecondaryFn,
]

let watcher = Watcher()

let ACTIONS: Set<String> = ["move", "click", "drag", "scroll", "key", "key_down", "key_up", "hold", "type", "wait"]

// ── Output ──────────────────────────────────────────────────────────────────

func send(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
        FileHandle.standardError.write("sei-mac-input: unserializable response\n".data(using: .utf8)!)
        return
    }
    outLock.lock()
    defer { outLock.unlock() }
    do {
        try FileHandle.standardOutput.write(contentsOf: data)
        try FileHandle.standardOutput.write(contentsOf: Data([0x0A]))
    } catch {
        // Broken pipe: the parent is gone. Let go of everything and leave.
        releaseAllNow()
        exit(0)
    }
}

func reply(_ id: Int, _ fields: [String: Any] = [:]) {
    var o = fields
    o["id"] = id
    o["ok"] = true
    send(o)
}

func replyError(_ id: Int, _ message: String, _ extra: [String: Any] = [:]) {
    var o = extra
    o["id"] = id
    o["ok"] = false
    o["error"] = message
    send(o)
}

func log(_ s: String) {
    FileHandle.standardError.write("sei-mac-input: \(s)\n".data(using: .utf8)!)
}

// ── Time ────────────────────────────────────────────────────────────────────

func now() -> Double { ProcessInfo.processInfo.systemUptime }

/// Sleep in small slices so a cancel lands within ~10 ms. Returns false when
/// the action was cancelled during the wait.
func sleepChecked(_ seconds: Double, _ gen: Int) -> Bool {
    let end = now() + seconds
    while now() < end {
        if state.generation != gen { return false }
        let left = end - now()
        Thread.sleep(forTimeInterval: min(0.01, max(0, left)))
    }
    return state.generation == gen
}

// ── State ───────────────────────────────────────────────────────────────────

final class HelperState {
    let lock = NSLock()
    private var _generation = 0
    var generation: Int {
        lock.lock(); defer { lock.unlock() }
        return _generation
    }
    func bump() -> Int {
        lock.lock(); defer { lock.unlock() }
        _generation += 1
        return _generation
    }
    /// Non-modifier keys currently held down by us.
    var heldKeys = Set<CGKeyCode>()
    /// Modifier keys currently held down by us (as flags).
    var heldMods: CGEventFlags = []
    /// Mouse buttons currently held down by us.
    var heldButtons = Set<UInt32>()
    /// Why the last cancel happened ("user_input" when the watcher fired), for
    /// the cancelled action's reply.
    var cancelReason = "cancelled"
    /// Set when the watcher saw the player: every action is refused from then
    /// until main re-arms the watcher for a new run. Guarded by `lock`.
    var lockedOut = false
}

let LOCKED_OUT_ERROR = "cancelled: user input (actions refused until the watcher is re-armed)"

func isLockedOut() -> Bool {
    state.lock.lock(); defer { state.lock.unlock() }
    return state.lockedOut
}


// ── Keys ────────────────────────────────────────────────────────────────────


func modifierFlags(_ names: [String]) -> CGEventFlags? {
    var f: CGEventFlags = []
    for n in names {
        guard let m = MODIFIER_FLAGS[n] else { return nil }
        f.insert(m)
    }
    return f
}

// ── Posting ─────────────────────────────────────────────────────────────────

/// Tag and post. The ONLY way this helper posts an event, so the watcher can
/// always tell ours from the player's.
func post(_ e: CGEvent) {
    e.setIntegerValueField(.eventSourceUserData, value: SEI_EVENT_TAG)
    e.post(tap: .cghidEventTap)
}

func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down) else { return }
    e.flags = flags
    post(e)
}

/// A modifier press/release is a flagsChanged event on real hardware; games
/// that read raw modifier state (hold shift to sprint) need that shape.
func postFlagsChanged(_ code: CGKeyCode, flags: CGEventFlags) {
    guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true) else { return }
    e.type = .flagsChanged
    e.flags = flags
    post(e)
}

func currentCursor() -> CGPoint {
    return CGEvent(source: nil)?.location ?? .zero
}

func buttonTypes(_ b: String) -> (CGMouseButton, CGEventType, CGEventType, CGEventType)? {
    switch b {
    case "left": return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return nil
    }
}

func postMouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clickState: Int64 = 0, flags: CGEventFlags = []) {
    guard let e = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    if clickState > 0 { e.setIntegerValueField(.mouseEventClickState, value: clickState) }
    e.flags = flags.union(state.heldMods)
    post(e)
}

func moveTo(_ p: CGPoint) {
    // While a button is held, a move is a drag on real hardware.
    if state.heldButtons.contains(CGMouseButton.left.rawValue) {
        postMouse(.leftMouseDragged, p, .left)
    } else if state.heldButtons.contains(CGMouseButton.right.rawValue) {
        postMouse(.rightMouseDragged, p, .right)
    } else {
        postMouse(.mouseMoved, p, .left)
    }
}

/// Let go of everything we are holding. Also posts a modifier-clear so a
/// modifier we pressed can never stick, even if our bookkeeping missed it.
func releaseAllNow() {
    state.lock.lock()
    let keys = state.heldKeys
    let buttons = state.heldButtons
    state.heldKeys.removeAll()
    state.heldButtons.removeAll()
    state.heldMods = []
    state.lock.unlock()
    for k in keys { postKey(k, down: false, flags: []) }
    let at = currentCursor()
    for b in buttons {
        if b == CGMouseButton.left.rawValue { postMouse(.leftMouseUp, at, .left) }
        else if b == CGMouseButton.right.rawValue { postMouse(.rightMouseUp, at, .right) }
        else { postMouse(.otherMouseUp, at, .center) }
    }
    for (name, _) in MODIFIER_FLAGS {
        if let code = KEY_CODES[name] { postFlagsChanged(code, flags: []) }
    }
}

// ── Actions ─────────────────────────────────────────────────────────────────

struct ActionError: Error { let message: String }

func point(_ args: [String: Any], _ key: String = "x", _ key2: String = "y") throws -> CGPoint {
    guard let x = (args[key] as? NSNumber)?.doubleValue, let y = (args[key2] as? NSNumber)?.doubleValue,
          x.isFinite, y.isFinite else { throw ActionError(message: "missing or invalid coordinates") }
    return CGPoint(x: x, y: y)
}

func pointArray(_ v: Any?) throws -> CGPoint {
    guard let a = v as? [NSNumber], a.count == 2 else { throw ActionError(message: "expected [x, y]") }
    return CGPoint(x: a[0].doubleValue, y: a[1].doubleValue)
}

func modsArg(_ args: [String: Any]) throws -> CGEventFlags {
    let names = (args["modifiers"] as? [String]) ?? []
    guard let f = modifierFlags(names) else { throw ActionError(message: "unknown modifier in \(names)") }
    return f
}

/// Press modifiers (flagsChanged), run body, release them. Tracked in heldMods
/// so a cancel mid-body releases them too.
func withModifiers(_ flags: CGEventFlags, _ body: () throws -> Void) rethrows {
    var pressed: [(CGKeyCode, CGEventFlags)] = []
    var acc: CGEventFlags = state.heldMods
    for (name, f) in MODIFIER_FLAGS where flags.contains(f) {
        guard let code = KEY_CODES[name] else { continue }
        acc.insert(f)
        state.lock.lock(); state.heldMods = acc; state.lock.unlock()
        postFlagsChanged(code, flags: acc)
        pressed.append((code, f))
    }
    defer {
        for (code, f) in pressed.reversed() {
            acc.remove(f)
            state.lock.lock(); state.heldMods = acc; state.lock.unlock()
            postFlagsChanged(code, flags: acc)
        }
    }
    try body()
}

func doClick(_ args: [String: Any], _ gen: Int) throws {
    let p = try point(args)
    let bname = (args["button"] as? String) ?? "left"
    guard let bt = buttonTypes(bname) else { throw ActionError(message: "unknown button \(bname)") }
    let (btn, downT, upT, _) = bt
    let count = max(1, min(3, (args["count"] as? NSNumber)?.intValue ?? 1))
    let flags = try modsArg(args)
    moveTo(p)
    // Hover first: some apps and games only arm a widget on hover and drop a
    // click that arrives with no preceding move.
    guard sleepChecked(0.05, gen) else { throw ActionError(message: "cancelled") }
    withModifiers(flags) {
        for i in 1...count {
            postMouse(downT, p, btn, clickState: Int64(i), flags: flags)
            state.lock.lock(); state.heldButtons.insert(btn.rawValue); state.lock.unlock()
            Thread.sleep(forTimeInterval: 0.02)
            postMouse(upT, p, btn, clickState: Int64(i), flags: flags)
            state.lock.lock(); state.heldButtons.remove(btn.rawValue); state.lock.unlock()
            if i < count { Thread.sleep(forTimeInterval: 0.04) }
        }
    }
}

func doDrag(_ args: [String: Any], _ gen: Int) throws {
    let from = try pointArray(args["from"])
    let to = try pointArray(args["to"])
    let bname = (args["button"] as? String) ?? "left"
    guard let bt = buttonTypes(bname) else { throw ActionError(message: "unknown button \(bname)") }
    let (btn, downT, upT, dragT) = bt
    let durationMs = max(50, min(5000, (args["durationMs"] as? NSNumber)?.doubleValue ?? 300))
    let flags = try modsArg(args)
    moveTo(from)
    guard sleepChecked(0.05, gen) else { throw ActionError(message: "cancelled") }
    try withModifiers(flags) {
        postMouse(downT, from, btn, clickState: 1, flags: flags)
        state.lock.lock(); state.heldButtons.insert(btn.rawValue); state.lock.unlock()
        let steps = max(2, Int(durationMs / 16))
        for s in 1...steps {
            let t = Double(s) / Double(steps)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            postMouse(dragT, p, btn, flags: flags)
            if !sleepChecked(durationMs / 1000 / Double(steps), gen) {
                throw ActionError(message: "cancelled")
            }
        }
        postMouse(upT, to, btn, clickState: 1, flags: flags)
        state.lock.lock(); state.heldButtons.remove(btn.rawValue); state.lock.unlock()
    }
}

func doScroll(_ args: [String: Any], _ gen: Int) throws {
    let p = try point(args)
    let dx = (args["dx"] as? NSNumber)?.intValue ?? 0
    let dy = (args["dy"] as? NSNumber)?.intValue ?? 0
    moveTo(p)
    guard sleepChecked(0.03, gen) else { throw ActionError(message: "cancelled") }
    // One event per wheel click, a little apart, the way a real wheel reports.
    let clicks = max(abs(dx), abs(dy))
    for i in 0..<clicks {
        let wy: Int32 = i < abs(dy) ? (dy > 0 ? 1 : -1) * 3 : 0
        let wx: Int32 = i < abs(dx) ? (dx > 0 ? 1 : -1) * 3 : 0
        guard let e = CGEvent(scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2, wheel1: wy, wheel2: wx, wheel3: 0) else { continue }
        e.location = p
        e.flags = state.heldMods
        post(e)
        guard sleepChecked(0.015, gen) else { throw ActionError(message: "cancelled") }
    }
}

func keyCode(_ name: String) throws -> CGKeyCode {
    guard let c = KEY_CODES[name] else { throw ActionError(message: "unknown key \(name)") }
    return c
}

// ── Secure input guard ─────────────────────────────────────────────────────
//
// Main checks the focused element once before a typing action. Focus can move
// during one (a page script, an autofocus, the Return that ends a login
// form), so the helper re-checks while it types: macOS's secure event input
// (on while a password field has focus) before EVERY character, and the
// focused element's AX subrole every SECURE_AX_EVERY characters (an AX call is
// a cross-process round trip, a few ms). Either one stops the action with an
// error that starts with SECURE_INPUT_ERROR, which main treats as the
// password guard. Secure input can also be on because another app turned it
// on (Terminal's Secure Keyboard Entry, some password managers); typing is
// refused then too, on purpose.

let SECURE_INPUT_ERROR = "refused: secure input"
let SECURE_AX_EVERY = 16

func focusedIsSecureField() -> Bool {
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 0.1)
    guard let v = axAttr(sys, kAXFocusedUIElementAttribute as String), CFGetTypeID(v) == AXUIElementGetTypeID() else { return false }
    return axString(v as! AXUIElement, kAXSubroleAttribute as String) == "AXSecureTextField"
}

func checkSecureInput(ax: Bool) throws {
    if IsSecureEventInputEnabled() {
        throw ActionError(message: "\(SECURE_INPUT_ERROR): secure keyboard entry is on (a password field has focus)")
    }
    if ax && focusedIsSecureField() {
        throw ActionError(message: "\(SECURE_INPUT_ERROR): keyboard focus is in a password field")
    }
}

/// A key that enters text when pressed without cmd or ctrl (letters, digits,
/// punctuation, space; shift and option only change which character).
func entersText(_ name: String, _ flags: CGEventFlags) -> Bool {
    if flags.contains(.maskCommand) || flags.contains(.maskControl) { return false }
    return name.count == 1 || name == "space"
}

func doKey(_ args: [String: Any], _ gen: Int) throws {
    guard let name = args["key"] as? String else { throw ActionError(message: "missing key") }
    let code = try keyCode(name)
    let flags = try modsArg(args)
    if entersText(name, flags) { try checkSecureInput(ax: true) }
    let rep = max(1, min(100, (args["repeat"] as? NSNumber)?.intValue ?? 1))
    try withModifiers(flags) {
        for _ in 0..<rep {
            if state.generation != gen { throw ActionError(message: "cancelled") }
            if let mf = MODIFIER_FLAGS[name] {
                postFlagsChanged(code, flags: state.heldMods.union(mf))
                Thread.sleep(forTimeInterval: 0.02)
                postFlagsChanged(code, flags: state.heldMods)
            } else {
                postKey(code, down: true, flags: state.heldMods)
                Thread.sleep(forTimeInterval: 0.02)
                postKey(code, down: false, flags: state.heldMods)
            }
            guard sleepChecked(0.03, gen) else { throw ActionError(message: "cancelled") }
        }
    }
}

func doKeyDown(_ args: [String: Any]) throws {
    guard let name = args["key"] as? String else { throw ActionError(message: "missing key") }
    let code = try keyCode(name)
    if let mf = MODIFIER_FLAGS[name] {
        state.lock.lock(); state.heldMods.insert(mf); let f = state.heldMods; state.lock.unlock()
        postFlagsChanged(code, flags: f)
    } else {
        state.lock.lock(); state.heldKeys.insert(code); let f = state.heldMods; state.lock.unlock()
        postKey(code, down: true, flags: f)
    }
}

func doKeyUp(_ args: [String: Any]) throws {
    guard let name = args["key"] as? String else { throw ActionError(message: "missing key") }
    let code = try keyCode(name)
    if let mf = MODIFIER_FLAGS[name] {
        state.lock.lock(); state.heldMods.remove(mf); let f = state.heldMods; state.lock.unlock()
        postFlagsChanged(code, flags: f)
    } else {
        state.lock.lock(); state.heldKeys.remove(code); let f = state.heldMods; state.lock.unlock()
        postKey(code, down: false, flags: f)
    }
}

func doHold(_ args: [String: Any], _ gen: Int) throws {
    let ms = max(10, min(HOLD_MAX_MS, (args["ms"] as? NSNumber)?.doubleValue ?? 500))
    if let name = args["key"] as? String, entersText(name, state.heldMods) { try checkSecureInput(ax: true) }
    try doKeyDown(args)
    let ok = sleepChecked(ms / 1000, gen)
    try doKeyUp(args)
    if !ok { throw ActionError(message: "cancelled") }
}

func doType(_ args: [String: Any], _ gen: Int) throws {
    guard let text = args["text"] as? String else { throw ActionError(message: "missing text") }
    guard text.count <= TYPE_MAX_CHARS else { throw ActionError(message: "text too long (at most \(TYPE_MAX_CHARS) characters per type)") }
    for (i, ch) in text.enumerated() {
        if state.generation != gen { throw ActionError(message: "cancelled") }
        try checkSecureInput(ax: i % SECURE_AX_EVERY == 0)
        if ch == "\n" || ch == "\r" {
            postKey(0x24, down: true, flags: state.heldMods)
            postKey(0x24, down: false, flags: state.heldMods)
        } else if ch == "\t" {
            postKey(0x30, down: true, flags: state.heldMods)
            postKey(0x30, down: false, flags: state.heldMods)
        } else {
            // Layout-independent: the event carries the character itself.
            // Some games read key codes only and will ignore these; typing
            // into a game should go through key/hold instead.
            let units = Array(String(ch).utf16)
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else { continue }
                units.withUnsafeBufferPointer { buf in
                    e.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
                }
                e.flags = []
                post(e)
            }
        }
        guard sleepChecked(0.008, gen) else { throw ActionError(message: "cancelled") }
    }
}

func cancelReasonNow() -> String {
    state.lock.lock(); defer { state.lock.unlock() }
    return state.cancelReason
}

/// Stop the in-flight action at its next check (every ~10 ms), then let go of
/// everything once it has returned (queued behind it on purpose, so the
/// action cannot press something after the release).
func cancelActions(_ reason: String) {
    state.lock.lock(); state.cancelReason = reason; state.lock.unlock()
    _ = state.bump()
}

func runAction(_ id: Int, _ cmd: String, _ args: [String: Any], _ gen: Int) {
    if isLockedOut() {
        replyError(id, LOCKED_OUT_ERROR, ["at": now()])
        return
    }
    if state.generation != gen {
        replyError(id, cancelReasonNow(), ["at": now()])
        return
    }
    let t0 = now()
    do {
        switch cmd {
        case "move": moveTo(try point(args))
        case "click": try doClick(args, gen)
        case "drag": try doDrag(args, gen)
        case "scroll": try doScroll(args, gen)
        case "key": try doKey(args, gen)
        case "key_down": try doKeyDown(args)
        case "key_up": try doKeyUp(args)
        case "hold": try doHold(args, gen)
        case "type": try doType(args, gen)
        case "wait":
            let ms = max(0, min(10_000, (args["ms"] as? NSNumber)?.doubleValue ?? 500))
            if !sleepChecked(ms / 1000, gen) { throw ActionError(message: "cancelled") }
        default: throw ActionError(message: "unknown action \(cmd)")
        }
        reply(id, ["ms": Int((now() - t0) * 1000)])
    } catch let e as ActionError {
        // "at" (systemUptime) lets the CI abort check measure how long a
        // cancel took to land, on the helper's own clock.
        replyError(id, e.message == "cancelled" ? cancelReasonNow() : e.message, ["at": now(), "ms": Int((now() - t0) * 1000)])
    } catch {
        replyError(id, "\(error)")
    }
}

// ── Queries ─────────────────────────────────────────────────────────────────

func rectDict(_ r: CGRect) -> [String: Any] {
    return ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.size.width), "h": Double(r.size.height)]
}

func windowInfo(_ w: [String: Any]) -> [String: Any]? {
    guard let num = w[kCGWindowNumber as String] as? NSNumber,
          let pid = w[kCGWindowOwnerPID as String] as? NSNumber,
          let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { return nil }
    var o: [String: Any] = [
        "id": num.intValue,
        "pid": pid.intValue,
        "layer": (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
        "alpha": (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
        "bounds": rectDict(bounds),
        "onScreen": (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
    ]
    if let owner = w[kCGWindowOwnerName as String] as? String { o["owner"] = owner }
    // Titles of other apps' windows need Screen Recording; absent otherwise.
    if let name = w[kCGWindowName as String] as? String { o["title"] = name }
    return o
}

/// On-screen windows, front to back (CGWindowList's documented order).
func listWindows() -> [[String: Any]] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return raw.compactMap(windowInfo)
}

func findWindow(_ wid: Int) -> [String: Any]? {
    guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(wid)) as? [[String: Any]] else { return nil }
    return raw.compactMap(windowInfo).first { ($0["id"] as? Int) == wid }
}

func listDisplays() -> [[String: Any]] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    let main = CGMainDisplayID()
    return ids.prefix(Int(count)).map { d -> [String: Any] in
        let b = CGDisplayBounds(d)
        var scale = 1.0
        if let mode = CGDisplayCopyDisplayMode(d), mode.width > 0 {
            scale = Double(mode.pixelWidth) / Double(mode.width)
        }
        return ["id": Int(d), "bounds": rectDict(b), "scale": scale, "main": d == main]
    }
}

func appInfo(_ app: NSRunningApplication?) -> [String: Any] {
    guard let app = app else { return [:] }
    var o: [String: Any] = ["pid": Int(app.processIdentifier)]
    if let b = app.bundleIdentifier { o["bundleId"] = b }
    if let n = app.localizedName { o["name"] = n }
    return o
}

func frontmost() -> [String: Any] {
    // NSWorkspace's frontmost app is kept current by notifications on the main
    // run loop, which is running (see the bottom of this file).
    var app: NSRunningApplication? = nil
    DispatchQueue.main.sync { app = NSWorkspace.shared.frontmostApplication }
    var o = appInfo(app)
    // Cross-check: owner of the frontmost normal-layer window.
    if let top = listWindows().first(where: { ($0["layer"] as? Int) == 0 }) {
        o["topWindowPid"] = top["pid"]
        o["topWindowId"] = top["id"]
    }
    return o
}

func appByPid(_ pid: Int) -> [String: Any]? {
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return nil }
    return appInfo(app)
}

func permissions(prompt: Bool) -> [String: Any] {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(opts)
    var post = CGPreflightPostEventAccess()
    if prompt && !post { post = CGRequestPostEventAccess() }
    return [
        "axTrusted": ax,
        "postEventAccess": post,
        "screenCaptureAccess": CGPreflightScreenCaptureAccess(),
    ]
}

// ── Screenshots ─────────────────────────────────────────────────────────────

func jpegBase64(_ img: CGImage, quality: Double) -> String? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return (data as Data).base64EncodedString()
}

/// 32x18 grayscale thumbnail as hex, for main's "did the screen change" test
/// (stall detection). Tolerant of JPEG noise in a way a byte hash is not.
func thumbHex(_ img: CGImage) -> String? {
    let w = 32, h = 18
    var buf = [UInt8](repeating: 0, count: w * h)
    let ok: Bool = buf.withUnsafeMutableBytes { raw -> Bool in
        guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        ctx.interpolationQuality = .medium
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    guard ok else { return nil }
    return buf.map { String(format: "%02x", $0) }.joined()
}

/// Text boxes in `img`, which shows global rect `r`, mapped to global points.
/// Apple Vision's on-device recognizer; nothing leaves the machine.
func ocrBoxes(_ img: CGImage, _ r: CGRect, accurate: Bool) -> [[String: Any]] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = accurate ? .accurate : .fast
    req.usesLanguageCorrection = accurate
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do { try handler.perform([req]) } catch { return [] }
    var out: [[String: Any]] = []
    for obs in req.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox // normalized, origin bottom-left
        out.append([
            "text": cand.string,
            "confidence": Double(cand.confidence),
            "x": Double(r.minX + bb.minX * r.width),
            "y": Double(r.minY + (1 - bb.maxY) * r.height),
            "w": Double(bb.width * r.width),
            "h": Double(bb.height * r.height),
        ])
    }
    return out
}

/// One frame of `rect` (global points, clipped to its display), scaled by
/// ScreenCaptureKit to exactly width x height pixels, with every window of
/// `excludePids` removed (Sei's own windows, so the model never sees its own
/// overlay). The reply carries the rect actually captured; main maps model
/// coordinates through that rect and the image size, which is what keeps
/// mixed-DPI setups exact without either side knowing a backing scale.
/// Optional extras on the same frame: `thumb` (change detection) and `ocr`.
@available(macOS 14.0, *)
func screenshot(_ id: Int, _ args: [String: Any]) async {
    let t0 = now()
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let tContent = now()
        var display: SCDisplay? = nil
        if let did = (args["displayId"] as? NSNumber)?.uint32Value {
            display = content.displays.first { $0.displayID == did }
        }
        var rect: CGRect? = nil
        if let r = args["rect"] as? [String: Any],
           let x = (r["x"] as? NSNumber)?.doubleValue, let y = (r["y"] as? NSNumber)?.doubleValue,
           let w = (r["w"] as? NSNumber)?.doubleValue, let h = (r["h"] as? NSNumber)?.doubleValue {
            rect = CGRect(x: x, y: y, width: w, height: h)
        }
        if display == nil, let r = rect {
            let c = CGPoint(x: r.midX, y: r.midY)
            display = content.displays.first { $0.frame.contains(c) }
        }
        guard let d = display ?? content.displays.first else { throw ActionError(message: "no display") }
        let frame = d.frame
        let r = (rect ?? frame).intersection(frame)
        guard !r.isNull, r.width >= 1, r.height >= 1 else { throw ActionError(message: "rect is off-screen") }
        let pids = Set(((args["excludePids"] as? [NSNumber]) ?? []).map { pid_t($0.int32Value) })
        let excluded = content.applications.filter { pids.contains($0.processID) }
        let filter = SCContentFilter(display: d, excludingApplications: excluded, exceptingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.sourceRect = CGRect(x: r.minX - frame.minX, y: r.minY - frame.minY, width: r.width, height: r.height)
        let w = max(1, (args["width"] as? NSNumber)?.intValue ?? Int(r.width))
        let h = max(1, (args["height"] as? NSNumber)?.intValue ?? Int(r.height))
        cfg.width = w
        cfg.height = h
        cfg.showsCursor = (args["cursor"] as? Bool) ?? true
        cfg.preservesAspectRatio = false
        cfg.captureResolution = .best
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        let tCap = now()
        let q = (args["quality"] as? NSNumber)?.doubleValue ?? 0.8
        guard let b64 = jpegBase64(img, quality: q) else { throw ActionError(message: "jpeg encode failed") }
        let tEnc = now()
        var o: [String: Any] = [
            "data": b64,
            "mime": "image/jpeg",
            "width": img.width,
            "height": img.height,
            "rect": rectDict(r),
            "displayId": Int(d.displayID),
        ]
        var timing: [String: Any] = [
            "contentMs": Int((tContent - t0) * 1000),
            "captureMs": Int((tCap - tContent) * 1000),
            "encodeMs": Int((tEnc - tCap) * 1000),
        ]
        if (args["thumb"] as? Bool) ?? false, let t = thumbHex(img) { o["thumb"] = t }
        if (args["ocr"] as? Bool) ?? false {
            let tO = now()
            o["ocr"] = ocrBoxes(img, r, accurate: (args["ocrAccurate"] as? Bool) ?? false)
            timing["ocrMs"] = Int((now() - tO) * 1000)
        }
        o["timing"] = timing
        reply(id, o)
    } catch let e as ActionError {
        replyError(id, e.message)
    } catch {
        replyError(id, "screenshot failed: \(error.localizedDescription)")
    }
}

// ── Accessibility tree ──────────────────────────────────────────────────────
//
// For the text-only chooser: the target app's AX elements with role, label
// and frame (global points, same space as everything else here). Needs the
// Accessibility grant, same as posting events. Bounded by node count and
// depth, with a short messaging timeout so a hung app cannot hang the helper.
// Runs on queryQueue, not the reader thread, so `cancel` is never stuck
// behind a slow tree walk.

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
    return v
}

func axString(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = axAttr(el, name) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : String(s.prefix(160)) }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axAttr(el, kAXPositionAttribute as String), let s = axAttr(el, kAXSizeAttribute as String),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}

func axNode(_ el: AXUIElement, depth: Int, parent: Int) -> [String: Any] {
    var o: [String: Any] = ["depth": depth, "parent": parent]
    if let r = axString(el, kAXRoleAttribute as String) { o["role"] = r }
    if let r = axString(el, kAXSubroleAttribute as String) { o["subrole"] = r }
    if let t = axString(el, kAXTitleAttribute as String) { o["title"] = t }
    if let t = axString(el, kAXDescriptionAttribute as String) { o["description"] = t }
    if let t = axString(el, "AXPlaceholderValue") { o["placeholder"] = t }
    // Never read the value of a secure field.
    if (o["subrole"] as? String) != "AXSecureTextField", let t = axString(el, kAXValueAttribute as String) { o["value"] = t }
    if let f = axFrame(el) { o["frame"] = rectDict(f) }
    if let e = axAttr(el, kAXEnabledAttribute as String) as? Bool { o["enabled"] = e }
    if let f = axAttr(el, kAXFocusedAttribute as String) as? Bool, f { o["focused"] = true }
    return o
}

func axDump(pid: Int, maxNodes: Int, maxDepth: Int) -> [[String: Any]] {
    let app = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(app, 0.25)
    var out: [[String: Any]] = []
    var queue: [(AXUIElement, Int, Int)] = []
    if let wins = axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement] {
        for w in wins { queue.append((w, 0, -1)) }
    }
    var i = 0
    while i < queue.count && out.count < maxNodes {
        let (el, depth, parent) = queue[i]
        i += 1
        let idx = out.count
        out.append(axNode(el, depth: depth, parent: parent))
        if depth >= maxDepth { continue }
        if let kids = axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
            for k in kids { queue.append((k, depth + 1, idx)) }
        }
    }
    return out
}

func axFocused() -> [String: Any] {
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 0.25)
    guard let v = axAttr(sys, kAXFocusedUIElementAttribute as String), CFGetTypeID(v) == AXUIElementGetTypeID() else { return [:] }
    let el = v as! AXUIElement
    var o = axNode(el, depth: 0, parent: -1)
    var pid: pid_t = 0
    if AXUIElementGetPid(el, &pid) == .success { o["pid"] = Int(pid) }
    return o
}

// ── User-input watcher ──────────────────────────────────────────────────────
//
// Stops the act loop the moment the player touches the mouse or keyboard,
// including in the middle of an action (a hold, a long type, a drag).
//
// An active CGEventTap on the session: it sees every key and mouse event and
// passes each one through untouched. Events we posted carry SEI_EVENT_TAG in
// kCGEventSourceUserData and are ignored; ANY other key or mouse event is the
// player (or something else that is not us, which is just as good a reason to
// stop). On the first one the watcher cancels the in-flight action right here,
// without a round trip to main, and then reports it.
//
// Active rather than listen-only on purpose: a listen-only tap needs the Input
// Monitoring grant to see key events, an active one needs Accessibility, which
// posting events already needs. The tap stays DISABLED while not armed, so
// outside a run it costs nothing, and it is re-enabled if macOS disables it
// for a slow callback (the callback only reads two fields).
//
// The replaced design read CGEventSource idle clocks and ignored everything
// while an action was running, which made the player invisible for the whole
// of a 10 s hold or a long type.

/// Event types that count as the player taking over. Key-ups and button-ups
/// are left out: every real interaction starts with a down or a move, and an
/// up for a key pressed before arming is not a takeover.
let WATCH_TYPES: [(CGEventType, String)] = [
    (.keyDown, "key"), (.flagsChanged, "key"),
    (.mouseMoved, "mouse"), (.leftMouseDown, "mouse"), (.rightMouseDown, "mouse"),
    (.otherMouseDown, "mouse"), (.leftMouseDragged, "mouse"), (.rightMouseDragged, "mouse"),
    (.otherMouseDragged, "mouse"), (.scrollWheel, "mouse"),
]

func watchKind(_ type: CGEventType) -> String? {
    return WATCH_TYPES.first(where: { $0.0 == type })?.1
}

/// Tap callback: a C function pointer, so no captures; it goes through the
/// global `watcher`.
func watchTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    watcher.onEvent(type, event)
    return Unmanaged.passUnretained(event)
}

final class Watcher {
    /// Guards every field below. Touched from the reader thread (arm, disarm)
    /// and the tap thread (onEvent).
    private let lock = NSLock()
    private var armed = false
    private var tap: CFMachPort? = nil

    /// Create the tap (once) and enable it. Returns nil when armed, else why not.
    func arm() -> String? {
        lock.lock()
        let existing = tap
        lock.unlock()
        let t: CFMachPort
        if let e = existing {
            t = e
        } else {
            guard let made = startTapThread() else {
                return "could not create the input event tap (Accessibility not granted?)"
            }
            t = made
        }
        lock.lock()
        tap = t
        armed = true
        CGEvent.tapEnable(tap: t, enable: true)
        lock.unlock()
        return nil
    }

    func disarm() {
        lock.lock()
        armed = false
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        lock.unlock()
    }

    /// The tap gets its own thread and run loop, so it never waits behind the
    /// main run loop or the reader. Returns the tap once it is installed.
    private func startTapThread() -> CFMachPort? {
        var mask: CGEventMask = 0
        for (type, _) in WATCH_TYPES { mask |= CGEventMask(1) << CGEventMask(type.rawValue) }
        // A box, not a captured var: Thread's block may be @Sendable, where
        // mutating a captured var does not compile.
        final class TapBox { var tap: CFMachPort? = nil }
        let box = TapBox()
        let boxLock = NSLock()
        let ready = DispatchSemaphore(value: 0)
        let th = Thread {
            guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                            eventsOfInterest: mask, callback: watchTapCallback, userInfo: nil) else {
                ready.signal()
                return
            }
            // Created enabled; stay off until arm() turns it on.
            CGEvent.tapEnable(tap: t, enable: false)
            let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
            boxLock.lock(); box.tap = t; boxLock.unlock()
            ready.signal()
            CFRunLoopRun()
        }
        th.name = "sei.mac-input.watch"
        th.start()
        _ = ready.wait(timeout: .now() + 2)
        boxLock.lock(); defer { boxLock.unlock() }
        return box.tap
    }

    func onEvent(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            if armed, let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            lock.unlock()
            return
        }
        guard let kind = watchKind(type) else { return }
        // Ours.
        if event.getIntegerValueField(.eventSourceUserData) == SEI_EVENT_TAG { return }
        // Key auto-repeat of a key that was already down: its first press
        // either counted already or predates arming.
        if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
        lock.lock()
        guard armed else { lock.unlock(); return }
        // One report per arming; main re-arms for the next run. Until then
        // every action is refused (lockedOut), so nothing queued behind the
        // cancelled one, or sent before main has seen user_input, can run.
        armed = false
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        lock.unlock()
        state.lock.lock(); state.lockedOut = true; state.lock.unlock()
        // Stop the in-flight action NOW (it checks every ~10 ms), then let go
        // of anything held once it has returned.
        cancelActions("cancelled: user input")
        actionQueue.async { releaseAllNow() }
        send(["event": "user_input", "kind": kind, "source": "\(type.rawValue)", "ago": 0, "at": now()])
    }
}

/// test_user_event: one UNTAGGED event from a separate source, standing in
/// for the player (the CI abort check). A key the text never contains, or a
/// 1 pt cursor nudge.
func postTestUserEvent(_ kind: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    if kind == "mouse" {
        let c = currentCursor()
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: c.x + 1, y: c.y), mouseButton: .left)?
            .post(tap: .cghidEventTap)
    } else {
        // F18: no app binds it by default.
        CGEvent(keyboardEventSource: src, virtualKey: 0x4F, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: src, virtualKey: 0x4F, keyDown: false)?.post(tap: .cghidEventTap)
    }
}


// ── Dispatch ────────────────────────────────────────────────────────────────


func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = (obj["id"] as? NSNumber)?.intValue,
          let cmd = obj["cmd"] as? String else {
        log("bad request line")
        return
    }
    if ACTIONS.contains(cmd) {
        let gen = state.generation
        actionQueue.async { runAction(id, cmd, obj, gen) }
        return
    }
    switch cmd {
    case "ping":
        var o = permissions(prompt: false)
        o["version"] = HELPER_VERSION
        o["pid"] = Int(getpid())
        o["macos"] = ProcessInfo.processInfo.operatingSystemVersionString
        reply(id, o)
    case "permissions":
        reply(id, permissions(prompt: (obj["prompt"] as? Bool) ?? false))
    case "frontmost":
        reply(id, frontmost())
    case "app":
        let pid = (obj["pid"] as? NSNumber)?.intValue ?? -1
        if let a = appByPid(pid) { reply(id, ["app": a]) } else { reply(id, ["app": NSNull()]) }
    case "windows":
        reply(id, ["windows": listWindows()])
    case "window":
        let wid = (obj["windowId"] as? NSNumber)?.intValue ?? -1
        if let w = findWindow(wid) { reply(id, ["window": w]) } else { reply(id, ["window": NSNull()]) }
    case "displays":
        reply(id, ["displays": listDisplays()])
    case "cursor":
        let c = currentCursor()
        reply(id, ["x": Double(c.x), "y": Double(c.y)])
    case "keys":
        reply(id, ["keys": KEY_CODES.keys.sorted()])
    case "screenshot":
        if #available(macOS 14.0, *) {
            Task { await screenshot(id, obj) }
        } else {
            replyError(id, "screenshot needs macOS 14")
        }
    case "ax_dump":
        let pid = (obj["pid"] as? NSNumber)?.intValue ?? -1
        let maxNodes = max(1, min(2000, (obj["maxNodes"] as? NSNumber)?.intValue ?? 400))
        let maxDepth = max(1, min(60, (obj["maxDepth"] as? NSNumber)?.intValue ?? 25))
        queryQueue.async {
            let t0 = now()
            let nodes = axDump(pid: pid, maxNodes: maxNodes, maxDepth: maxDepth)
            reply(id, ["nodes": nodes, "ms": Int((now() - t0) * 1000)])
        }
    case "ax_focused":
        queryQueue.async { reply(id, ["element": axFocused()]) }
    case "watch":
        if (obj["enabled"] as? Bool) ?? false {
            // "tap" is the only mode; main refuses to drive without it.
            // Arming (a new run) is the only thing that lifts the lockout. It
            // is lifted BEFORE the tap goes live, so a player event right
            // after arming locks it again instead of being overwritten.
            state.lock.lock(); let wasLocked = state.lockedOut; state.lockedOut = false; state.lock.unlock()
            if let err = watcher.arm() {
                state.lock.lock(); state.lockedOut = state.lockedOut || wasLocked; state.lock.unlock()
                replyError(id, err)
            } else {
                reply(id, ["mode": "tap"])
            }
        } else {
            watcher.disarm()
            reply(id)
        }
    case "cancel":
        cancelActions("cancelled")
        actionQueue.async {
            releaseAllNow()
            reply(id)
        }
    case "test_user_event":
        guard TEST_COMMANDS else { replyError(id, "unknown command \(cmd)"); return }
        postTestUserEvent((obj["kind"] as? String) ?? "key")
        reply(id, ["at": now()])
    case "test_secure_input":
        // Test only: turn macOS secure event input on or off from here, as a
        // focused password field would (the CI mid-type password check).
        guard TEST_COMMANDS else { replyError(id, "unknown command \(cmd)"); return }
        if (obj["enabled"] as? Bool) ?? false { EnableSecureEventInput() } else { DisableSecureEventInput() }
        reply(id, ["enabled": IsSecureEventInputEnabled(), "at": now()])
    case "release_all":
        cancelActions("cancelled")
        releaseAllNow()
        actionQueue.async {
            releaseAllNow()
            reply(id)
        }
    default:
        replyError(id, "unknown command \(cmd)")
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        handle(line)
    }
    // EOF: parent gone or pipe closed. Orphan guard.
    watcher.disarm()
    _ = state.bump()
    releaseAllNow()
    exit(0)
}
reader.start()

var ready = permissions(prompt: false)
ready["event"] = "ready"
ready["version"] = HELPER_VERSION
ready["pid"] = Int(getpid())
send(ready)

RunLoop.main.run()
