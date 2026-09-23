import Intents
import UIKit
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    lock.lock()
    self.contentHandler = contentHandler
    bestAttempt = request.content
    lock.unlock()
    guard let sender = BotSender(request.content) else {
      deliver(request.content)
      return
    }
    let intent = sender.messageIntent(body: request.content.body)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { _ in
      let content = (try? request.content.updating(from: intent)) ?? request.content
      self.deliver(content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock()
    let content = bestAttempt
    lock.unlock()
    if let content { deliver(content) }
  }

  private func deliver(_ content: UNNotificationContent) {
    lock.lock()
    let handler = contentHandler
    contentHandler = nil
    lock.unlock()
    handler?(content)
  }
}

struct BotSender {
  let botId: String
  let threadId: String
  let name: String
  let color: UIColor
  let shape: AvatarShape

  init?(_ content: UNNotificationContent) {
    let data = BotSender.payload(content.userInfo)
    guard
      let botId = data["botId"] as? String,
      let threadId = data["threadId"] as? String,
      let hex = data["avatarColor"] as? String,
      let color = UIColor(hex: hex),
      let index = (data["avatarShape"] as? NSNumber)?.intValue,
      avatarShapes.indices.contains(index),
      !content.title.isEmpty
    else { return nil }
    self.botId = botId
    self.threadId = threadId
    self.name = content.title
    self.color = color
    self.shape = avatarShapes[index]
  }

  private static func payload(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
    if let body = userInfo["body"] as? [String: Any] { return body }
    if let body = userInfo["body"] as? String,
      let data = body.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    {
      return object
    }
    return userInfo.reduce(into: [String: Any]()) { result, entry in
      if let key = entry.key as? String { result[key] = entry.value }
    }
  }

  func messageIntent(body: String) -> INSendMessageIntent {
    let image = AvatarRenderer.png(shape: shape, color: color).map { INImage(imageData: $0) }
    let person = INPerson(
      personHandle: INPersonHandle(value: botId, type: .unknown),
      nameComponents: nil,
      displayName: name,
      image: image,
      contactIdentifier: nil,
      customIdentifier: botId
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: body,
      speakableGroupName: nil,
      conversationIdentifier: threadId,
      serviceName: nil,
      sender: person,
      attachments: nil
    )
    if let image { intent.setImage(image, forParameterNamed: \.sender) }
    return intent
  }
}

enum AvatarRenderer {
  static let side: CGFloat = 256
  static let bodyShare: CGFloat = 0.3

  static func png(shape: AvatarShape, color: UIColor) -> Data? {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
    let image = renderer.image { context in
      let cg = context.cgContext
      cg.setFillColor(UIColor(hex: avatarBackground)?.cgColor ?? UIColor.black.cgColor)
      cg.fill(CGRect(x: 0, y: 0, width: side, height: side))
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
    return image.pngData()
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
