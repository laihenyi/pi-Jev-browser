// A standalone macOS accessibility helper for the desktop driver.
//
// It speaks one JSON object per line over stdin/stdout and stays resident, so the
// TypeScript driver can keep it alive instead of paying process startup per action.
//
// Everything macOS-specific lives here: locating an application by bundle id (not
// by display name, which is localised), walking the accessibility tree, resolving
// an accessible name, performing actions, and refusing to act when the tree moved
// since the observation it was asked about.
//
// Build: swiftc -O -o ax-helper ax-helper.swift

import ApplicationServices
import AppKit
import Foundation
import Vision

// MARK: - accessibility helpers

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func text(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func frame(_ element: AXUIElement) -> (x: Int, y: Int, w: Int, h: Int)? {
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard let positionValue = attribute(element, kAXPositionAttribute),
          let sizeValue = attribute(element, kAXSizeAttribute),
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else { return nil }
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else { return nil }
    return (Int(origin.x), Int(origin.y), Int(size.width), Int(size.height))
}

/// The accessible name, in the order accessibility clients are expected to try.
/// Calculator publishes nothing in AXTitle and everything in AXDescription, so a
/// driver that only read AXTitle would see 25 unnamed buttons.
func accessibleName(_ element: AXUIElement) -> String {
    // A web search box often has only a placeholder ("搜尋"); it is the name a person reads.
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, "AXPlaceholderValue"] {
        if let value = text(element, key)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            return value
        }
    }
    return ""
}

/// The accessibility root of one application. A browser opening a tab or loading a
/// page can take longer than the default one-second reply window, and then an action
/// that did land is reported as AXError -25204 (cannot complete); five seconds is
/// generous for an app that is merely busy and still fails fast for one that hung.
func applicationElement(_ app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 5.0)
    return element
}

func application(bundleId: String) -> NSRunningApplication? {
    // This helper is a resident process without a run loop, so the workspace's
    // cached list is not refreshed; ask Launch Services directly instead, or an
    // application started after the helper is never seen.
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
        ?? NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
}

func frontmost() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.isActive }
}

// MARK: - observation

struct Node {
    let element: AXUIElement
    let index: Int
    let role: String
    let subrole: String
    let name: String
    let value: String
    let identifier: String
    let enabled: Bool
    let actions: [String]
    let frame: (x: Int, y: Int, w: Int, h: Int)?

    func renamed(_ name: String) -> Node {
        Node(element: element, index: index, role: role, subrole: subrole, name: name, value: value,
             identifier: identifier, enabled: enabled, actions: actions, frame: frame)
    }

    func revalued(_ value: String) -> Node {
        Node(element: element, index: index, role: role, subrole: subrole, name: name, value: value,
             identifier: identifier, enabled: enabled, actions: actions, frame: frame)
    }
}

let pressableRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuItem",
    "AXMenuButton", "AXLink", "AXDisclosureTriangle", "AXTab", "AXSegment",
]

/// Editable text. These carry no press action, so a walk that only looked for
/// AXPress never offered them: TextEdit's document was invisible to the driver.
/// They are driven by setting AXValue, and their value is part of the window text
/// because for an editor the document *is* the state.
let textRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"]

/// Titlebar buttons carry these subroles. They are not part of the application's
/// content, and pressing close terminates applications that quit with their last
/// window, so they are never offered as targets.
let windowControlSubroles: Set<String> = [
    "AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton",
]

func isInteractive(_ role: String, _ subrole: String, _ actions: [String]) -> Bool {
    if windowControlSubroles.contains(subrole) { return false }
    // SwiftUI attaches AXPress to every static text. A label is content, not a
    // control: offering it as a target hides the window text the decision layer
    // needs and buries the real controls among dozens of unnamed "buttons".
    if role == "AXStaticText" { return false }
    if actions.contains(kAXPressAction) { return true }
    if pressableRoles.contains(role) { return true }
    if textRoles.contains(role) { return true }
    return actions.contains("AXConfirm") || actions.contains("AXPick")
}

/// The window a person would call "the window": the focused one, else the main
/// one, else the first standard window. Menu-bar apps keep invisible helper
/// windows (status item, HUD) in the window list, often ahead of the real one,
/// so `windows.first` can pick a window nobody sees.
func primaryWindow(_ appElement: AXUIElement) -> AXUIElement? {
    if let focused = attribute(appElement, kAXFocusedWindowAttribute) {
        return (focused as! AXUIElement)
    }
    if let main = attribute(appElement, kAXMainWindowAttribute) {
        return (main as! AXUIElement)
    }
    let windows = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    return windows.first { text($0, kAXSubroleAttribute) == "AXStandardWindow" } ?? windows.first
}

/// Posts a Return key press to one process (key code 36).
func pressReturn(pid: pid_t) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false)
    else { return }
    down.postToPid(pid)
    usleep(30_000)
    up.postToPid(pid)
}

/// Rows and cells that carry a frame but no accessible text. Some applications
/// (LINE, other Chromium- or custom-drawn lists) expose their lists as hundreds
/// of empty AXRow shells: geometry without names, actions or children. What a
/// person reads in them is only on screen, so the helper reads it from the
/// screen: one capture of the window, one text-recognition pass, and each line
/// is assigned to the shell whose frame contains it. Such a shell is then a
/// target like any other, pressed with a synthesised mouse click at its centre.
let shellRoles: Set<String> = ["AXRow", "AXCell"]
let maxShells = 60
let mouseClickAction = "MouseClick"

/// A document drawn by the application itself. Word's page is one AXLayoutArea
/// with no value, no actions and no children: the text on it exists only on
/// screen, and the only way in is the keyboard. Such a canvas is offered as a
/// text target whose value is what the recogniser reads off it, and typing into
/// it is a click to place the caret followed by keyboard events.
let documentRoles: Set<String> = ["AXLayoutArea"]
let typeTextAction = "TypeText"
let maxCanvases = 4

/// Types a string into one process as keyboard events carrying Unicode, so any
/// script goes in without a keyboard layout; a line break is the Return key.
func typeUnicode(pid: pid_t, _ value: String) {
    for line in value.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
        if line.offset > 0 { pressReturn(pid: pid); usleep(40_000) }
        var chunk: [UniChar] = []
        func flush() {
            guard !chunk.isEmpty,
                  let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else { chunk.removeAll(); return }
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            down.postToPid(pid)
            usleep(8_000)
            up.postToPid(pid)
            usleep(12_000)
            chunk.removeAll()
        }
        for character in line.element {
            let units = Array(String(character).utf16)
            if chunk.count + units.count > 16 { flush() }
            chunk.append(contentsOf: units)
        }
        flush()
    }
}

struct Collected {
    let app: NSRunningApplication
    let window: AXUIElement
    let windowTitle: String
    let windowFrame: (x: Int, y: Int, w: Int, h: Int)?
    let nodes: [Node]
    let texts: [String]
    let ocr: String?
}

func intersects(_ a: (x: Int, y: Int, w: Int, h: Int), _ b: (x: Int, y: Int, w: Int, h: Int)) -> Bool {
    a.w > 0 && a.h > 0 && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/// Walks one window and returns its interactive nodes plus its readable text.
/// Depth-capped and count-capped, so a pathological app cannot produce an
/// unbounded observation. `observe` serialises the result and `resolve` picks an
/// element out of a fresh one, so both always see the same node order.
func collect(bundleId: String) throws -> Collected {
    guard let app = application(bundleId: bundleId) else {
        throw HelperError("no running application with bundle id \(bundleId)")
    }
    let appElement = applicationElement(app)
    guard let window = primaryWindow(appElement) else {
        throw HelperError("application \(bundleId) has no window")
    }
    let windowFrame = frame(window)

    var nodes: [Node] = []
    var texts: [String] = []
    var shells: [(element: AXUIElement, role: String, subrole: String, frame: (x: Int, y: Int, w: Int, h: Int))] = []
    var canvases: [Int] = []
    var seen = 0

    func walk(_ element: AXUIElement, _ depth: Int) {
        if depth > 24 || nodes.count >= 400 || seen >= 4000 { return }
        seen += 1
        let role = text(element, kAXRoleAttribute) ?? ""
        let subrole = text(element, kAXSubroleAttribute) ?? ""
        let elementActions = actions(element)
        if documentRoles.contains(role), canvases.count < maxCanvases, nodes.count < 400,
           children(element).isEmpty, (text(element, kAXValueAttribute) ?? "").isEmpty,
           let f = frame(element), let wf = windowFrame, intersects(f, wf) {
            // The visible part of the page is what is read and where the caret goes.
            let visible = (x: max(f.x, wf.x), y: max(f.y, wf.y),
                           w: min(f.x + f.w, wf.x + wf.w) - max(f.x, wf.x),
                           h: min(f.y + f.h, wf.y + wf.h) - max(f.y, wf.y))
            canvases.append(nodes.count)
            nodes.append(
                Node(
                    element: element,
                    index: nodes.count,
                    role: role,
                    subrole: subrole,
                    name: accessibleName(element),
                    value: "",
                    identifier: text(element, kAXIdentifierAttribute) ?? "",
                    enabled: true,
                    actions: [typeTextAction],
                    frame: visible
                )
            )
            return
        }
        if isInteractive(role, subrole, elementActions) {
            let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
            // Only document-like text joins the window text; a combo box's value ("12")
            // is a control setting, not content, and it is still reported on the node.
            if role == "AXTextArea" || role == "AXTextField",
               let value = text(element, kAXValueAttribute), !value.isEmpty {
                texts.append(String(value.prefix(2000)))
            }
            nodes.append(
                Node(
                    element: element,
                    index: nodes.count,
                    role: role,
                    subrole: subrole,
                    name: accessibleName(element),
                    value: text(element, kAXValueAttribute).map { String($0.prefix(200)) } ?? "",
                    identifier: text(element, kAXIdentifierAttribute) ?? "",
                    enabled: enabled,
                    actions: elementActions,
                    frame: frame(element)
                )
            )
        } else if role == "AXStaticText", let value = text(element, kAXValueAttribute), !value.isEmpty {
            texts.append(value)
        } else if shellRoles.contains(role), shells.count < maxShells,
                  accessibleName(element).isEmpty,
                  (text(element, kAXValueAttribute) ?? "").isEmpty,
                  let f = frame(element), let wf = windowFrame, intersects(f, wf) {
            shells.append((element, role, subrole, f))
        }
        for child in children(element) { walk(child, depth + 1) }
    }

    walk(window, 0)

    // Unnamed controls with a frame (a composer whose placeholder is only drawn,
    // an icon button) are named from the same capture, so the screen is read once.
    let unnamed = nodes.indices.filter { nodes[$0].name.isEmpty && nodes[$0].value.isEmpty && nodes[$0].frame != nil }
    var ocr: String? = nil
    var recognisedLeftover: [RecognisedLine] = []
    if !shells.isEmpty || !unnamed.isEmpty || !canvases.isEmpty, let wf = windowFrame {
        if !CGPreflightScreenCaptureAccess() {
            ocr = "screen_recording_denied"
        } else {
            let lines = recogniseText(window: windowNumber(pid: app.processIdentifier, frame: wf), in: wf)
            ocr = "\(lines.count) lines"
            var consumed = Set<Int>()
            func textInside(_ f: (x: Int, y: Int, w: Int, h: Int)) -> String {
                let inside = lines.indices.filter {
                    let c = lines[$0].centre
                    return c.x >= f.x && c.x < f.x + f.w && c.y >= f.y && c.y < f.y + f.h
                }
                for i in inside { consumed.insert(i) }
                return inside
                    .sorted { lines[$0].centre.y != lines[$1].centre.y ? lines[$0].centre.y < lines[$1].centre.y : lines[$0].centre.x < lines[$1].centre.x }
                    .map { lines[$0].text }
                    .joined(separator: " · ")
            }
            for i in unnamed where !canvases.contains(i) {
                let name = textInside(nodes[i].frame!)
                if !name.isEmpty { nodes[i] = nodes[i].renamed(String(name.prefix(120))) }
            }
            // For a document the page *is* the state: what the recogniser reads on
            // the canvas is its value and joins the window text, as an editor's
            // AXValue does.
            for i in canvases {
                let content = textInside(nodes[i].frame!).replacingOccurrences(of: " · ", with: "\n")
                if !content.isEmpty {
                    nodes[i] = nodes[i].revalued(String(content.prefix(2000)))
                    texts.append(String(content.prefix(2000)))
                }
            }
            for shell in shells {
                let inside = textInside(shell.frame)
                guard !inside.isEmpty, nodes.count < 400 else { continue }
                nodes.append(
                    Node(
                        element: shell.element,
                        index: nodes.count,
                        role: shell.role,
                        subrole: shell.subrole,
                        name: String(inside.prefix(120)),
                        value: "",
                        identifier: "",
                        enabled: true,
                        actions: [mouseClickAction],
                        frame: shell.frame
                    )
                )
            }
            recognisedLeftover = lines.indices.filter { !consumed.contains($0) }.map { lines[$0] }
        }
    }

    // What the recogniser read outside any control is the window's content as
    // a person sees it (a chat's header and messages, a status line): it joins
    // the window text so the decision layer has evidence, not only targets.
    if let wf = windowFrame, ocr != nil, ocr != "screen_recording_denied" {
        _ = wf
        let leftover = recognisedLeftover
            .sorted { $0.centre.y != $1.centre.y ? $0.centre.y < $1.centre.y : $0.centre.x < $1.centre.x }
            .map { $0.text }
        if !leftover.isEmpty { texts.append(contentsOf: leftover) }
    }

    return Collected(
        app: app,
        window: window,
        windowTitle: text(window, kAXTitleAttribute) ?? "",
        windowFrame: windowFrame,
        nodes: nodes,
        texts: texts,
        ocr: ocr
    )
}

struct RecognisedLine {
    let text: String
    let centre: (x: Int, y: Int)
}

/// The window server's id for the application window at `frame`, so the capture
/// is of that window itself, not of whatever is stacked over that part of the
/// screen. Nil when it cannot be found; the caller then captures the region.
func windowNumber(pid: pid_t, frame: (x: Int, y: Int, w: Int, h: Int)) -> CGWindowID? {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return nil }
    for entry in list {
        guard (entry[kCGWindowOwnerPID as String] as? pid_t) == pid,
              (entry[kCGWindowLayer as String] as? Int) == 0,
              let bounds = entry[kCGWindowBounds as String] as? [String: Any],
              let x = bounds["X"] as? Double, let y = bounds["Y"] as? Double,
              let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double,
              abs(Int(x) - frame.x) <= 2, abs(Int(y) - frame.y) <= 2,
              abs(Int(w) - frame.w) <= 2, abs(Int(h) - frame.h) <= 2,
              let number = entry[kCGWindowNumber as String] as? CGWindowID
        else { continue }
        return number
    }
    return nil
}

/// Captures one window (or, failing that, its screen rectangle in points,
/// top-left origin) and recognises the text in it. Accurate mode is required:
/// the fast recogniser has no CJK support.
func recogniseText(window: CGWindowID?, in rect: (x: Int, y: Int, w: Int, h: Int)) -> [RecognisedLine] {
    let path = NSTemporaryDirectory() + "ax-helper-ocr-\(getpid()).png"
    defer { try? FileManager.default.removeItem(atPath: path) }
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = window.map { ["-x", "-o", "-l", "\($0)", path] }
        ?? ["-x", "-R", "\(rect.x),\(rect.y),\(rect.w),\(rect.h)", path]
    do { try capture.run() } catch { return [] }
    capture.waitUntilExit()
    guard let image = NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { return [] }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // Order matters: Vision reads with the first language as primary, and CJK
    // text read as Latin comes back as noise. Traditional Chinese and English
    // first, then the system's preferred languages, without duplicates.
    var languages: [String] = []
    for language in ["zh-Hant", "en-US"] + Locale.preferredLanguages.prefix(3).map({ String($0) })
    where !languages.contains(language) { languages.append(language) }
    request.recognitionLanguages = languages
    guard (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil else { return [] }
    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox // normalised, origin bottom-left
        let cx = rect.x + Int(box.midX * Double(rect.w))
        let cy = rect.y + Int((1 - box.midY) * Double(rect.h))
        return RecognisedLine(text: candidate.string, centre: (cx, cy))
    }
}

func signatureOf(_ nodes: [Node]) -> String {
    // The signature is the identity of the controls, not their state: which
    // controls exist, in which order, under which names. A value that ticks (a
    // player's time, a counter) or text that rotates (an advertisement) does not
    // make the window a different surface, and treating it as one left a run on a
    // video site unable to act because every re-observation "changed". A control
    // that appears, disappears or is renamed still changes the signature, so a
    // press still lands only on the control that was observed.
    // Digits in a name are normalised: a player's seek slider is named by its
    // position ("0 分鐘 2 秒，共 29 分鐘 33 秒") and a badge by its count, and
    // neither makes it a different control.
    fnv1a(
        nodes
            .map { "\($0.index)|\($0.role)|\($0.subrole)|\(digitsNormalised($0.name))|\($0.identifier)|\($0.enabled)" }
            .joined(separator: "\u{1}")
    )
}

func observe(bundleId: String) throws -> [String: Any] {
    let collected = try collect(bundleId: bundleId)
    var result: [String: Any] = [
        "ok": true,
        "bundleId": bundleId,
        "app": collected.app.localizedName ?? bundleId,
        "window": collected.windowTitle,
        "windowFrame": collected.windowFrame.map { ["x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h] } ?? [:],
        "signature": signatureOf(collected.nodes),
        "text": String(collected.texts.joined(separator: "\n").prefix(6000)),
        "nodes": collected.nodes.map { node -> [String: Any] in
            var entry: [String: Any] = [
                "index": node.index,
                "role": node.role,
                "subrole": node.subrole,
                "name": node.name,
                "value": node.value,
                "identifier": node.identifier,
                "enabled": node.enabled,
                "actions": node.actions,
            ]
            if let frame = node.frame {
                entry["x"] = frame.x
                entry["y"] = frame.y
                entry["w"] = frame.w
                entry["h"] = frame.h
            }
            return entry
        },
    ]
    if let ocr = collected.ocr { result["ocr"] = ocr }
    return result
}

/// Synthesises a left click at a screen point (top-left origin). The click goes
/// through the event tap, so the application must be frontmost; `press` activates
/// it first. This is how a shell row with no accessibility action is chosen.
/// Clicks at a point and puts the pointer back where it was. Leaving it over the
/// target would keep hover effects (highlights, icons that appear under the pointer)
/// alive, and the next observation would read them as a change the click made.
func mouseClick(x: Int, y: Int) {
    let point = CGPoint(x: x, y: y)
    let before = CGEvent(source: nil)?.location
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
          let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else { return }
    move.post(tap: .cghidEventTap)
    usleep(60_000)
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    up.post(tap: .cghidEventTap)
    if let before,
       let back = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: before, mouseButton: .left) {
        usleep(40_000)
        back.post(tap: .cghidEventTap)
    }
}

func digitsNormalised(_ value: String) -> String {
    value.replacingOccurrences(of: "[0-9]+", with: "#", options: .regularExpression)
}

/// Stable across processes, unlike Swift's Hasher.
func fnv1a(_ value: String) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in value.utf8 {
        hash ^= UInt64(byte)
        hash = hash &* 0x1000_0000_01b3
    }
    return String(hash, radix: 16)
}

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// MARK: - acting

/// Re-walks the tree and returns the node at `index` only if the tree still matches
/// the signature the caller observed. This is the desktop equivalent of a fresh
/// element handle: an action cannot land on whatever replaced the target.
func resolve(bundleId: String, signature: String, index: Int) throws -> Node {
    let fresh = try collect(bundleId: bundleId)
    guard signatureOf(fresh.nodes) == signature else {
        throw HelperError("surface changed since the observation")
    }
    guard let node = fresh.nodes.first(where: { $0.index == index }) else {
        throw HelperError("no node at index \(index)")
    }
    return node
}

// MARK: - protocol

func respond(_ payload: [String: Any]) {
    let data = try? JSONSerialization.data(withJSONObject: payload, options: [])
    FileHandle.standardOutput.write(data ?? Data("{}".utf8))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func failure(_ message: String) {
    respond(["ok": false, "error": message])
}

func handle(_ request: [String: Any]) {
    let command = request["cmd"] as? String ?? ""
    do {
        switch command {
        case "ping":
            respond(["ok": true, "trusted": AXIsProcessTrusted(), "version": 1])
        case "apps":
            let apps = NSWorkspace.shared.runningApplications
                .filter { $0.activationPolicy == .regular }
                .compactMap { app -> [String: Any]? in
                    guard let id = app.bundleIdentifier else { return nil }
                    return [
                        "bundleId": id,
                        "name": app.localizedName ?? id,
                        "pid": Int(app.processIdentifier),
                        "frontmost": app.isActive,
                    ]
                }
            respond(["ok": true, "apps": apps])
        case "front":
            guard let app = frontmost(), let id = app.bundleIdentifier else {
                throw HelperError("no frontmost application")
            }
            respond(["ok": true, "bundleId": id, "name": app.localizedName ?? id])
        case "instance":
            // The running instance of the driven application, independent of which
            // application is frontmost. Accessibility actions do not need focus, so a
            // human switching windows mid-run must not look like the surface moving.
            guard let id = request["bundleId"] as? String, let app = application(bundleId: id) else {
                throw HelperError("no running application with bundle id \(request["bundleId"] ?? "")")
            }
            respond(["ok": true, "bundleId": id, "pid": Int(app.processIdentifier)])
        case "activate":
            guard let id = request["bundleId"] as? String, let app = application(bundleId: id) else {
                throw HelperError("no running application for activation")
            }
            app.activate()
            // Give the window server a moment so a following observe sees it frontmost.
            usleep(250_000)
            respond(["ok": true])
        case "observe":
            guard let id = request["bundleId"] as? String else {
                throw HelperError("observe needs bundleId")
            }
            respond(try observe(bundleId: id))
        case "press":
            guard let id = request["bundleId"] as? String,
                  let signature = request["signature"] as? String,
                  let index = request["index"] as? Int
            else { throw HelperError("press needs bundleId, signature and index") }
            let node = try resolve(bundleId: id, signature: signature, index: index)
            guard node.enabled else { throw HelperError("node \(index) is disabled") }
            if node.actions.contains(mouseClickAction) {
                guard let f = node.frame else { throw HelperError("node \(index) has no frame") }
                if let app = application(bundleId: id), !app.isActive {
                    app.activate()
                    usleep(300_000)
                }
                mouseClick(x: f.x + f.w / 2, y: f.y + f.h / 2)
                respond(["ok": true])
                break
            }
            // A control without AXPress is still interactive when it confirms or
            // picks (search fields, combo boxes); pressing it means that action.
            // Safari's toolbar buttons list only custom actions (move, remove) while
            // still answering AXPress; a pressable role is tried before giving up.
            guard let action = [kAXPressAction, kAXConfirmAction, kAXPickAction]
                .first(where: { node.actions.contains($0) })
                ?? (pressableRoles.contains(node.role) ? kAXPressAction : nil)
            else { throw HelperError("node \(index) has no press action") }
            let result = AXUIElementPerformAction(node.element, action as CFString)
            guard result == .success else { throw HelperError("press failed: AXError \(result.rawValue)") }
            respond(["ok": true])
        case "setvalue":
            guard let id = request["bundleId"] as? String,
                  let signature = request["signature"] as? String,
                  let index = request["index"] as? Int,
                  let value = request["value"] as? String
            else { throw HelperError("setvalue needs bundleId, signature, index and value") }
            let node = try resolve(bundleId: id, signature: signature, index: index)
            if node.actions.contains(typeTextAction) {
                // A drawn document: place the caret with a click near the top of the
                // visible page, then type. The text goes in at the caret, after
                // whatever is there; nothing is selected or replaced.
                guard let f = node.frame else { throw HelperError("node \(index) has no frame") }
                guard let app = application(bundleId: id) else { throw HelperError("application disappeared") }
                if !app.isActive { app.activate(); usleep(300_000) }
                mouseClick(x: f.x + f.w / 2, y: f.y + min(f.h, 240) / 2)
                usleep(250_000)
                typeUnicode(pid: app.processIdentifier, value)
                respond(["ok": true])
                break
            }
            // A field that can confirm (a browser address bar, a search field) is
            // submitted, because a value left unconfirmed there does nothing. It is
            // focused first: Safari repopulates its address bar with the page URL
            // when it gains focus, which would discard a value set before that.
            let submits = node.actions.contains(kAXConfirmAction) || node.subrole == "AXSearchField"
            if submits {
                AXUIElementSetAttributeValue(node.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                usleep(100_000)
            }
            let result = AXUIElementSetAttributeValue(
                node.element, kAXValueAttribute as CFString, value as CFString
            )
            guard result == .success else { throw HelperError("setvalue failed: AXError \(result.rawValue)") }
            if submits, let app = application(bundleId: id) {
                usleep(150_000)
                // AXConfirm alone does not navigate Safari; the Return key does. It is
                // posted to the application's pid, so it cannot land in another window.
                pressReturn(pid: app.processIdentifier)
            }
            respond(["ok": true])
        case "return":
            // Return in a field that cannot confirm through accessibility: a chat
            // composer sends on Return and exposes no send button.
            guard let id = request["bundleId"] as? String,
                  let signature = request["signature"] as? String,
                  let index = request["index"] as? Int
            else { throw HelperError("return needs bundleId, signature and index") }
            let node = try resolve(bundleId: id, signature: signature, index: index)
            guard let app = application(bundleId: id) else { throw HelperError("application disappeared") }
            AXUIElementSetAttributeValue(node.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            usleep(100_000)
            pressReturn(pid: app.processIdentifier)
            respond(["ok": true])
        case "quit":
            respond(["ok": true])
            exit(0)
        default:
            throw HelperError("unknown command \(command)")
        }
    } catch let error as HelperError {
        failure(error.description)
    } catch {
        failure("\(error)")
    }
}

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else {
        failure("request was not a JSON object")
        continue
    }
    handle(request)
}
