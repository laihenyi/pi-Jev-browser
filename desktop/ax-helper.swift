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
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
        if let value = text(element, key)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            return value
        }
    }
    return ""
}

func application(bundleId: String) -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
}

func frontmost() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.isActive }
}

// MARK: - observation

struct Node {
    let element: AXUIElement
    let index: Int
    let role: String
    let name: String
    let value: String
    let identifier: String
    let enabled: Bool
    let actions: [String]
    let frame: (x: Int, y: Int, w: Int, h: Int)?
}

let pressableRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuItem",
    "AXMenuButton", "AXLink", "AXDisclosureTriangle", "AXTab", "AXSegment",
]

func isInteractive(_ role: String, _ actions: [String]) -> Bool {
    if actions.contains(kAXPressAction) { return true }
    if pressableRoles.contains(role) { return true }
    return actions.contains("AXConfirm") || actions.contains("AXPick")
}

/// Walks one window and returns its interactive nodes plus its readable text.
/// Depth-capped and count-capped, so a pathological app cannot produce an
/// unbounded observation.
func observe(bundleId: String) throws -> [String: Any] {
    guard let app = application(bundleId: bundleId) else {
        throw HelperError("no running application with bundle id \(bundleId)")
    }
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    let windows = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    guard let window = windows.first else {
        throw HelperError("application \(bundleId) has no window")
    }

    var nodes: [Node] = []
    var texts: [String] = []
    var seen = 0

    func walk(_ element: AXUIElement, _ depth: Int) {
        if depth > 24 || nodes.count >= 400 || seen >= 4000 { return }
        seen += 1
        let role = text(element, kAXRoleAttribute) ?? ""
        let elementActions = actions(element)
        if isInteractive(role, elementActions) {
            let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
            nodes.append(
                Node(
                    element: element,
                    index: nodes.count,
                    role: role,
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
        }
        for child in children(element) { walk(child, depth + 1) }
    }

    walk(window, 0)

    let windowTitle = text(window, kAXTitleAttribute) ?? ""
    let signature = nodes
        .map { "\($0.index)|\($0.role)|\($0.name)|\($0.value)|\($0.identifier)|\($0.enabled)" }
        .joined(separator: "\u{1}")

    return [
        "ok": true,
        "bundleId": bundleId,
        "app": app.localizedName ?? bundleId,
        "window": windowTitle,
        "signature": fnv1a(signature),
        "text": String(texts.joined(separator: "\n").prefix(6000)),
        "nodes": nodes.map { node -> [String: Any] in
            var entry: [String: Any] = [
                "index": node.index,
                "role": node.role,
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
    let fresh = try observe(bundleId: bundleId)
    guard let freshSignature = fresh["signature"] as? String, freshSignature == signature else {
        throw HelperError("surface changed since the observation")
    }
    guard let raw = fresh["nodes"] as? [[String: Any]],
          let match = raw.first(where: { ($0["index"] as? Int) == index })
    else {
        throw HelperError("no node at index \(index)")
    }
    // Rebuild the element by walking again, keeping only the requested index.
    guard let app = application(bundleId: bundleId) else {
        throw HelperError("application disappeared")
    }
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    let windows = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    guard let window = windows.first else { throw HelperError("no window") }
    var found: AXUIElement?
    var counter = 0
    func walk(_ element: AXUIElement, _ depth: Int) {
        if depth > 24 || found != nil { return }
        let role = text(element, kAXRoleAttribute) ?? ""
        if isInteractive(role, actions(element)) {
            if counter == index { found = element; return }
            counter += 1
        }
        for child in children(element) { walk(child, depth + 1) }
    }
    walk(window, 0)
    guard let element = found else { throw HelperError("node \(index) vanished") }
    _ = match
    return Node(
        element: element,
        index: index,
        role: match["role"] as? String ?? "",
        name: match["name"] as? String ?? "",
        value: match["value"] as? String ?? "",
        identifier: match["identifier"] as? String ?? "",
        enabled: match["enabled"] as? Bool ?? true,
        actions: match["actions"] as? [String] ?? [],
        frame: nil
    )
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
            guard node.actions.contains(kAXPressAction) else {
                throw HelperError("node \(index) has no press action")
            }
            let result = AXUIElementPerformAction(node.element, kAXPressAction as CFString)
            guard result == .success else { throw HelperError("press failed: AXError \(result.rawValue)") }
            respond(["ok": true])
        case "setvalue":
            guard let id = request["bundleId"] as? String,
                  let signature = request["signature"] as? String,
                  let index = request["index"] as? Int,
                  let value = request["value"] as? String
            else { throw HelperError("setvalue needs bundleId, signature, index and value") }
            let node = try resolve(bundleId: id, signature: signature, index: index)
            let result = AXUIElementSetAttributeValue(
                node.element, kAXValueAttribute as CFString, value as CFString
            )
            guard result == .success else { throw HelperError("setvalue failed: AXError \(result.rawValue)") }
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
