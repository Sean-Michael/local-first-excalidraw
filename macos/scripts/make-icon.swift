// Renders the app icon (the favicon's mark on a macOS-style rounded square) into an .iconset.
// Usage: swift make-icon.swift OUT.iconset
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px) / 1024
    // Apple's grid: an 824pt body centred in 1024 with a ~185pt corner radius.
    let body = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let shadow = NSShadow()
    shadow.shadowColor = .black.withAlphaComponent(0.25)
    shadow.shadowBlurRadius = 20 * s
    shadow.shadowOffset = NSSize(width: 0, height: -8 * s)
    shadow.set()
    let bg = NSBezierPath(roundedRect: body, xRadius: 185 * s, yRadius: 185 * s)
    NSGradient(starting: NSColor(srgbRed: 0.49, green: 0.47, blue: 0.91, alpha: 1),
               ending: NSColor(srgbRed: 0.37, green: 0.35, blue: 0.82, alpha: 1))!.draw(in: bg, angle: -90)
    NSShadow().set()
    let tri = NSBezierPath()
    tri.move(to: NSPoint(x: 512 * s, y: 730 * s))
    tri.line(to: NSPoint(x: 740 * s, y: 310 * s))
    tri.line(to: NSPoint(x: 284 * s, y: 310 * s))
    tri.close()
    tri.lineWidth = 70 * s
    tri.lineJoinStyle = .round
    NSColor.white.setStroke()
    tri.stroke()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: out.appending(path: "icon_\(size)x\(size).png"))
    try render(size * 2).write(to: out.appending(path: "icon_\(size)x\(size)@2x.png"))
}
