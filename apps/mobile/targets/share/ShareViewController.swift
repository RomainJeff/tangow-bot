import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The web link the host app shared, with the title it gave it.
struct SharedLink {
  let url: URL
  let title: String?
}

final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
    Task { @MainActor [weak self] in
      let link = await Self.link(in: items)
      guard let self else { return }
      guard let link else {
        cancel()
        return
      }
      let context = extensionContext
      let root = ShareView(
        model: ShareModel(link: link),
        onCancel: { context?.cancelRequest(withError: CocoaError(.userCancelled)) },
        onDone: { context?.completeRequest(returningItems: nil) })
      let host = UIHostingController(rootView: root)
      addChild(host)
      host.view.frame = view.bounds
      host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.addSubview(host.view)
      host.didMove(toParent: self)
    }
  }

  private func cancel() {
    extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
  }

  private static func link(in items: [NSExtensionItem]) async -> SharedLink? {
    for item in items {
      let title = [item.attributedTitle?.string, item.attributedContentText?.string]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty && URL(string: $0)?.scheme == nil }
      for provider in item.attachments ?? [] {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
          let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
          isWeb(url)
        {
          return SharedLink(url: url, title: title)
        }
      }
    }
    return nil
  }

  private static func isWeb(_ url: URL) -> Bool {
    url.scheme == "https" || url.scheme == "http"
  }
}
