import UIKit

/// Draws a bot's resting bloub the way the app does, for the extensions that cannot run it.
enum AvatarRenderer {
  /// The bloub a bot wears: its picked seed, or a hash of its id (`avatarIdentitySeed`).
  static func shape(seed: Int?, botId: String) -> AvatarShape {
    avatarShapes[(seed ?? identitySeed(botId)) % avatarShapes.count]
  }

  /// The notification sender image: the bloub on the app's dark square.
  static func png(shape: AvatarShape, color: UIColor) -> Data? {
    image(shape: shape, color: color, side: 256, bodyShare: 0.3, background: UIColor(hex: avatarBackground))
      .pngData()
  }

  /// `bodyShare` is the bloub's radius as a share of `side`.
  static func image(
    shape: AvatarShape, color: UIColor, side: CGFloat, bodyShare: CGFloat, background: UIColor?
  ) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = background == nil ? 0 : 1
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
    return renderer.image { context in
      let cg = context.cgContext
      if let background {
        cg.setFillColor(background.cgColor)
        cg.fill(CGRect(x: 0, y: 0, width: side, height: side))
      }
      cg.translateBy(x: side / 2, y: side / 2)
      let scale = side * bodyShare / avatarRadius
      cg.scaleBy(x: scale, y: scale)

      let body = bodyPath(shape)
      cg.addPath(body)
      cg.setFillColor(color.cgColor)
      cg.fillPath()

      let luminance = color.luminance
      cg.saveGState()
      cg.addPath(body)
      cg.clip()
      let paper = UIColor(hex: luminance < avatarLightPaperBelow ? avatarLightPaper : avatarDarkPaper) ?? .white
      cg.setFillColor(paper.cgColor)
      for eye in shape.eyes {
        cg.addPath(eyePath(eye))
      }
      cg.fillPath()
      cg.restoreGState()

      if luminance > avatarOutlineAbove, let outline = UIColor(hex: avatarOutline) {
        cg.addPath(body)
        cg.setStrokeColor(outline.cgColor)
        cg.setLineWidth(avatarRadius * 0.06)
        cg.strokePath()
      }
    }
  }

  /// Same 32-bit string hash as `avatarIdentitySeed` in @tangow/core.
  private static func identitySeed(_ identity: String) -> Int {
    var hash: Int32 = 0
    for unit in identity.utf16 {
      hash = (hash &<< 5) &- hash &+ Int32(unit)
    }
    return Int(abs(Int64(hash)))
  }

  private static func bodyPath(_ shape: AvatarShape) -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: shape.start[0], y: shape.start[1]))
    for curve in shape.curves {
      path.addCurve(
        to: CGPoint(x: curve[4], y: curve[5]),
        control1: CGPoint(x: curve[0], y: curve[1]),
        control2: CGPoint(x: curve[2], y: curve[3])
      )
    }
    path.closeSubpath()
    return path
  }

  private static func eyePath(_ eye: AvatarEye) -> CGPath {
    let m = eye.matrix
    var transform = CGAffineTransform(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5])
    return CGPath(
      roundedRect: CGRect(
        x: -eye.halfWidth, y: -eye.halfHeight,
        width: eye.halfWidth * 2, height: eye.halfHeight * 2),
      cornerWidth: min(eye.radius, eye.halfWidth, eye.halfHeight),
      cornerHeight: min(eye.radius, eye.halfWidth, eye.halfHeight),
      transform: &transform
    )
  }
}

extension UIColor {
  convenience init?(hex: String) {
    var digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
    guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
    self.init(
      red: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }

  var luminance: CGFloat {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    getRed(&red, green: &green, blue: &blue, alpha: nil)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
}
