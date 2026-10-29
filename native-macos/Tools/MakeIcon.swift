import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = base * scale, size = CGFloat(pixels)
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
        context.cgContext.clear(CGRect(x: 0, y: 0, width: size, height: size))
        let rect = NSRect(x: size * 0.08, y: size * 0.08, width: size * 0.84, height: size * 0.84)
        let background = NSBezierPath(roundedRect: rect, xRadius: size * 0.18, yRadius: size * 0.18)
        NSGradient(starting: NSColor(calibratedRed: 0.18, green: 0.49, blue: 0.94, alpha: 1), ending: NSColor(calibratedRed: 0.04, green: 0.16, blue: 0.40, alpha: 1))!.draw(in: background, angle: -90)
        NSColor.white.setStroke()
        let glyph = NSBezierPath(); glyph.lineWidth = size * 0.055; glyph.lineCapStyle = .round; glyph.lineJoinStyle = .round
        glyph.move(to: NSPoint(x: size * 0.29, y: size * 0.66)); glyph.line(to: NSPoint(x: size * 0.46, y: size * 0.50)); glyph.line(to: NSPoint(x: size * 0.29, y: size * 0.34))
        glyph.move(to: NSPoint(x: size * 0.53, y: size * 0.34)); glyph.line(to: NSPoint(x: size * 0.73, y: size * 0.34)); glyph.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("icon_\(base)x\(base)\(suffix).png"))
    }
}
