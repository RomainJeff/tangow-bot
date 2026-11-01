import SwiftUI
import UIKit

@MainActor
final class ShareModel: ObservableObject {
  enum Phase {
    case loading
    case signedOut
    case ready
    case failed(String)
  }

  let link: SharedLink
  @Published var phase = Phase.loading
  @Published var targets: [ShareTarget] = []
  @Published var target: ShareTarget?
  @Published var note = ""
  @Published var sending = false
  @Published var sendError: String?

  private var client: ShareClient?
  /// The extension's own memory of where the last link went; empty before the first share.
  private static let lastTargetKey = "lastShareTarget"

  init(link: SharedLink) {
    self.link = link
  }

  func load() async {
    guard let session = ShareSession.load() else {
      phase = .signedOut
      return
    }
    let client = ShareClient(session: session)
    self.client = client
    do {
      targets = try await client.targets()
      let last = UserDefaults.standard.string(forKey: Self.lastTargetKey)
      target = targets.first { $0.id == last }
      phase = .ready
    } catch {
      phase = .failed(error.localizedDescription)
    }
  }

  func send() async -> Bool {
    guard let client, let target, !sending else { return false }
    sending = true
    sendError = nil
    defer { sending = false }
    let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    let text = trimmed.isEmpty ? link.url.absoluteString : "\(trimmed)\n\n\(link.url.absoluteString)"
    do {
      try await client.send(text, to: target)
      UserDefaults.standard.set(target.id, forKey: Self.lastTargetKey)
      return true
    } catch {
      sendError = error.localizedDescription
      return false
    }
  }
}

struct ShareView: View {
  @StateObject var model: ShareModel
  let onCancel: () -> Void
  let onDone: () -> Void
  @FocusState private var noteFocused: Bool

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 16) {
          content
        }
        .padding(16)
      }
      .background(Tokens.background.ignoresSafeArea())
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }
        ToolbarItem(placement: .confirmationAction) {
          if model.sending {
            ProgressView()
          } else {
            Button("Send") {
              Task {
                if await model.send() {
                  UINotificationFeedbackGenerator().notificationOccurred(.success)
                  onDone()
                }
              }
            }
            .fontWeight(.semibold)
            .disabled(model.target == nil)
          }
        }
      }
      .navigationBarTitleDisplayMode(.inline)
    }
    .tint(Tokens.foreground)
    .task { await model.load() }
  }

  @ViewBuilder private var content: some View {
    switch model.phase {
    case .loading:
      ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
    case .signedOut:
      Notice(text: Text("Sign in to Rakazo"))
    case .failed(let message):
      Notice(text: Text(message))
    case .ready:
      Card {
        NavigationLink {
          TargetPicker(targets: model.targets, selection: $model.target)
        } label: {
          ToRow(target: model.target)
        }
      }
      Card {
        VStack(alignment: .leading, spacing: 12) {
          TextField("Message…", text: $model.note, axis: .vertical)
            .lineLimit(3...8)
            .focused($noteFocused)
            .onAppear { noteFocused = true }
            .foregroundStyle(Tokens.foreground)
          LinkTile(link: model.link)
        }
        .padding(16)
      }
      if let error = model.sendError {
        Text(error).font(.footnote).foregroundStyle(Tokens.destructive)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
      }
    }
  }
}

/// "To" and the chosen target, or nothing chosen yet.
private struct ToRow: View {
  let target: ShareTarget?

  var body: some View {
    HStack(spacing: 12) {
      Text("To").foregroundStyle(Tokens.mutedForeground)
      if let target {
        TargetAvatar(target: target, size: 28)
        Text(target.name).foregroundStyle(Tokens.foreground).lineLimit(1)
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
        .foregroundStyle(Tokens.foregroundSubtle)
    }
    .padding(.horizontal, 16)
    .frame(minHeight: 56)
    .contentShape(Rectangle())
  }
}

private struct TargetPicker: View {
  let targets: [ShareTarget]
  @Binding var selection: ShareTarget?
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  private var shown: [ShareTarget] {
    query.isEmpty ? targets : targets.filter { $0.name.localizedCaseInsensitiveContains(query) }
  }

  var body: some View {
    ScrollView {
      Card {
        LazyVStack(spacing: 0) {
          ForEach(Array(shown.enumerated()), id: \.element.id) { index, target in
            if index > 0 { Divider().overlay(Tokens.border).padding(.leading, 60) }
            Button {
              selection = target
              dismiss()
            } label: {
              HStack(spacing: 12) {
                TargetAvatar(target: target, size: 32)
                Text(target.name).foregroundStyle(Tokens.foreground).lineLimit(1)
                Spacer(minLength: 0)
                if target.id == selection?.id {
                  Image(systemName: "checkmark").fontWeight(.semibold)
                    .foregroundStyle(Tokens.foreground)
                }
              }
              .padding(.horizontal, 16)
              .frame(minHeight: 56)
              .contentShape(Rectangle())
            }
            .buttonStyle(PressedRow())
          }
        }
      }
      .padding(16)
    }
    .background(Tokens.background.ignoresSafeArea())
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
    .navigationTitle(Text("To"))
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// A bot carries its identity color; a group gets a neutral glyph.
private struct TargetAvatar: View {
  let target: ShareTarget
  let size: CGFloat

  var body: some View {
    if let hex = target.color.flatMap(Color.init(hex:)) {
      Circle().fill(hex).frame(width: size, height: size)
    } else {
      Circle().fill(Tokens.well).frame(width: size, height: size)
        .overlay(
          Image(systemName: "person.2.fill").font(.system(size: size * 0.42))
            .foregroundStyle(Tokens.mutedForeground))
    }
  }
}

private struct LinkTile: View {
  let link: SharedLink

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "link").font(.system(size: 20)).foregroundStyle(Tokens.mutedForeground)
        .frame(width: 56, height: 56)
        .background(Tokens.group, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(link.title ?? link.url.absoluteString).font(.subheadline.weight(.semibold))
          .foregroundStyle(Tokens.foreground).lineLimit(2)
        Text(link.url.host() ?? "").font(.footnote).foregroundStyle(Tokens.mutedForeground)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(8)
    .background(Tokens.well, in: RoundedRectangle(cornerRadius: Tokens.cardRadius, style: .continuous))
  }
}

private struct Notice: View {
  let text: Text

  var body: some View {
    Card {
      text.foregroundStyle(Tokens.mutedForeground).padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct Card<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    content
      .background(Tokens.group, in: RoundedRectangle(cornerRadius: Tokens.groupRadius, style: .continuous))
      .clipShape(RoundedRectangle(cornerRadius: Tokens.groupRadius, style: .continuous))
  }
}

private struct PressedRow: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.background(configuration.isPressed ? Tokens.accent : .clear)
  }
}

extension Color {
  init(light: UInt32, dark: UInt32) {
    self.init(
      UIColor { traits in
        UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
      })
  }

  init?(hex: String) {
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
    self.init(UIColor(rgb: value))
  }
}

extension UIColor {
  convenience init(rgb: UInt32) {
    self.init(
      red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
  }
}
