import EventKit
import EventKitUI
import ExpoModulesCore

struct NewEvent: Record {
  @Field var title: String = ""
  @Field var startMs: Double = 0
  @Field var endMs: Double = 0
  @Field var allDay: Bool = false
}

public class RakazoDatesModule: Module {
  // The detector Messages and Mail use, in the device's own language and time zone.
  private let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue)
  // The sheet's delegate, kept alive until the sheet closes.
  private var editor: EventEditor?

  public func definition() -> ModuleDefinition {
    Name("RakazoDates")

    // Before iOS 17 the calendar sheet needs full calendar access, which the app
    // never asks for: no dates are offered there.
    Function("find") { (text: String) -> [[String: Double]] in
      guard #available(iOS 17.0, *), let detector = self.detector else { return [] }
      let range = NSRange(text.startIndex..., in: text)
      return detector.matches(in: text, range: range).compactMap { match in
        guard let date = match.date else { return nil }
        return [
          "start": Double(match.range.location),
          "length": Double(match.range.length),
          "startMs": date.timeIntervalSince1970 * 1000,
          "durationS": match.duration,
        ]
      }
    }

    // From iOS 17 the system draws this sheet outside the app, which needs no
    // calendar permission: the person reviews the event and saves it to the
    // calendar they choose.
    AsyncFunction("addEvent") { (newEvent: NewEvent, promise: Promise) in
      guard #available(iOS 17.0, *),
        let presenter = self.appContext?.utilities?.currentViewController()
      else {
        promise.resolve(false)
        return
      }
      let store = EKEventStore()
      let event = EKEvent(eventStore: store)
      event.title = newEvent.title
      event.isAllDay = newEvent.allDay
      event.startDate = Date(timeIntervalSince1970: newEvent.startMs / 1000)
      event.endDate = Date(timeIntervalSince1970: newEvent.endMs / 1000)

      let sheet = EKEventEditViewController()
      sheet.eventStore = store
      sheet.event = event
      let editor = EventEditor { [weak self] in self?.editor = nil }
      self.editor = editor
      sheet.editViewDelegate = editor
      presenter.present(sheet, animated: true)
      promise.resolve(true)
    }.runOnQueue(.main)
  }
}

private final class EventEditor: NSObject, EKEventEditViewDelegate {
  private let onClose: () -> Void

  init(onClose: @escaping () -> Void) {
    self.onClose = onClose
  }

  func eventEditViewController(
    _ controller: EKEventEditViewController,
    didCompleteWith action: EKEventEditViewAction
  ) {
    controller.dismiss(animated: true)
    onClose()
  }
}
